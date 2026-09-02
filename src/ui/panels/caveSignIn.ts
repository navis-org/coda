/**
 * The window half of a CAVE sign-in: open a popup, wait for what it posts back.
 *
 * Separated from `data/cave/oauth.ts` along the line invariant 1 draws — that file is what is
 * true about CAVE, this one is what is true about a browser — and the split earns itself twice
 * over here, because everything below is about failure. The happy path is nine lines. What
 * takes the rest is that a login window has four ways to end and three of them are silent:
 *
 *  - **The browser refuses to open it.** `window.open` answers `null`, which is not an error
 *    anywhere and reads as nothing happening. The popup is therefore opened *first*, before the
 *    `auth_info` lookup that decides where to point it, because a window opened after an
 *    `await` is no longer inside the click that asked for it and every browser blocks it.
 *    Hence `about:blank` and then a navigation, rather than one call with the real URL.
 *  - **The user closes it.** Nothing is delivered and nothing is raised; the promise would
 *    simply never settle. So the handle is polled — the same answer neuroglancer's
 *    `monitorAuthPopupWindow` reaches.
 *  - **The flow ends somewhere that posts nothing.** middle_auth delivers the token from its
 *    callback page, and three exits never reach it: a missing session cookie ("Invalid Request,
 *    are third-party cookies enabled?"), a state that has expired, and an OAuth error. Each
 *    renders a page and stops. At the moment it happens this is indistinguishable from the case
 *    above — the window they are left looking at is one they will close — so the closed message
 *    is written for it, and the paste field stays on the panel as the way through.
 *  - **Something else posts a message.** `postMessage(msg, "*")` means the callback page will
 *    hand its token to whoever opened it, and by symmetry any page may post to us. Two checks,
 *    both required and neither sufficient: the event's `source` must be the window we opened
 *    (identity survives the navigation through Google), and its `origin` must be the auth
 *    service we discovered *before* opening it.
 *
 * Worth knowing about the case that *looks* like that third one and is not. A **first-ever
 * login** is diverted to a "choose a username" form before it finishes, which is the most
 * alarming thing a new user meets — an unexpected form is exactly when somebody closes the
 * window. It does deliver: the form posts back to a URL still carrying `new_account=true`, and
 * `register_choose_username_post` passes `template_name = None` for precisely that case, so the
 * flow falls through to the `postMessage`. Nor is a pending terms-of-service a dead end here:
 * that diversion fires only when `/authorize` is called with an explicit `tos_id`, which this
 * never passes. Both were read as dead ends once, and the copy that said so was wrong.
 *
 * Nothing here is reachable from jsdom — it has no popups and no cross-document messaging — so
 * `openWindow` is a seam and the flow was also walked in a real browser against
 * `global.daf-apis.com`.
 */

import { errorMessage } from '../../core/errors'
import type { CaveLoginService } from '../../data/cave/oauth'
import { discoverLoginService, fetchIdentity, readAuthMessage } from '../../data/cave/oauth'

/** Which way a sign-in ended, for a caller that says something different about each. */
export type CaveSignInFailure = 'blocked' | 'closed' | 'cancelled' | 'unreachable'

export class CaveSignInError extends Error {
  readonly kind: CaveSignInFailure
  constructor(kind: CaveSignInFailure, message: string) {
    super(message)
    this.name = 'CaveSignInError'
    this.kind = kind
  }
}

export interface CaveSignIn {
  /** middle_auth's login token — a seven-day credential, not a permanent API key. */
  token: string
  /** The Google account it was issued to, where the auth server would say. */
  email?: string
}

export interface CaveSignInOptions {
  /** The global server whose `auth_info` says where to sign in. */
  server: string
  signal?: AbortSignal
  /**
   * How the popup is opened. The default is the real one; a test passes a stand-in, because
   * jsdom's `window.open` is not implemented and answers `null` — which this code correctly
   * reports as a blocked popup, making every other path untestable without this seam.
   */
  openWindow?: (url: string) => Window | null
  /** How often the popup is asked whether it has been closed. */
  pollMs?: number
}

const CLOSED_MESSAGE =
  'The CAVE sign-in window closed before a token arrived. If it ended on an error page — a ' +
  'session that expired, or cookies your browser blocked — signing in again usually clears it. ' +
  'Otherwise paste a token from your CAVE account page below.'

const BLOCKED_MESSAGE =
  'Your browser blocked the CAVE sign-in window. Allow pop-ups for this page and try again, or ' +
  'paste a token below.'

/**
 * Sign in to a CAVE deployment, resolving with the token it hands back.
 *
 * **Call this synchronously from the click that asked for it.** The first thing it does is open
 * a window, and an `await` before that is what turns a sign-in into a pop-up warning.
 */
export async function signInToCave(options: CaveSignInOptions): Promise<CaveSignIn> {
  const { server, signal, pollMs = 400 } = options
  const openWindow = options.openWindow ?? ((url: string) => window.open(url, '_blank', POPUP))

  if (signal?.aborted) throw new CaveSignInError('cancelled', 'Sign-in cancelled.')

  const opened = openWindow('about:blank')
  if (!opened) throw new CaveSignInError('blocked', BLOCKED_MESSAGE)
  // Narrowed once. The handlers below are hoisted declarations, so each would otherwise have to
  // re-check a window that provably cannot be null past this line.
  const popup: Window = opened

  let service: CaveLoginService
  try {
    service = await discoverLoginService(server, signal ? { signal } : {})
  } catch (error) {
    popup.close()
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new CaveSignInError('cancelled', 'Sign-in cancelled.')
    }
    throw new CaveSignInError('unreachable', errorMessage(error))
  }

  const token = await new Promise<string>((resolve, reject) => {
    // First, so that `stop` can close over it. Everything it and the listeners below call is
    // declared underneath and reached only once this turn is over — the earliest a message can
    // arrive is a network round trip away, and the earliest tick is `pollMs`.
    const timer = setInterval(() => {
      if (!popup.closed) return
      stop()
      reject(new CaveSignInError('closed', CLOSED_MESSAGE))
    }, pollMs)

    const stop = () => {
      window.removeEventListener('message', onMessage)
      signal?.removeEventListener('abort', onAbort)
      clearInterval(timer)
    }

    function onMessage(event: MessageEvent) {
      // Both halves matter: `source` says this is the window we opened rather than any other
      // frame on the page, `origin` says the document in it is still the auth service rather
      // than somewhere it was navigated on to.
      if (event.source !== popup || event.origin !== service.origin) return
      const found = readAuthMessage(event.data)
      if (!found) return
      stop()
      resolve(found)
    }

    function onAbort() {
      stop()
      popup.close()
      reject(new CaveSignInError('cancelled', 'Sign-in cancelled.'))
    }

    window.addEventListener('message', onMessage)
    signal?.addEventListener('abort', onAbort)

    // Last, so that a page which answers instantly cannot post before anything is listening.
    popup.location.href = service.authorizeUrl
  })

  popup.close()
  const email = await fetchIdentity(service.apiBase, token, signal ? { signal } : {})
  return email ? { token, email } : { token }
}

/** Roughly middle_auth's own login window, which is a narrow column of Google's form. */
const POPUP = 'width=460,height=680,toolbar=no,menubar=no'
