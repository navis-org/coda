/**
 * Coda's CAVE tokens, offered to neuroglancer as its credentials for a protected data server — the
 * `middleauthapp` provider, replaced in this frame by one that tries Coda's token first.
 *
 * Neuroglancer asks a provider per data server, when a layer first needs it, so this is where the
 * token belongs: nothing is written into neuroglancer's storage, nothing waits at boot, and a scene
 * that needs another server later just asks again. Registered before `setupDefaultViewer`, which
 * copies the registry into the viewer it builds; the last registration for a key wins.
 *
 * Neuroglancer's own provider stays underneath and takes over where Coda has nothing to offer:
 *  - no Coda token for the server's login service (`codaTokenFor`);
 *  - Coda's token refused — a refusal comes back here as a request for fresh credentials, and the
 *    answer is neuroglancer's own sign-in, never Coda's token again (which would be refused again).
 * One exception: a terms-of-service form accepted after a refusal is a reason to try Coda's token
 * once more, since accepting the terms is what the refusal was about.
 */

import type {
  CredentialsManager,
  CredentialsWithGeneration,
} from 'neuroglancer/unstable/credentials_provider/index.js'
import {
  CredentialsProvider,
  makeCachedCredentialsGetter,
} from 'neuroglancer/unstable/credentials_provider/index.js'
import { registerDefaultCredentialsProvider } from 'neuroglancer/unstable/credentials_provider/default_manager.js'
import type { OAuth2Credentials } from 'neuroglancer/unstable/credentials_provider/oauth2.js'
import type { MiddleAuthToken } from 'neuroglancer/unstable/kvstore/middleauth/credentials_provider.js'
import { MiddleAuthAppCredentialsProvider } from 'neuroglancer/unstable/kvstore/middleauth/credentials_provider.js'
import type { HttpError } from 'neuroglancer/unstable/util/http_request.js'

import { codaTokenFor } from '../data/neuroglancer/frameCredentials'

/** Coda's token, as neuroglancer's middleauth spells a token — marked so a refusal can tell. */
type Offered = MiddleAuthToken & { coda?: true }

class CodaCaveCredentialsProvider extends CredentialsProvider<Offered> {
  private readonly origin: string
  private readonly stock: MiddleAuthAppCredentialsProvider
  /** Coda's token was refused here: neuroglancer's own sign-in from now on. */
  private refused = false
  /** Terms accepted after a refusal of Coda's token: worth trying it once more. */
  private retry = false
  private generation = 0

  constructor(origin: string, manager: CredentialsManager) {
    super()
    this.origin = origin
    this.stock = this.registerDisposer(new MiddleAuthAppCredentialsProvider(origin, manager))
  }

  get = makeCachedCredentialsGetter<Offered>(async (invalid, options) => {
    const ours = invalid?.credentials.coda === true
    if (ours && !this.retry) this.refused = true
    this.retry = false
    if (!this.refused) {
      const held = await codaTokenFor(this.origin)
      if (held) {
        return {
          generation: ++this.generation,
          credentials: {
            tokenType: 'Bearer',
            accessToken: held.token,
            url: held.login,
            appUrls: [this.origin],
            coda: true,
          },
        }
      }
    }
    // Neuroglancer's own: its stored token, or its sign-in. Its refusal is passed on; ours is not
    // its business.
    return this.stock.get(
      ours ? undefined : (invalid as CredentialsWithGeneration<MiddleAuthToken>),
      options,
    )
  })

  override errorHandler = async (
    error: HttpError,
    credentials: OAuth2Credentials,
  ): Promise<'refresh'> => {
    const answer = await this.stock.errorHandler(error, credentials)
    // The stock handler shows a terms-of-service form for a 403 and answers "refresh" once it is
    // accepted — about the terms, not the token.
    if ((credentials as Offered).coda && error.status === 403) this.retry = true
    return answer
  }
}

/** Put Coda's provider in front of neuroglancer's for every protected data server. */
export function registerCaveCredentials(): void {
  registerDefaultCredentialsProvider(
    'middleauthapp',
    (origin: string, manager: CredentialsManager) =>
      new CodaCaveCredentialsProvider(origin, manager),
  )
}
