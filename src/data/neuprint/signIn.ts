/**
 * Signing in to neuPrint with Google, through Janelia's DatasetGateway.
 *
 * neuPrint moved its accounts to DatasetGateway (DSG) in August 2026, and every neuPrint
 * deployment — production, `neuprint-test`, `-cns`, `-fish2` — validates against the one DSG at
 * `dsg.janelia.org`. So there is one token for all of them, which is what `credentials.ts` already
 * held, and nothing here is per deployment.
 *
 * The flow is middle_auth's shape (see `cave/oauth.ts`) with its one hole closed: DSG posts
 * `{token}` to the opener **only for an origin somebody registered with it**, and posts it with
 * that origin as the `targetOrigin` rather than `"*"`. Everything else was settled with Janelia and
 * checked against the live service, September 2026, because each point decides a line below:
 *
 *  - **No discovery step.** CAVE reads its login prefix from `auth_info` because it differs per
 *    deployment; here there is one gateway, so the URL is a constant and the popup can be pointed
 *    at it without a round trip first.
 *  - **The origin is exact.** `dsg.janelia.org` and `dataset-gateway.janelia.org` serve the same
 *    application from two origins, and a message is accepted from the one the popup was opened on.
 *  - **An unregistered origin gets `"badorigin"`**, a bare string, from a page that then closes
 *    itself. Read as "not a token" it would look exactly like the user closing the window, so it
 *    is its own answer — `readDsgMessage` — and the sentence names the site rather than the user.
 *    Registered: `https://coda.science` (the custom domain the Pages site redirects to, so the
 *    origin the deployed app really runs on), `https://navis-org.github.io` and
 *    `http://localhost:5173`. `127.0.0.1` is a different origin from `localhost`.
 *  - **What comes back is a seven-day DSG API key**, refused by DSG's own token management and
 *    account pages and never carrying admin. Stored as it arrives; signed in again on a 401.
 *  - **Cancelling the consent page posts nothing**, so it is the popup's closed-window case.
 *  - **"Don't ask again for this site"** makes a later sign-in deliver silently — the window opens
 *    and closes on its own. Grants are revoked at `dsg.janelia.org/web/my-account`.
 */

import { DEFAULT_SERVER } from './servers'
import { fetchSignedInEmail, readAuthMessage } from '../signIn'

/** The one DatasetGateway every neuPrint deployment validates against. */
export const DSG_ORIGIN = 'https://dsg.janelia.org'

/** Where a user sees, and revokes, the sites they have let sign them in. */
export const DSG_ACCOUNT_URL = `${DSG_ORIGIN}/web/my-account`

/**
 * The consent page, for a page served from `appOrigin`.
 *
 * `token=api` asks for the seven-day API key rather than a browser session: the key is what a
 * `Bearer` header to neuPrint takes, and the session cookie is `HttpOnly` on janelia.org anyway.
 */
export function dsgLoginUrl(appOrigin: string): string {
  return `${DSG_ORIGIN}/login?origin=${encodeURIComponent(appOrigin)}&token=api`
}

/**
 * Read a message posted by the gateway's delivery page, in the shape `signInWithPopup` takes.
 *
 * `"badorigin"` is a refusal rather than "not a token" because it is the one answer that is final:
 * the window has already closed itself, and signing in again from this site will get the same one.
 * Left as "not a token" it would reach the closed-window poll, which blames the user.
 */
export function readDsgMessage(
  data: unknown,
  appOrigin: string,
): { token: string } | { refused: string } | undefined {
  if (data === 'badorigin') {
    return {
      refused:
        `Janelia's sign-in service does not accept sign-ins from ${appOrigin}, so this copy of ` +
        `Coda cannot sign you in to neuPrint. Paste a token from your neuPrint account page ` +
        `below instead.`,
    }
  }
  const token = readAuthMessage(data)
  return token ? { token } : undefined
}

/**
 * Which account a token belongs to, from neuPrint's `/profile` — see `fetchSignedInEmail`.
 *
 * Asked of neuPrint rather than of the gateway: DSG's `whoami` sends no CORS headers, while
 * neuPrint's `/profile` answers `ACAO: *` on every deployment. Note the capital `E` — neuPrint's
 * shape, not CAVE's `/user/me`. Always the production host, because the token is the same
 * everywhere and that is the one deployment somebody signing in is sure to be able to reach.
 */
export function fetchNeuPrintIdentity(
  token: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<string | undefined> {
  return fetchSignedInEmail(`${DEFAULT_SERVER}/profile`, token, 'Email', options)
}
