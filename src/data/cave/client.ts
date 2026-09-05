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
  /**
   * Refuse quietly: throw as usual, but keep a 401/403 off the global auth channel.
   *
   * For a request made **speculatively, about something nobody asked for**, whose failure the
   * caller has already decided to tolerate. `runListing` is the case that forced it: it asks
   * every specced datastack for its materializations so the dataset picker can offer them, and
   * catches each failure into an empty list — but the report had already fired, so a user with
   * no access to *one* of the three opened the Connections panel on every Run of a graph that
   * worked. Measured: `403` on `datastack/full/minnie65_public` beside `200` from FlyWire's and
   * BANC's.
   *
   * **Not a way to make a failure quieter in general.** A 401/403 on a request somebody's graph
   * is waiting for has to reach the panel — that is the whole of how a stale token gets
   * replaced. The test is whether the caller can carry on without an answer.
   *
   * One nuance where it meets a memo: `datastackRecord` shares an in-flight promise, so a loud
   * caller arriving while a quiet fetch is in flight inherits the silence. It is self-healing —
   * a rejected record is dropped, so the next loud caller re-asks and reports — and the
   * alternative, keying the memo on the flag, would issue the request twice to keep a message
   * that arrives one run later anyway.
   */
  quiet?: boolean | undefined
}

/** One row of a CAVE query result: the API answers with an array of record objects. */
export type CaveRow = Record<string, string | number | boolean | null>

async function request<T>(
  url: string,
  init: RequestInit,
  options: CaveRequestOptions,
): Promise<T> {
  const token = options.token ?? getToken()
  if (!token) refuseNoToken(options)

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

  const text = await response.text()
  // `text` is read *before* this branch because the refusal is in the body: the canned sentence
  // was being told to somebody whose token was fine and whose remedy was a terms page.
  if (response.status === 401 || response.status === 403)
    refuseAuth(url, response.status, text, options)

  if (!response.ok)
    throw new CaveError(`CAVE returned ${response.status}: ${explain(text)}`, response.status)
  return parseCaveJson<T>(text)
}

/**
 * Refuse a request on the credential: build the sentence, report it unless the caller is carrying
 * on without an answer, and throw.
 *
 * **One function because there were four sites and they had drifted.** `request` grew the
 * body-derived message and the `quiet` rule; `cavePostBinary` and `caveGetBytes` kept a canned
 * `CAVE rejected the token (403).` that neither read the body nor honoured `quiet` — so a
 * terms-gated *skeleton* fetch still told somebody to sign in again, which is the thing that
 * cannot work. The tokenless case was a third spelling, in all three functions, and it ignored
 * `quiet` too: a speculative caller had to gate on `getToken()` itself to avoid raising "No CAVE
 * token" at somebody who had only dragged a node onto the canvas.
 *
 * `never`, so a call site is a statement rather than a branch it has to remember to `throw` in.
 */
function refuseAuth(
  url: string,
  status: number,
  body: string,
  options: CaveRequestOptions,
): never {
  return refuse(authRefusal(url, status, body), status, options)
}

/**
 * The refusal for a request that was never sent, because there is no credential to send.
 *
 * Its own entry point rather than `refuseAuth` with an empty body: a server that answers `401`
 * with nothing in it is a different thing from never having asked, and inferring one from the
 * other tells somebody who *has* a token to go and add one.
 */
function refuseNoToken(options: CaveRequestOptions): never {
  return refuse(
    'No CAVE token. Add one in Connections — the branch icon in the toolbar.',
    401,
    options,
  )
}

/** Report unless the caller is carrying on without an answer, and throw either way. */
function refuse(message: string, status: number, options: CaveRequestOptions): never {
  if (!options.quiet) reportAuthFailure(message)
  throw new CaveError(message, status)
}

/**
 * What a 401 or 403 actually means, read off the body rather than assumed.
 *
 * `middle_auth_client` answers a `Bearer` request three distinguishable ways, and telling
 * somebody the wrong one costs them the fix. **`missing_tos`** is the one that was being
 * mistold: the account may view the dataset and has not agreed to its terms, and the body
 * carries the form that fixes it (`tos_form_url`, plus the terms' name) — so "your token may
 * have expired" sends somebody to sign in again, which cannot work and is exactly what was
 * reported. **`missing_permission`** is a group they are not in, where signing in again is
 * equally useless. Anything else falls back to the token, which is what a bare `401` from the
 * auth layer really is.
 *
 * A browser-shaped request gets a `302` to the terms form instead of any of this, which is why
 * it is never seen outside a programmatic client — and why this is read from the JSON rather
 * than from a status alone.
 */
function authRefusal(url: string, status: number, body: string): string {
  const parsed = parsedBody(body)
  const data = (parsed.data ?? {}) as Record<string, unknown>
  const dataset = typeof data.auth_dataset === 'string' ? data.auth_dataset : 'this dataset'

  if (parsed.error === 'missing_tos') {
    const name = typeof data.tos_name === 'string' ? data.tos_name : 'its terms of service'
    const form =
      typeof data.tos_form_url === 'string' ? ` — accept them at ${data.tos_form_url}` : ''
    return (
      `CAVE will not serve ${dataset} until you have accepted ${name}${form}. Your token is ` +
      `fine; signing in again will not help.`
    )
  }
  if (parsed.error === 'missing_permission') {
    return (
      `Your CAVE account is not permitted to read ${dataset} (${status} at ` +
      `${new URL(url).origin}). Your token is fine; this is a permission on the dataset, so ` +
      `signing in again will not help.`
    )
  }
  return (
    `CAVE rejected the token (${status}). It may have expired, or it may not ` +
    `grant access to this datastack — check at ${new URL(url).origin}.`
  )
}

/** A CAVE error body as an object, or an empty one — it is JSON on some paths and HTML on others. */
function parsedBody(body: string): Record<string, unknown> {
  try {
    return (JSON.parse(body) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
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
  const parsed = parsedBody(body)
  if (typeof parsed.message === 'string') return parsed.message
  if (parsed.schema_errors) return `invalid query — ${JSON.stringify(parsed.schema_errors)}`
  if (typeof parsed.error === 'string') return parsed.error
  // Not JSON: an HTML error page, or nothing at all.
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
  if (!token) refuseNoToken(options)
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
  if (response.status === 401 || response.status === 403)
    refuseAuth(url, response.status, await response.text(), options)
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

/**
 * A GET whose reply is bytes rather than JSON, or `undefined` where there is nothing there.
 *
 * The skeleton service is the one CAVE endpoint that answers a precomputed blob, and it answers
 * it under the same token every other call here carries — so this exists rather than reaching for
 * `precomputed/transport.ts`, which knows nothing about a token and would report a 401 as an
 * unreadable bucket instead of opening the Connections panel. `cavePostBinary`'s reasoning, one
 * verb over.
 *
 * **A 404 is an answer, not a failure.** A root id the cache has never been asked for is exactly
 * that, and one missing body must not fail a batch of five hundred — the same rule
 * `precomputed/skeletons.ts` states for a bucket.
 */
export async function caveGetBytes(
  url: string,
  options: CaveRequestOptions = {},
): Promise<ArrayBuffer | undefined> {
  const token = options.token ?? getToken()
  if (!token) refuseNoToken(options)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new CaveError(
      `Could not reach CAVE at ${new URL(url).origin}. It could not be read cross-origin, or ` +
        `the host is down — a browser reports both the same way. (${errorMessage(error)})`,
    )
  }
  if (response.status === 404) return undefined
  if (response.status === 401 || response.status === 403)
    refuseAuth(url, response.status, await response.text(), options)
  if (!response.ok) throw new CaveError(`CAVE returned ${response.status}`, response.status)
  return response.arrayBuffer()
}

export function cavePostRaw<T>(
  url: string,
  body: string,
  options: CaveRequestOptions = {},
): Promise<T> {
  return request<T>(url, { method: 'POST', body }, options)
}
