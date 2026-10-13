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
