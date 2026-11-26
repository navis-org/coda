/**
 * The edit-permission check, against a stubbed auth service shaped as the live one answered
 * (2026-11-16). What is pinned is which list decides: `permissions_v2`, which already leaves out a
 * dataset whose terms are pending — not `missing_tos`, which lists every dataset's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { editPermission, resetLoginServices } from './permissions'

const AUTH = 'https://global.daf-apis.com/sticky_auth/api/v1'
/** The sandbox chunkedgraph, whose host names the login service that judges it. */
const GRAPHENE = {
  server: 'https://cave.fanc-fly.com',
  table: 'mar2021_test',
  base: 'https://cave.fanc-fly.com/segmentation/table/mar2021_test',
}
const OPTIONS = { deployment: 'https://global.daf-apis.com', token: 'test-token' }

function serve(
  user: object,
  chunkedgraphLogin = 'https://global.daf-apis.com/sticky_auth',
): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url)
    const login = url.startsWith(GRAPHENE.server)
      ? chunkedgraphLogin
      : 'https://global.daf-apis.com/sticky_auth'
    const body = url.endsWith('/auth_info')
      ? JSON.stringify({ login_url: login })
      : url.endsWith('/dataset')
        ? '"FANC_sandbox"'
        : JSON.stringify(user)
    return new Response(body, { status: 200 })
  })
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetLoginServices()
})

describe('editPermission', () => {
  it('asks the chunkedgraph’s host where it logs in, then the table’s dataset and the user’s permissions', async () => {
    const asked = serve({
      permissions_v2: { FANC_sandbox: ['edit', 'view'] },
      // Terms pending elsewhere are no reason to refuse here.
      missing_tos: [{ dataset: 'minnie65_public' }],
    })
    expect(await editPermission(GRAPHENE, OPTIONS)).toEqual({
      dataset: 'FANC_sandbox',
      mayEdit: true,
      termsPending: false,
    })
    expect(asked).toEqual([
      'https://cave.fanc-fly.com/auth_info',
      'https://global.daf-apis.com/auth_info',
      `${AUTH}/service/pychunkedgraph/table/mar2021_test/dataset`,
      `${AUTH}/user/cache`,
    ])
    // Where a host logs in is kept: a second check asks only the permissions.
    asked.length = 0
    await editPermission(GRAPHENE, OPTIONS)
    expect(asked).toEqual([
      `${AUTH}/service/pychunkedgraph/table/mar2021_test/dataset`,
      `${AUTH}/user/cache`,
    ])
  })

  it('refuses a user who may only view', async () => {
    serve({ permissions_v2: { FANC_sandbox: ['view'] } })
    expect(await editPermission(GRAPHENE, OPTIONS)).toMatchObject({
      mayEdit: false,
      termsPending: false,
    })
  })

  it('says when only the dataset’s terms stand in the way', async () => {
    serve({
      permissions_v2: {},
      permissions_v2_ignore_tos: { FANC_sandbox: ['edit', 'view'] },
    })
    expect(await editPermission(GRAPHENE, OPTIONS)).toMatchObject({
      mayEdit: false,
      termsPending: true,
    })
  })

  /** The token is the deployment's; a chunkedgraph judged elsewhere would refuse it. */
  it('refuses, without sending the token on, where the chunkedgraph logs in elsewhere', async () => {
    const asked = serve({}, 'https://other-auth.example.org/sticky_auth')
    await expect(editPermission(GRAPHENE, OPTIONS)).rejects.toThrow(
      /checks permissions with https:\/\/other-auth\.example\.org, but your token is from https:\/\/global\.daf-apis\.com/,
    )
    expect(asked.some((url) => url.includes('other-auth'))).toBe(false)
  })

  /** `/auth` redirects to `/sticky_auth` on global: one service, two spellings. */
  it('takes one login service reached at two paths for one', async () => {
    serve({ permissions_v2: { FANC_sandbox: ['edit'] } }, 'https://global.daf-apis.com/auth')
    expect(await editPermission(GRAPHENE, OPTIONS)).toMatchObject({ mayEdit: true })
  })

  it('names which lookup failed: the chunkedgraph’s, or the deployment’s', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.startsWith(GRAPHENE.server)
        ? new Response('{"login_url":"https://global.daf-apis.com/sticky_auth"}', {
            status: 200,
          })
        : new Response('nope', { status: 404 }),
    )
    await expect(editPermission(GRAPHENE, OPTIONS)).rejects.toThrow(
      /Could not find where your CAVE deployment https:\/\/global\.daf-apis\.com signs in/,
    )
  })

  it('stops waiting on a shared lookup when its own caller cancels', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const stop = new AbortController()
    const waiting = editPermission(GRAPHENE, { ...OPTIONS, signal: stop.signal })
    stop.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('says a failed lookup is about permissions, not about signing in', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }))
    await expect(editPermission(GRAPHENE, OPTIONS)).rejects.toThrow(
      /Could not find where https:\/\/cave\.fanc-fly\.com checks permissions/,
    )
  })
})
