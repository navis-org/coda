/**
 * HTTP to neuPrint.
 *
 * **There is no direct browser access.** neuPrint sends no `Access-Control-*` headers on
 * any response, and its `OPTIONS` preflight returns 401 before CORS middleware would run —
 * so a request carrying an `Authorization` header is blocked by the browser before it is
 * ever sent. Every request here therefore goes through a same-origin proxy. In development
 * that is the `/neuprint` rule in `vite.config.ts`; a deployed build needs its own, which
 * is what `setBaseUrl` is for. Point the base URL straight at `https://neuprint.janelia.org`
 * and nothing will work, no matter how valid the token is.
 */

import { getBaseUrl, getToken, reportAuthFailure } from './credentials'
import type { CypherResponse } from './decode'
import { errorMessage } from '../../core/errors'

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
  /** Overrides the stored base URL. Used by the connection panel to test a candidate. */
  baseUrl?: string | undefined
  token?: string | undefined
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
  const base = options.baseUrl ?? getBaseUrl()
  const token = options.token ?? getToken()
  if (!token) {
    const message = 'No neuPrint token. Add one in Sources (⌘, or the toolbar).'
    reportAuthFailure(message)
    throw new NeuPrintError(message, 401)
  }

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', mode === 'text' ? '*/*' : 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')

  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // An AbortError is the scheduler cancelling; it must stay an AbortError so the run
    // machinery reports "cancelled" rather than "the server is down".
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new NeuPrintError(
      `Could not reach neuPrint at ${base}. In development this needs the /neuprint proxy — ` +
        `is the dev server running? (${errorMessage(error)})`,
      0,
    )
  }

  if (response.status === 401 || response.status === 403) {
    const message = `neuPrint rejected the token (${response.status}). It may have expired — get a new one from neuprint.janelia.org/account.`
    reportAuthFailure(message)
    throw new NeuPrintError(message, response.status)
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300)
    /*
     * A 404 with an empty body on a same-origin base means the request never left the local
     * server: nothing is proxying `base` to neuPrint. neuPrint's own errors always carry a
     * JSON body, so the empty body is the tell. Reporting this as "neuPrint returned 404"
     * blames the wrong machine and sends people looking at their token.
     */
    if (response.status === 404 && !body && base.startsWith('/')) {
      throw new NeuPrintError(
        `Nothing is serving ${base} — the request never reached neuPrint. That path has to be ` +
          `proxied: run \`pnpm dev\` (or \`pnpm preview\`), which proxies it via vite.config.ts. ` +
          `If the app is served some other way, set Sources → Server to your own proxy.`,
        404,
      )
    }
    throw new NeuPrintError(`neuPrint returned ${response.status}: ${body}`, response.status)
  }
  return (mode === 'text' ? await response.text() : await response.json()) as T
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
  return get<CypherResponse>(`/api/skeletons/skeleton/${datasetSegment(dataset)}/${bodyId}`, options)
}
