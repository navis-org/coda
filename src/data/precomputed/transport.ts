/**
 * Byte fetching for precomputed sources, with a per-**bucket** CORS fallback.
 *
 * Mesh buckets are inconsistent about CORS, and it is decided per bucket rather than per
 * provider: `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe`
 * all answer `Access-Control-Allow-Origin: *`, while `flyem-male-cns` sends no CORS headers
 * at all. So a direct fetch is tried first — which keeps hemibrain, MANC and optic-lobe
 * working with no proxy, including from a plain static deploy — and only the buckets that
 * actually refuse get routed through one.
 *
 * A browser reports a CORS refusal as an opaque `TypeError`, indistinguishable from the
 * network being down, so "did direct work?" can only be answered by trying. The answer is
 * cached so that costs one request per bucket per session rather than one per fetch — and it
 * is cached against the *bucket*, not the host, which all four of those share. See
 * `PATH_STYLE_HOSTS` for what keying it by host cost.
 */

const MODE_KEY = 'coda.precomputed.transport'

/**
 * Same-origin prefixes that proxy a remote host. Kept as a table because a proxy rule has
 * to exist on the server side too — see `vite.config.ts`.
 */
const PROXY_PREFIXES: ReadonlyArray<{ host: string; prefix: string }> = [
  { host: 'storage.googleapis.com', prefix: '/gcs' },
]

/**
 * Hosts that put the **bucket in the first path segment**, where one host serves many buckets.
 *
 * This exists because the answer being cached — "does a direct read work here?" — is a property
 * of the *bucket*, and keying it by host got that wrong in the one way that matters. Every FlyEM
 * bucket lives on `storage.googleapis.com`: hemibrain, MANC and optic-lobe answer
 * `Access-Control-Allow-Origin: *`, and `flyem-male-cns` sends no CORS headers at all. Under a
 * host key, one male-CNS mesh recorded `storage.googleapis.com → proxy`, **persisted it to
 * localStorage**, and from then on every hemibrain read in that browser profile went through the
 * proxy without ever retrying direct — including in later sessions, and including for somebody
 * who never opened male-CNS again.
 *
 * Measured on a 300-body hemibrain fetch: 3.1 s direct against 30.5 s through the dev proxy. The
 * requests are all issued — the browser reports 100 in flight either way — they just queue behind
 * a single-origin HTTP/1.1 hop. That is a tenfold penalty with nothing on screen to attribute it
 * to, and it was invisible while `BUCKET_CONCURRENCY` was 6, because then both routes were slow.
 *
 * S3 needs no entry: `objectStoreUrl` emits virtual-hosted style, so there the bucket *is* the
 * host and the host key is already the right one.
 */
const PATH_STYLE_HOSTS = new Set(['storage.googleapis.com'])

type Mode = 'direct' | 'proxy' | 'unreachable'

const modes = new Map<string, Mode>()
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = window.localStorage?.getItem(MODE_KEY)
    if (!raw) return
    for (const [key, mode] of Object.entries(JSON.parse(raw) as Record<string, Mode>)) {
      /*
       * Entries written by the host-keyed version are dropped rather than migrated. A bare
       * `storage.googleapis.com` cannot be mapped onto a bucket — it stood for whichever one
       * happened to be read first — and keeping it would mean carrying a value that can never
       * match a lookup again. Dropping it costs one probe per bucket and un-poisons every
       * profile that read male-CNS once.
       */
      if (PATH_STYLE_HOSTS.has(key)) continue
      modes.set(key, mode)
    }
  } catch {
    // No storage, or corrupt: start from scratch and re-probe.
  }
}

function remember(container: string, mode: Mode): void {
  modes.set(container, mode)
  try {
    // 'unreachable' is deliberately not persisted — it is usually transient (offline,
    // proxy not started yet) and a sticky failure would outlive its cause.
    const durable = Object.fromEntries([...modes].filter(([, m]) => m !== 'unreachable'))
    window.localStorage?.setItem(MODE_KEY, JSON.stringify(durable))
  } catch {
    // Fine — the in-memory map still saves the retries for this session.
  }
}

/** Rewrite an absolute URL onto its same-origin proxy prefix, if one is configured. */
export function proxied(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const rule = PROXY_PREFIXES.find((p) => p.host === parsed.host)
  if (!rule) return undefined
  return `${rule.prefix}${parsed.pathname}${parsed.search}`
}

export class PrecomputedFetchError extends Error {
  readonly url: string
  readonly status: number
  constructor(message: string, url: string, status: number) {
    super(message)
    this.name = 'PrecomputedFetchError'
    this.url = url
    this.status = status
  }
}

export interface FetchOptions {
  /** Inclusive byte range, as `[start, end]`. Omit for the whole object. */
  range?: readonly [number, number] | undefined
  signal?: AbortSignal | undefined
}

async function attempt(url: string, options: FetchOptions): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {}
  if (options.range) headers['Range'] = `bytes=${options.range[0]}-${options.range[1]}`
  const response = await fetch(url, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    throw new PrecomputedFetchError(`${response.status} from ${url}`, url, response.status)
  }
  return response.arrayBuffer()
}

/**
 * `gs://bucket/path` or `s3://bucket/path` → a URL a browser can fetch.
 *
 * Here rather than in either backend because there are two of them now: neuPrint reads a
 * `precomputed://gs://…` out of a neuroglancer state, and CAVE reads a bare `gs://` out of a
 * graphene segmentation's `data_dir`. The rule is the same and the mistake is the same — the
 * first copy of this quietly mapped an unrecognised scheme onto the GCS host, which produces a
 * confidently wrong URL rather than a refusal, and 404s that read as missing neurons.
 *
 * **Undefined for anything else**, deliberately. Not every CAVE datastack is on GCS.
 */
export function objectStoreUrl(uri: string): string | undefined {
  const match = /^(gs|s3):\/\/(.+)$/.exec(uri.trim())
  if (!match) return undefined
  const [, scheme, path] = match
  const clean = path!.replace(/\/+$/, '')
  if (scheme === 'gs') return `https://storage.googleapis.com/${clean}`
  // Virtual-hosted style: the path-style endpoint 301-redirects, and fetch will not follow a
  // redirect that drops CORS headers.
  const [bucket, ...rest] = clean.split('/')
  return `https://${bucket}.s3.amazonaws.com/${rest.join('/')}`
}

/**
 * Fetch bytes, falling back to a proxy for hosts that refuse cross-origin reads.
 *
 * A non-2xx response is *not* retried through the proxy: the request plainly arrived, and
 * a 404 means the object is missing whichever route it took. Only a thrown fetch — CORS or
 * transport — triggers the fallback.
 */
export async function fetchBytes(
  url: string,
  options: FetchOptions = {},
): Promise<ArrayBuffer> {
  load()
  const container = containerOf(url)
  const mode = container ? modes.get(container) : undefined
  const viaProxy = proxied(url)

  if (mode === 'proxy' && viaProxy) return attempt(viaProxy, options)

  try {
    const result = await attempt(url, options)
    if (container && mode !== 'direct') remember(container, 'direct')
    return result
  } catch (error) {
    if (error instanceof PrecomputedFetchError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (!viaProxy) {
      if (container) remember(container, 'unreachable')
      throw new PrecomputedFetchError(
        `Could not read ${url}. The host is unreachable or refuses cross-origin reads, and ` +
          `no proxy is configured for it.`,
        url,
        0,
      )
    }
    // Direct failed and a proxy route exists — very likely CORS.
    const result = await attempt(viaProxy, options).catch((proxyError: unknown) => {
      if (container) remember(container, 'unreachable')
      throw proxyError instanceof PrecomputedFetchError
        ? proxyError
        : new PrecomputedFetchError(
            `${container ?? url} refuses cross-origin reads and the ${viaProxy} proxy is not ` +
              `answering either. In development that proxy comes from vite.config.ts, so this ` +
              `needs \`pnpm dev\` or \`pnpm preview\`.`,
            url,
            0,
          )
    })
    if (container) remember(container, 'proxy')
    return result
  }
}

/**
 * What the transport mode is remembered against: the **bucket**, where a host serves many.
 *
 * `storage.googleapis.com/flyem-male-cns` and `storage.googleapis.com/flyem-optic-lobe` are two
 * different answers to "does direct work", and CORS is configured per bucket. Everywhere else
 * the host is the whole of it — so this doubles as the answer to "which host is this", and the
 * error message below uses it for that. Naming the bucket there is strictly better anyway: it is
 * the thing that actually refused.
 */
function containerOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (!PATH_STYLE_HOSTS.has(parsed.host)) return parsed.host
  const bucket = parsed.pathname.split('/').filter(Boolean)[0]
  return bucket ? `${parsed.host}/${bucket}` : parsed.host
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const bytes = await fetchBytes(url, options)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/** How each bucket is currently being reached. Surfaced by the Sources panel. */
export function transportModes(): Record<string, Mode> {
  load()
  return Object.fromEntries(modes)
}

export function resetTransport(): void {
  modes.clear()
  loaded = false
  try {
    window.localStorage?.removeItem(MODE_KEY)
  } catch {
    // nothing to clear
  }
}

/**
 * Inflate gzip. Both the minishard index and the mesh manifests are gzipped, and
 * `DecompressionStream` means that needs no library.
 */
export async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot inflate gzip (no DecompressionStream)')
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}
