// @vitest-environment jsdom

/**
 * The neuPrint sign-in through DatasetGateway, as far as jsdom can see it.
 *
 * The window machinery is shared with CAVE and pinned in `caveSignIn.test.ts`; what is pinned here
 * is DSG's own contract: the fixed URL carrying this page's origin, the one exact origin a token
 * is taken from, `"badorigin"` as an answer of its own rather than a window that closed, and the
 * identity read off neuPrint's `/profile` with its capital `E`. The gesture itself was walked in a
 * real browser against `dsg.janelia.org`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FakePopup } from '../../test/popupStubs'
import { fakePopup, opener, post as deliver } from '../../test/popupStubs'

import { signInToNeuPrint } from './neuprintSignIn'

const DSG = 'https://dsg.janelia.org'
const APP = 'http://localhost:5173'
const LOGIN = `${DSG}/login?origin=${encodeURIComponent(APP)}&token=api`

afterEach(() => {
  vi.unstubAllGlobals()
})

function post(source: FakePopup, data: unknown, origin = DSG): void {
  deliver(source, data, origin)
}

/** neuPrint's `/profile`, and a record of what was asked of it. */
function stubProfile(body: unknown, status = 200): string[] {
  const seen: string[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    seen.push(`${url} ${new Headers(init?.headers).get('Authorization')}`)
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  })
  return seen
}

function start(popup: FakePopup | null, signal?: AbortSignal) {
  return signInToNeuPrint({
    appOrigin: APP,
    openWindow: opener(popup),
    pollMs: 2,
    ...(signal ? { signal } : {}),
  })
}

describe('signInToNeuPrint', () => {
  it('points the window at the gateway with this origin, and names the account', async () => {
    const seen = stubProfile({ Email: 'a@janelia.org', AuthLevel: 'readonly' })
    const popup = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(LOGIN))
    post(popup, { token: 'dsg-key' })

    await expect(signIn).resolves.toEqual({ token: 'dsg-key', email: 'a@janelia.org' })
    expect(popup.closed).toBe(true)
    expect(seen).toEqual(['https://neuprint.janelia.org/profile Bearer dsg-key'])
  })

  it('takes a token only from the exact gateway origin and the window it opened', async () => {
    stubProfile({ Email: 'a@janelia.org' })
    const popup = fakePopup()
    const impostor = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(LOGIN))

    post(impostor, { token: 'stolen' })
    // The same application on its other hostname is a different origin, and not the one opened.
    post(popup, { token: 'stolen' }, 'https://dataset-gateway.janelia.org')
    post(popup, { token: 'ok' })

    await expect(signIn).resolves.toMatchObject({ token: 'ok' })
  })

  it('says the site is not registered on "badorigin", rather than that a window closed', async () => {
    const seen = stubProfile({})
    const popup = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(LOGIN))
    post(popup, 'badorigin')

    await expect(signIn).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining(`from ${APP}`),
    })
    expect(seen).toEqual([])
  })

  it('settles as closed when the consent is cancelled, which posts nothing', async () => {
    stubProfile({})
    const popup = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(LOGIN))
    popup.closed = true

    await expect(signIn).rejects.toMatchObject({ kind: 'closed' })
  })

  it('signs in without a name where neuPrint will not say whose token it is', async () => {
    stubProfile({ error: 'nope' }, 401)
    const popup = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(LOGIN))
    post(popup, { token: 'dsg-key' })

    await expect(signIn).resolves.toEqual({ token: 'dsg-key' })
  })

  it('reports a blocked pop-up and asks nothing', async () => {
    const seen = stubProfile({})
    await expect(start(null)).rejects.toMatchObject({ kind: 'blocked' })
    expect(seen).toEqual([])
  })
})
