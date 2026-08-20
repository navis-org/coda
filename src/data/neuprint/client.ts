/**
 * HTTP to neuPrint, and the choice of how to get there.
 *
 * **Direct where CORS allows it, a same-origin proxy where it does not.** neuPrint historically
 * sent no `Access-Control-*` headers at all and answered its `OPTIONS` preflight with 401
 * before CORS middleware would run, so a browser could not call it from any origin, token or
 * not, and every request had to be relayed. Janelia has since fixed that on
 * `neuprint-test.janelia.org` — 204 on the preflight, `Access-Control-Allow-Origin` on every
 * response *including its errors*, which is the part that matters, since the 401 channel below
 * only works if the browser lets us read the status. The public deployment has not got it yet.
 *
 * So which route works is a property of the deployment, and it is not knowable in advance: a
 * browser reports a CORS refusal as an opaque `TypeError` indistinguishable from a dead host.
 * `routesForServer` offers the candidates and this module *tries* them, remembering per
 * deployment which one answered. Same trade, same reasoning, and deliberately the same shape as
 * `data/precomputed/transport.ts`, which has always done this for the mesh buckets.
 */

import { getToken, reportAuthFailure } from './credentials'
import type { CypherResponse } from './decode'
import type { Route, RouteKind } from './servers'
import { normaliseServer, routesForServer } from './servers'
import { errorMessage } from '../../core/errors'
import { readStorage, writeStorage } from '../localStore'

export class NeuPrintError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'NeuPrintError'
    this.status = status
  }
}

/** Everything a query needs to reach the server, resolved at call time. */
export interface RequestOptions {
  signal?: AbortSignal | undefined
  /**
   * Which deployment to talk to. Routes are worked out from it, best first.
   *
   * Absent means the default deployment — which is a real hazard rather than a convenience,
   * so `NeuPrintSource` passes it on every call: a site that forgets it does not fail, it
   * quietly queries Janelia's public server and returns plausible data from the wrong place.
   */
  server?: string | undefined
  /**
   * Fetch exactly this base and do not fall back. Used by the connection panel to test a
   * candidate, where trying somewhere else would report success for a wrong entry.
   */
  baseUrl?: string | undefined
  token?: string | undefined
}

const ROUTE_KEY = 'coda.neuprint.routes'

/**
 * Which route last answered, per deployment.
 *
 * Persisted, because without it every request in a session where the proxy is the working
 * route pays a failed cross-origin attempt first — and a CORS refusal costs a preflight, so
 * that is a real round trip per query rather than a branch.
 *
 * **Only a route that produced a 2xx is remembered.** A 404 is not evidence a route works: it
 * is what a static host answers for a proxy path nobody is serving, and remembering that would
 * pin a deployment to a route that cannot ever succeed. Not remembering merely costs a re-probe,
 * which is also what lets a deployment that gains CORS later stop being reached through a relay.
 */
const routeMemory = new Map<string, RouteKind>()
let memoryLoaded = false

function loadMemory(): void {
  if (memoryLoaded) return
  memoryLoaded = true
  const raw = readStorage(ROUTE_KEY)
  if (!raw) return
  try {
    for (const [server, kind] of Object.entries(JSON.parse(raw) as Record<string, RouteKind>)) {
      if (kind === 'direct' || kind === 'proxy') routeMemory.set(server, kind)
    }
  } catch {
    // Corrupt: start from scratch and re-probe.
  }
}

function rememberRoute(server: string, kind: RouteKind): void {
  loadMemory()
  if (routeMemory.get(server) === kind) return
  routeMemory.set(server, kind)
  writeStorage(ROUTE_KEY, JSON.stringify(Object.fromEntries(routeMemory)))
}

/** Drop what is known about how to reach a deployment, so the next request re-probes. */
export function forgetRoutes(server?: string): void {
  loadMemory()
  if (server) routeMemory.delete(normaliseServer(server))
  else routeMemory.clear()
  writeStorage(
    ROUTE_KEY,
    routeMemory.size ? JSON.stringify(Object.fromEntries(routeMemory)) : undefined,
  )
}

/** How each deployment is currently being reached. Surfaced by the Sources panel. */
export function neuPrintRoutes(): Record<string, RouteKind> {
  loadMemory()
  return Object.fromEntries(routeMemory)
}

/**
 * The routes to try, in order, with whatever answered last time first.
 *
 * The remembered route is preferred rather than used exclusively: if it has stopped working —
 * a dev server that is no longer running, a proxy that has gone away — the others are still
 * there. That costs nothing when the memory is right, which is the common case.
 */
function candidateRoutes(options: RequestOptions): {
  server: string
  routes: readonly Route[]
} {
  const server = normaliseServer(options.server)
  if (options.baseUrl) {
    return {
      server,
      routes: [
        { base: options.baseUrl, kind: options.baseUrl.startsWith('/') ? 'proxy' : 'direct' },
      ],
    }
  }
  loadMemory()
  const routes = routesForServer(options.server)
  const preferred = routeMemory.get(server)
  if (!preferred || routes.length < 2) return { server, routes }
  return {
    server,
    routes: [...routes].sort(
      (a, b) => Number(b.kind === preferred) - Number(a.kind === preferred),
    ),
  }
}

/**
 * What to do with a successful body.
 *
 * Everything neuPrint serves is JSON except the region meshes, which are OBJ text. Threading a
 * mode through here rather than writing a second transport is what keeps the token handling, the
 * 401 channel and — the one that cost a debugging round trip — the empty-404-means-no-proxy tell
 * in exactly one place.
 */
type BodyMode = 'json' | 'text'

async function request<T>(
  path: string,
  init: RequestInit,
  options: RequestOptions = {},
  mode: BodyMode = 'json',
): Promise<T> {
  const token = options.token ?? getToken()
  if (!token) {
    const message = 'No neuPrint token. Add one in Connections, in the toolbar.'
    reportAuthFailure(message)
    throw new NeuPrintError(message, 401)
  }

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', mode === 'text' ? '*/*' : 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')

  const { server, routes } = candidateRoutes(options)

  /*
   * Only a *thrown* fetch moves on to the next route, which is `transport.ts`'s rule and it is
   * load-bearing here too: a response of any status means the request plainly arrived, so a 404
   * means neuPrint said 404 rather than that this route is wrong. Retrying a status would also
   * send a second copy of a POST somewhere else, which for an endpoint that runs Cypher is not
   * a free thing to do.
   */
  let lastError: unknown
  for (const route of routes) {
    let response: Response
    try {
      response = await fetch(`${route.base}${path}`, {
        ...init,
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      // An AbortError is the scheduler cancelling; it must stay an AbortError so the run
      // machinery reports "cancelled" rather than "the server is down", and it must not be
      // answered by trying somewhere else.
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      lastError = error
      continue
    }
    if (response.ok) rememberRoute(server, route.kind)
    return await readResponse<T>(response, route, mode)
  }

  /*
   * Named by kind rather than by position: `candidateRoutes` may have put the remembered route
   * first, so `routes[1]` is not reliably the proxy. Both halves are stated because the fixes
   * are nothing alike — a deployment with no CORS needs a relay in front of it, an unproxied
   * path needs the dev server or a deploy that serves it — and neither can be told from the
   * other by a browser, which reports a refused cross-origin read and a dead host identically.
   */
  const fallback = routes.find((route) => route.kind === 'proxy')
  throw new NeuPrintError(
    `Could not reach neuPrint at ${server}. It could not be read cross-origin — the deployment ` +
      `may send no CORS headers, or may simply be down; a browser reports both the same way` +
      (fallback && fallback.base !== server
        ? `. ${fallback.base} did not answer either: in development that path comes from ` +
          `vite.config.ts, so it needs \`pnpm dev\` or \`pnpm preview\`, and a static deploy ` +
          `serves nothing there at all.`
        : `.`) +
      ` (${errorMessage(lastError)})`,
    0,
  )
}

/** Status handling, shared by every route so a failure reads the same whichever one produced it. */
async function readResponse<T>(response: Response, route: Route, mode: BodyMode): Promise<T> {
  if (response.status === 401 || response.status === 403) {
    const message = `neuPrint rejected the token (${response.status}). It may have expired — get a new one from neuprint.janelia.org/account.`
    reportAuthFailure(message)
    throw new NeuPrintError(message, response.status)
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300)
    /*
     * A 404 on a *same-origin* base means the request never left the machine serving this page:
     * nothing is proxying that path to neuPrint. Two tells, because the two hosts that produce
     * it answer differently — a vite server with no matching rule sends an empty body, and a
     * static host (GitHub Pages) sends its own HTML 404 page. Checking only for the empty body
     * is how a Pages deploy came to report `neuPrint returned 404: <!DOCTYPE html>…`, blaming a
     * server that never saw the request and sending people to look at their token.
     */
    if (
      response.status === 404 &&
      route.kind === 'proxy' &&
      route.base.startsWith('/') &&
      (!body || looksLikeHtml(body))
    ) {
      throw new NeuPrintError(
        `Nothing is serving ${route.base} — the request never reached neuPrint. That path has ` +
          `to be proxied: \`pnpm dev\` and \`pnpm preview\` proxy it via vite.config.ts, and a ` +
          `static deploy does not. Where the deployment sends CORS headers no proxy is needed ` +
          `at all; where it does not, put one in front and name it in Connections → Base URL.`,
        404,
      )
    }
    throw new NeuPrintError(`neuPrint returned ${response.status}: ${body}`, response.status)
  }
  return (mode === 'text' ? await response.text() : await response.json()) as T
}

/** A served error page rather than anything neuPrint would send: its own errors are JSON. */
function looksLikeHtml(body: string): boolean {
  return /^\s*<(!doctype|html)/i.test(body)
}

export function get<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { method: 'GET' }, options)
}

/** A GET whose body is not JSON. Region meshes are OBJ; nothing else here uses it. */
export function getText(path: string, options?: RequestOptions): Promise<string> {
  return request<string>(path, { method: 'GET' }, options, 'text')
}

/**
 * Run Cypher against a dataset.
 *
 * neuPrint's custom endpoint takes no parameter map, so values are inlined by the builders
 * in `cypher.ts` — which is why everything that reaches a query goes through `escapeString`
 * or `numberList` there.
 */
export function runCypher(
  cypher: string,
  dataset: string,
  options?: RequestOptions,
): Promise<CypherResponse> {
  return request<CypherResponse>(
    '/api/custom/custom',
    { method: 'POST', body: JSON.stringify({ cypher, dataset }) },
    options,
  )
}

export interface RawDatasetEntry {
  description?: string
  info?: string
  uuid?: string
  ROIs?: string[]
  superLevelROIs?: string[]
  hidden?: string | boolean
  'last-mod'?: string
}

export function fetchDatasets(
  options?: RequestOptions,
): Promise<Record<string, RawDatasetEntry>> {
  return get<Record<string, RawDatasetEntry>>('/api/dbmeta/datasets', options)
}

/**
 * Escape a dataset id for a path segment, but leave the colon alone.
 *
 * Every dataset is named `hemibrain:v1.2.1`, and neuPrint's router matches the raw segment:
 * percent-encoding the colon gets a 400 ("no store found supporting the datatype and
 * dataset"). A colon is a legal path character per RFC 3986, so this is correctness rather
 * than a workaround.
 */
export function datasetSegment(dataset: string): string {
  return encodeURIComponent(dataset).replace(/%3A/gi, ':')
}

/**
 * A cached, whole-dataset summary endpoint.
 *
 * The dataset travels as a **query parameter**, and it is required rather than optional for a
 * reason that costs nothing to honour and is very expensive to discover: omitting it does not
 * fail. neuPrint answers 200 with a well-formed body describing whatever database the
 * deployment happens to default to — `optic-lobe` on Janelia's — so a call that forgot the
 * dataset returns plausible numbers about the wrong connectome. Same failure mode as a query
 * that forgets its base URL, and the same answer: make it impossible to leave out.
 *
 * `URLSearchParams` is correct here, unlike in a path segment. `datasetSegment` exists because
 * neuPrint's *router* matches a raw colon and 400s on `%3A`; in a query string both forms are
 * accepted identically, which was checked rather than assumed.
 */
function cached<T>(endpoint: string, dataset: string, options?: RequestOptions): Promise<T> {
  const query = new URLSearchParams({ dataset })
  return get<T>(`/api/cached/${endpoint}?${query.toString()}`, options)
}

/** Per-ROI traced-vs-total synapse counts, in neuPrint's `{columns, data}` shape. */
export function fetchRoiCompleteness(
  dataset: string,
  options?: RequestOptions,
): Promise<CypherResponse> {
  return cached<CypherResponse>('roicompleteness', dataset, options)
}

/**
 * Region-to-region connectivity.
 *
 * Its own shape rather than `{columns, data}`: a name list plus a map keyed `"A=>B"`.
 */
export interface RoiConnectivityResponse {
  roi_names?: string[]
  weights?: Record<string, { count?: number; weight?: number }>
}

export function fetchRoiConnectivity(
  dataset: string,
  options?: RequestOptions,
): Promise<RoiConnectivityResponse> {
  return cached<RoiConnectivityResponse>('roiconnectivity', dataset, options)
}

/** SWC for one body, as `{columns: [rowId,x,y,z,radius,link], data}`. */
export function fetchSkeleton(
  dataset: string,
  bodyId: number,
  options?: RequestOptions,
): Promise<CypherResponse> {
  return get<CypherResponse>(
    `/api/skeletons/skeleton/${datasetSegment(dataset)}/${bodyId}`,
    options,
  )
}
