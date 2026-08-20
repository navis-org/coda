// @vitest-environment jsdom

/**
 * The run indicator's geometry.
 *
 * jsdom applies no CSS and runs no animations, so what is checkable here is the arithmetic
 * that decides how much of the perimeter is drawn — which is the part that would silently
 * misreport. The animation behaviour lives in `editor.css` and is unverified.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { NodeRunRing } from './NodeRunRing'

afterEach(cleanup)

function ring(progress?: number) {
  const { container } = render(
    <NodeRunRing {...(progress === undefined ? {} : { progress })} />,
  )
  const svg = container.querySelector('svg')!
  const rect = container.querySelector('rect')!
  return {
    mode: svg.getAttribute('data-mode'),
    dash: rect.getAttribute('stroke-dasharray'),
    pathLength: rect.getAttribute('pathLength'),
  }
}

describe('NodeRunRing', () => {
  it('normalises the perimeter to 1, so the dash array is a plain fraction', () => {
    // This is what removes any need to measure the node: no ResizeObserver, and correct at
    // whatever height the card ends up.
    expect(ring(0.5).pathLength).toBe('1')
  })

  it('draws the reported fraction of the outline', () => {
    expect(ring(0.25).dash).toBe('0.25 0.75')
    expect(ring(0.5).dash).toBe('0.5 0.5')
    expect(ring(1).dash).toBe('1 0')
  })

  it('still shows an arc at zero progress', () => {
    // A zero-length dash draws nothing, so a node that just started would appear to have no
    // indicator at all — which is the moment the indicator matters most.
    expect(ring(0).dash).toBe('0.02 0.98')
  })

  it('clamps a value outside 0..1 rather than drawing a negative gap', () => {
    expect(ring(1.5).dash).toBe('1 0')
    expect(ring(-2).dash).toBe('0.02 0.98')
  })

  it('goes indeterminate when the node reports no progress', () => {
    expect(ring().mode).toBe('indeterminate')
    expect(ring(0.4).mode).toBe('progress')
  })

  it('uses a partial arc when indeterminate, never a full ring', () => {
    // A complete outline reads as finished, which is the opposite of what this state means.
    // The travelling animation in CSS is what makes the partial arc legible as activity.
    expect(ring().dash).toBe('0.18 0.82')
  })

  it('treats a non-finite progress value as unknown', () => {
    expect(ring(Number.NaN).mode).toBe('indeterminate')
  })

  it('is hidden from assistive tech, since the node state is already announced', () => {
    const { container } = render(<NodeRunRing progress={0.5} />)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})
