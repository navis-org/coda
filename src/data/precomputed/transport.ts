/**
 * Byte fetching for precomputed sources, with a per-**bucket** CORS fallback.
 *
 * Mesh buckets are inconsistent about CORS, and it is decided per bucket rather than per
 * provider: `neuroglancer-janelia-flyem-hemibrain`, `manc-seg-v1p2` and `flyem-optic-lobe`
 * all answer `Access-Control-Allow-Origin: *`, while `flyem-male-cns` sends no CORS headers
 * at all — to anybody. That was re-probed against six origins including
 * `neuroglancer-demo.appspot.com` and `clio-ng.janelia.org`, so it is an absent policy rather
 * than an allow-list Coda is missing from.
 *
 * A browser reports a CORS refusal as an opaque `TypeError`, indistinguishable from the
 * network being down, so "did direct work?" can only be answered by trying. The answer is
 * cached so that costs one request per bucket per session rather than one per fetch — and it
 * is cached against the *bucket*, not the host, which all four of those share. See
 * `PATH_STYLE_HOSTS` for what keying it by host cost.
 *
 * ## Three routes, and the order is what makes the deployed site work
 *
 * `direct` → `gcs-api` → `proxy`, each tried only after the one before it throws.
 *
 * **`gcs-api` is why a refusing GCS bucket is readable at all in production.** Google serves the
 * same object under two endpoints and only one of them consults the bucket's CORS policy:
 *
 *     XML / direct   storage.googleapis.com/<bucket>/<key>
 *     JSON API       storage.googleapis.com/storage/v1/b/<bucket>/o/<urlencoded key>?alt=media
 *
 * The JSON API answers `Access-Control-Allow-Origin: <the request's origin>` whatever the bucket
 * says, which is how neuroglancer reads male-CNS — its `gs://` driver builds exactly this URL
 * (`src/kvstore/gcs/index.ts`), and that is the whole of the difference. Measured against
 * `flyem-male-cns/v1.0/segmentation/info` from `Origin: https://coda.science`: 200 with the
 * header, 206 with `Content-Range` under a `Range` request, and an `OPTIONS` preflight allowing
 * `range` with `max-age: 3600`. So it carries everything the sharded reader needs.
 *
 * **It goes before the proxy, not after**, for two reasons that point the same way. It works in
 * a static deploy, where `/gcs` is a path on this origin that nothing serves — `coda.science`
 * answers it with GitHub Pages' 404 page. And it is a real cross-origin host, so it multiplexes:
 * the proxy is one same-origin HTTP/1.1 hop, measured at 30.5 s against 3.1 s direct on a
 * 300-body hemibrain fetch. The proxy stays as the third route because it is not GCS-specific
 * and is the only thing left for some other host that refuses.
 *
 * **The cache-busting parameter neuroglancer appends is deliberately not copied.** Its comment
 * cites [crbug 1214563](https://bugs.chromium.org/p/chromium/issues/detail?id=1214563) — GCS
 * omitting an updated `Access-Control-Allow-Origin` on the 304 answering a cache revalidation,
 * which would make a warm cache fail CORS about an hour in, intermittently. That was re-measured
 * here rather than assumed, and it no longer reproduces: a conditional GET with `If-None-Match`
 * returns 304 carrying `Vary: …,Origin,X-Origin` and the *requesting* origin's header, including
 * after the edge was primed from a different origin. Since the objects are served
 * `public, max-age=3600, must-revalidate`, a unique URL per request would throw away every
 * revalidation for a bug that is fixed. If it ever comes back the symptom is a CORS failure that
 * only appears on a second visit, and the fix is one query parameter.
 */

const MODE_KEY = 'coda.precomputed.transport'

/**
 * Google's object host, which three separate rules below are each about.
 *
 * One name rather than four literals: it is the host that proxies through `/gcs`, the one host
 * here that puts the bucket in the path, the one `objectStoreUrl` emits for `gs://`, and the one
 * whose JSON API `gcsJsonApiUrl` restates. Four spellings of one fact is how a change reaches
 * three of them.
 */
const GCS_HOST = 'storage.googleapis.com'

/** The JSON API's own prefix — both the guard against rewriting twice and half the rewrite. */
const GCS_API_PREFIX = '/storage/v1/'

/**
 * Same-origin prefixes that proxy a remote host. Kept as a table because a proxy rule has
 * to exist on the server side too — see `vite.config.ts`.
 */
const PROXY_PREFIXES: ReadonlyArray<{ host: string; prefix: string }> = [
  { host: GCS_HOST, prefix: '/gcs' },
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
const PATH_STYLE_HOSTS = new Set([GCS_HOST])

/**
 * The fallback routes, in the order they are tried after a direct read throws.
 *
 * A table rather than statements inside `fetchBytes`, because three separate things are facts
 * *about a route* and were otherwise spread across the function: its name in the persisted
 * memory, how it rewrites a URL, and what to tell somebody when it is the one that failed. The
 * `Mode` union derives from this, so a fourth route cannot arrive half-registered.
 *
 * The order is load-bearing and the file header argues it: `gcs-api` before `proxy` because it
 * works in a static deploy, where `/gcs` is a path on this origin that nothing serves, and
 * because it is a real cross-origin host that multiplexes rather than queueing behind one
 * same-origin HTTP/1.1 hop.
 *
 * `rewrite` answering undefined means "this route has no form of that URL" — an S3 object has no
 * JSON API address and no proxy prefix — which is also what makes a remembered mode safe to look
 * up here: one that does not apply simply finds nothing and the container re-probes.
 */
const ROUTES = [
  { mode: 'gcs-api', rewrite: gcsJsonApiUrl, hint: undefined },
  {
    mode: 'proxy',
    rewrite: proxied,
    /*
     * Kept on the route rather than in the failure message, which is where it used to live and
     * how it nearly got lost when that message was generalised to N routes. It is the likeliest
     * local failure of this whole path, and `neuprint/client.ts` carries the same sentence for
     * the same reason.
     */
    hint: 'In development that proxy comes from vite.config.ts, so this needs `pnpm dev` or `pnpm preview`.',
  },
] as const

/**
 * How a container is reached. Persisted, so a value here is also a name in `localStorage`.
 *
 * `direct` and `unreachable` are the two ends and belong to no route; everything between them is
 * a fallback, so the union is **derived from `ROUTES`** rather than restated. A fifth route added
 * to that table without being added here would otherwise be dropped by `load` on the next
 * session — silently, and by the very check written to prevent that class of thing.
 */
type Mode = 'direct' | 'unreachable' | (typeof ROUTES)[number]['mode']

/** Every mode `load` will honour. Derived, for the reason on `Mode`. */
const MODES: readonly string[] = ['direct', 'unreachable', ...ROUTES.map((route) => route.mode)]

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
      /*
       * A route name from some other build. It is *harmless* to the lookup below — an unknown
       * mode matches no entry in `ROUTES`, so the container simply re-probes — so this is not
       * load-bearing for correctness. What it stops is the weaker thing: a dead name sitting in
       * `modes` for the session, being re-persisted by every `remember`, and being reported by
       * `transportModes()` as though it were a route somebody could act on.
       */
      if (!MODES.includes(mode)) continue
      modes.set(key, mode)
    }
  } catch {
    // No storage, or corrupt: start from scratch and re-probe.
  }
}

function remember(container: string, mode: Mode): void {
  /*
   * A burst of concurrent reads all reach the fallback loop before any of them has remembered
   * anything, so without this a refusing bucket at `BUCKET_CONCURRENCY` 100 does 100 identical
   * writes — each one a spread, a filter, an `Object.fromEntries`, a `JSON.stringify` of a
   * string that grows with every container seen this session, and a synchronous disk-backed
   * `setItem`. Measured at 100 writes of 5.1 kB for one bucket.
   */
  if (modes.get(container) === mode) return
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

/**
 * A path-style GCS object URL restated through the JSON API, which always answers CORS.
 *
 * `storage.googleapis.com/<bucket>/<key>` → `…/storage/v1/b/<bucket>/o/<key>?alt=media`, with
 * the key percent-encoded **whole**: it is one path segment there, so every `/` in it becomes
 * `%2F`. `encodeURIComponent` is exactly that rule and is what neuroglancer uses.
 *
 * Three refusals, each of which would otherwise produce a confidently wrong URL:
 *
 *  - **Not this host** — S3 and everything else. The JSON API is Google's.
 *  - **Already a JSON API URL.** Rewriting one again would ask for an object literally named
 *    `storage/v1/b/…` in a bucket called `storage`, which 404s and reads as a missing mesh.
 *  - **A query string.** The rewrite owns `?alt=media`, and merging somebody else's parameters
 *    into it risks colliding with the API's own. Nothing under `objectStoreUrl` emits one, so
 *    this refuses rather than guessing; such a URL simply falls through to the proxy, which is
 *    what it did before this route existed.
 */
export function gcsJsonApiUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.host !== GCS_HOST) return undefined
  if (parsed.pathname.startsWith(GCS_API_PREFIX)) return undefined
  if (parsed.search) return undefined
  const [bucket, ...rest] = parsed.pathname.split('/').filter(Boolean)
  const key = rest.join('/')
  if (!bucket || !key) return undefined
  return `https://${GCS_HOST}${GCS_API_PREFIX}b/${bucket}/o/${encodeURIComponent(key)}?alt=media`
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
  /**
   * Extra request headers.
   *
   * Empty for every object store here — a public bucket takes none, and sending one would turn
   * a simple cross-origin GET into a preflight. It exists because `data/dvid` reads through this
   * transport and DVID deployments are moving towards requiring a credential: those servers are
   * plain HTTPS hosts with CORS, so they want this file's routing and error handling and differ
   * only in carrying an `Authorization`. A second byte-fetching stack for one header is how the
   * CORS fallback comes to exist twice and disagree once.
   */
  headers?: Readonly<Record<string, string>> | undefined
  /**
   * Abandon the response past this many bytes, reporting **413**.
   *
   * For a store that publishes no size in advance. A precomputed pyramid names each level's byte
   * count in its manifest, so `fetchMeshes` refuses an over-large body for free — but DVID
   * publishes no manifest, answers `HEAD` with no `Content-Length`, and ignores `Range` (200, not
   * 206), all measured against `flyem.dvid.io`. So there is nothing to ask, and the only way to
   * bound the cost is to stop reading.
   *
   * The bound is on the **download**, not on the decoded result, and that is the whole point: a
   * check after `arrayBuffer()` has already spent the bytes, and one DVID body can be 107 MB with
   * no coarser level to fall back to.
   *
   * 413 because it means exactly this, and because callers already switch on status — a body that
   * is too big to want is unavailable in the same way a 404 body is, and neither is worth another
   * route. Streaming only happens when this is set, so the ordinary path is untouched.
   */
  maxBytes?: number | undefined
}

/**
 * Read a response body, giving up past `maxBytes`.
 *
 * `Content-Length` first, because a store that sends one lets the refusal cost nothing; the
 * stream is for the stores that do not. Cancelling the reader is what actually stops the
 * transfer rather than merely ignoring it.
 */
async function readCapped(
  response: Response,
  url: string,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel()
    throw new PrecomputedFetchError(`${url} is ${declared} bytes, over ${maxBytes}`, url, 413)
  }
  const reader = response.body?.getReader()
  if (!reader) return response.arrayBuffer()

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel()
      throw new PrecomputedFetchError(`${url} is over ${maxBytes} bytes`, url, 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out.buffer
}

async function attempt(url: string, options: FetchOptions): Promise<ArrayBuffer> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.range) headers['Range'] = `bytes=${options.range[0]}-${options.range[1]}`
  const response = await fetch(url, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok) {
    throw new PrecomputedFetchError(`${response.status} from ${url}`, url, response.status)
  }
  if (options.maxBytes !== undefined) return readCapped(response, url, options.maxBytes)
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
  if (scheme === 'gs') return `https://${GCS_HOST}/${clean}`
  // Virtual-hosted style: the path-style endpoint 301-redirects, and fetch will not follow a
  // redirect that drops CORS headers.
  const [bucket, ...rest] = clean.split('/')
  return `https://${bucket}.s3.amazonaws.com/${rest.join('/')}`
}

/**
 * Is this the opaque failure a browser reports for a CORS refusal, rather than an answer?
 *
 * The distinction is the whole basis of the fallback chain. A `PrecomputedFetchError` means a
 * response *arrived* and said no — a 404 is a missing object down every route, so retrying it
 * three ways would triple every lookup for a body that simply has no mesh. A bare `TypeError`
 * means nothing came back, and only that is worth another route.
 */
function isRoutable(error: unknown): boolean {
  if (error instanceof PrecomputedFetchError) return false
  if (error instanceof DOMException && error.name === 'AbortError') return false
  return true
}

/**
 * Fetch bytes, falling back for hosts that refuse cross-origin reads.
 *
 * Direct first, then each of `ROUTES` in turn — and only ever when the one before it *threw*.
 * A non-2xx response is not retried, because the request plainly arrived and a 404 means the
 * object is missing whichever way it was asked for; `isRoutable` is that distinction and the
 * file header argues the order.
 */
export async function fetchBytes(
  url: string,
  options: FetchOptions = {},
): Promise<ArrayBuffer> {
  load()
  const container = containerOf(url)
  const mode = container ? modes.get(container) : undefined

  /*
   * Which routes this URL actually has a form of, in `ROUTES` order. A remembered mode is looked
   * up in the same list, so it can never name a route the URL cannot take — a stored `gcs-api`
   * against an S3 bucket finds nothing here and the container re-probes.
   */
  const fallbacks = ROUTES.flatMap((route) => {
    const rewritten = route.rewrite(url)
    return rewritten === undefined ? [] : [{ ...route, url: rewritten }]
  })

  const remembered = fallbacks.find((route) => route.mode === mode)
  if (remembered) return attempt(remembered.url, options)

  try {
    const result = await attempt(url, options)
    if (container && mode !== 'direct') remember(container, 'direct')
    return result
  } catch (error) {
    if (!isRoutable(error)) throw error

    // Direct failed with nothing coming back — very likely CORS. Try each route in turn.
    let last: unknown
    for (const route of fallbacks) {
      try {
        const result = await attempt(route.url, options)
        if (container) remember(container, route.mode)
        return result
      } catch (routeError) {
        // A route that *answered* settles it, exactly as a direct answer would — see `isRoutable`.
        if (!isRoutable(routeError)) throw routeError
        last = routeError
      }
    }

    if (container) remember(container, 'unreachable')
    const tried = fallbacks.length
      ? `Tried ${fallbacks.map((route) => route.url).join(', ')}. ` +
        `${fallbacks
          .map((route) => route.hint)
          .filter(Boolean)
          .join(' ')} ` +
        `The last said: ${last instanceof Error ? last.message : String(last)}`
      : 'No fallback route is configured for it.'
    throw new PrecomputedFetchError(
      `Could not read ${url}: ${container ?? 'the host'} is unreachable or refuses ` +
        `cross-origin reads. ${tried}`.replace(/\s+/g, ' ').trim(),
      url,
      0,
    )
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

/**
 * A precomputed directory's `info`, read at most once per URL per session.
 *
 * An `info` is immutable under a fixed URL — it is the published description of a released
 * dataset — which is what makes a cache correct here rather than merely convenient. Without it
 * the same document is fetched repeatedly by callers that cannot see each other: opening one
 * draco mesh source reads it twice on its own (`openMeshSource`, then `readMultiResInfo`), and
 * the Neuroglancer Source node's probe reads it again before the first Run.
 *
 * **Only successes are held.** A failure is usually transient — an unreachable host, a proxy not
 * started yet — and a sticky one would outlive its cause, which is the same reason
 * `remember` refuses to persist `unreachable`. Callers that want a failure remembered say so at
 * their own level; `precomputed/probe.ts` does.
 *
 * **In-flight requests are not deduplicated**, deliberately. Sharing one promise would mean one
 * caller's `AbortSignal` rejecting for every other caller — and the requests this exists to
 * remove are sequential rather than concurrent, so there is nothing to gain against that risk.
 */
export async function fetchInfo<T>(base: string, options: FetchOptions = {}): Promise<T> {
  const url = `${base.replace(/\/+$/, '')}/info`
  const held = infos.get(url)
  if (held !== undefined) return held as T
  const body = await fetchJson<T>(url, options)
  infos.set(url, body)
  return body
}

const infos = new Map<string, unknown>()

/** How each bucket is currently being reached. Surfaced by the Sources panel. */
export function transportModes(): Record<string, Mode> {
  load()
  return Object.fromEntries(modes)
}

export function resetTransport(): void {
  modes.clear()
  // The `info` memo is network state learned by this module too, and every test that resets one
  // wants the other — a held `info` from a previous case answers a stubbed fetch that never ran.
  infos.clear()
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
