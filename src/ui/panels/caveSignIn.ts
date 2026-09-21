/**
 * The CAVE half of a popup sign-in: where a deployment's window points, and what it hands back.
 *
 * The window machinery — opening before any `await`, the closed-window poll, the two checks on a
 * message — is `popupSignIn.ts`, shared with neuPrint. What is left here is what is true about
 * `middle_auth`:
 *
 *  - **Where to point the window is discovered**, from `auth_info`, once the window is already
 *    open. `middle_auth` posts to `"*"`, so the origin that lookup yields is the whole of what
 *    tells its message apart from any other page's.
 *  - **Three exits post nothing**: a missing session cookie ("Invalid Request, are third-party
 *    cookies enabled?"), a state that has expired, and an OAuth error. Each renders a page and
 *    stops, so the closed message is written for them.
 *
 * Worth knowing about the case that *looks* like one of those and is not. A **first-ever login**
 * is diverted to a "choose a username" form before it finishes, which is the most alarming thing
 * a new user meets — an unexpected form is exactly when somebody closes the window. It does
 * deliver: the form posts back to a URL still carrying `new_account=true`, and
 * `register_choose_username_post` passes `template_name = None` for precisely that case, so the
 * flow falls through to the `postMessage`. Nor is a pending terms-of-service a dead end here:
 * that diversion fires only when `/authorize` is called with an explicit `tos_id`, which this
 * never passes. Both were read as dead ends once, and the copy that said so was wrong.
 *
 * Walked in a real browser against `global.daf-apis.com`.
 */

import { readAuthMessage } from '../../data/signIn'
import { discoverLoginService, fetchIdentity } from '../../data/cave/oauth'
import type { PopupPassThrough, SignIn } from './popupSignIn'
import { signInWithPopup } from './popupSignIn'

const CLOSED_MESSAGE =
  'The CAVE sign-in window closed before a token arrived. If it ended on an error page — a ' +
  'session that expired, or cookies your browser blocked — signing in again usually clears it. ' +
  'Otherwise paste a token from your CAVE account page below.'

const BLOCKED_MESSAGE =
  'Your browser blocked the CAVE sign-in window. Allow pop-ups for this page and try again, or ' +
  'paste a token below.'

/**
 * Sign in to a CAVE deployment — `server` is the global server whose `auth_info` says where.
 *
 * **Call this synchronously from the click that asked for it** — see `signInWithPopup`.
 */
export function signInToCave({
  server,
  ...passThrough
}: { server: string } & PopupPassThrough): Promise<SignIn> {
  return signInWithPopup({
    ...passThrough,
    target: async (signal) => {
      const service = await discoverLoginService(server, signal ? { signal } : {})
      return {
        url: service.authorizeUrl,
        origin: service.origin,
        identify: (token, abort) => fetchIdentity(service.apiBase, token, { signal: abort }),
      }
    },
    read: (data) => {
      const token = readAuthMessage(data)
      return token ? { token } : undefined
    },
    blockedMessage: BLOCKED_MESSAGE,
    closedMessage: CLOSED_MESSAGE,
  })
}
