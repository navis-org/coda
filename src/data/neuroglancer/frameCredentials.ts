/**
 * Which of Coda's CAVE tokens a protected data server in Coda's own neuroglancer frame should be
 * sent — so somebody signed in to Coda is not asked to sign in again inside the card.
 *
 * Read by the frame's credentials provider (`src/ngframe/caveCredentials.ts`), which neuroglancer
 * asks per data server when a layer first needs it. The rule is the one neuroglancer's own
 * middleauth applies: a server's `/auth_info` names the login service it trusts, and a token is
 * for that server only if it came from that login service. Coda's credentials are kept per CAVE
 * deployment, so the deployment is asked the same question and the two answers compared — a
 * server trusting some other login service never receives this token.
 *
 * Compared as `/auth_info` answers, untrimmed (`readLoginUrl`): both sides come from the same
 * kind of document, and neuroglancer keys its own storage by that exact string.
 */

import { listCredentials } from '../cave/credentials'
import type { CaveCredential } from '../cave/credentials'
import { readLoginUrl } from '../cave/oauth'
import { memoPromise } from '../memoPromise'

/** A token for a data server, and the login service it is from. */
export interface ServerToken {
  token: string
  login: string
}

export async function codaTokenFor(
  origin: string,
  loginUrl: (server: string) => Promise<string | undefined> = askedLoginUrl,
  credentials: readonly CaveCredential[] = listCredentials(),
): Promise<ServerToken | undefined> {
  if (credentials.length === 0) return undefined
  const [login, ...logins] = await Promise.all([
    loginUrl(origin),
    ...credentials.map((c) => loginUrl(c.server)),
  ])
  if (!login) return undefined
  const at = logins.indexOf(login)
  return at === -1 ? undefined : { token: credentials[at]!.token, login }
}

/** Each server asked once per document; a server that does not answer has no token sent to it. */
const asked = new Map<string, Promise<string | undefined>>()

function askedLoginUrl(server: string): Promise<string | undefined> {
  return memoPromise(asked, server, () => readLoginUrl(server), { keep: 'resolved' }).catch(
    () => undefined,
  )
}
