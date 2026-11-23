/**
 * Where a live write may go, and the fence that holds a script to it (`docs/seam-merge-plan.md`,
 * phase 7).
 *
 * The sandbox chunkedgraph shares its host with production Aedes (`cave.fanc-fly.com` serves
 * both `mar2021_test` and `wclee_aedes_brain`), so a host check alone would let a production
 * write through. The fence checks the **final** request URL — after the datastack record, the
 * graphene source and the writer have each had their say — against the sandbox table exactly,
 * and refuses before `fetch` is called. It is an allow-list of the scripts' own requests, so a
 * write it was never told about is refused too. It also counts: the merge test sends one merge
 * and one undo, and a third write is a bug, refused.
 *
 * No `vitest` import, so the probe script can install it; `writeGuard.ts` (every test file)
 * shares `isChunkedgraphEdit`.
 */

/** The one place a live write may go: FANC's sandbox (`fanc_sandbox`, table `mar2021_test`). */
export const SANDBOX = Object.freeze({
  datastack: 'fanc_sandbox',
  server: 'https://cave.fanc-fly.com',
  table: 'mar2021_test',
})

/** Every chunkedgraph route that writes, read off pychunkedgraph's `routes.py` (1.27.0, 2.20.0). */
const EDIT_ROUTE =
  /\/segmentation\/(?:.*\/)?(?:merge|merge_admin|split|undo|redo|rollback_user)\/?$/

/**
 * Whether a URL is a chunkedgraph route that writes. Judged on the **decoded** path, since the
 * server decodes `%6Derge` to `merge`, and with a trailing slash allowed. A deny-list, so a write
 * route added after these versions is not known here; the fence (`sandboxRefusal`) is an
 * allow-list and does not depend on it.
 */
export function isChunkedgraphEdit(url: string): boolean {
  const path = new URL(url, 'http://localhost').pathname
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // A malformed escape: judge the path as written.
  }
  return EDIT_ROUTE.test(path) || EDIT_ROUTE.test(decoded)
}

/**
 * The URL a `fetch` call asks for. Duck-typed: a `Request` from undici's own class or another
 * realm fails `instanceof Request`, and a fence reading it as `String(input)` would judge
 * `[object Request]` and let it through.
 */
export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'object' && 'url' in input ? input.url : String(input)
}

const ON_SANDBOX = `/segmentation/api/v1/table/${SANDBOX.table}/`

/** The only writes the live tests send, as paths on the sandbox host: a merge or a split, an undo. */
const WRITES = new Map(
  (['merge', 'split', 'undo'] as const).map((route) => [ON_SANDBOX + route, route]),
)

/**
 * The reads the scripts send as POSTs, all on the sandbox table: the chunkedgraph's (`rootIds.ts`,
 * and the split preview, `splitPreview.ts`) and the level-2 cache's chunk points (`l2.ts`).
 */
const POSTED_READS = new Set([
  ...['roots_binary', 'is_latest_roots', 'node/leaves_many', 'graph/split_preview'].map(
    (route) => ON_SANDBOX + route,
  ),
  `/l2cache/api/v1/table/${SANDBOX.table}/attributes`,
])

/** A request's method, wherever it was given; `fetch`'s default is GET. */
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const given =
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : '')
  return (given || 'GET').toUpperCase()
}

/**
 * Why a request is refused, or undefined for one the merge test may make. An **allow-list**, not a
 * list of known write routes: any request but a GET or HEAD must be one of the writes (`WRITES`) or
 * the posted reads (`POSTED_READS`), on the sandbox host and table — so a write route nobody listed, a trailing
 * slash, or another CAVE service's POST is refused too. A GET to a write route is refused as well.
 * Read off the parsed URL, so a `..` segment is resolved before it is judged and an encoded slash
 * is never the sandbox's path.
 */
export function sandboxRefusal(url: string, method = 'GET'): string | undefined {
  const reads = method === 'GET' || method === 'HEAD'
  if (reads && !isChunkedgraphEdit(url)) return undefined
  const parsed = new URL(url)
  if (parsed.origin !== SANDBOX.server) {
    return `${parsed.origin} is not the sandbox's chunkedgraph (${SANDBOX.server}).`
  }
  if (reads || !(WRITES.has(parsed.pathname) || POSTED_READS.has(parsed.pathname))) {
    return `${method} ${parsed.pathname} is not one of the live tests' requests on the sandbox table.`
  }
  return undefined
}

/**
 * Begins every refusal the fence throws, so a caller holding only the writer's outcome — which
 * reads any thrown `fetch` as "not known" — can tell "refused here, never sent" from a request
 * that failed on the way.
 */
export const FENCE_REFUSED = 'Refused by the sandbox fence, never sent'

/** How many of each write a script may send. Absent is none. */
export interface WriteLimits {
  readonly merge?: number
  readonly split?: number
  readonly undo?: number
}

type WriteRoute = keyof WriteLimits

/**
 * The fence counts writes; it cannot tell which edit an undo takes back. That pairing is the
 * writer's: `undoEdit` takes only a `done` outcome `edits.ts` itself returned, once.
 *
 * Put the fence in front of this process's `fetch`: a request `sandboxRefusal` refuses, a write
 * past its limit, an undo with no merge or split before it, or a split that does not say whether it
 * is a min-cut throws before anything is sent. The merge test declares `{ merge: 1, undo: 1 }`,
 * the split test `{ split: 1, undo: 1 }`, the pair finder `{}`, which is reads only. Returns how
 * many writes went out.
 */
export function fenceWrites(limits: WriteLimits): () => number {
  const real = globalThis.fetch
  const sent: Record<WriteRoute, number> = { merge: 0, split: 0, undo: 0 }
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const method = methodOf(input, init)
    const parsed = new URL(url, 'http://localhost')
    const route = method === 'GET' ? undefined : WRITES.get(parsed.pathname)
    const refusal =
      sandboxRefusal(url, method) ??
      (route && sent[route] >= (limits[route] ?? 0)
        ? `${sent[route]} ${route}(s) sent, of ${limits[route] ?? 0} allowed.`
        : undefined) ??
      (route === 'undo' && sent.undo >= sent.merge + sent.split
        ? 'an undo needs a merge or a split before it.'
        : undefined) ??
      // The server's default is its min-cut: a split must say which it asks for.
      (route === 'split' && !['true', 'false'].includes(parsed.searchParams.get('mincut') ?? '')
        ? 'a split must say whether it is a min-cut (mincut=true or mincut=false).'
        : undefined)
    if (refusal) throw new Error(`${FENCE_REFUSED}: ${method} ${url}: ${refusal}`)
    if (route) sent[route]++
    return real(input, init)
  }
  return () => Object.values(sent).reduce((all, n) => all + n, 0)
}
