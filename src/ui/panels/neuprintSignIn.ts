/**
 * The neuPrint half of a popup sign-in: DatasetGateway's consent page, and what it hands back.
 *
 * The window machinery is `popupSignIn.ts`; what DSG is and why each constant is what it is lives
 * in `data/neuprint/signIn.ts`. Two things are specific to this end:
 *
 *  - **There is no lookup before the navigation**, the gateway being one fixed URL. The window is
 *    still opened on `about:blank` first, so the listener is installed before a consent that was
 *    already granted ("Don't ask again") posts its token and closes the window in one go.
 *  - **`"badorigin"` settles the sign-in with a sentence naming the site**, rather than falling to
 *    the closed-window poll, which would tell somebody they had closed a window they never touched.
 */

import {
  DSG_ORIGIN,
  dsgLoginUrl,
  fetchNeuPrintIdentity,
  readDsgMessage,
} from '../../data/neuprint/signIn'
import type { PopupPassThrough, SignIn } from './popupSignIn'
import { signInWithPopup } from './popupSignIn'

const CLOSED_MESSAGE =
  'The neuPrint sign-in window closed before a token arrived. If you cancelled on the consent ' +
  'page, sign in again when you are ready; otherwise paste a token from your neuPrint account ' +
  'page below.'

const BLOCKED_MESSAGE =
  'Your browser blocked the neuPrint sign-in window. Allow pop-ups for this page and try again, ' +
  'or paste a token below.'

/**
 * Sign in to neuPrint through DatasetGateway. `appOrigin` is the origin DSG is told this page is
 * served from — the real one unless a test says otherwise.
 *
 * **Call this synchronously from the click that asked for it** — see `signInWithPopup`.
 */
export function signInToNeuPrint({
  appOrigin = window.location.origin,
  ...passThrough
}: { appOrigin?: string } & PopupPassThrough = {}): Promise<SignIn> {
  return signInWithPopup({
    ...passThrough,
    target: () => ({
      url: dsgLoginUrl(appOrigin),
      origin: DSG_ORIGIN,
      identify: (token, signal) => fetchNeuPrintIdentity(token, { signal }),
    }),
    read: (data) => readDsgMessage(data, appOrigin),
    blockedMessage: BLOCKED_MESSAGE,
    closedMessage: CLOSED_MESSAGE,
  })
}
