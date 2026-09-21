/**
 * A stand-in for a sign-in popup, for the suites that drive `signInWithPopup` through a backend.
 *
 * jsdom has no popups and no cross-document messaging, so a sign-in is tested through its
 * `openWindow` seam with this in place of the window, and `post` in place of the auth server's
 * delivery page. One copy, because each popup backend would otherwise bring its own.
 */

export interface FakePopup {
  closed: boolean
  location: { href: string }
  close: () => void
}

export function fakePopup(): FakePopup {
  const popup: FakePopup = {
    closed: false,
    location: { href: 'about:blank' },
    close: () => {
      popup.closed = true
    },
  }
  return popup
}

/** What an auth server's delivery page does, as far as the opener can tell. */
export function post(source: FakePopup, data: unknown, origin: string): void {
  const event = new MessageEvent('message', { data, origin })
  // `source` takes a real `Window` through the constructor, and a stand-in is the whole point.
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

/** The `openWindow` seam, answering with `popup` — or `null`, which is a blocked pop-up. */
export function opener(popup: FakePopup | null): () => Window | null {
  return () => popup as unknown as Window | null
}
