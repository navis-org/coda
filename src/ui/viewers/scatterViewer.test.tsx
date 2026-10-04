// @vitest-environment jsdom

/**
 * What the scatter card *says*.
 *
 * jsdom has no canvas, so the marks themselves are unreachable here — they are covered by
 * `scatterPlot.test.ts` and `scatterDraw.test.ts` instead. What is reachable, and what this
 * file is for, is the caption: every one of its notes exists because the alternative is a
 * picture that is quietly smaller or thinner than its data with nothing on screen to say so.
 * That is the same rule `labels thinned` and `N nodes, M links filtered` follow.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable, tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ScatterViewer } from './ScatterViewer'

beforeAll(() => installJsdomStubs({ width: 600, height: 400 }))
afterEach(cleanup)

const SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
  column('type', 'str'),
  column('side', 'str'),
)

function neurons(
  count: number,
  overrides: (i: number) => Record<string, unknown> = () => ({}),
) {
  return tableFromRows(
    SCHEMA,
    Array.from({ length: count }, (_, i) => ({
      neuronId: 1000 + i,
      pre: i + 1,
      post: (i + 1) * 2,
      type: i % 2 === 0 ? 'LC4' : 'LC6',
      side: i % 3 === 0 ? 'L' : 'R',
      ...overrides(i),
    })),
    'neurons',
  )
}

function draw(table: TableValue, props: Partial<Parameters<typeof ScatterViewer>[0]> = {}) {
  return render(
    <ScatterViewer
      table={table}
      xColumn="pre"
      yColumn="post"
      xScale="linear"
      yScale="linear"
      aspect="fit"
      color={{ mode: 'constant', column: undefined, constant: '0' }}
      size={{ column: undefined, min: 3, max: 12 }}
      shape={{ mode: 'constant', column: undefined, constant: 'circle' }}
      idColumn="neuronId"
      opacity={0.8}
      trend="none"
      trendPerGroup
      selection={[]}
      {...props}
    />,
  )
}

describe('the caption', () => {
  it('counts the points it could plot', () => {
    draw(neurons(24))
    expect(screen.getByText(/24 points/)).toBeTruthy()
    expect(screen.getByText(/post vs pre/)).toBeTruthy()
  })

  it('draws every point, so there is no sample to admit', () => {
    // Past `CIRCLES_MAX` the canvas writes pixels rather than thinning the rows.
    draw(neurons(12_000))
    expect(screen.getByText(/12,000 points/)).toBeTruthy()
    expect(screen.queryByText(/showing/)).toBeNull()
  })

  it('admits rows it could not place at all', () => {
    // Two rows with a null coordinate: dropped by `usableRows`, and said so rather than
    // silently making the cloud smaller than the table beside it.
    const table = neurons(10, (i) => (i < 2 ? { post: null } : {}))
    draw(table)
    expect(screen.getByText('2 unplottable')).toBeTruthy()
    expect(screen.getByText(/8 points/)).toBeTruthy()
  })

  it('counts a log axis dropping non-positive values as unplottable too', () => {
    // A log toggle discarding rows is the case that most needs saying out loud, because
    // nothing about flipping a switch suggests the data would change.
    const table = neurons(10, (i) => (i < 3 ? { pre: 0 } : {}))
    draw(table, { xScale: 'log' })
    expect(screen.getByText('3 unplottable')).toBeTruthy()
  })

  it('reports the correlation when there is a single trend line', () => {
    draw(neurons(20), { trend: 'linear' })
    // post is exactly 2 × pre.
    expect(screen.getByText('r = 1.00')).toBeTruthy()
  })

  it('counts the selection', () => {
    draw(neurons(20), { selection: ['1002', '1005'] })
    expect(screen.getByText(/2 selected/)).toBeTruthy()
  })

  it('warns that a selection with no ID column is by position', () => {
    // Fragile but useful — the tables least likely to carry an id are exactly the ones a
    // scatter is for. Saying so is what makes it a trade rather than a trap.
    draw(neurons(20), { idColumn: undefined, selection: ['3'] })
    expect(screen.getByText('by row index')).toBeTruthy()
  })

  it('keeps quiet about row-index selection when there is nothing selected', () => {
    draw(neurons(20), { idColumn: undefined })
    expect(screen.queryByText('by row index')).toBeNull()
  })
})

describe('the legend', () => {
  it('keys a categorical colour, without which the hues say nothing', () => {
    draw(neurons(20), { color: { mode: 'categorical', column: 'type', constant: '0' } })
    expect(screen.getByText('LC4')).toBeTruthy()
    expect(screen.getByText('LC6')).toBeTruthy()
  })

  it('keys the shape channel with the marks themselves', () => {
    const { container } = draw(neurons(20), {
      shape: { mode: 'categorical' as const, column: 'side', constant: 'circle' },
    })
    expect(screen.getByText('side')).toBeTruthy()
    expect(container.querySelectorAll('svg.legend__mark').length).toBe(2)
  })

  it('stands the magnitude ramp down in a card but keeps the identity key', () => {
    // A size ramp annotates a comparison the reader can already make by eye; a categorical
    // colour without its key says nothing at all. Same split as the network legend.
    const { container } = draw(neurons(20), {
      compact: true,
      color: { mode: 'categorical', column: 'type', constant: '0' },
      size: { column: 'pre', min: 3, max: 12 },
    })
    expect(screen.getByText('LC4')).toBeTruthy()
    expect(container.querySelectorAll('.legend__disc')).toHaveLength(0)
  })
})

describe('empty states', () => {
  it('asks for columns rather than drawing nothing', () => {
    draw(neurons(5), { xColumn: 'missing' })
    expect(screen.getByText(/Pick two numeric columns/)).toBeTruthy()
  })

  it('says an empty table is empty', () => {
    const empty = makeTable(
      SCHEMA,
      { neuronId: [], pre: [], post: [], type: [], side: [] },
      'neurons',
    )
    draw(empty)
    expect(screen.getByText(/the table is empty/)).toBeTruthy()
  })
})

describe('the tooltip', () => {
  it('lists the picked columns after its own rows, once each', () => {
    // One point is framed at the centre of the plot, which is inset from the box by the full
    // margins (left 50, right 14, top 10, bottom 40).
    const { container } = draw(neurons(1), { hoverColumns: ['side', 'pre', 'type'] })
    const surface = container.querySelector('.scatter-canvas')!
    const box = surface.getBoundingClientRect()
    // Through the zoom correction `tooltipPoint` applies, the stubbed box and offset sizes differing.
    const zoom = box.width / (surface as HTMLElement).offsetWidth
    fireEvent.pointerMove(surface, {
      clientX: box.left + (50 + (600 - 64) / 2) * zoom,
      clientY: box.top + (10 + (400 - 50) / 2) * zoom,
      pointerId: 1,
    })
    const tip = container.querySelector('.chart-tooltip')
    expect(tip?.textContent).toMatch(/side: L/)
    expect(tip?.textContent).toMatch(/type: LC4/)
    // `pre` is the x axis, already a row of its own.
    expect(tip?.textContent?.match(/pre:/g)).toHaveLength(1)
  })
})

describe('the search', () => {
  function search(table = neurons(6), props = {}) {
    const onSelectionChange = vi.fn()
    const utils = draw(table, { onSelectionChange, labelColumn: 'type', ...props })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const box = screen.getByRole('searchbox', { name: 'Find points' })
    return { ...utils, onSelectionChange, box }
  }

  it('keeps a press on the strip from starting a pan, whose capture would swallow the click', () => {
    // jsdom does not retarget a captured pointer's events, so the test is the cause: the plot
    // must not take the pointer when the press is on one of the strip's buttons.
    const capture = vi.spyOn(HTMLElement.prototype, 'setPointerCapture')
    draw(neurons(6))
    const button = screen.getByRole('button', { name: 'Search' })
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 })
    expect(capture).not.toHaveBeenCalled()
    capture.mockRestore()
  })

  it('counts the points whose label or id matches', () => {
    const { box, container } = search()
    fireEvent.change(box, { target: { value: 'lc4' } })
    // Six neurons, alternating LC4 and LC6.
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('3')
    fireEvent.change(box, { target: { value: '1004' } })
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('1')
  })

  it('steps through the hits, naming the one it is on in a tooltip', () => {
    const { box, container } = search()
    fireEvent.change(box, { target: { value: 'LC6' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('1 / 3')
    expect(container.querySelector('.chart-tooltip strong')?.textContent).toBe('LC6')
    fireEvent.click(screen.getByRole('button', { name: 'Previous hit' }))
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('3 / 3')
    // Opening the options keeps the place: the menu is not a new search.
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }))
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('3 / 3')
  })

  it('selects every hit, and adds them to the selection with Shift', () => {
    const { box, onSelectionChange } = search(neurons(6), { selection: ['1001'] })
    fireEvent.change(box, { target: { value: 'LC4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select hits' }))
    expect(onSelectionChange).toHaveBeenLastCalledWith(['1000', '1002', '1004'])
    fireEvent.click(screen.getByRole('button', { name: 'Select hits' }), { shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(['1001', '1000', '1002', '1004'])
  })

  it('searches one picked column instead, from its options', () => {
    const { box, container } = search()
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }))
    fireEvent.change(container.querySelector('.network-strip__menu select')!, {
      target: { value: 'side' },
    })
    fireEvent.change(box, { target: { value: 'L' } })
    fireEvent.click(screen.getByLabelText('Whole value only'))
    // `side` is L for every third neuron: 0 and 3.
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('2')
  })

  it('says a pattern will not compile rather than finding nothing silently', () => {
    const { box, container } = search()
    fireEvent.change(box, { target: { value: '/[' } })
    expect(container.querySelector('.network-strip__count')?.textContent).toBe('bad pattern')
    expect(box.getAttribute('aria-invalid')).toBe('true')
  })
})
