/**
 * What a chart mark is called, and what it resolves back to.
 *
 * The round trip is the thing worth pinning: a viewer writes the label or the range and a node
 * turns it back into rows, and the two are only one module because they have to agree exactly.
 * Every case here is one where the obvious implementation disagrees quietly.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import {
  MISSING_LABEL,
  decodeRange,
  decodeRanges,
  encodeRange,
  markLabel,
  numericCell,
  rowsInRanges,
  rowsWithLabels,
} from './chartSelection'

const SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('pre', 'i64'),
)

function table() {
  return tableFromRows(SCHEMA, [
    { neuronId: 1, type: 'LC4', pre: 0 },
    { neuronId: 2, type: 'LC4', pre: 10 },
    { neuronId: 3, type: 'LPLC2', pre: 50 },
    { neuronId: 4, type: null, pre: 100 },
    { neuronId: 5, type: 'LPLC2', pre: null },
  ])
}

describe('markLabel', () => {
  it('gives null and undefined one visible bucket rather than dropping them', () => {
    // A third of a real neuron table has no `type`. A pie that omits them silently misreports
    // every remaining percentage.
    expect(markLabel(null)).toBe(MISSING_LABEL)
    expect(markLabel(undefined)).toBe(MISSING_LABEL)
  })

  it('stringifies, so a numeric category is addressed by its text', () => {
    expect(markLabel(5)).toBe('5')
    expect(markLabel(false)).toBe('false')
  })
})

describe('rowsWithLabels', () => {
  it('keeps the table order rather than the selection order', () => {
    const rows = rowsWithLabels(table(), 'type', ['LPLC2', 'LC4'])
    expect(rows.data.neuronId).toEqual([1, 2, 3, 5])
  })

  it('selects the missing bucket by the label the viewer drew it under', () => {
    expect(rowsWithLabels(table(), 'type', [MISSING_LABEL]).data.neuronId).toEqual([4])
  })

  it('answers empty for an unresolved column instead of throwing', () => {
    // Invariant 5's corollary: a stale control is not a reason to block everything downstream.
    expect(rowsWithLabels(table(), undefined, ['LC4']).length).toBe(0)
    expect(rowsWithLabels(table(), 'gone', ['LC4']).length).toBe(0)
  })

  it('keeps the schema and the kind on an empty result', () => {
    const empty = rowsWithLabels(table(), 'type', [])
    expect(empty.length).toBe(0)
    expect(empty.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'pre'])
  })
})

describe('range codec', () => {
  it('round-trips, closed flag and all', () => {
    for (const range of [
      { lo: 0, hi: 1 },
      { lo: -2.5, hi: 3.25, closed: true },
    ]) {
      expect(decodeRange(encodeRange(range))).toEqual(range)
    }
  })

  it('round-trips a double exactly, so a stored bar keeps naming its own edges', () => {
    const range = { lo: 1 / 3, hi: 2 / 3 }
    expect(decodeRange(encodeRange(range))).toEqual(range)
  })

  it('survives an exponent and a minus sign, neither of which contains a colon', () => {
    expect(decodeRange(encodeRange({ lo: -1e-7, hi: 1e21 }))).toEqual({ lo: -1e-7, hi: 1e21 })
  })

  it('skips a malformed entry rather than throwing on it', () => {
    // A selection is whatever was last saved, including by a build that spelled it differently.
    expect(decodeRanges(['1:2', 'nonsense', '', '5:4', '3:4:x', null])).toEqual([
      { lo: 1, hi: 2 },
    ])
  })
})

describe('numericCell', () => {
  it('refuses what Number() accepts', () => {
    // `Number(null)`, `Number('')` and `Number(false)` are all 0, which would put every empty
    // cell in whichever bar contains zero.
    for (const cell of [null, undefined, '', false, 'LC4']) {
      expect(numericCell(cell as never)).toBeUndefined()
    }
    expect(numericCell('12')).toBe(12)
    expect(numericCell(0)).toBe(0)
  })
})

describe('rowsInRanges', () => {
  it('is half-open, so a value on a shared edge belongs to one bar', () => {
    const rows = rowsInRanges(table(), 'pre', [encodeRange({ lo: 0, hi: 10 })])
    expect(rows.data.neuronId).toEqual([1])
  })

  it('takes the maximum only on the bar that says it is closed', () => {
    expect(rowsInRanges(table(), 'pre', ['50:100']).data.neuronId).toEqual([3])
    expect(rowsInRanges(table(), 'pre', ['50:100:c']).data.neuronId).toEqual([3, 4])
  })

  it('counts a row once even when two selected ranges overlap it', () => {
    expect(rowsInRanges(table(), 'pre', ['0:60', '40:120:c']).data.neuronId).toEqual([
      1, 2, 3, 4,
    ])
  })

  it('leaves out a row with no usable number', () => {
    expect(rowsInRanges(table(), 'pre', ['0:1000:c']).data.neuronId).toEqual([1, 2, 3, 4])
  })
})
