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

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable, tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ScatterViewer } from './ScatterViewer'

beforeAll(() => installJsdomStubs({ width: 600, height: 400 }))
afterEach(cleanup)

const SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
  column('type', 'str'),
  column('side', 'str'),
)

function neurons(count: number, overrides: (i: number) => Record<string, unknown> = () => ({})) {
  return tableFromRows(
    SCHEMA,
    Array.from({ length: count }, (_, i) => ({
      bodyId: 1000 + i,
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
      idColumn="bodyId"
      opacity={0.8}
      maxPoints={50000}
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

  it('admits the point budget rather than quietly thinning', () => {
    draw(neurons(100), { maxPoints: 10 })
    expect(screen.getByText('showing 10 of 100')).toBeTruthy()
  })

  it('says nothing about a budget it did not reach', () => {
    draw(neurons(10), { maxPoints: 50000 })
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
    const { container } = draw(neurons(20), { shapeColumn: 'side' })
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
    const empty = makeTable(SCHEMA, { bodyId: [], pre: [], post: [], type: [], side: [] }, 'neurons')
    draw(empty)
    expect(screen.getByText(/the table is empty/)).toBeTruthy()
  })
})
