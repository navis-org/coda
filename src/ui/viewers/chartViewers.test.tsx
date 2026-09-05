// @vitest-environment jsdom

/**
 * Geometry and gestures for the histogram, the pie and the box plot.
 *
 * The arithmetic behind all three is tested headlessly (`histogramBins`, `pieLayout`,
 * `boxStats`); what is left for jsdom is what those numbers become — how many marks, which
 * marks, and above all **what a click writes back**, since that string is what a node resolves
 * into rows and is the one thing the two halves have to agree on exactly.
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { DistributionViewer } from './DistributionViewer'
import { HistogramViewer } from './HistogramViewer'
import { PieViewer } from './PieViewer'

beforeAll(() => installJsdomStubs({ width: 800, height: 400 }))
afterEach(cleanup)

const SCHEMA = tableSchema(column('pre', 'i64'), column('type', 'str'))

function neurons(rows: { pre: number | null; type?: string }[]) {
  return tableFromRows(
    SCHEMA,
    rows.map((r) => ({ pre: r.pre, type: r.type ?? 'LC4' })),
  )
}

/** Every drawn mark, ignoring the transparent full-band hit areas and the surface. */
function marks(container: HTMLElement, selector: string) {
  return [...container.querySelectorAll(selector)].filter(
    (el) => el.getAttribute('fill') !== 'transparent',
  )
}

describe('HistogramViewer', () => {
  const table = neurons([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((pre) => ({ pre })))

  it('draws one bar per bin', () => {
    const { container } = render(
      <HistogramViewer table={table} valueColumn="pre" binMode="fixed" bins={5} />,
    )
    // One `rect` per bar plus the surface; the hit areas are transparent and filtered out.
    expect(marks(container, 'rect').length).toBe(6)
  })

  it('writes the clicked bar back as a value range, not as a bar number', () => {
    // A bar number would silently re-point at different rows the moment the bin count moved,
    // and the bin count is presentational so nothing would re-run.
    const onSelectionChange = vi.fn()
    const { container } = render(
      <HistogramViewer
        table={table}
        valueColumn="pre"
        binMode="fixed"
        bins={5}
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('svg > g')[0]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['0:1.8'])
  })

  it('marks the top bar closed, so the largest value is inside a bar', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <HistogramViewer
        table={table}
        valueColumn="pre"
        binMode="fixed"
        bins={5}
        onSelectionChange={onSelectionChange}
      />,
    )
    const groups = container.querySelectorAll('svg > g')
    fireEvent.click(groups[groups.length - 1]!)
    expect(onSelectionChange.mock.calls[0]![0][0]).toMatch(/:c$/)
  })

  it('adds to the selection on a modified click and replaces on a plain one', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <HistogramViewer
        table={table}
        valueColumn="pre"
        binMode="fixed"
        bins={5}
        selection={['0:1.8']}
        onSelectionChange={onSelectionChange}
      />,
    )
    const groups = container.querySelectorAll('svg > g')
    fireEvent.click(groups[1]!, { shiftKey: true })
    expect(onSelectionChange.mock.calls[0]![0]).toHaveLength(2)
    onSelectionChange.mockClear()
    fireEvent.click(groups[1]!)
    expect(onSelectionChange.mock.calls[0]![0]).toHaveLength(1)
  })

  it('clears when the one selected bar is clicked again', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <HistogramViewer
        table={table}
        valueColumn="pre"
        binMode="fixed"
        bins={5}
        selection={['0:1.8']}
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('svg > g')[0]!)
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it('gives every bar a full-height hit area, so a tail is not a two-pixel target', () => {
    // The tail is what somebody clicking a histogram is nearly always after.
    const skewed = neurons([...Array(200).fill({ pre: 1 }), { pre: 1000 }])
    const { container } = render(
      <HistogramViewer table={skewed} valueColumn="pre" binMode="fixed" bins={10} />,
    )
    const hits = [...container.querySelectorAll('rect')].filter(
      (r) => r.getAttribute('fill') === 'transparent',
    )
    expect(hits).toHaveLength(10)
    expect(new Set(hits.map((r) => r.getAttribute('height'))).size).toBe(1)
  })

  it('shows a legend once there are two series and not before', () => {
    const { container, rerender } = render(
      <HistogramViewer table={table} valueColumn="pre" seriesColumn="type" />,
    )
    expect(container.querySelector('.legend')).toBeNull()
    rerender(
      <HistogramViewer
        table={neurons([
          { pre: 1, type: 'LC4' },
          { pre: 2, type: 'LPLC2' },
        ])}
        valueColumn="pre"
        seriesColumn="type"
      />,
    )
    expect(container.querySelectorAll('.legend .legend__item')).toHaveLength(2)
  })

  it('admits in the caption how many rows it could not place', () => {
    const { container } = render(
      <HistogramViewer
        table={neurons([{ pre: 1 }, { pre: 0 }, { pre: -5 }])}
        valueColumn="pre"
        log
      />,
    )
    expect(container.querySelector('.viewer__caption')?.textContent).toContain('2 unplottable')
  })

  it('says what is wrong rather than drawing an empty axis', () => {
    const { container } = render(
      <HistogramViewer table={neurons([{ pre: null }])} valueColumn="pre" />,
    )
    expect(container.querySelector('.viewer__empty')?.textContent).toContain('no usable')
  })
})

describe('PieViewer', () => {
  const table = tableFromRows(SCHEMA, [
    { pre: 10, type: 'a' },
    { pre: 8, type: 'b' },
    { pre: 6, type: 'c' },
    { pre: 4, type: 'd' },
    { pre: 2, type: 'e' },
  ])

  it('draws one arc per slice, with the tail folded into one', () => {
    const { container } = render(
      <PieViewer table={table} categoryColumn="type" valueColumn="pre" maxSlices={3} />,
    )
    expect(container.querySelectorAll('svg path')).toHaveLength(4)
    expect(container.querySelectorAll('.legend__item')).toHaveLength(4)
  })

  it('writes the folded categories out by name when the residual is clicked', () => {
    // `Other` depends on `maxSlices`, which is presentational — so a stored `"Other"` would
    // quietly come to mean a different set of rows after somebody widened the chart.
    const onSelectionChange = vi.fn()
    const { container } = render(
      <PieViewer
        table={table}
        categoryColumn="type"
        valueColumn="pre"
        maxSlices={3}
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('svg > g')[3]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['d', 'e'])
  })

  it('writes a plain slice back as its own label', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <PieViewer
        table={table}
        categoryColumn="type"
        valueColumn="pre"
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('svg > g')[0]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['a'])
  })

  it('selects from the legend as well as from the ring', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <PieViewer
        table={table}
        categoryColumn="type"
        valueColumn="pre"
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('.legend__label')[1]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['b'])
  })

  it('cuts a hole for a donut and none for a pie', () => {
    const wedge = render(
      <PieViewer table={table} categoryColumn="type" valueColumn="pre" shape="pie" />,
    )
    // A wedge starts at the centre; a ring segment starts on its own outer edge.
    expect(wedge.container.querySelector('svg path')!.getAttribute('d')).toMatch(/^M400,/)
    cleanup()
    const ring = render(
      <PieViewer table={table} categoryColumn="type" valueColumn="pre" shape="donut" />,
    )
    expect(ring.container.querySelector('svg path')!.getAttribute('d')).not.toMatch(/^M400,200/)
  })

  it('counts rows when no value column is given', () => {
    const { container } = render(<PieViewer table={table} categoryColumn="type" />)
    // Five categories of one row each: every slice is a fifth.
    expect(container.querySelectorAll('svg path')).toHaveLength(5)
    expect(container.querySelector('.viewer__caption')?.textContent).toContain('rows by type')
  })

  it('says how many negatives it refused', () => {
    const negatives = tableFromRows(SCHEMA, [
      { pre: 10, type: 'a' },
      { pre: -4, type: 'b' },
    ])
    const { container } = render(
      <PieViewer table={negatives} categoryColumn="type" valueColumn="pre" />,
    )
    expect(container.querySelector('.viewer__caption')?.textContent).toContain('1 unplottable')
  })
})

describe('DistributionViewer', () => {
  const table = tableFromRows(SCHEMA, [
    ...[1, 2, 3, 4, 5, 60].map((pre) => ({ pre, type: 'LC4' })),
    ...[10, 20, 30].map((pre) => ({ pre, type: 'LPLC2' })),
  ])

  it('draws one box per group and labels each one', () => {
    const { container } = render(
      <DistributionViewer table={table} valueColumn="pre" groupColumn="type" />,
    )
    const labels = [...container.querySelectorAll('svg text')].map((t) => t.textContent)
    expect(labels).toContain('LC4')
    expect(labels).toContain('LPLC2')
  })

  it('draws the outliers Tukey found and none under the full-range rule', () => {
    const tukey = render(
      <DistributionViewer table={table} valueColumn="pre" groupColumn="type" />,
    )
    expect(tukey.container.querySelectorAll('circle').length).toBe(1)
    cleanup()
    const full = render(
      <DistributionViewer
        table={table}
        valueColumn="pre"
        groupColumn="type"
        whiskers="minmax"
      />,
    )
    expect(full.container.querySelectorAll('circle').length).toBe(0)
  })

  it('draws a violin outline only when one was asked for', () => {
    const box = render(
      <DistributionViewer table={table} valueColumn="pre" groupColumn="type" />,
    )
    expect(box.container.querySelectorAll('svg path')).toHaveLength(0)
    cleanup()
    const violin = render(
      <DistributionViewer table={table} valueColumn="pre" groupColumn="type" style="violin" />,
    )
    expect(violin.container.querySelectorAll('svg path').length).toBeGreaterThan(0)
  })

  it('writes a clicked box back as its group label', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <DistributionViewer
        table={table}
        valueColumn="pre"
        groupColumn="type"
        sortByMedian={false}
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('svg > g')[0]!)
    expect(onSelectionChange).toHaveBeenCalledWith(['LC4'])
  })

  it('offers no selection at all without a group column, rather than a box that selects everything', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <DistributionViewer
        table={table}
        valueColumn="pre"
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(container.querySelectorAll('svg > g')[0]!)
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('swaps the axes when the groups run along the bottom', () => {
    // The one claim `orientation` makes. Read off the group labels: down the side they are
    // right-anchored in a left gutter and upright; along the bottom they are rotated.
    const rows = render(
      <DistributionViewer table={table} valueColumn="pre" groupColumn="type" />,
    )
    const rowLabel = [...rows.container.querySelectorAll('svg text')].find(
      (t) => t.textContent === 'LC4',
    )!
    expect(rowLabel.getAttribute('transform')).toBeNull()
    cleanup()

    const columns = render(
      <DistributionViewer
        table={table}
        valueColumn="pre"
        groupColumn="type"
        orientation="columns"
      />,
    )
    const columnLabel = [...columns.container.querySelectorAll('svg text')].find(
      (t) => t.textContent === 'LC4',
    )!
    expect(columnLabel.getAttribute('transform')).toMatch(/^rotate\(-45/)
  })

  it('runs the value axis upwards as columns, so bigger is higher', () => {
    // Screen y grows downwards and a value axis does not — the one asymmetry in the frame, and
    // the one that draws the whole chart upside down when it is missed.
    const { container } = render(
      <DistributionViewer
        table={table}
        valueColumn="pre"
        groupColumn="type"
        orientation="columns"
        sortByMedian={false}
      />,
    )
    const boxes = [...container.querySelectorAll('svg rect')].filter(
      (r) => r.getAttribute('fill') !== 'transparent' && r.getAttribute('rx') === '2',
    )
    // LC4's median is 3.5 and LPLC2's is 20, so LPLC2's box must sit higher up the card.
    const [lc4, lplc2] = boxes.map((r) => Number(r.getAttribute('y')))
    expect(lplc2).toBeLessThan(lc4!)
  })

  it('draws one mark per observation in a swarm, and no separate outliers', () => {
    // A swarm already shows every point, so drawing the Tukey outliers again would double them.
    const { container } = render(
      <DistributionViewer table={table} valueColumn="pre" groupColumn="type" style="swarm" />,
    )
    expect(container.querySelectorAll('circle')).toHaveLength(9)
  })

  it('says so in the caption when a swarm was thinned', () => {
    const many = tableFromRows(
      SCHEMA,
      Array.from({ length: 900 }, (_, i) => ({ pre: i + 1, type: 'LC4' })),
    )
    const { container } = render(
      <DistributionViewer table={many} valueColumn="pre" groupColumn="type" style="swarm" />,
    )
    expect(container.querySelectorAll('circle')).toHaveLength(300)
    expect(container.querySelector('.viewer__caption')?.textContent).toContain('swarm thinned')
  })

  it('keeps a swarm inside its own band', () => {
    // Packed wider than the band it belongs to, a dense group would spill into its neighbours.
    const dense = tableFromRows(SCHEMA, [
      ...Array.from({ length: 120 }, () => ({ pre: 50, type: 'LC4' })),
      ...Array.from({ length: 5 }, () => ({ pre: 50, type: 'LPLC2' })),
    ])
    const { container } = render(
      <DistributionViewer table={dense} valueColumn="pre" groupColumn="type" style="swarm" />,
    )
    const bands = [...container.querySelectorAll('svg rect')].filter(
      (r) => r.getAttribute('fill') === 'transparent',
    )
    const [first] = bands.map((r) => ({
      top: Number(r.getAttribute('y')),
      bottom: Number(r.getAttribute('y')) + Number(r.getAttribute('height')),
    }))
    const ys = [...container.querySelectorAll('circle')].map((c) =>
      Number(c.getAttribute('cy')),
    )
    // Every mark of the crowded group is inside the band it belongs to.
    const inFirst = ys.filter((y) => y >= first!.top - 3 && y <= first!.bottom + 3)
    expect(inFirst.length).toBeGreaterThan(100)
  })

  it('says how many groups there were when it drew fewer', () => {
    const many = tableFromRows(
      SCHEMA,
      Array.from({ length: 30 }, (_, i) => ({ pre: i + 1, type: `t${i}` })),
    )
    const { container } = render(
      <DistributionViewer table={many} valueColumn="pre" groupColumn="type" maxGroups={5} />,
    )
    expect(container.querySelector('.viewer__caption')?.textContent).toContain('5 of 30 groups')
  })
})
