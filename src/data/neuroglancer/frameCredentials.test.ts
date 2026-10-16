/**
 * Which of Coda's CAVE tokens a data server in Coda's own neuroglancer frame is sent. The quiet
 * failure worth pinning is a token sent to a server that trusts some other login service.
 */

import { describe, expect, it } from 'vitest'

import type { CaveCredential } from '../cave/credentials'
import { codaTokenFor } from './frameCredentials'

const LOGIN = 'https://global.daf-apis.com/sticky_auth'
const GLOBAL = 'https://global.daf-apis.com'
const FLYWIRE = 'https://prod.flywire-daf.com'

/** `/auth_info` as a table of who logs in where; anything not listed does not answer. */
const logins =
  (table: Record<string, string>) =>
  (server: string): Promise<string | undefined> =>
    Promise.resolve(table[server])

const held = (...rows: Array<[string, string]>): CaveCredential[] =>
  rows.map(([server, token]) => ({ server, token }))

describe('the token a data server is sent', () => {
  it('is the token of the deployment whose login service the server trusts', async () => {
    const answer = await codaTokenFor(
      FLYWIRE,
      logins({
        [FLYWIRE]: LOGIN,
        [GLOBAL]: LOGIN,
        'https://other.org': 'https://other.org/auth',
      }),
      held(['https://other.org', 'other-token'], [GLOBAL, 'coda-token']),
    )
    expect(answer).toEqual({ token: 'coda-token', login: LOGIN })
  })

  it('is none for a server trusting a login service Coda holds no token from', async () => {
    const answer = await codaTokenFor(
      'https://x.org',
      logins({ 'https://x.org': 'https://x.org/auth', [GLOBAL]: LOGIN }),
      held([GLOBAL, 'coda-token']),
    )
    expect(answer).toBeUndefined()
  })

  it('is none for a server that does not say, and none without credentials', async () => {
    expect(
      await codaTokenFor(FLYWIRE, logins({ [GLOBAL]: LOGIN }), held([GLOBAL, 'coda-token'])),
    ).toBeUndefined()
    expect(await codaTokenFor(FLYWIRE, logins({ [FLYWIRE]: LOGIN }), [])).toBeUndefined()
  })
})
