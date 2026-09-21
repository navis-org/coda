/**
 * The window half of a popup sign-in: open a window, wait for what it posts back.
 *
 * Shared by CAVE (`caveSignIn.ts`) and neuPrint (`neuprintSignIn.ts`), whose auth services both
 * end a Google login by posting `{token}` to the opener. What differs between them — where the
 * window is pointed, and what counts as an answer — is passed in; what is here is what is true
 * about a browser, and it is nearly all about failure. A login window has four ways to end and
 * three of them are silent:
 *
 *  - **The browser refuses to open it.** `window.open` answers `null`, which is not an error
 *    anywhere and reads as nothing happening. The popup is therefore opened *first*, before any
 *    lookup that decides where to point it, because a window opened after an `await` is no longer
 *    inside the click that asked for it and every browser blocks it. Hence `about:blank` and then
 *    a navigation, rather than one call with the real URL — even where the URL is a constant,
 *    since the listener has to be installed before the page that may answer instantly is loaded.
 *  - **The user closes it.** Nothing is delivered and nothing is raised; the promise would simply
 *    never settle. So the handle is polled — the same answer neuroglancer's
 *    `monitorAuthPopupWindow` reaches.
 *  - **The flow ends somewhere that posts nothing.** An error page, a cancelled consent. At the
 *    moment it happens this is indistinguishable from the case above, so the caller's closed
 *    message is written for both, and the paste field stays on the panel as the way through.
 *  - **Something else posts a message.** Two checks, both required and neither sufficient: the
 *    event's `source` must be the window we opened (identity survives the navigation through
 *    Google), and its `origin` must be the one the caller named *before* the window was pointed.
 *
 * A service may also answer with a refusal rather than a token — DatasetGateway's `"badorigin"`.
 * That settles the sign-in with a sentence of the caller's rather than leaving it to the poll,
 * which would otherwise report it as the user closing the window.
 *
 * Nothing here is reachable from jsdom — it has no popups and no cross-document messaging — so
 * `openWindow` is a seam and each backend's flow was also walked in a real browser.
 */

import { errorMessage } from '../../core/errors'

/** Which way a sign-in ended, for a caller that says something different about each. */
type SignInFailure = 'blocked' | 'closed' | 'cancelled' | 'unreachable' | 'refused'

export class SignInError extends Error {
  readonly kind: SignInFailure
  constructor(kind: SignInFailure, message: string) {
    super(message)
    this.name = 'SignInError'
    this.kind = kind
  }
}

/** What a sign-in hands back. */
export interface SignIn {
  /** A seven-day credential for the service, not a permanent API key. */
  token: string
  /** The Google account it was issued to, where the service would say. */
  email?: string
}

/** Where to point the window, the one origin an answer may come from, and who a token is. */
interface PopupTarget {
  url: string
  /**
   * Held beside the URL rather than derived at the receiving end, because the check it exists
   * for — "is this `message` event the auth server or any other page on the internet?" — must
   * compare against something decided *before* the popup was pointed anywhere.
   */
  origin: string
  /**
   * The account a token belongs to — undefined where the service will not say. On the target
   * because it may need what finding the target found (CAVE's auth service).
   */
  identify: (token: string, signal: AbortSignal | undefined) => Promise<string | undefined>
}

/** What a message said: a token, a refusal to report as it stands, or nothing for us. */
type PopupReply = { token: string } | { refused: string } | undefined

export interface PopupSignInOptions {
  /**
   * Where to point the window, asked *after* it is open. May fetch — CAVE's does — and a failure
   * closes the window and settles as `unreachable`.
   */
  target: (signal: AbortSignal | undefined) => PopupTarget | Promise<PopupTarget>
  /** Read a message that passed both checks. */
  read: (data: unknown) => PopupReply
  /** What to say when the browser will not open the window. */
  blockedMessage: string
  /** What to say when the window closed with nothing delivered. */
  closedMessage: string
  signal?: AbortSignal | undefined
  /**
   * How the popup is opened. The default is the real one; a test passes a stand-in, because
   * jsdom's `window.open` is not implemented and answers `null` — which this code correctly
   * reports as a blocked popup, making every other path untestable without this seam.
   */
  openWindow?: ((url: string) => Window | null) | undefined
  /** How often the popup is asked whether it has been closed. */
  pollMs?: number | undefined
}

/** What a backend's sign-in passes through untouched. */
export type PopupPassThrough = Pick<PopupSignInOptions, 'signal' | 'openWindow' | 'pollMs'>

/**
 * Run a popup sign-in, resolving with the token it hands back and whose it is.
 *
 * **Call this synchronously from the click that asked for it.** The first thing it does is open
 * a window, and an `await` before that is what turns a sign-in into a pop-up warning.
 */
export async function signInWithPopup(options: PopupSignInOptions): Promise<SignIn> {
  const { signal, pollMs = 400 } = options
  const openWindow = options.openWindow ?? ((url: string) => window.open(url, '_blank', POPUP))

  if (signal?.aborted) throw cancelled()

  const opened = openWindow('about:blank')
  if (!opened) throw new SignInError('blocked', options.blockedMessage)
  // Narrowed once. The handlers below are hoisted declarations, so each would otherwise have to
  // re-check a window that provably cannot be null past this line.
  const popup: Window = opened

  let target: PopupTarget
  try {
    target = await options.target(signal)
  } catch (error) {
    popup.close()
    if (error instanceof DOMException && error.name === 'AbortError') throw cancelled()
    throw new SignInError('unreachable', errorMessage(error))
  }

  const token = await new Promise<string>((resolve, reject) => {
    // First, so that `stop` can close over it. Everything it and the listeners below call is
    // declared underneath and reached only once this turn is over — the earliest a message can
    // arrive is a network round trip away, and the earliest tick is `pollMs`.
    const timer = setInterval(() => {
      if (!popup.closed) return
      stop()
      reject(new SignInError('closed', options.closedMessage))
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
      if (event.source !== popup || event.origin !== target.origin) return
      const reply = options.read(event.data)
      if (!reply) return
      stop()
      if ('token' in reply) resolve(reply.token)
      else reject(new SignInError('refused', reply.refused))
    }

    function onAbort() {
      stop()
      popup.close()
      reject(cancelled())
    }

    window.addEventListener('message', onMessage)
    signal?.addEventListener('abort', onAbort)

    // Last, so that a page which answers instantly cannot post before anything is listening.
    popup.location.href = target.url
  }).finally(() => popup.close())

  const email = await target.identify(token, signal)
  return email ? { token, email } : { token }
}

function cancelled(): SignInError {
  return new SignInError('cancelled', 'Sign-in cancelled.')
}

/** Roughly a Google sign-in form's own width: a narrow column. */
const POPUP = 'width=460,height=680,toolbar=no,menubar=no'
