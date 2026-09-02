/**
 * What a CAVE sign-in knows before a window is involved.
 *
 * The window half is `ui/panels/caveSignIn.test.ts`; here it is the two facts that would be
 * wrong silently. Discovery must **not** assume a path — `/auth` is what CAVEclient's docs and
 * this app's own help link name, and `global.daf-apis.com` serves middle_auth under
 * `/sticky_auth` — so a deployment that will not say where it logs in has to be reported rather
 * than guessed at. And a message is not a token: the login window's terms-of-service arm posts
 * the bare string `"success"`, which stored as a credential would give somebody a session that
 * fails on its first query with no way to see why.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installRouteFetch } from '../../test/caveStubs'
import { discoverLoginService, fetchIdentity, readAuthMessage } from './oauth'

afterEach(() => {
  vi.unstubAllGlobals()
})

const AUTH_INFO = JSON.stringify({
  login_url: 'https://global.daf-apis.com/sticky_auth',
  supported_datastacks: [],
})

describe('discoverLoginService', () => {
  it('reads the prefix off auth_info rather than assuming one', async () => {
    const seen = installRouteFetch({ '/auth_info': { body: AUTH_INFO } })

    const service = await discoverLoginService('https://global.daf-apis.com')

    expect(seen).toEqual(['https://global.daf-apis.com/auth_info'])
    expect(service.authorizeUrl).toBe(
      'https://global.daf-apis.com/sticky_auth/api/v1/authorize',
    )
    expect(service.apiBase).toBe('https://global.daf-apis.com/sticky_auth/api/v1')
    // The origin is kept apart from the path: it is what the receiving end compares against,
    // and everything after the host is not part of that question.
    expect(service.origin).toBe('https://global.daf-apis.com')
  })

  it('tolerates trailing slashes on both the server and the answer', async () => {
    installRouteFetch({
      '/auth_info': { body: JSON.stringify({ login_url: 'https://a.example/auth/' }) },
    })

    const service = await discoverLoginService('https://a.example/')

    expect(service.authorizeUrl).toBe('https://a.example/auth/api/v1/authorize')
  })

  it('refuses a login_url that is not an absolute address', async () => {
    // The shape that would otherwise be concatenated into `/sticky_auth/api/v1/authorize`, a
    // relative URL a popup would resolve against *Coda's* origin.
    installRouteFetch({ '/auth_info': { body: JSON.stringify({ login_url: '/sticky_auth' }) } })

    await expect(discoverLoginService('https://a.example')).rejects.toThrow(/named no login/)
  })

  /*
   * Through `fetchText`, so the two failures stay apart: a deployment that answers but publishes
   * no login service is a different problem from one a browser could not read at all, and a
   * cross-origin refusal is reported identically to a dead host unless something says so.
   */
  it('tells a deployment with no login service from one it could not reach', async () => {
    installRouteFetch({})
    await expect(discoverLoginService('https://a.example')).rejects.toThrow(
      /publishes no login service/,
    )

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    await expect(discoverLoginService('https://a.example')).rejects.toThrow(
      /unreachable, or it may not allow cross-origin reads/,
    )
  })

  it('keeps a cancellation a cancellation rather than a dead host', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      // What `fetch` does with an already-aborted signal, which is the case a caller hits when
      // the panel is closed while the lookup is in flight.
      return init?.signal?.aborted
        ? Promise.reject(new DOMException('aborted', 'AbortError'))
        : Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('{}'),
          } as Response)
    })

    await expect(
      discoverLoginService('https://a.example', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses a deployment that answers something other than JSON', async () => {
    installRouteFetch({ '/auth_info': { body: '<html>login</html>' } })

    await expect(discoverLoginService('https://a.example')).rejects.toThrow(
      /did not answer JSON/,
    )
  })
})

describe('readAuthMessage', () => {
  it('takes the token out of a login message', () => {
    expect(readAuthMessage({ token: 'abc123', app_urls: ['https://x.example'] })).toBe('abc123')
  })

  it('is not fooled by the terms-of-service arm, which posts a bare string', () => {
    expect(readAuthMessage('success')).toBeUndefined()
  })

  it('ignores anything else that can reach a window listening for "*"', () => {
    expect(readAuthMessage(undefined)).toBeUndefined()
    expect(readAuthMessage(null)).toBeUndefined()
    expect(readAuthMessage({})).toBeUndefined()
    expect(readAuthMessage({ token: 42 })).toBeUndefined()
    expect(readAuthMessage({ token: '   ' })).toBeUndefined()
  })
})

describe('fetchIdentity', () => {
  it('names the account a token belongs to', async () => {
    installRouteFetch({
      '/user/me': { body: JSON.stringify({ id: 7, email: 'a@example.org' }) },
    })

    expect(await fetchIdentity('https://a.example/auth/api/v1', 'tok')).toBe('a@example.org')
  })

  it('sends the token as a bearer', async () => {
    let headers: Headers | undefined
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers)
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"email":"a@example.org"}'),
      } as Response)
    })

    await fetchIdentity('https://a.example/auth/api/v1', 'tok')

    expect(headers?.get('Authorization')).toBe('Bearer tok')
  })

  it('degrades to no name rather than failing a sign-in that worked', async () => {
    installRouteFetch({ '/user/me': { status: 403, body: 'nope' } })
    expect(await fetchIdentity('https://a.example/auth/api/v1', 'tok')).toBeUndefined()

    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    expect(await fetchIdentity('https://a.example/auth/api/v1', 'tok')).toBeUndefined()
  })
})
