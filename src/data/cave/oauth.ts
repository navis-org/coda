/**
 * Signing in to CAVE with Google, from a page nobody registered.
 *
 * CAVE's auth is seung-lab's `middle_auth`, and it already answers the question a static app
 * has to ask: **how does a browser get a token without a client secret and without an origin
 * anybody had to approve?** The answer is that middle_auth is the OAuth client — it holds
 * Google's secret, it owns the redirect URI — and it hands the result to whoever opened the
 * window. Its callback renders a page whose whole body is
 * `window.opener.postMessage({token, app_urls}, "*")`. There is no allowlist on that `"*"`, so
 * the flow works from `localhost`, from a Pages deploy and from a fork, with nothing to
 * register and no secret to ship. Neuroglancer — a static app in the same position — does
 * exactly this.
 *
 * The half of it that touches a window lives in `ui/panels/caveSignIn.ts`, because a popup is a
 * gesture rather than a fetch and `src/data` has to stay runnable with no DOM at all. What is
 * here is everything that is *about CAVE*: where a deployment logs in, what counts as a token
 * arriving, and who it belongs to.
 *
 * Three things measured against the live services, September 2026, because each decides a line
 * below:
 *
 *  - **The path is per deployment and must be discovered.** `global.daf-apis.com` serves
 *    middle_auth under `/sticky_auth`, not the `/auth` that CAVEclient's documentation and this
 *    panel's own help link still name — `/auth/api/v1/authorize` is a 404 there, while
 *    `/auth/api/v1/create_token` redirects to `/sticky_auth/…`. So the prefix is read from
 *    `GET {global server}/auth_info`, which every CAVE info service publishes (`ACAO: *`, no
 *    token needed), rather than assumed. A 401 body's `WWW-Authenticate` realm names the same
 *    URL and is exposed cross-origin too, so there is a second source if this one ever goes:
 *    deliberately not read here, because a sign-in must be reachable *before* anything fails.
 *  - **Every auth API endpoint reflects an arbitrary `Origin`**, with
 *    `Access-Control-Allow-Credentials: true` and `WWW-Authenticate` exposed. Confirmed with a
 *    preflight from a github.io origin. So `fetchIdentity` is a plain cross-origin GET.
 *  - **The token this returns is a login token, not an API key**, and middle_auth issues those
 *    with a seven-day expiry. Coda stores it as it arrives and signs in again when it is
 *    refused — see `credentials.ts`. The alternative was to mint a permanent key through
 *    `create_token`, which would put a credential that never expires in `localStorage` and
 *    leave a row on the user's CAVE account that Coda would then be responsible for.
 */

import { fetchText } from '../fetchText'
import { parseCaveJson } from './json'

/** Where a deployment logs in: one document's worth of discovery, in the shapes callers need. */
export interface CaveLoginService {
  /** `…/api/v1` — the base every authenticated auth call hangs off. */
  apiBase: string
  /** The page a popup is pointed at, which is where Google is entered and left. */
  authorizeUrl: string
  /**
   * The one origin a token may arrive from.
   *
   * Held beside the URLs rather than derived at the receiving end, because the check it exists
   * for — "is this `message` event the auth server or is it any other page on the internet?" —
   * must compare against something computed *before* the popup was opened.
   */
  origin: string
}

/** An absolute `http(s)` URL with its trailing slashes gone, or undefined for anything else. */
function absoluteUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/\/+$/, '')
  if (!text) return undefined
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask a global server where it logs in.
 *
 * Through `fetchText`, which is the one thing here that tells an unreachable host from a
 * cross-origin refusal — a browser reports the two identically, and this is a GET to a host the
 * user named, so both are live possibilities. It is also why a caller's `signal` had to reach
 * that function: signing in is abandonable, and an abort must not read as a dead deployment.
 *
 * `auth_info` is the info service's own answer to this question — it is what neuroglancer reads
 * to find the auth server for a protected source — and it is unauthenticated, which is the
 * property that matters: signing in cannot be gated on a request that needs the token you do
 * not have yet.
 *
 * A deployment that does not answer it is one Coda cannot sign in to, and that is reported
 * rather than guessed at. Appending `/sticky_auth` because today's deployment uses it would
 * make the next deployment's failure a wrong password rather than a missing endpoint.
 */
export async function discoverLoginService(
  globalServer: string,
  options: { signal?: AbortSignal } = {},
): Promise<CaveLoginService> {
  const base = globalServer.trim().replace(/\/+$/, '')
  const url = `${base}/auth_info`
  const text = await fetchText(url, {
    hint: 'Signing in needs that document; you can paste a token instead.',
    notFound:
      'This deployment publishes no login service, so it cannot be signed in to. Paste a ' +
      'token instead.',
    ...(options.signal ? { signal: options.signal } : {}),
  })

  let info: { login_url?: unknown }
  try {
    info = parseCaveJson<{ login_url?: unknown }>(text)
  } catch {
    throw new Error(`${url} did not answer JSON, so this deployment cannot be signed in to.`)
  }

  const loginUrl = absoluteUrl(info.login_url)
  if (!loginUrl) {
    throw new Error(
      `${url} named no login service, so this deployment cannot be signed in to. Paste a token ` +
        `instead.`,
    )
  }

  return {
    apiBase: `${loginUrl}/api/v1`,
    authorizeUrl: `${loginUrl}/api/v1/authorize`,
    origin: new URL(loginUrl).origin,
  }
}

/**
 * The token in a `message` from the auth server, or undefined for anything that is not one.
 *
 * Deliberately a *reader* rather than a guard returning a boolean: the caller has one thing to
 * do with this event and it is take the token out, so a shape check that hands back nothing
 * would be checked once and then indexed again anyway.
 *
 * It has real work to do, because the login window posts more than one kind of message. The
 * terms-of-service arm of middle_auth posts the bare string `"success"`, which is not a token
 * and would otherwise be stored as one; and `"*"` means anything at all may post here, so the
 * shape check is the second half of a test whose first half is the origin.
 */
export function readAuthMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const token = (data as { token?: unknown }).token
  if (typeof token !== 'string') return undefined
  const trimmed = token.trim()
  return trimmed || undefined
}

/**
 * Which account a token belongs to, or undefined if the server would not say.
 *
 * Worth a request of its own for a reason that is the whole shape of this feature: a user may
 * hold one Google account for CAVE and another for neuPrint, and a token is otherwise 32
 * characters that look like every other token. Showing the email back is how somebody sees they
 * signed in as the wrong person.
 *
 * **Degrades to silence rather than failing the sign-in.** The token is already in hand and
 * already works; not being able to put a name on it is a worse label, not a failure.
 */
export async function fetchIdentity(
  apiBase: string,
  token: string,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  try {
    const response = await fetch(`${apiBase}/user/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return undefined
    const info = parseCaveJson<{ email?: unknown }>(await response.text())
    return typeof info.email === 'string' && info.email.trim() ? info.email.trim() : undefined
  } catch {
    return undefined
  }
}
