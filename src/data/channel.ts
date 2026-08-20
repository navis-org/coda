/**
 * A subscribe/notify channel, which `src/data` had written out six times.
 *
 * The shape is always the same three lines — a `Set` of listeners, a notify that iterates it,
 * a subscribe that returns its own removal — and it is the idiom this layer reaches for
 * whenever something that must stay headless needs to tell the UI that a fact changed:
 * `reportSourceLearned`, the upload store, and the auth-failure and value-changed channels of
 * both credential modules.
 *
 * Deliberately not an `EventTarget` or an emitter keyed by event name. There is exactly one
 * event per channel here, and naming it would turn a call the type checker fully understands
 * into a string nothing checks.
 *
 * **It does not replay.** A listener added after a notification never learns about it, which is
 * what every caller wants: these announce that something *just* happened, and a subscription
 * started at mount should not fire for a failure the user already dealt with.
 */

export interface Channel<T> {
  notify: (value: T) => void
  /** Returns the unsubscribe, so a React effect can hand it straight back. */
  subscribe: (listener: (value: T) => void) => () => void
}

export function channel<T = void>(): Channel<T> {
  const listeners = new Set<(value: T) => void>()
  return {
    notify: (value) => {
      for (const listener of listeners) listener(value)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
