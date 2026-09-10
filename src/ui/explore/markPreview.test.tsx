// @vitest-environment jsdom

/**
 * What a mark's hover preview says.
 *
 * The content, drawn on its own. The gesture — the delay, the mouse-only guard, the dismissal — is
 * `useHoverPanel`'s and is exercised whole through the widget in `explore.test.tsx`, which is also
 * where a merged column's preview is read end to end. Where the panel lands is a fact about layout
 * and belongs to `pnpm probe:explore-columns`.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { OTHER_LABEL, seriesColor } from '../colors'
import { installJsdomStubs } from '../../test/jsdomStubs'
import {
  ConfidencePreview,
  PREVIEW_W,
  PartsPreview,
  RegionsPreview,
  SpreadPreview,
} from './MarkPreview'
import { spreadOf } from './rowPlots'
import { MAX_REGIONS } from './rowRois'

beforeAll(() => installJsdomStubs({ width: 800, height: 500 }))
afterEach(cleanup)

/** Each legend row as its cells' text, so an assertion reads like the panel does. */
const legend = (root: ParentNode) =>
  [...root.querySelectorAll('.explore-mark-preview__legend tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent ?? ''),
  )

/** A colour as the CSSOM spells it, so a hex attribute and a style compare equal. */
function css(color: string | null): string {
  const probe = document.createElement('span')
  probe.style.color = color ?? ''
  return probe.style.color
}

const PARTS = [
  { name: 'axonIn', count: 30, share: 0.75 },
  { name: 'axonOut', count: 10, share: 0.25 },
]

describe('PartsPreview', () => {
  it('keys each part in the colour the row draws it in, and says what the shares are of', () => {
    const { container } = render(<PartsPreview parts={PARTS} shape="stacked" mode="dark" />)
    const fills = [...container.querySelectorAll('svg rect')].map((r) =>
      css(r.getAttribute('fill')),
    )
    const swatches = [...container.querySelectorAll<HTMLElement>('.legend__swatch')]
    expect(swatches.map((s) => css(s.style.background))).toEqual(fills)
    expect(fills).toEqual([css(seriesColor(0, 'dark')), css(seriesColor(1, 'dark'))])
    expect(legend(container)).toEqual([
      ['', 'axonIn', '30', '75%'],
      ['', 'axonOut', '10', '25%'],
      // The parts' own sum, which is not necessarily any column's total — see `sharesOf`.
      ['', 'Sum of these', '40', '100%'],
    ])
  })

  it('draws every split shape across the whole preview, not at the row’s size', () => {
    for (const shape of ['stacked', 'bars', 'donut'] as const) {
      const { container } = render(<PartsPreview parts={PARTS} shape={shape} mode="light" />)
      expect(container.querySelector('svg')!.getAttribute('width')).toBe(String(PREVIEW_W))
      cleanup()
    }
  })
})

describe('RegionsPreview', () => {
  const folded = Array.from({ length: 10 }, (_, i) => ({ roi: `F${i}`, count: 10 - i }))
  const rest = folded.reduce((a, r) => a + r.count, 0)
  const shares = [
    { roi: 'ME(R)', count: 45, share: 45 / (45 + rest), rank: 0 },
    { roi: OTHER_LABEL, count: rest, share: rest / (45 + rest), rank: MAX_REGIONS, folded },
  ]

  it('itemises what Other folded, and counts what it does not name', () => {
    const { container } = render(<RegionsPreview shares={shares} mode="dark" />)
    const tail = container.querySelector('.explore-mark-preview__folded')!
    expect(tail.textContent).toContain(`${OTHER_LABEL} · 10 regions`)
    const named = legend(tail)
    expect(named).toHaveLength(8)
    // Its share is of the neuron's whole primary total, like every row above it.
    expect(named[0]).toEqual(['F0', '10', '10%'])
    expect(tail.textContent).toContain('+2 more')
  })

  it('keeps the ring’s own legend folded, in the ring’s colours', () => {
    const { container } = render(<RegionsPreview shares={shares} mode="dark" />)
    const main = container.querySelector('.explore-mark-preview__legend')!
    expect(legend(main).map((row) => row[1])).toEqual(['ME(R)', OTHER_LABEL, 'Primary regions'])
  })

  it('adds nothing beneath a ring that folded nothing', () => {
    const { container } = render(
      <RegionsPreview shares={[{ roi: 'ME(R)', count: 5, share: 1, rank: 0 }]} mode="dark" />,
    )
    expect(container.querySelector('.explore-mark-preview__folded')).toBeNull()
  })
})

describe('SpreadPreview', () => {
  const histogram = spreadOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'linear', true, 10)!
  const filled = (value: number) => {
    const { container } = render(
      <SpreadPreview
        spread={histogram}
        value={value}
        unit={undefined}
        caption="caption"
        mode="dark"
      />,
    )
    const below = container.querySelectorAll('rect[data-below]').length
    const marker = Number(
      container.querySelector('.explore-mark-preview__marker')!.getAttribute('x'),
    )
    cleanup()
    return { below, marker }
  }

  it('fills the dataset up to the neuron and no further, and marks where it sits', () => {
    const low = filled(0)
    const mid = filled(5)
    const high = filled(9)
    expect(low.below).toBe(0)
    expect(high.below).toBe(10)
    expect(mid.below).toBeGreaterThan(low.below)
    expect(mid.below).toBeLessThan(high.below)
    // The marker stays inside the drawing at both ends.
    expect(low.marker).toBe(0)
    expect(high.marker).toBe(PREVIEW_W - 2)
  })

  it('says so where the axis is a log one', () => {
    const log = spreadOf([1, 10, 100, 1000], 'log', false, 10)!
    const { container } = render(
      <SpreadPreview spread={log} value={10} unit={undefined} caption="caption" mode="light" />,
    )
    expect(container.querySelector('.explore-mark-preview__axis')!.textContent).toContain(
      'log scale',
    )
  })
})

describe('ConfidencePreview', () => {
  it('explains a grey bar, and only a grey one', () => {
    const weak = render(<ConfidencePreview value={0.3} label="gaba" mode="dark" />)
    expect(weak.container.textContent).toContain('gaba — 30% confidence')
    expect(weak.container.textContent).toContain('under 50%')
    cleanup()
    const strong = render(<ConfidencePreview value={0.8} label="gaba" mode="dark" />)
    expect(strong.container.textContent).not.toContain('under 50%')
  })
})
