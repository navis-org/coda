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
 *     at 500,000 rows and says so in a `warning` header — but its
 *     `Access-Control-Expose-Headers` lists only `WWW-Authenticate` and `column_names`, so that
 *     header is unreadable from a page. Truncation is therefore detected by *counting*:
 *     `CAVE_MAX_ROWS` rows back means the answer is probably not the whole answer. Callers that
 *     could plausibly reach it have to say so rather than hand back a quietly short table.
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
 * The materialization engine's hard result cap, and the reason anything counts rows.
 *
 * Not configurable and not ours: the server applies it and reports it in a header a browser
 * cannot read. Confirmed live — an unfiltered join on `flywire_fafb_public` v783 returned
 * exactly 500,000 rows with `warning: 201 - "Limited query to 500000 rows`.
 */
export const CAVE_MAX_ROWS = 500_000

/**
 * A result the size of the server's cap is not a result.
 *
 * The engine truncates at `CAVE_MAX_ROWS` and says so in a `warning` header its CORS policy does
 * not expose (see above), so a browser can only count. A short table is not a visible failure —
 * it is a dataset that silently lacks neurons or labels, and every query against it comes back
 * quietly wrong rather than broken.
 *
 * The caller supplies the *consequence* because that is the whole of what differs between them,
 * and it is the half a reader acts on: "the neuron index would be incomplete" sends somebody to a
 * different datastack, "these annotations would be incomplete" to a narrower table.
 */
export function refuseIfCapped(rows: number, table: string, consequence: string): void {
  if (rows < CAVE_MAX_ROWS) return
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
  if (!response.ok) throw new CaveError(`CAVE returned ${response.status}: ${explain(text)}`, response.status)
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
