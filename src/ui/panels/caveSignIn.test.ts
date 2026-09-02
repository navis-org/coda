// @vitest-environment jsdom

/**
 * The four ways a CAVE login window ends, three of which are silent.
 *
 * jsdom has no popups and no cross-document messaging, so what is exercised here is the state
 * machine around them through the `openWindow` seam: the window is opened *before* the lookup
 * that decides where to point it, a message is only a token if it came from the window we
 * opened **and** the origin we discovered, a closed window settles the promise instead of
 * hanging it, and a deployment that cannot say where it logs in fails without leaving a blank
 * window on screen. The gesture itself — a real pop-up blocker, a real Google round trip — was
 * walked in a browser against `global.daf-apis.com`, which is the only place it can be.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installRouteFetch } from '../../test/caveStubs'
import { signInToCave } from './caveSignIn'

const SERVER = 'https://global.daf-apis.com'
const AUTHORIZE = 'https://global.daf-apis.com/sticky_auth/api/v1/authorize'
const AUTH_ORIGIN = 'https://global.daf-apis.com'

afterEach(() => {
  vi.unstubAllGlobals()
})

interface FakePopup {
  closed: boolean
  location: { href: string }
  close: () => void
}

function fakePopup(): FakePopup {
  const popup: FakePopup = {
    closed: false,
    location: { href: 'about:blank' },
    close: () => {
      popup.closed = true
    },
  }
  return popup
}

/** The two documents a sign-in reads: where to log in, and whose token came back. */
const ROUTES = {
  '/auth_info': { body: JSON.stringify({ login_url: `${SERVER}/sticky_auth` }) },
  '/user/me': { body: JSON.stringify({ email: 'a@example.org' }) },
}

/** What middle_auth's callback page does, as far as this window can tell. */
function post(source: FakePopup, data: unknown, origin = AUTH_ORIGIN): void {
  const event = new MessageEvent('message', { data, origin })
  // `source` takes a real `Window` through the constructor, and a stand-in is the whole point.
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

function start(popup: FakePopup | null, signal?: AbortSignal) {
  return signInToCave({
    server: SERVER,
    openWindow: () => popup as unknown as Window | null,
    pollMs: 2,
    ...(signal ? { signal } : {}),
  })
}

describe('signInToCave', () => {
  it('opens the window first and navigates it once the login service is known', async () => {
    installRouteFetch(ROUTES)
    const popup = fakePopup()

    const signIn = start(popup)
    // Before the lookup lands, there is already a window: that ordering is what keeps the call
    // inside the click, and it is why the popup starts blank.
    expect(popup.location.href).toBe('about:blank')

    await vi.waitFor(() => expect(popup.location.href).toBe(AUTHORIZE))
    post(popup, { token: 'tok-1', app_urls: [`${SERVER}/annotation`] })

    await expect(signIn).resolves.toEqual({ token: 'tok-1', email: 'a@example.org' })
    expect(popup.closed).toBe(true)
  })

  it('ignores a message from another window, another origin, or another shape', async () => {
    installRouteFetch(ROUTES)
    const popup = fakePopup()
    const impostor = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(AUTHORIZE))

    post(impostor, { token: 'stolen' })
    post(popup, { token: 'stolen' }, 'https://evil.example')
    post(popup, 'success')
    post(popup, {})
    post(popup, { token: 'tok-2' })

    // Anything but the last would have resolved this promise with a token that is not one.
    await expect(signIn).resolves.toEqual({ token: 'tok-2', email: 'a@example.org' })
  })

  it('settles when the window is closed instead of waiting forever', async () => {
    installRouteFetch(ROUTES)
    const popup = fakePopup()

    const signIn = start(popup)
    await vi.waitFor(() => expect(popup.location.href).toBe(AUTHORIZE))
    popup.closed = true

    // The message names the case it is really for: middle_auth's three exits that render a page
    // and post nothing — a missing session cookie, an expired state, an OAuth error — which is
    // what somebody is looking at when they close the window.
    await expect(signIn).rejects.toMatchObject({
      kind: 'closed',
      message: expect.stringMatching(/ended on an error page/),
    })
  })

  it('reports a blocked pop-up rather than a missing token, and asks for nothing', async () => {
    const seen = installRouteFetch(ROUTES)

    await expect(start(null)).rejects.toMatchObject({ kind: 'blocked' })
    expect(seen).toEqual([])
  })

  it('closes the window when the deployment will not say where it signs in', async () => {
    installRouteFetch({ ...ROUTES, '/auth_info': { status: 500, body: 'down' } })
    const popup = fakePopup()

    await expect(start(popup)).rejects.toMatchObject({ kind: 'unreachable' })
    expect(popup.closed).toBe(true)
  })

  it('closes the window when the caller gives up', async () => {
    installRouteFetch(ROUTES)
    const popup = fakePopup()
    const controller = new AbortController()

    const signIn = start(popup, controller.signal)
    await vi.waitFor(() => expect(popup.location.href).toBe(AUTHORIZE))
    controller.abort()

    await expect(signIn).rejects.toMatchObject({ kind: 'cancelled' })
    expect(popup.closed).toBe(true)
  })
})
