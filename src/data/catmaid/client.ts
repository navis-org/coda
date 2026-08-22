/**
 * HTTP to CATMAID.
 *
 * The transport carries one fact that no other backend here has, and it decides the whole
 * module: **a browser cannot POST to a public CATMAID anonymously, and no amount of retrying
 * changes that.** CATMAID's core query endpoints are POST-only — `skeletons/connectivity`,
 * `annotations/query-targets`, `skeleton/neuronnames` — and Django's CSRF asks for two things a
 * page cannot supply. `Referer` is a forbidden header name, so `fetch` sends our own origin and
 * the trusted-origins check rejects it; the `csrftoken` cookie is `SameSite=Lax`, so it is never
 * sent cross-site at all. Both gates, closed, structurally.
 *
 * A token opens both at once, because DRF's token class runs *before* its session class and so
 * never reaches `enforce_csrf`. Verified against VFB's FAFB instance: a bogus token is answered
 * `Invalid token`, not `CSRF Failed`. `docs/catmaid_vfb.md` has the evidence and the upstream ask.
 *
 * **So the route is chosen rather than probed**, which is the deliberate departure from
 * `neuprint/client.ts` and `seaTable.ts`. Those two cannot tell a CORS refusal from a dead host —
 * a browser reports both as an opaque `TypeError` — so they try and remember. Here the governing
 * fact is known in advance: an anonymous POST *cannot* succeed direct, so issuing one to find out
 * is a request spent confirming something the protocol already says. Route memory still earns its
 * place for the case it was built for — a CATMAID that sends no CORS headers at all, which VFB's
 * does not but somebody's lab instance well might — and that case is still a thrown fetch.
 */

import { errorMessage } from '../../core/errors'
import type { RouteKind } from '../routeMemory'
import { makeRouteMemory } from '../routeMemory'
import type { CatmaidInstance } from './credentials'
import { basicAuthHeader, credentialsFor, reportAuthFailure } from './credentials'

/** Served by `vite.config.ts` under `pnpm dev`/`pnpm preview`, and by nothing in a static build. */
const PROXY_PREFIX = '/cm'

export class CatmaidError extends Error {
  /** HTTP status, or 0 for a failure that never got one — a refusal, or an unreachable host. */
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'CatmaidError'
    this.status = status
  }
}

const memory = makeRouteMemory('coda.catmaid.routes.v1')

/** Drop what is known about how to reach a host, so the next request re-probes. */
export function forgetCatmaidRoutes(): void {
  memory.forget()
}

/**
 * What a CATMAID endpoint takes: scalars, and lists that must be written **indexed**.
 *
 * `skeleton_ids[0]=16&skeleton_ids[1]=27`, never `skeleton_ids[]=16&skeleton_ids[]=27`. The
 * bracket form is what `/apis/` documents and it **silently returns only the last id** — not an
 * error, a short answer, which is the worst way for this to fail. Confirmed on
 * `skeletons/summary` and `skeletons/cable-length` over both methods, so it is the view rather
 * than the verb. The plain repeated form works on some endpoints and 400s on `review-status`.
 * Indexed is the only encoding that works everywhere, and it is what pymaid emits.
 */
export type CatmaidParams = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>

export function encodeParams(params: CatmaidParams): string {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      value.forEach((item, index) => out.set(`${key}[${index}]`, String(item)))
    } else {
      out.set(key, String(value as string | number | boolean))
    }
  }
  return out.toString()
}

/**
 * The URLs worth trying for one request, best first.
 *
 * **A POST with no token goes straight to the relay**, because direct cannot work: see the
 * module note. Everything else prefers direct, since the relay is slower and is served by
 * nothing in a published build.
 *
 * `hasToken` is specifically the **CATMAID token**, never basic auth. Only the token reaches
 * `CsrfBypassTokenAuthenticationMiddleware`, which is what sets Django's
 * `_dont_enforce_csrf_checks`; HTTP Basic satisfies the web server in front and leaves CSRF
 * exactly where it was. Conflating the two would send an anonymous POST direct on any instance
 * that happens to sit behind nginx auth, and it would be refused every time.
 */
function routesFor(
  server: string,
  path: string,
  query: string,
  post: boolean,
  hasToken: boolean,
): readonly { url: string; kind: RouteKind }[] {
  const origin = new URL(server).origin
  const suffix = `${path}${query ? `?${query}` : ''}`
  const proxy = {
    url: `${PROXY_PREFIX}/${encodeURIComponent(origin)}${suffix}`,
    kind: 'proxy' as const,
  }
  if (post && !hasToken) return [proxy]
  return memory.prefer(origin, [{ url: `${origin}${suffix}`, kind: 'direct' as const }, proxy])
}

export interface CatmaidRequestOptions {
  signal?: AbortSignal | undefined
  /** Override the configured credentials for this server. For tests and the panel's Test button. */
  credentials?: CatmaidInstance | undefined
}

/**
 * One request, over whichever route can carry it.
 *
 * `params` go in the query string for a GET and in a form-encoded body for a POST, which is what
 * CATMAID's views read either way — they take `request.GET` or `request.POST` by method, so the
 * same names work for both and the *only* thing the verb decides is which endpoints will answer.
 */
async function catmaidRequest<T>(
  server: string,
  path: string,
  params: CatmaidParams,
  post: boolean,
  options: CatmaidRequestOptions,
): Promise<T> {
  const credentials = options.credentials ?? credentialsFor(server)
  const token = credentials?.token
  const encoded = encodeParams(params)
  const origin = new URL(server).origin

  const headers: Record<string, string> = { Accept: 'application/json' }
  /*
   * Two independent credentials, and they are carried on two different headers **on purpose**.
   * CATMAID's own middleware explains why it does not use `Authorization` for its token: "to
   * prevent conflicts with, e.g., HTTP server basic authentication". So an instance behind nginx
   * basic auth sends both, and neither displaces the other.
   */
  if (token) headers['X-Authorization'] = `Token ${token}`
  const basic = basicAuthHeader(credentials)
  if (basic) headers.Authorization = basic
  if (post) headers['Content-Type'] = 'application/x-www-form-urlencoded'

  const init: RequestInit = post
    ? { method: 'POST', headers, body: encoded }
    : { method: 'GET', headers }

  let response: Response | undefined
  let answered: RouteKind | undefined
  let lastError: unknown
  for (const route of routesFor(server, path, post ? '' : encoded, post, Boolean(token))) {
    try {
      response = await fetch(route.url, {
        ...init,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      // An AbortError is the scheduler cancelling. It must stay an AbortError, and must never be
      // answered by issuing the request the cancellation was meant to stop.
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      lastError = error
      response = undefined
      continue
    }
    answered = route.kind
    // Only a 2xx is remembered: a 404 is what a static host answers for a relay path nobody
    // serves, and pinning that would outlive the day this deployment gains what it needs.
    if (response.ok) memory.remember(origin, route.kind)
    break
  }

  if (!response) {
    throw new CatmaidError(
      `Could not reach CATMAID at ${origin}. It could not be read cross-origin, or the host is ` +
        `down — a browser reports both the same way. (${errorMessage(lastError)})`,
    )
  }

  const text = await response.text()

  if (response.status === 401 || response.status === 403) {
    const message = refusalMessage(text, origin, Boolean(token), post)
    reportAuthFailure(message)
    throw new CatmaidError(message, response.status)
  }
  if (!response.ok) {
    /*
     * A 404 from the *relay* means nothing is serving that path, not that CATMAID said 404 — and
     * this backend meets it far more often than its neighbours, because an anonymous POST has no
     * route but the relay, which a published build serves with its own HTML 404 page. Left alone
     * it reads `CATMAID returned 404: <!DOCTYPE html>…`, blaming a server that never saw the
     * request. `neuprint/client.ts` diagnoses the same thing with its own copy of this; the
     * honest fix is one helper beside `routeMemory`, which is a change to three clients.
     */
    if (answered === 'proxy' && response.status === 404) {
      throw new CatmaidError(
        `Nothing is serving Coda's relay at ${PROXY_PREFIX}/, so an anonymous request to ` +
          `${origin} could not be sent. The relay comes from vite.config.ts, so \`pnpm dev\` ` +
          `and \`pnpm preview\` serve it and a published build does not. Adding a CATMAID ` +
          `token in Connections sends the request directly instead.`,
        response.status,
      )
    }
    throw new CatmaidError(
      `CATMAID returned ${response.status}: ${explain(text)}`,
      response.status,
    )
  }
  return JSON.parse(text) as T
}

/** A GET, which is every endpoint a public instance answers without a token. */
export function catmaidGet<T>(
  server: string,
  path: string,
  params: CatmaidParams = {},
  options: CatmaidRequestOptions = {},
): Promise<T> {
  return catmaidRequest<T>(server, path, params, false, options)
}

/** A POST, which needs a token or the dev relay. */
export function catmaidPost<T>(
  server: string,
  path: string,
  params: CatmaidParams = {},
  options: CatmaidRequestOptions = {},
): Promise<T> {
  return catmaidRequest<T>(server, path, params, true, options)
}

/**
 * What to say about a 401/403, which on this backend is usually not about the credential.
 *
 * The CSRF case is recognised from the body text, which is exactly what `reportAuthFailure`
 * exists to avoid — so it is bounded the way the Explore widget's refusal-matching is: it
 * **only softens wording**, never routing, and a real refusal still shows through unchanged. The
 * reason to bother is that the default reading of a 403 here sends somebody to check a token
 * that is not the problem, when the fix is a relay or a one-line change on the deployment.
 */
function refusalMessage(
  body: string,
  origin: string,
  hasToken: boolean,
  post: boolean,
): string {
  if (/CSRF Failed/i.test(body)) {
    return (
      `${origin} refused a POST because of Django's CSRF check, which a browser cannot satisfy: ` +
      `\`Referer\` is a forbidden header name and the CSRF cookie is SameSite=Lax. A CATMAID ` +
      `token bypasses it — add one in Connections — or run \`pnpm dev\`, whose relay does the ` +
      `CSRF handshake server-side. See docs/catmaid_vfb.md.`
    )
  }
  if (!hasToken && post) {
    return (
      `${origin} refused an unauthenticated request. Public CATMAID instances answer every GET ` +
      `anonymously but not a POST, and Coda needs POST for connectivity and neuron names. Add a ` +
      `token in Connections — the branch icon in the toolbar.`
    )
  }
  return (
    `${origin} rejected the token. CATMAID tokens are per-user and per-instance — check that ` +
    `this one was issued by this server.`
  )
}

/**
 * The readable part of a CATMAID error body.
 *
 * Its views answer in two shapes: DRF's `{"detail": …}` for a method or permission problem, and
 * CATMAID's own `{"error": …, "detail": <a full traceback>}` for anything raised inside a view.
 * The second is the one worth digging into and the one worth *truncating* — `detail` there is a
 * Python traceback several kilobytes long, and putting that in a node's error badge buries the
 * one line that says what went wrong.
 */
function explain(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 300)
  } catch {
    // Not JSON: a served HTML page, or nothing at all.
  }
  return body.slice(0, 300) || '(empty response)'
}
