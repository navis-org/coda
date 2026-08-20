/**
 * `localStorage`, for code that must survive not having it.
 *
 * Two accessors and a try/catch, which sounds too small to be a module until you notice the
 * catch is the load-bearing part: `src/data` has to stay usable where there is no `window` at
 * all — a unit test under Node, and eventually the non-browser consumer invariant 1 exists for
 * — and a browser in private mode throws on access rather than returning null. Failing to
 * *remember* a value is not failing to compute one, so both swallow and the caller carries on
 * with whatever it has in memory.
 *
 * Deliberately not `src/store/persistence.ts`, which owns the same idiom for the editor's own
 * preferences: `src/data` may not import `src/store` (the eslint boundary), and that is the
 * right way round — a backend's credentials must not depend on the editor existing.
 */

export function readStorage(name: string): string | undefined {
  try {
    return window.localStorage?.getItem(name) ?? undefined
  } catch {
    return undefined
  }
}

/** Writing `undefined` removes the key, so "no value" has one representation rather than two. */
export function writeStorage(name: string, value: string | undefined): void {
  try {
    if (value) window.localStorage?.setItem(name, value)
    else window.localStorage?.removeItem(name)
  } catch {
    // Storage disabled or full. The in-memory value still works for this session.
  }
}
