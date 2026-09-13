/**
 * The cell-id grammar two ZapBench nodes speak. One writes a row label and the other reads it, so
 * a disagreement here is a Heatmap selection that reaches the wrong neurons — or none, counted as
 * cells nobody matched.
 */

import { describe, expect, it } from 'vitest'

import {
  cellIdsOf,
  cellLabel,
  outsideRelease,
  parseCellList,
  readCellList,
} from './zapbenchCells'

describe('a row label', () => {
  it('reads back the cells it was written from', () => {
    expect(cellIdsOf(cellLabel([71721, 4, 12]))).toEqual([71721, 4, 12])
    expect(cellIdsOf(cellLabel([5]))).toEqual([5])
  })

  it('reads a zapbenchId cell as one cell, and an empty cell as none', () => {
    expect(cellIdsOf(5)).toEqual([5])
    expect(cellIdsOf(null)).toEqual([])
    expect(cellIdsOf('')).toEqual([])
  })

  it('is not cell ids when any part is not a whole number', () => {
    expect(cellIdsOf('LC4')).toBeUndefined()
    expect(cellIdsOf('5+')).toBeUndefined()
    expect(cellIdsOf(2.5)).toBeUndefined()
    expect(cellIdsOf(true)).toBeUndefined()
  })
})

describe('a pasted list', () => {
  it('takes commas, new lines, ranges and row labels, and hands back what it cannot read', () => {
    expect(parseCellList('1, 2\n3-5 7+8; x 9-3')).toEqual({
      ids: [1, 2, 3, 4, 5, 7, 8],
      unreadable: ['x', '9-3'],
    })
  })

  it('reads a list pasted as Python or JSON, as Input IDs does', () => {
    expect(parseCellList('[1203, 4410]\n"5"')).toEqual({ ids: [1203, 4410, 5], unreadable: [] })
  })

  it('stays remembered while another card reads its own list', () => {
    const long = readCellList('1-500')
    readCellList('')
    readCellList('7, 8')
    expect(readCellList('1-500')).toBe(long)
    expect(long.cells).toHaveLength(500)
  })

  it('refuses a range wider than the release rather than expanding it', () => {
    expect(parseCellList('1-71721000').unreadable).toEqual(['1-71721000'])
    expect(parseCellList('1-71721').ids).toHaveLength(71721)
  })

  it('names the ids the release has no cell for, at both ends', () => {
    expect(outsideRelease([0, 1, 71721, 71722])).toEqual([0, 71722])
  })
})
