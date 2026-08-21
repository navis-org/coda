/**
 * Byte fetching for precomputed sources, with a per-host CORS fallback.
 *
 * Mesh buckets are inconsistent about CORS, and it is decided per bucket rather than per
 * provider: `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe`
 * all answer `Access-Control-Allow-Origin: *`, while `flyem-male-cns` sends no CORS headers
 * at all. So a direct fetch is tried first — which keeps hemibrain, MANC and optic-lobe
 * working with no proxy, including from a plain static deploy — and only the hosts that
 * actually refuse get routed through one.
 *
 * A browser reports a CORS refusal as an opaque `TypeError`, indistinguishable from the
 * network being down, so "did direct work?" can only be answered by trying. The answer is
 * cached per host so that costs one request per host per session rather than one per fetch.
 */

const MODE_KEY = 'coda.precomputed.transport'

/**
 * Same-origin prefixes that proxy a remote host. Kept as a table because a proxy rule has
 * to exist on the server side too — see `vite.config.ts`.
 */
const PROXY_PREFIXES: ReadonlyArray<{ host: string; prefix: string }> = [
  { host: 'storage.googleapis.com', prefix: '/gcs' },
]

type Mode = 'direct' | 'proxy' | 'unreachable'

const modes = new Map<string, Mode>()
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = window.localStorage?.getItem(MODE_KEY)
    if (!raw) return
    for (const [host, mode] of Object.entries(JSON.parse(raw) as Record<string, Mode>)) {
      modes.set(host, mode)
    }
  } catch {
    // No storage, or corrupt: start from scratch and re-probe.
  }
}

function remember(host: string, mode: Mode): void {
  modes.set(host, mode)
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
  const host = hostOf(url)
  const mode = host ? modes.get(host) : undefined
  const viaProxy = proxied(url)

  if (mode === 'proxy' && viaProxy) return attempt(viaProxy, options)

  try {
    const result = await attempt(url, options)
    if (host && mode !== 'direct') remember(host, 'direct')
    return result
  } catch (error) {
    if (error instanceof PrecomputedFetchError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (!viaProxy) {
      if (host) remember(host, 'unreachable')
      throw new PrecomputedFetchError(
        `Could not read ${url}. The host is unreachable or refuses cross-origin reads, and ` +
          `no proxy is configured for it.`,
        url,
        0,
      )
    }
    // Direct failed and a proxy route exists — very likely CORS.
    const result = await attempt(viaProxy, options).catch((proxyError: unknown) => {
      if (host) remember(host, 'unreachable')
      throw proxyError instanceof PrecomputedFetchError
        ? proxyError
        : new PrecomputedFetchError(
            `${hostOf(url) ?? url} refuses cross-origin reads and the ${viaProxy} proxy is not ` +
              `answering either. In development that proxy comes from vite.config.ts, so this ` +
              `needs \`pnpm dev\` or \`pnpm preview\`.`,
            url,
            0,
          )
    })
    if (host) remember(host, 'proxy')
    return result
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const bytes = await fetchBytes(url, options)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/** How each host is currently being reached. Surfaced by the Sources panel. */
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
