// @vitest-environment jsdom
/**
 * The Line Chart, rendered: a path per line, the legend and caption saying what is drawn and what
 * is not, the crosshair reading every line at one X, and the zoom along X going back on a
 * double-click. jsdom lays nothing out, so the stubbed 800 × 400 box stands in for the card; how it
 * looks is a browser question.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { LineChartViewer } from './LineChartViewer'

beforeAll(() => installJsdomStubs({ width: 800, height: 400 }))
afterEach(cleanup)

/** Simulate's shape: time, the soma, one record site with a missing sample. */
const TRACES = makeTable(
  tableSchema(column('t', 'f64'), column('soma', 'f64'), column('tip', 'f64')),
  {
    t: [0, 1, 2, 3, 4],
    soma: [-60, -58, -50, -55, -60],
    tip: [-60, -40, null, -45, -60],
  },
)

/** The drawn lines: paths inside the plot's clip group. */
const paths = (container: HTMLElement) => [...container.querySelectorAll('g[clip-path] path')]

describe('LineChartViewer', () => {
  it('draws one line per Y, keys them, and counts what it could not draw', () => {
    const { container } = render(<LineChartViewer table={TRACES} x="t" ys={['soma', 'tip']} />)
    expect(paths(container)).toHaveLength(2)
    expect(screen.getByText('2 lines · 9 points')).toBeTruthy()
    expect(screen.getByText('soma')).toBeTruthy()
    expect(screen.getByText('1 not plotted')).toBeTruthy()
  })

  it('draws no key for a single line', () => {
    const { container } = render(<LineChartViewer table={TRACES} x="t" ys={['soma']} />)
    expect(paths(container)).toHaveLength(1)
    expect(container.querySelector('.legend__item')).toBeNull()
  })

  it('reads every line at the X under the pointer', () => {
    const { container } = render(<LineChartViewer table={TRACES} x="t" ys={['soma', 'tip']} />)
    // Three quarters of the way across a plot that runs from t = 0 to 4, scaled by the stub's
    // card zoom as every pointer test here is.
    const zoom = 800 / 1200
    fireEvent.mouseMove(container.querySelector('svg')!, {
      clientX: (54 + (800 - 70) * 0.75) * zoom,
      clientY: 100 * zoom,
    })
    const tooltip = container.querySelector('.chart-tooltip')!
    expect(tooltip.textContent).toMatch(/t 3/)
    expect(tooltip.textContent).toMatch(/soma -55/)
    expect(tooltip.textContent).toMatch(/tip -45/)
  })

  it('marks the cursor at its X, and draws none without one', () => {
    const { container, rerender } = render(
      <LineChartViewer table={TRACES} x="t" ys={['soma']} cursor={2} />,
    )
    const cursors = () => container.querySelectorAll('g[clip-path] line')
    expect(cursors()).toHaveLength(1)
    // Halfway across a plot from t = 0 to 4.
    const x = Number(cursors()[0]!.getAttribute('x1'))
    rerender(<LineChartViewer table={TRACES} x="t" ys={['soma']} cursor={4} />)
    expect(Number(cursors()[0]!.getAttribute('x1'))).toBeGreaterThan(x)
    rerender(<LineChartViewer table={TRACES} x="t" ys={['soma']} />)
    expect(cursors()).toHaveLength(0)
  })

  it('ticks each mark at the foot of the plot, inside the window, labelled', () => {
    const { container } = render(
      <LineChartViewer
        table={TRACES}
        x="t"
        ys={['soma']}
        xMarks={[1, 3, 99]}
        xMarksLabel="input spikes arriving"
      />,
    )
    const marks = [...container.querySelectorAll('g[clip-path] path')].find(
      (path) => path.querySelector('title')?.textContent === 'input spikes arriving',
    )
    // Two inside the data's X range; the one at 99 is off the plot.
    expect(marks?.getAttribute('d')?.match(/M/g)).toHaveLength(2)
  })

  it('draws Y2 dashed against a right axis of its own, and names it in the key', () => {
    const { container } = render(
      <LineChartViewer table={TRACES} x="t" ys={['soma']} y2s={['tip']} />,
    )
    const drawn = paths(container)
    expect(drawn.map((p) => p.getAttribute('stroke-dasharray'))).toEqual([null, '5 3'])
    // The right axis's labels sit beyond the plot, starting there; the left axis's end there.
    const right = [...container.querySelectorAll('text[text-anchor="start"]')].map(
      (t) => t.textContent,
    )
    expect(right).toContain('-40')
    expect(screen.getByText('tip (right)')).toBeTruthy()
    expect(screen.getByText('2 lines · 9 points')).toBeTruthy()
  })

  it('draws a strip under the plot on the same X, with a Y and a label of its own', () => {
    const strip = { label: 'injected', unit: 'nA', x: [0, 1, 2, 3, 4], y: [0, 0, 0.2, 0.2, 0] }
    const { container } = render(
      <LineChartViewer table={TRACES} x="t" ys={['soma']} strip={strip} />,
    )
    expect(screen.getByText('injected (nA)')).toBeTruthy()
    const line = [...container.querySelectorAll('path')].find((p) =>
      p.getAttribute('clip-path')?.endsWith('-strip)'),
    )
    expect(line?.getAttribute('d')?.match(/[ML]/g)).toHaveLength(5)
    // Its zero in its range, and its top the strip's largest value.
    expect(screen.getByText('0.2')).toBeTruthy()
  })

  it('says when there is nothing to draw', () => {
    const empty = makeTable(tableSchema(column('t', 'f64'), column('v', 'f64')), {
      t: [null],
      v: [null],
    })
    render(<LineChartViewer table={empty} x="t" ys={['v']} />)
    expect(screen.getByText(/Nothing to draw: 1 value could not be plotted/)).toBeTruthy()
  })

  it('zooms along X on the wheel, and a double-click goes back to the whole trace', async () => {
    const { container } = render(<LineChartViewer table={TRACES} x="t" ys={['soma']} />)
    const stage = container.querySelector('.viewer__scroll')!
    fireEvent.wheel(stage, { deltaY: -400, clientX: 400, clientY: 200 })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(await screen.findByText('zoomed')).toBeTruthy()
    fireEvent.doubleClick(stage)
    expect(screen.queryByText('zoomed')).toBeNull()
  })
})
