/**
 * A `matchMedia` that actually answers, for the two features that ask the viewport a question.
 *
 * jsdom evaluates no media query — `installJsdomStubs` supplies a `matchMedia` that answers
 * `false` to everything, which is right for the three hundred suites that never think about the
 * viewport and useless for the two that are about it. So this evaluates the query itself against
 * a viewport the test sets.
 *
 * **The parser refuses what it cannot read, and that refusal is the point.** It understands one
 * shape — comma-separated `(max-width: Npx)` / `(max-height: Npx)` terms, OR-ed, which is what a
 * comma means in a media query list — and throws on anything else. A query rewritten into a form
 * this cannot evaluate should fail loudly rather than quietly answering `false`, which would turn
 * every case that asserts "not narrow" green while asserting nothing at all.
 *
 * Install it *after* `installJsdomStubs`, which only fills in a `matchMedia` if there is none.
 */

export interface Viewport {
  width: number
  height: number
}

/** Evaluate one media query list against a viewport. Throws on a term it cannot read. */
export function evaluateQuery(query: string, view: Viewport): boolean {
  return query.split(',').some((raw) => {
    const term = /^\s*\(max-(width|height):\s*(\d+)px\)\s*$/.exec(raw)
    if (!term) throw new Error(`matchMedia stub cannot read the term "${raw.trim()}"`)
    const size = term[1] === 'width' ? view.width : view.height
    return size <= Number(term[2])
  })
}

let viewport: Viewport = { width: 1440, height: 900 }
const listeners = new Set<() => void>()

/**
 * Swap `window.matchMedia` for one that reads `viewport`. `matches` is a getter, so a list
 * handed out before a resize answers the new size — which is what a browser does.
 */
export function installMatchMedia(): void {
  listeners.clear()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return evaluateQuery(query, viewport)
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

/**
 * Resize, and tell whoever is watching — a browser fires `change` on the list itself.
 *
 * Not wrapped in `act` here: this module knows nothing about React, and a caller that is
 * asserting on a re-render wraps the call. Setting the size *before* a first render needs no
 * act at all, which is the commoner case.
 */
export function setViewport(next: Viewport): void {
  viewport = next
  for (const fn of [...listeners]) fn()
}
