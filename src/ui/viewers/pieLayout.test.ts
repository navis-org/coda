/**
 * Slices and arcs.
 *
 * Two things here are load-bearing rather than cosmetic: which categories the fold keeps (by
 * size, whatever the display order), and the full-circle arc — a 360° sweep starts and ends at
 * the same point and renders as nothing at all, which is exactly the single-category case.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { MISSING_LABEL } from '../../nodes/lib/chartSelection'
import { arcPath, pieSlices, polar, tallyCategories } from './pieLayout'

const SCHEMA = tableSchema(column('type', 'str'), column('weight', 'f64'))

function tableOf(rows: { type: string | null; weight?: number | null }[]) {
  return tableFromRows(
    SCHEMA,
    rows.map((r) => ({ type: r.type, weight: r.weight ?? null })),
  )
}

describe('tallyCategories', () => {
  it('counts rows when no value column is given', () => {
    const { totals } = tallyCategories(
      tableOf([{ type: 'a' }, { type: 'a' }, { type: 'b' }]),
      'type',
      undefined,
    )
    expect([...totals.entries()]).toEqual([
      ['a', 2],
      ['b', 1],
    ])
  })

  it('sums the value column when one is', () => {
    const { totals } = tallyCategories(
      tableOf([
        { type: 'a', weight: 3 },
        { type: 'a', weight: 4 },
      ]),
      'type',
      'weight',
    )
    expect(totals.get('a')).toBe(7)
  })

  it('drops a negative and counts it, because a share cannot be less than nothing', () => {
    const { totals, dropped } = tallyCategories(
      tableOf([
        { type: 'a', weight: 10 },
        { type: 'b', weight: -40 },
        { type: 'c', weight: null },
      ]),
      'type',
      'weight',
    )
    expect(dropped).toBe(2)
    expect([...totals.keys()]).toEqual(['a'])
  })

  it('gives nulls the same visible bucket every other chart gives them', () => {
    const { totals } = tallyCategories(tableOf([{ type: null }]), 'type', undefined)
    expect(totals.get(MISSING_LABEL)).toBe(1)
  })
})

describe('pieSlices', () => {
  const totals = new Map([
    ['a', 50],
    ['b', 30],
    ['c', 10],
    ['d', 6],
    ['e', 4],
  ])

  it('covers the circle exactly once', () => {
    const { slices } = pieSlices(totals)
    expect(slices[0]!.start).toBe(0)
    expect(slices[slices.length - 1]!.end).toBeCloseTo(Math.PI * 2)
    expect(slices.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1)
  })

  it('folds the tail into one residual that remembers what went into it', () => {
    // A click on `Other` has to mean "these categories" to the node resolving it — the fold
    // itself depends on a presentational param and so is not in the cache key.
    const { slices } = pieSlices(totals, { maxSlices: 3 })
    expect(slices.map((s) => s.label)).toEqual(['a', 'b', 'c', 'Other'])
    expect(slices[3]!.folded).toEqual(['d', 'e'])
    expect(slices[3]!.value).toBe(10)
  })

  it('folds by size even when the display order is alphabetical', () => {
    // Otherwise `Sort by size` would quietly change which rows a click on the residual
    // selects, which is not what a sort control is.
    const { slices } = pieSlices(
      new Map([
        ['zebra', 100],
        ['alpha', 1],
        ['beta', 1],
      ]),
      { maxSlices: 1, sort: false },
    )
    expect(slices.map((s) => s.label)).toEqual(['zebra', 'Other'])
  })

  it('drops a zero-valued category, which has no arc to draw', () => {
    const { slices } = pieSlices(
      new Map([
        ['a', 5],
        ['b', 0],
      ]),
    )
    expect(slices.map((s) => s.label)).toEqual(['a'])
  })

  it('answers empty rather than dividing by a zero total', () => {
    expect(pieSlices(new Map([['a', 0]])).slices).toEqual([])
  })
})

describe('arcPath', () => {
  it('draws a full circle as two arcs, which is the single-category case', () => {
    // One 360° arc starts and ends at the same point and renders as nothing at all.
    const path = arcPath(50, 50, 40, 0, 0, Math.PI * 2)
    expect(path.match(/A/g)).toHaveLength(2)
  })

  it('cuts the hole out of a full ring by winding it the other way', () => {
    const path = arcPath(50, 50, 40, 20, 0, Math.PI * 2)
    expect(path.match(/A/g)).toHaveLength(4)
    expect(path).toContain('0 0 1')
    expect(path).toContain('0 0 0')
  })

  it('sets the large-arc flag past a half turn and not before', () => {
    expect(arcPath(0, 0, 10, 0, 0, Math.PI * 0.9)).toContain('0 0 1')
    expect(arcPath(0, 0, 10, 0, 0, Math.PI * 1.2)).toContain('0 1 1')
  })

  it('draws a wedge from the centre and a ring from its own edge', () => {
    expect(arcPath(0, 0, 10, 0, 0, 1).startsWith('M0,0')).toBe(true)
    expect(arcPath(0, 0, 10, 5, 0, 1).startsWith('M0,0')).toBe(false)
  })

  it('is empty for a slice with no sweep, rather than a stray moveto', () => {
    expect(arcPath(0, 0, 10, 0, 1, 1)).toBe('')
  })
})

describe('polar', () => {
  it('puts zero at twelve o’clock and runs clockwise, which is how a pie is read', () => {
    expect(polar(0, 0, 1, 0)).toEqual({ x: 0, y: -1 })
    const quarter = polar(0, 0, 1, Math.PI / 2)
    expect(quarter.x).toBeCloseTo(1)
    expect(quarter.y).toBeCloseTo(0)
  })
})
