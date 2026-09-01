// @vitest-environment jsdom

/**
 * Where the run outline sits in the DOM.
 *
 * The ring is drawn *outside* the node's bounds, and `.coda-node` clips with
 * `overflow: hidden` — so it has to be a sibling of the card inside React Flow's wrapper, not
 * a child of it. Move it back inside and nothing throws, nothing fails typecheck, and the
 * outline silently loses everything beyond the node's edge. That is exactly the kind of
 * regression a comment does not prevent.
 *
 * Uses a deliberately slow mock source: the running state is unobservable at zero latency,
 * which is why the main smoke test cannot cover this.
 */

import { readFileSync } from 'node:fs'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 360, height: 220 })
  // Slow enough that 'running' is observable, fast enough not to drag the suite.
  registerSource(new MockSource({ latencyMs: 120 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(cleanup)

describe('run outline placement', () => {
  it('renders outside the card, so the outset is not clipped away', async () => {
    render(<App />)
    // Started, not awaited: the assertion is about the state *during* the run. `waitFor`
    // does the act() wrapping, so this must not be wrapped again here.
    const running = useGraphStore.getState().runAll()

    const ring = await waitFor(() => {
      const found = document.querySelector('.coda-node__ring')
      if (!found) throw new Error('no ring while running')
      return found
    })

    // The load-bearing assertion: not a descendant of the clipping card.
    expect(ring.closest('.coda-node')).toBeNull()
    // And it does live inside React Flow's wrapper, which is the positioned ancestor the
    // negative inset resolves against.
    expect(ring.parentElement?.classList.contains('react-flow__node')).toBe(true)
    expect(ring.getAttribute('data-mode')).toMatch(/progress|indeterminate/)

    await running
  })

  it('disappears once nothing is running', async () => {
    render(<App />)
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run all stale nodes' })).toBeTruthy()
    })
    expect(document.querySelector('.coda-node__ring')).toBeNull()
  })
})

/**
 * jsdom performs no layout, so the ring's actual box cannot be measured here. What can be
 * checked is the declaration that decided it — worth doing because this exact rule shipped
 * broken once, and the failure was silent to every other kind of test.
 */
describe('run outline sizing', () => {
  function ringRule(): string {
    // Read from source rather than a stylesheet object: vitest never applies the CSS.
    // Path is relative to the repo root, which is vitest's working directory.
    const css = readFileSync('src/ui/editor.css', 'utf8')
    const start = css.indexOf('.coda-node__ring {')
    expect(start).toBeGreaterThan(-1)
    // Comments stripped: the rule's own prose explains the `width: auto` trap, and matching
    // against an explanation of the bug rather than the code is a fine way to test nothing.
    return css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('sizes itself explicitly rather than leaving width to auto', () => {
    /*
     * `<svg>` is a replaced element: `width: auto` takes its *intrinsic* size (300×150 with
     * no viewBox) and drops `right`/`bottom` as over-constrained. An `inset: -6px` shorthand
     * therefore drew a fixed 300×150 box hanging off the node's corner — which read as a
     * bounding box around the outgoing edges instead of an outline around the card.
     */
    const rule = ringRule()
    expect(rule).not.toMatch(/width:\s*auto/)
    expect(rule).not.toMatch(/height:\s*auto/)
    expect(rule).toMatch(/width:\s*calc\(100% \+/)
    expect(rule).toMatch(/height:\s*calc\(100% \+/)
  })

  it('offsets by the same amount it grows, so it stays centred on the card', () => {
    // Grow by 2×out and shift by −out, or the outline sits lopsided.
    const rule = ringRule()
    expect(rule).toMatch(/top:\s*calc\(-1 \* var\(--ring-out\)\)/)
    expect(rule).toMatch(/left:\s*calc\(-1 \* var\(--ring-out\)\)/)
    expect(rule).toMatch(/width:\s*calc\(100% \+ 2 \* var\(--ring-out\)\)/)
  })
})
