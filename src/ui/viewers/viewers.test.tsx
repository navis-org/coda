// @vitest-environment jsdom

/**
 * Geometry checks for the chart viewers.
 *
 * The palette is validated by the dataviz validator, but nothing checks *layout* — so
 * these tests assert the mark specs that would otherwise only be caught by eye:
 * bar thickness cap, 4px rounded data-end on a square baseline, the 2px surface gap
 * between stacked segments, a legend once there are two series, and labels that are
 * dropped rather than clipped when they don't fit.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeMatrix, tableFromRows } from '../../core/values'
import { MAX_BAR_THICKNESS, SURFACE_GAP } from '../colors'
import { installDownloadCapture, installJsdomStubs } from '../../test/jsdomStubs'
import { BarChartViewer } from './BarChartViewer'
import { HeatmapViewer } from './HeatmapViewer'
import { TableViewer } from './TableViewer'

beforeAll(() => installJsdomStubs({ width: 800, height: 400 }))
afterEach(cleanup)

const ROI_SCHEMA = tableSchema(
  column('roi', 'str'),
  column('type', 'str'),
  column('sum_post', 'i64', 'synapses'),
)

function roiTable() {
  return tableFromRows(ROI_SCHEMA, [
    { roi: 'CA(R)', type: 'KCg-m', sum_post: 900 },
    { roi: 'CA(R)', type: 'KCab-c', sum_post: 500 },
    { roi: 'gL(R)', type: 'KCg-m', sum_post: 300 },
    { roi: 'PED(R)', type: 'KCab-c', sum_post: 120 },
  ])
}

/** Pull the (x, width) of every bar path out of the rendered SVG. */
function barGeometry(container: HTMLElement) {
  return [...container.querySelectorAll('path')].map((path) => {
    const d = path.getAttribute('d') ?? ''
    // Both forms start with an absolute moveto: "M<x>,<y>".
    const move = /^M([\d.]+),([\d.]+)/.exec(d)
    const x = move ? Number(move[1]) : NaN
    const y = move ? Number(move[2]) : NaN
    // Rounded form ends the top edge at H<x1-r>; square form uses h<width>.
    const hAbs = /H([\d.]+)/.exec(d)
    const hRel = /h([\d.]+)/.exec(d)
    const arc = /A([\d.]+),([\d.]+)/.exec(d)
    const radius = arc ? Number(arc[1]) : 0
    const width = hAbs ? Number(hAbs[1]) - x + radius : hRel ? Number(hRel[1]) : NaN
    return { x, y, width, radius, d }
  })
}

describe('BarChartViewer', () => {
  it('draws one mark per non-zero segment with positive width', () => {
    const { container } = render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        seriesColumn="type"
      />,
    )
    const bars = barGeometry(container)
    // 2 segments for CA(R), 1 each for gL(R) and PED(R).
    expect(bars).toHaveLength(4)
    for (const bar of bars) {
      expect(bar.width, bar.d).toBeGreaterThan(0)
      expect(Number.isFinite(bar.x)).toBe(true)
    }
  })

  it('caps bar thickness instead of filling the band', () => {
    const { container } = render(
      <BarChartViewer table={roiTable()} categoryColumn="roi" valueColumn="sum_post" />,
    )
    const paths = [...container.querySelectorAll('path')]
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) {
      const d = path.getAttribute('d') ?? ''
      const vertical = /V([\d.]+)/.exec(d)
      const move = /^M([\d.]+),([\d.]+)/.exec(d)
      const arc = /A([\d.]+),/.exec(d)
      if (!vertical || !move || !arc) continue
      // The path's V lands at y + height - r, so height = V - y + r.
      const thickness = Number(vertical[1]) - Number(move[2]) + Number(arc[1])
      expect(thickness).toBeLessThanOrEqual(MAX_BAR_THICKNESS + 0.01)
      expect(thickness).toBeGreaterThan(8)
    }
  })

  it('rounds the data end and keeps the baseline square', () => {
    const { container } = render(
      <BarChartViewer table={roiTable()} categoryColumn="roi" valueColumn="sum_post" />,
    )
    const bars = barGeometry(container)
    for (const bar of bars) {
      // Two arcs at the data end, radius 4; no arc at the baseline.
      expect(bar.radius).toBeCloseTo(4, 5)
      expect((bar.d.match(/A/g) ?? []).length).toBe(2)
    }
  })

  it('separates stacked segments with a 2px surface gap', () => {
    const { container } = render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        seriesColumn="type"
      />,
    )
    const bars = barGeometry(container)
    // CA(R) is the largest bar and sorts first: its two segments share a row (same y).
    const firstRow = bars.filter((b) => b.y === bars[0]!.y)
    expect(firstRow).toHaveLength(2)
    const [left, right] = firstRow as [(typeof firstRow)[0], (typeof firstRow)[0]]
    const gap = right.x - (left.x + left.width)
    expect(gap).toBeCloseTo(SURFACE_GAP, 1)
  })

  it('shows a legend for two series and none for one', () => {
    const { container, unmount } = render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        seriesColumn="type"
      />,
    )
    expect(container.querySelectorAll('.legend__item')).toHaveLength(2)
    expect(screen.getByText('KCg-m')).toBeTruthy()
    unmount()

    const single = render(
      <BarChartViewer table={roiTable()} categoryColumn="roi" valueColumn="sum_post" />,
    )
    // One series: the caption names what is plotted, so a one-swatch legend is noise.
    expect(single.container.querySelectorAll('.legend')).toHaveLength(0)
  })

  it('labels bar tips and axis ticks with clean numbers', () => {
    render(<BarChartViewer table={roiTable()} categoryColumn="roi" valueColumn="sum_post" />)
    // CA(R) total = 900 + 500. Four-digit values keep their separators; compaction to
    // "1.4K" only kicks in at 10,000, where the separator stops helping.
    expect(screen.getByText('1,400')).toBeTruthy()
    expect(screen.getByText('CA(R)')).toBeTruthy()
    // niceTicks rounds to a clean step rather than max/4.
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.getByText('500')).toBeTruthy()
  })

  it('sorts bars by value when asked, alphabetically otherwise', () => {
    const sorted = render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        sortBars
      />,
    )
    const labelsOf = (c: HTMLElement) =>
      [...c.querySelectorAll('text')]
        .map((t) => t.textContent ?? '')
        .filter((t) => t.endsWith('(R)'))
    expect(labelsOf(sorted.container)).toEqual(['CA(R)', 'gL(R)', 'PED(R)'])
    sorted.unmount()

    const alpha = render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        sortBars={false}
      />,
    )
    // Locale collation, not code-unit order — otherwise lowercase type names like
    // "gL(R)" sort after every uppercase one, which reads as random to a user.
    expect(labelsOf(alpha.container)).toEqual(
      ['PED(R)', 'gL(R)', 'CA(R)'].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    )
  })

  it('reports an empty result rather than drawing an empty frame', () => {
    const empty = tableFromRows(ROI_SCHEMA, [])
    render(<BarChartViewer table={empty} categoryColumn="roi" valueColumn="sum_post" />)
    expect(screen.getByText(/Nothing to plot/)).toBeTruthy()
  })
})

describe('HeatmapViewer', () => {
  const matrix = () =>
    makeMatrix(
      ['LC4', 'LC6'],
      ['DNp02', 'DNp11', 'PVLP002'],
      Float64Array.from([0.7, 0.2, 0.1, 0.0, 0.4, 0.6]),
      'fraction of row',
    )

  it('draws one cell per matrix entry', () => {
    const { container } = render(<HeatmapViewer matrix={matrix()} />)
    // 6 cells + 1 background rect.
    const rects = [...container.querySelectorAll('rect')]
    expect(rects.length).toBeGreaterThanOrEqual(7)
  })

  it('labels both axes', () => {
    render(<HeatmapViewer matrix={matrix()} />)
    expect(screen.getByText('LC4')).toBeTruthy()
    expect(screen.getByText('DNp02')).toBeTruthy()
    expect(screen.getByText('PVLP002')).toBeTruthy()
  })

  it('draws cell values only when they are switched on', () => {
    // Scoped to the SVG: the colour-bar caption always prints the value *range*, so
    // checking the whole container would find "0.7" either way.
    const cellText = (c: HTMLElement) =>
      [...(c.querySelector('svg')?.querySelectorAll('text') ?? [])]
        .map((t) => t.textContent ?? '')
        .join('|')

    const withValues = render(<HeatmapViewer matrix={matrix()} showValues />)
    expect(cellText(withValues.container)).toContain('0.7')
    withValues.unmount()

    const without = render(<HeatmapViewer matrix={matrix()} />)
    expect(cellText(without.container)).not.toContain('0.7')
  })

  it('omits zero-valued cell labels so empty pairs stay quiet', () => {
    const { container } = render(<HeatmapViewer matrix={matrix()} showValues />)
    const labels = [...(container.querySelector('svg')?.querySelectorAll('text') ?? [])].map(
      (t) => t.textContent,
    )
    // LC6 → DNp02 is 0 in the fixture; a "0" in every empty cell is chart noise.
    expect(labels).not.toContain('0')
  })

  it('refuses to draw an unreasonably large matrix and says what to do', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `r${i}`)
    const cols = Array.from({ length: 200 }, (_, i) => `c${i}`)
    render(<HeatmapViewer matrix={makeMatrix(rows, cols, new Float64Array(40_000))} />)
    expect(screen.getByText(/too large to draw/)).toBeTruthy()
    expect(screen.getByText(/Aggregate upstream/)).toBeTruthy()
  })

  it('reports an empty matrix', () => {
    render(<HeatmapViewer matrix={makeMatrix([], [], new Float64Array(0))} />)
    expect(screen.getByText(/Matrix is empty/)).toBeTruthy()
  })
})

describe('TableViewer', () => {
  it('renders headers with units and right-aligns numeric cells', () => {
    const { container } = render(<TableViewer table={roiTable()} />)
    expect(screen.getByText('sum_post')).toBeTruthy()
    expect(screen.getByText('synapses')).toBeTruthy()
    const numericCells = container.querySelectorAll('td[data-numeric="true"]')
    expect(numericCells.length).toBe(4)
    expect(screen.getByText('900')).toBeTruthy()
  })

  it('pages through the rows and reports the window', () => {
    const big = tableFromRows(
      ROI_SCHEMA,
      Array.from({ length: 50 }, (_, i) => ({ roi: `r${i}`, type: 't', sum_post: i })),
    )
    const { container } = render(<TableViewer table={big} pageSize={10} />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(10)
    expect(screen.getByText('1–10 of 50')).toBeTruthy()
  })

  it('marks nulls rather than printing "null"', () => {
    const withNull = tableFromRows(ROI_SCHEMA, [{ roi: 'CA(R)', type: 'KC', sum_post: null }])
    const { container } = render(<TableViewer table={withNull} />)
    expect(container.querySelector('td[data-null="true"]')?.textContent).toBe('—')
  })
})

describe('TableViewer paging', () => {
  const numbered = (count: number) =>
    tableFromRows(
      ROI_SCHEMA,
      Array.from({ length: count }, (_, i) => ({ roi: `r${i}`, type: 't', sum_post: i })),
    )

  const firstCell = (container: HTMLElement) =>
    container.querySelector('tbody tr td')?.textContent

  it('walks forward and back through pages', () => {
    const { container } = render(<TableViewer table={numbered(50)} pageSize={10} />)
    expect(firstCell(container)).toBe('r0')

    fireEvent.click(screen.getByLabelText('Next page'))
    expect(screen.getByText('11–20 of 50')).toBeTruthy()
    expect(firstCell(container)).toBe('r10')

    fireEvent.click(screen.getByLabelText('Previous page'))
    expect(firstCell(container)).toBe('r0')
  })

  it('jumps to first and last', () => {
    const { container } = render(<TableViewer table={numbered(50)} pageSize={10} />)
    fireEvent.click(screen.getByLabelText('Last page'))
    expect(screen.getByText('41–50 of 50')).toBeTruthy()
    expect(firstCell(container)).toBe('r40')

    fireEvent.click(screen.getByLabelText('First page'))
    expect(screen.getByText('1–10 of 50')).toBeTruthy()
  })

  it('disables the edge buttons at the ends', () => {
    render(<TableViewer table={numbered(50)} pageSize={10} />)
    expect((screen.getByLabelText('First page') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByLabelText('Last page'))
    expect((screen.getByLabelText('Next page') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Last page') as HTMLButtonElement).disabled).toBe(true)
  })

  it('handles a final short page and an empty table', () => {
    render(<TableViewer table={numbered(25)} pageSize={10} />)
    fireEvent.click(screen.getByLabelText('Last page'))
    expect(screen.getByText('21–25 of 25')).toBeTruthy()

    cleanup()
    render(<TableViewer table={numbered(0)} pageSize={10} />)
    expect(screen.getByText('0 rows')).toBeTruthy()
    expect(screen.getByText('no rows')).toBeTruthy()
  })

  it('changes page size and returns to the first page', () => {
    const { container } = render(<TableViewer table={numbered(50)} pageSize={10} />)
    fireEvent.click(screen.getByLabelText('Next page'))
    expect(firstCell(container)).toBe('r10')

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '25' } })
    expect(screen.getByText('1–25 of 50')).toBeTruthy()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25)
  })

  it('clamps the page when the table shrinks underneath it', () => {
    const { rerender } = render(<TableViewer table={numbered(50)} pageSize={10} />)
    fireEvent.click(screen.getByLabelText('Last page'))
    expect(screen.getByText('41–50 of 50')).toBeTruthy()

    // An upstream filter cut the data; the viewer must not sit on a page that is gone.
    rerender(<TableViewer table={numbered(12)} pageSize={10} />)
    expect(screen.getByText('1–10 of 12')).toBeTruthy()
  })
})

describe('TableViewer sorting', () => {
  const unsorted = () =>
    tableFromRows(ROI_SCHEMA, [
      { roi: 'b', type: 't', sum_post: 20 },
      { roi: 'c', type: 't', sum_post: 5 },
      { roi: 'a', type: 't', sum_post: null },
    ])

  const columnValues = (container: HTMLElement, index: number) =>
    [...container.querySelectorAll('tbody tr')].map(
      (row) => row.querySelectorAll('td')[index]?.textContent,
    )

  it('cycles ascending, descending, then back to source order', () => {
    const { container } = render(<TableViewer table={unsorted()} />)
    const header = screen.getByText('sum_post').closest('th')!

    fireEvent.click(header)
    // Nulls sort last in both directions — absence is not an extreme.
    expect(columnValues(container, 2)).toEqual(['5', '20', '—'])
    expect(header.getAttribute('aria-sort')).toBe('ascending')

    fireEvent.click(header)
    expect(columnValues(container, 2)).toEqual(['20', '5', '—'])
    expect(header.getAttribute('aria-sort')).toBe('descending')

    fireEvent.click(header)
    // Third click restores exactly what the graph produced.
    expect(columnValues(container, 2)).toEqual(['20', '5', '—'])
    expect(columnValues(container, 0)).toEqual(['b', 'c', 'a'])
    expect(header.getAttribute('aria-sort')).toBe('none')
  })

  it('sorts text with locale collation', () => {
    const { container } = render(<TableViewer table={unsorted()} />)
    fireEvent.click(screen.getByText('roi').closest('th')!)
    expect(columnValues(container, 0)).toEqual(['a', 'b', 'c'])
  })

  it('says the sort is view-only, since downstream nodes are unaffected', () => {
    render(<TableViewer table={unsorted()} />)
    expect(screen.queryByText('sorted view only')).toBeNull()
    fireEvent.click(screen.getByText('roi').closest('th')!)
    expect(screen.getByText('sorted view only')).toBeTruthy()
  })

  it('resets to page one when the sort changes', () => {
    const many = tableFromRows(
      ROI_SCHEMA,
      Array.from({ length: 40 }, (_, i) => ({ roi: `r${i}`, type: 't', sum_post: i })),
    )
    render(<TableViewer table={many} pageSize={10} />)
    fireEvent.click(screen.getByLabelText('Next page'))
    expect(screen.getByText('11–20 of 40')).toBeTruthy()
    fireEvent.click(screen.getByText('sum_post').closest('th')!)
    expect(screen.getByText('1–10 of 40')).toBeTruthy()
  })
})

describe('viewer downloads', () => {
  let capture: ReturnType<typeof installDownloadCapture>

  beforeEach(() => {
    capture = installDownloadCapture()
  })
  afterEach(() => capture.restore())

  it('downloads a table as CSV with the given filename', async () => {
    render(<TableViewer table={roiTable()} baseName="my-graph_table" />)
    fireEvent.click(screen.getByLabelText('Download CSV data'))

    expect(capture.downloads).toHaveLength(1)
    expect(capture.downloads[0]!.filename).toBe('my-graph_table.csv')
    const text = await capture.downloads[0]!.text()
    expect(text.split('\n')[0]).toBe('roi,type,sum_post')
    expect(text).toContain('CA(R),KCg-m,900')
  })

  it('offers CSV, SVG and PNG for a chart', () => {
    render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        baseName="bars"
      />,
    )
    fireEvent.click(screen.getByLabelText('Download'))
    expect(screen.getByText('CSV data')).toBeTruthy()
    expect(screen.getByText('SVG vector')).toBeTruthy()
    expect(screen.getByText('PNG image')).toBeTruthy()
  })

  it('exports a heatmap as wide CSV', async () => {
    render(
      <HeatmapViewer
        matrix={makeMatrix(['LC4'], ['DNp02', 'DNp11'], Float64Array.from([40, 12]))}
        baseName="matrix"
      />,
    )
    fireEvent.click(screen.getByLabelText('Download'))
    fireEvent.click(screen.getByText('CSV data'))

    expect(capture.downloads[0]!.filename).toBe('matrix.csv')
    expect(await capture.downloads[0]!.text()).toBe(',DNp02,DNp11\nLC4,40,12\n')
  })

  it('exports a chart as SVG', async () => {
    render(
      <BarChartViewer
        table={roiTable()}
        categoryColumn="roi"
        valueColumn="sum_post"
        baseName="bars"
      />,
    )
    fireEvent.click(screen.getByLabelText('Download'))
    fireEvent.click(screen.getByText('SVG vector'))

    expect(capture.downloads[0]!.filename).toBe('bars.svg')
    const text = await capture.downloads[0]!.text()
    expect(text).toContain('<svg')
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('shows an expand button only when the viewer can be enlarged', () => {
    const withExpand = render(<TableViewer table={roiTable()} onExpand={() => {}} />)
    expect(screen.getByLabelText('Expand viewer')).toBeTruthy()
    withExpand.unmount()

    render(<TableViewer table={roiTable()} />)
    expect(screen.queryByLabelText('Expand viewer')).toBeNull()
  })

  it('calls onExpand when clicked', () => {
    const onExpand = vi.fn()
    render(<TableViewer table={roiTable()} onExpand={onExpand} />)
    fireEvent.click(screen.getByLabelText('Expand viewer'))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})
