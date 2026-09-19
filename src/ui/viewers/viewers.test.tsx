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

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { CRASH_FLOOR_CELLS } from '../../core/limits'
import { column, tableSchema } from '../../core/types'
import type { MatrixValue } from '../../core/values'
import { makeMatrix, tableFromRows } from '../../core/values'
import { MAX_BAR_THICKNESS, SURFACE_GAP } from '../colors'
import { installDownloadCapture, installJsdomStubs } from '../../test/jsdomStubs'
import { BarChartViewer } from './BarChartViewer'
import { HeatmapViewer } from './HeatmapViewer'
import { HEATMAP_CELLS_WARN } from './heatmapPlot'
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

  it('paints the cells to a canvas and keeps the labels as real text', () => {
    const { container } = render(<HeatmapViewer matrix={matrix()} />)
    // The cells are unbounded — a matrix can be millions — so they go to a canvas. The axis
    // labels are bounded by pixels however large the matrix is, so they stay in the DOM,
    // where they can be selected, found and read aloud.
    expect(container.querySelector('canvas')).toBeTruthy()
    expect(container.querySelector('.heatmap-overlay')).toBeTruthy()
    expect(screen.getByText('LC4')).toBeTruthy()
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

  it('draws a matrix the old per-cell rendering refused, and says it merged cells', () => {
    // 200 x 200 = 40,000 was refused outright when every cell was its own <rect>. It is now
    // simply a picture; a matrix with more cells than the plot has pixels is folded, and the
    // caption says so rather than the viewer quietly showing a subset.
    const big = (n: number) =>
      makeMatrix(
        Array.from({ length: n }, (_, i) => `r${i}`),
        Array.from({ length: n }, (_, i) => `c${i}`),
        Float64Array.from({ length: n * n }, (_, i) => i % 7),
      )

    const drawn = render(<HeatmapViewer matrix={big(200)} />)
    expect(screen.queryByText(/too large to draw/)).toBeNull()
    expect(drawn.container.querySelector('canvas')).toBeTruthy()
    // 200 rows against a 400px-tall stub: labels cannot all fit, and the caption admits it.
    expect(screen.getByText('labels thinned')).toBeTruthy()
    drawn.unmount()

    render(<HeatmapViewer matrix={big(1_000)} />)
    expect(screen.getByText('cells merged')).toBeTruthy()
  })

  it('draws a matrix past the old ceiling, and says it is a large one', () => {
    /*
     * Four million cells was the refusal until the measurement in `heatmapPlot.ts` was read
     * back: paint tracks the *grid* rather than the matrix, so this costs one slower fold on
     * first layout and nothing per frame. A 2,000-square NBLAST is exactly the picture this
     * viewer exists for.
     */
    const labels = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`)
    const side = 2_100
    const matrix = makeMatrix(
      labels('r', side),
      labels('c', side),
      new Float64Array(side * side),
    )
    expect(side * side).toBeGreaterThan(HEATMAP_CELLS_WARN)

    render(<HeatmapViewer matrix={matrix} />)
    expect(screen.queryByText(/more than a browser can hold/)).toBeNull()
    expect(screen.getByText('large matrix')).toBeTruthy()
  })

  it('zooms on the wheel where the card is the surface, and fits again on ⤢', async () => {
    /*
     * The gesture is a native listener the stub box can receive: a wheel with negative deltaY
     * zooms in about the pointer, the caption admits the magnification, and Fit clears it. Only
     * off the canvas — the compact card is a preview React Flow already zooms.
     */
    const { container } = render(<HeatmapViewer matrix={matrix()} />)
    const box = container.querySelector('.heatmap-plot')!
    // The magnification note, as distinct from the "2 × 3" shape the caption always prints.
    const zoomNote = () =>
      [...container.querySelectorAll('.viewer__note')].find((n) =>
        n.textContent?.startsWith('×'),
      )
    expect(screen.getByLabelText('Fit to view')).toBeTruthy()
    expect(zoomNote()).toBeUndefined()

    // A raw dispatch, because the listener is native rather than React's — under `act`, and
    // waiting a frame, because wheel events are coalesced to one update per animation frame.
    await act(async () => {
      box.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -600, clientX: 300, clientY: 200, bubbles: true }),
      )
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 20)
      })
    })
    expect(zoomNote()?.textContent).toBe('×2.5')

    fireEvent.click(screen.getByLabelText('Fit to view'))
    expect(zoomNote()).toBeUndefined()
  })

  it('offers no zoom on the compact card', () => {
    render(<HeatmapViewer matrix={matrix()} compact />)
    expect(screen.queryByLabelText('Fit to view')).toBeNull()
  })

  it('still refuses the one shape a browser cannot hold as a grid', () => {
    /*
     * Built by hand rather than through `makeMatrix`, which checks that the values are all
     * there — this is a test about the *labels*, and allocating the 536 MB it describes to
     * prove that would be a test costing more than the thing it guards. Same call
     * `linkageOps.test.ts` makes about its own floor.
     */
    const labels = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`)
    const side = Math.ceil(Math.sqrt(CRASH_FLOOR_CELLS)) + 1
    const matrix: MatrixValue = {
      kind: 'matrix',
      rowLabels: labels('r', side),
      colLabels: labels('c', side),
      values: new Float64Array(0),
    }
    expect(side * side).toBeGreaterThan(CRASH_FLOOR_CELLS)

    render(<HeatmapViewer matrix={matrix} />)
    expect(screen.getByText(/more than a browser can hold/)).toBeTruthy()
    expect(screen.getByText(/Aggregate upstream/)).toBeTruthy()
  })

  it('reports an empty matrix', () => {
    render(<HeatmapViewer matrix={makeMatrix([], [], new Float64Array(0))} />)
    expect(screen.getByText(/Matrix is empty/)).toBeTruthy()
  })

  /*
   * The circle mark. The geometry is pinned headlessly in `heatmapPlot.test.ts`; what is here is
   * that the choice reaches both renderers and that the refusal is *said* rather than silent.
   */
  describe('circles sized by value', () => {
    /** Four rows of four, values 0..15, so the ramp is exercised and cell 0 is neutral. */
    const ramped = () =>
      makeMatrix(
        ['a', 'b', 'c', 'd'],
        ['w', 'x', 'y', 'z'],
        Float64Array.from({ length: 16 }, (_, i) => i),
      )
    // The SVG export is the one handle on the drawing without a browser: jsdom's canvas stub
    // accepts every call and records nothing, so the cells are observable nowhere else.
    let capture: ReturnType<typeof installDownloadCapture>
    beforeEach(() => {
      capture = installDownloadCapture()
    })
    afterEach(() => capture.restore())

    const exported = async (): Promise<string> => {
      fireEvent.click(screen.getByLabelText('Download'))
      fireEvent.click(screen.getByText('SVG vector'))
      return capture.downloads[capture.downloads.length - 1]!.text()
    }

    it('exports arcs where squares export corners', async () => {
      render(<HeatmapViewer matrix={ramped()} cellShape="circle" baseName="m" />)
      const text = await exported()
      // `a` is the arc command; two half turns, since SVG has no full-turn arc.
      expect(text).toMatch(/d="M[^"]*a[\d.]+,[\d.]+ 0 1,0/)
      expect(text).not.toContain('h-')
    })

    it('still exports corners for squares, so the choice actually reaches the file', async () => {
      render(<HeatmapViewer matrix={ramped()} baseName="m" />)
      const text = await exported()
      expect(text).toContain('h-')
      expect(text).not.toMatch(/ 0 1,0 /)
    })

    it('draws nothing for a cell at the neutral end', async () => {
      /*
       * The decision this mark rests on: radius runs to zero, so an empty pair is an empty cell
       * and a sparse matrix reads as sparse. 16 cells, one of them 0 — so 15 arcs.
       */
      render(<HeatmapViewer matrix={ramped()} cellShape="circle" baseName="m" />)
      const text = await exported()
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const arcs = [...doc.querySelectorAll('path')]
        .map((path) => (path.getAttribute('d') ?? '').split('M').length - 1)
        .reduce((a, b) => a + b, 0)
      expect(arcs).toBe(15)
    })

    it('says so when the cells are too small, on a card as well as expanded', () => {
      /*
       * Not stood down under `compact`, which every other note here is: this one is about a
       * *control* rather than about the picture, and the card is where it will nearly always
       * fire — a preview plot is a couple of hundred pixels for however many rows.
       */
      const dense = makeMatrix(
        Array.from({ length: 120 }, (_, i) => `r${i}`),
        Array.from({ length: 120 }, (_, i) => `c${i}`),
        Float64Array.from({ length: 14_400 }, (_, i) => i % 9),
      )
      const { container } = render(<HeatmapViewer matrix={dense} cellShape="circle" compact />)
      const notes = [...container.querySelectorAll('.viewer__note')].map((n) => n.textContent)
      expect(notes).toContain('too dense for circles')
    })

    it('says nothing when the circles were drawn', () => {
      const { container } = render(<HeatmapViewer matrix={ramped()} cellShape="circle" />)
      const notes = [...container.querySelectorAll('.viewer__note')].map((n) => n.textContent)
      expect(notes).not.toContain('too dense for circles')
    })
  })

  /*
   * The gestures themselves need a browser — jsdom lays nothing out, so `pnpm
   * probe:heatmap-select` is what says a dragged box names the lines under it. What is pinned
   * here is the *wiring* underneath: which chord reaches which branch, and that the surface
   * offers the gesture at all. Both are things a refactor can break with the probe not run.
   */
  describe('the selection chords', () => {
    /** The press and release of one click, at a point the stub's 800x400 box puts in the plot. */
    const clickAt = (box: Element, modifiers: Partial<PointerEventInit> = {}) => {
      const at = { clientX: 400, clientY: 200, button: 0, pointerId: 1, ...modifiers }
      fireEvent.pointerDown(box.querySelector('canvas')!, at)
      fireEvent.pointerUp(box.querySelector('canvas')!, at)
    }
    const plot = (container: HTMLElement) => container.querySelector('.heatmap-plot')!

    it('adds the cell under a shift+⌘ click, without a drag', () => {
      const onSelectionChange = vi.fn()
      const { container } = render(
        <HeatmapViewer matrix={matrix()} onSelectionChange={onSelectionChange} />,
      )
      clickAt(plot(container), { shiftKey: true, metaKey: true })
      // One row and one column: a cell, which is what the two independent axis lists make of
      // one. Which line it is depends on the stub's geometry and is the probe's question.
      const ids = onSelectionChange.mock.calls.at(-1)?.[0] as string[]
      expect(ids.filter((id) => id.startsWith('r:'))).toHaveLength(1)
      expect(ids.filter((id) => id.startsWith('c:'))).toHaveLength(1)
    })

    it('adds to what is already there rather than replacing it', () => {
      const onSelectionChange = vi.fn()
      const { container } = render(
        <HeatmapViewer
          matrix={matrix()}
          selection={['r:0', 'c:0']}
          onSelectionChange={onSelectionChange}
        />,
      )
      clickAt(plot(container), { shiftKey: true, ctrlKey: true })
      const ids = onSelectionChange.mock.calls.at(-1)?.[0] as string[]
      // What was there survives, and the click's own cell — the centre of a 2 x 3, which is
      // neither row 0 nor column 0 — is beside it. A replace would have left two entries.
      expect(ids).toContain('r:0')
      expect(ids).toContain('c:0')
      expect(ids.length).toBeGreaterThan(2)
    })

    it('still clears on a bare shift click, which is now the only way the plot clears', () => {
      const onSelectionChange = vi.fn()
      const { container } = render(
        <HeatmapViewer
          matrix={matrix()}
          selection={['r:0', 'c:0']}
          onSelectionChange={onSelectionChange}
        />,
      )
      clickAt(plot(container), { shiftKey: true })
      expect(onSelectionChange).toHaveBeenLastCalledWith([])
    })

    it('leaves a bare click alone — it is the start of a pan, not a request to lose a selection', () => {
      const onSelectionChange = vi.fn()
      const { container } = render(
        <HeatmapViewer
          matrix={matrix()}
          selection={['r:0', 'c:0']}
          onSelectionChange={onSelectionChange}
        />,
      )
      clickAt(plot(container))
      expect(onSelectionChange).not.toHaveBeenCalled()
    })

    it('selects on the compact card, where only the expanded view used to', () => {
      const onSelectionChange = vi.fn()
      const { container } = render(
        <HeatmapViewer matrix={matrix()} compact onSelectionChange={onSelectionChange} />,
      )
      clickAt(plot(container), { shiftKey: true, metaKey: true })
      expect(onSelectionChange).toHaveBeenCalled()
      // Zoom and pan stay expanded-only: it is selecting that moved, not the whole surface.
      expect(screen.queryByLabelText('Fit to view')).toBeNull()
    })

    it('carries nokey, or React Flow’s pane takes the press before the card sees it', () => {
      // `selectionKeyCode="Shift"` makes the pane claim a shift-press anywhere inside it,
      // capture the pointer and stop propagation in the capture phase. `.nokey` is the
      // library's own opt-out and is the whole of why selecting on a card works.
      const { container } = render(<HeatmapViewer matrix={matrix()} compact />)
      expect(plot(container).classList.contains('nokey')).toBe(true)
    })

    it('says how much is selected on a card, where the bands cannot', () => {
      const { container } = render(
        <HeatmapViewer matrix={matrix()} compact selection={['r:0', 'c:1', 'c:2']} />,
      )
      const notes = [...container.querySelectorAll('.viewer__note')].map((n) => n.textContent)
      expect(notes).toContain('1 × 2 selected')
    })

    it('draws each band twice — a core over a casing, and the casing underneath all of them', () => {
      /*
       * Two layers rather than two rects per band, so one band's casing cannot overdraw its
       * neighbour's core. The contrast that makes the pair necessary is measured in
       * `encoding.test.ts`; what is pinned here is that both layers exist, carry the same
       * geometry, and keep `data-axis` — `pnpm probe:heatmap-select` counts bands off the core
       * layer alone and would double every count if this collapsed back to one.
       */
      const { container } = render(
        <HeatmapViewer matrix={matrix()} selection={['r:0', 'c:1']} />,
      )
      const rects = (cls: string) => [...container.querySelectorAll(`${cls} rect`)]
      const core = rects('.heatmap-band__core')
      const casing = rects('.heatmap-band__case')
      expect(core.length).toBe(2)
      expect(casing.length).toBe(core.length)
      expect(core.map((r) => r.getAttribute('data-axis'))).toEqual(['rows', 'columns'])
      expect(casing.map((r) => r.getAttribute('x'))).toEqual(
        core.map((r) => r.getAttribute('x')),
      )
      // The casing is painted first, so every core sits above every casing.
      const band = container.querySelector('.heatmap-band')!
      expect(band.firstElementChild?.getAttribute('class')).toBe('heatmap-band__case')
    })

    it('marks a card compact, which is what thins the band', () => {
      /*
       * The widths themselves are CSS and jsdom resolves no stylesheet, so what is checkable
       * here is the hook they hang off: a preview plot is a couple of hundred pixels across with
       * cells two or three wide, and a band sized for the expanded view covers several rows of
       * what it points at. Measured in a browser — card 3px casing under a 1px core, expanded
       * 4 under 2, the casing staying exactly 2px wider either way so its edge stays crisp.
       */
      const { container: card } = render(<HeatmapViewer matrix={matrix()} compact />)
      expect(plot(card).classList.contains('heatmap-plot--compact')).toBe(true)
      cleanup()
      const { container: big } = render(<HeatmapViewer matrix={matrix()} />)
      expect(plot(big).classList.contains('heatmap-plot--compact')).toBe(false)
    })

    it('has no clear button left in the strip', () => {
      // Three better spellings already: a shift-click on the plot, the Selection tab's field,
      // and — for a rectangle — drawing a new one. The ⤢ beside it stays; it resets the zoom.
      render(
        <HeatmapViewer matrix={matrix()} selection={['r:0']} onSelectionChange={vi.fn()} />,
      )
      expect(screen.queryByLabelText('Clear selection')).toBeNull()
      expect(screen.getByLabelText('Fit to view')).toBeTruthy()
    })
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

  /**
   * A neuron id is a name, so it is printed as it would be typed back — while the count in the
   * column beside it keeps its separator. Asserted here rather than only in `format.test.ts`
   * because the rule is worth nothing until the column name reaches it, and a cell rendering
   * `formatCell(cell)` with the name dropped fails no type check.
   */
  it('prints ids verbatim and quantities grouped, in the same row', () => {
    const schema = tableSchema(column('neuronId', 'i64'), column('post', 'i64', 'synapses'))
    const { container } = render(
      <TableViewer table={tableFromRows(schema, [{ neuronId: 527536, post: 527536 }])} />,
    )
    const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent)
    expect(cells).toEqual(['527536', '527,536'])
    // And the hover agrees with what is drawn, which it did not before.
    const idCell = container.querySelector('tbody td')
    expect(idCell?.getAttribute('title')).toBe(idCell?.textContent)
  })
})

/**
 * The filter row.
 *
 * The semantics are `tableFilter.test.ts`'s; what is asserted here is the *wiring*, which is
 * where this can silently stop working: a control that edits a draft and never commits, a
 * commit that fires per keystroke, or a caption that reports the whole table while showing a
 * subset. None of those fail a type check and all three look fine in a screenshot.
 */
describe('TableViewer filtering', () => {
  const NEURONS = tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('pre', 'i64'),
  )
  const neurons = () =>
    tableFromRows(NEURONS, [
      { neuronId: 1, type: 'LC4', pre: 40 },
      { neuronId: 2, type: 'LC6', pre: 5 },
      { neuronId: 3, type: 'DNp01', pre: 100 },
    ])

  const cell = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="Filter ${name}"]`)

  const neuronIds = (container: HTMLElement) =>
    [...container.querySelectorAll('tbody tr')].map(
      (row) => row.querySelector('td')?.textContent,
    )

  it('shows no filter controls at all without a way to store them', () => {
    // This component draws every table in the app; only `out.table` has a port for the result,
    // so a Filter node's own preview must not grow a control that writes a param it lacks.
    const { container } = render(<TableViewer table={neurons()} />)
    expect(cell(container, 'type')).toBeNull()
    expect(screen.queryByLabelText(/filter row/i)).toBeNull()
  })

  it('filters the drawn rows on the keystroke, before anything is committed', () => {
    const onFiltersChange = vi.fn()
    const { container } = render(
      <TableViewer
        table={neurons()}
        filters={[]}
        onFiltersChange={onFiltersChange}
        showFilters
      />,
    )
    fireEvent.change(cell(container, 'type')!, { target: { value: 'LC' } })
    expect(neuronIds(container)).toEqual(['1', '2'])
    // The param follows the pause, not the keystroke — see COMMIT_DELAY_MS.
    expect(onFiltersChange).not.toHaveBeenCalled()
  })

  it('commits once for a burst of typing', async () => {
    vi.useFakeTimers()
    try {
      const onFiltersChange = vi.fn()
      const { container } = render(
        <TableViewer
          table={neurons()}
          filters={[]}
          onFiltersChange={onFiltersChange}
          showFilters
        />,
      )
      const field = cell(container, 'type')!
      fireEvent.change(field, { target: { value: 'L' } })
      fireEvent.change(field, { target: { value: 'LC' } })
      fireEvent.change(field, { target: { value: 'LC4' } })
      act(() => void vi.advanceTimersByTime(500))
      expect(onFiltersChange).toHaveBeenCalledTimes(1)
      expect(onFiltersChange).toHaveBeenLastCalledWith([{ column: 'type', expression: 'LC4' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('says how many rows of how many, beside the sort note that means something else', () => {
    const { container } = render(
      <TableViewer
        table={neurons()}
        filters={[{ column: 'pre', expression: '>=40' }]}
        onFiltersChange={() => {}}
      />,
    )
    // The filter changed the data and reports in rows; the sort changed only the view and says
    // so in words. Two controls that look alike, told apart in the one place a reader looks.
    expect(screen.getByText('2 of 3 rows')).toBeTruthy()
    expect(screen.queryByText('sorted view only')).toBeNull()
    fireEvent.click(screen.getByText('neuronId'))
    expect(screen.getByText('sorted view only')).toBeTruthy()
    expect(screen.getByText('2 of 3 rows')).toBeTruthy()
    // Paging counts what survived, not what arrived.
    expect(screen.getByText('1–2 of 2')).toBeTruthy()
    expect(neuronIds(container)).toEqual(['1', '3'])
  })

  it('opens the row for a filter that is already set, and refuses to hide it', () => {
    // A filtered table must always show why it is short; clearing the cells is what closes it.
    const { container } = render(
      <TableViewer
        table={neurons()}
        filters={[{ column: 'type', expression: 'LC' }]}
        onFiltersChange={() => {}}
        showFilters={false}
      />,
    )
    expect(cell(container, 'type')?.value).toBe('LC')
    expect(screen.getByLabelText(/filter row/i).hasAttribute('disabled')).toBe(true)
  })

  it('marks a clause it cannot apply rather than emptying the table', () => {
    const { container } = render(
      <TableViewer
        table={neurons()}
        filters={[{ column: 'type', expression: '~^LC[' }]}
        onFiltersChange={() => {}}
      />,
    )
    expect(cell(container, 'type')?.getAttribute('data-invalid')).toBe('true')
    // Dropped, so every row survives — a broken clause shows more rows, never fewer.
    expect(neuronIds(container)).toEqual(['1', '2', '3'])
  })

  it('distinguishes an empty result from an empty input', () => {
    const { rerender } = render(
      <TableViewer
        table={neurons()}
        filters={[{ column: 'type', expression: '==nothing' }]}
        onFiltersChange={() => {}}
      />,
    )
    expect(screen.getByText('no rows match the filters')).toBeTruthy()
    rerender(
      <TableViewer
        table={tableFromRows(NEURONS, [])}
        filters={[]}
        onFiltersChange={() => {}}
      />,
    )
    expect(screen.getByText('no rows')).toBeTruthy()
  })

  it('exports what is on screen', async () => {
    const capture = installDownloadCapture()
    try {
      render(
        <TableViewer
          table={neurons()}
          filters={[{ column: 'type', expression: '==LC4' }]}
          onFiltersChange={() => {}}
          baseName="neurons"
        />,
      )
      fireEvent.click(screen.getByTitle(/CSV/i))
      const text = await capture.downloads[0]!.text()
      // The button has always exported the table it was drawing. Now that the drawing can be a
      // subset, exporting the whole input would make it disagree with the rows above it.
      expect(text).toContain('LC4')
      expect(text).not.toContain('DNp01')
    } finally {
      capture.restore()
    }
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
    // The name is the sort target and the `th` carries `aria-sort`, because the cell also
    // holds a filter field that must not sort when it is clicked.
    const name = screen.getByText('sum_post')
    const header = name.closest('th')!

    fireEvent.click(name)
    // Nulls sort last in both directions — absence is not an extreme.
    expect(columnValues(container, 2)).toEqual(['5', '20', '—'])
    expect(header.getAttribute('aria-sort')).toBe('ascending')

    fireEvent.click(name)
    expect(columnValues(container, 2)).toEqual(['20', '5', '—'])
    expect(header.getAttribute('aria-sort')).toBe('descending')

    fireEvent.click(name)
    // Third click restores exactly what the graph produced.
    expect(columnValues(container, 2)).toEqual(['20', '5', '—'])
    expect(columnValues(container, 0)).toEqual(['b', 'c', 'a'])
    expect(header.getAttribute('aria-sort')).toBe('none')
  })

  it('sorts text with locale collation', () => {
    const { container } = render(<TableViewer table={unsorted()} />)
    fireEvent.click(screen.getByText('roi'))
    expect(columnValues(container, 0)).toEqual(['a', 'b', 'c'])
  })

  it('says the sort is view-only, since downstream nodes are unaffected', () => {
    render(<TableViewer table={unsorted()} />)
    expect(screen.queryByText('sorted view only')).toBeNull()
    fireEvent.click(screen.getByText('roi'))
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
    fireEvent.click(screen.getByText('sum_post'))
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

  it('exports a heatmap as SVG, one subpath per drawn cell', async () => {
    /*
     * jsdom has no canvas beyond the accept-everything stub, so the cells are not observable on
     * screen — the SVG the same spec produces is the only handle on the drawing without a
     * browser, exactly as `networkDraw.test.ts` is for the network.
     */
    render(
      <HeatmapViewer
        matrix={makeMatrix(
          ['LC4', 'LC6'],
          ['DNp02', 'DNp11', 'PVLP002'],
          Float64Array.from([0.7, 0.2, 0.1, 0, 0.4, 0.6]),
        )}
        baseName="matrix"
      />,
    )
    fireEvent.click(screen.getByLabelText('Download'))
    fireEvent.click(screen.getByText('SVG vector'))

    const text = await capture.downloads[0]!.text()
    expect(capture.downloads[0]!.filename).toBe('matrix.svg')
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"')
    // A path per ramp bucket carrying a subpath per cell, never a <rect> per cell: at one cell
    // per pixel a full-width plot is ~285,000 of them, which is a file nothing opens.
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const subpaths = [...doc.querySelectorAll('path')]
      .map((path) => (path.getAttribute('d') ?? '').split('M').length - 1)
      .reduce((a, b) => a + b, 0)
    expect(subpaths).toBe(6)
    // The axis names travel with it.
    expect(text).toContain('PVLP002')
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
