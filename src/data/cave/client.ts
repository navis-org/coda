/**
 * HTTP to CAVE.
 *
 * Much smaller than its neuPrint counterpart, and the reason is worth stating rather than
 * leaving as an absence: **every CAVE service Coda calls answers a browser directly.** Probed
 * with a browser-shaped `Origin` and no cookie against `global.daf-apis.com` and
 * `prod.flywire-daf.com` — `Access-Control-Allow-Origin` reflects the origin or is `*`, and it
 * is present on the 401 as well, which is what makes `reportAuthFailure` work at all. So there
 * is no route probing, no proxy, no per-deployment memory: a URL is fetched as given.
 *
 * The transport carries two CAVE-specific facts that a naive `fetch` + `res.json()` gets wrong,
 * and both are silent:
 *
 *  1. **The body is read as text and parsed by `parseCaveJson`**, never by `response.json()`.
 *     `response.json()` is `JSON.parse` with extra steps, and that rounds every root id. See
 *     `json.ts`.
 *  2. **A capped query cannot announce itself to a browser.** The materialize API caps a result
 *     at a per-deployment row count and says so in a `warning` header — but its
 *     `Access-Control-Expose-Headers` lists only `WWW-Authenticate` and `column_names`, so that
 *     header is unreadable from a page. Truncation is therefore detected by *counting*, against
 *     the server's own `COUNT` of the same query (`api.ts`'s `countTable`) rather than against a
 *     constant — see `refuseIfCapped` for what the constant got wrong. Callers that could
 *     plausibly reach it have to say so rather than hand back a quietly short table.
 */

import { errorMessage } from '../../core/errors'
import { parseCaveJson } from './json'
import { getToken, reportAuthFailure } from './credentials'

export class CaveError extends Error {
  /** HTTP status, or 0 for a failure that never got one — a refusal, or an unreachable host. */
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'CaveError'
    this.status = status
  }
}

/**
 * The result cap **one** deployment applies. A fallback, not a fact about CAVE.
 *
 * It reads as a constant and it is not: `QUERY_LIMIT_SIZE` is the materialization engine's own
 * config, defaulting to 200,000, and each deployment sets it. Measured, same day, same request
 * shape — `prod.flywire-daf.com` truncated `hierarchical_neuron_annotations` at exactly 500,000
 * with `warning: 201 - "Limited query to 500000 rows`, while `cave.fanc-fly.com` answered all
 * **1,994,371** rows of BANC's `codex_annotations` with no warning at all.
 *
 * So it survives only as the tell of last resort, for when the count `refuseIfCapped` wants
 * could not be had. Nothing should read it as "how many rows CAVE returns".
 */
export const CAVE_MAX_ROWS = 500_000

/**
 * A result short of what the server says the query holds is a truncated result.
 *
 * The engine truncates silently as far as a browser is concerned: it says so in a `warning`
 * header whose `Access-Control-Expose-Headers` lists only `WWW-Authenticate` and `column_names`
 * (see above). And a short table is not a visible failure — it is a dataset that quietly lacks
 * neurons or labels, and every query against it comes back confidently wrong rather than broken.
 * So something has to notice, and the only thing a page can see is how many rows arrived.
 *
 * **`total` is what makes that a test rather than a guess**, and it is the server's own `COUNT`
 * of the same query — see `countTable`. Comparing against `CAVE_MAX_ROWS` instead did both
 * halves of the wrong thing: it refused BANC's complete 1,994,371-row `codex_annotations` for
 * being *larger* than a cap that deployment does not apply, and it would wave through a
 * genuinely truncated read on any deployment configured below 500,000.
 *
 * Undefined `total` is the fallback, and it is deliberately the old, weaker rule: **exactly**
 * the cap, which is what a truncated FlyWire read looks like. Not `>=`. A result larger than the
 * cap is positive proof the cap did not apply.
 *
 * The caller supplies the *consequence* because that is the whole of what differs between them,
 * and it is the half a reader acts on: "the neuron index would be incomplete" sends somebody to a
 * different datastack, "these annotations would be incomplete" to a narrower table.
 */
export function refuseIfCapped(
  rows: number,
  total: number | undefined,
  table: string,
  consequence: string,
): void {
  if (total !== undefined) {
    if (rows >= total) return
    throw new CaveError(
      `CAVE returned ${rows.toLocaleString()} of "${table}"'s ${total.toLocaleString()} rows — ` +
        `its server caps a single query — so ${consequence}.`,
    )
  }
  if (rows !== CAVE_MAX_ROWS) return
  throw new CaveError(
    `CAVE truncated "${table}" at ${CAVE_MAX_ROWS.toLocaleString()} rows, so ${consequence}.`,
  )
}

export interface CaveRequestOptions {
  signal?: AbortSignal | undefined
  token?: string | undefined
}

/** One row of a CAVE query result: the API answers with an array of record objects. */
export type CaveRow = Record<string, string | number | boolean | null>

async function request<T>(
  url: string,
  init: RequestInit,
  options: CaveRequestOptions,
): Promise<T> {
  const token = options.token ?? getToken()
  if (!token) {
    const message = 'No CAVE token. Add one in Connections — the branch icon in the toolbar.'
    reportAuthFailure(message)
    throw new CaveError(message, 401)
  }

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // An AbortError is the scheduler cancelling. It must stay an AbortError, or the run
    // machinery reports "the server is down" for a run the user stopped.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new CaveError(
      `Could not reach CAVE at ${new URL(url).origin}. It could not be read cross-origin, or ` +
        `the host is down — a browser reports both the same way. (${errorMessage(error)})`,
    )
  }

  if (response.status === 401 || response.status === 403) {
    const message =
      `CAVE rejected the token (${response.status}). It may have expired, or it may not ` +
      `grant access to this datastack — check at ${new URL(url).origin}.`
    reportAuthFailure(message)
    throw new CaveError(message, response.status)
  }

  const text = await response.text()
  if (!response.ok)
    throw new CaveError(`CAVE returned ${response.status}: ${explain(text)}`, response.status)
  return parseCaveJson<T>(text)
}

/**
 * The readable part of a CAVE error body.
 *
 * Its services answer in three shapes and only one of them is a plain sentence: `{"error":…,
 * "message":…}` from the info service, `{"schema_errors":{…}}` from the query validator — which
 * is the one anybody building a request will meet, and it names the offending field — and an
 * HTML page from whatever is in front. Digging the first two out beats printing 300 characters
 * of JSON at somebody, and falling back to a truncated body beats printing nothing.
 */
function explain(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (typeof parsed.message === 'string') return parsed.message
    if (parsed.schema_errors) return `invalid query — ${JSON.stringify(parsed.schema_errors)}`
    if (typeof parsed.error === 'string') return parsed.error
  } catch {
    // Not JSON: an HTML error page, or nothing at all.
  }
  return body.slice(0, 300) || '(empty response)'
}

export function caveGet<T>(url: string, options: CaveRequestOptions = {}): Promise<T> {
  return request<T>(url, { method: 'GET' }, options)
}

export function cavePost<T>(
  url: string,
  body: unknown,
  options: CaveRequestOptions = {},
): Promise<T> {
  return request<T>(url, { method: 'POST', body: JSON.stringify(body) }, options)
}

/**
 * A POST whose body the caller has already written.
 *
 * For the one thing `JSON.stringify` cannot express: a list of **unquoted** integers too wide for
 * a double. `is_latest_roots` takes `node_ids` as integers, and a root id through
 * `JSON.stringify` of a `number` is a different neuron (invariant 8) — where quoting them is a
 * type the endpoint was not promised to accept. So the digits are spliced in as text, the same
 * answer `idList` gives for Cypher and `pyLongIntList` for the notebook.
 */
/**
 * A POST whose body and reply are both raw `uint64` arrays.
 *
 * `roots_binary` — what `caveclient.chunkedgraph.get_roots` calls — takes
 * `np.array(ids, dtype=np.uint64).tobytes()` and answers the same. It is the one CAVE endpoint
 * here that is not JSON, and for once that is the *easier* half of invariant 8: a
 * `BigUint64Array` holds a root id exactly, so nothing is parsed, rounded or quoted in either
 * direction. Little-endian on both sides, which is what numpy's native order and every platform
 * JavaScript runs on both are.
 *
 * Its own function rather than an option on `request`, which parses JSON unconditionally and
 * would have to grow a branch through every error path to do otherwise.
 */
export async function cavePostBinary(
  url: string,
  body: BigUint64Array,
  options: CaveRequestOptions = {},
): Promise<BigUint64Array> {
  const token = options.token ?? getToken()
  if (!token) {
    const message = 'No CAVE token. Add one in Connections — the branch icon in the toolbar.'
    reportAuthFailure(message)
    throw new CaveError(message, 401)
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: body.buffer as ArrayBuffer,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new CaveError(
      `Could not reach CAVE at ${new URL(url).origin}. It could not be read cross-origin, or ` +
        `the host is down — a browser reports both the same way. (${errorMessage(error)})`,
    )
  }
  if (response.status === 401 || response.status === 403) {
    const message = `CAVE rejected the token (${response.status}).`
    reportAuthFailure(message)
    throw new CaveError(message, response.status)
  }
  if (!response.ok) {
    throw new CaveError(`CAVE returned ${response.status}`, response.status)
  }
  const buffer = await response.arrayBuffer()
  // A partial word would silently truncate the last id rather than failing.
  if (buffer.byteLength % 8 !== 0) {
    throw new CaveError(`CAVE returned ${buffer.byteLength} bytes, which is not whole uint64s`)
  }
  return new BigUint64Array(buffer)
}

export function cavePostRaw<T>(
  url: string,
  body: string,
  options: CaveRequestOptions = {},
): Promise<T> {
  return request<T>(url, { method: 'POST', body }, options)
}
