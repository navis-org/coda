/**
 * What a number is allowed to look like.
 *
 * The rule under test is `isIdentifierColumn`, and the reason it has a file of its own is that
 * both of its failure modes are silent: a grouped neuron id (`527,536`) is a plausible-looking
 * string that no query accepts, and an ungrouped synapse count is merely untidy. Only the
 * first is a correctness problem, which is why the cases below lean on the names Coda's own
 * nodes generate rather than on a tidy pair of examples.
 */

import { describe, expect, it } from 'vitest'

import { formatCell, formatNumber, isIdentifierColumn } from './format'

describe('isIdentifierColumn', () => {
  it('takes the names every query node publishes', () => {
    // neuronId is the contract name; the rest are what Connectivity, Profile and BuildNetwork
    // emit, and `id`/`root_id` are what an uploaded CSV arrives under.
    for (const name of [
      'neuronId',
      'preId',
      'postId',
      'partnerId',
      'sourceId',
      'targetId',
      'id',
      'ID',
      'neuronIds',
      'root_id',
      'pt_root_id',
      'supervoxel_id',
    ]) {
      expect(isIdentifierColumn(name), name).toBe(true)
    }
  })

  it('is not `endsWith("id")` — those are words, not columns of ids', () => {
    for (const name of ['centroid', 'valid', 'pyramid', 'lipid', 'grid']) {
      expect(isIdentifierColumn(name), name).toBe(false)
    }
  })

  it('leaves ordinary quantities alone', () => {
    for (const name of ['weight', 'pre', 'post', 'n', 'cableLength', 'degreeIn', undefined]) {
      expect(isIdentifierColumn(name), String(name)).toBe(false)
    }
  })

  /**
   * The one that pays for the aggregate prefixes. `groupBy` writes `<agg>_<column>`, so a
   * count of distinct partners is literally called `countDistinct_partnerId` — a quantity
   * that reaches five figures on male-CNS and does want its separator.
   */
  it('reads an aggregate of an id column as a quantity again', () => {
    expect(isIdentifierColumn('countDistinct_partnerId')).toBe(false)
    expect(isIdentifierColumn('sum_neuronId')).toBe(false)
    expect(isIdentifierColumn('max_preId')).toBe(false)
    expect(formatCell(12345, 'countDistinct_partnerId')).toBe(formatNumber(12345))
  })
})

describe('formatCell', () => {
  it('prints an id as it would be typed back', () => {
    expect(formatCell(527536, 'neuronId')).toBe('527536')
    expect(formatCell(1158187240, 'preId')).toBe('1158187240')
  })

  it('still groups a count in the column beside it', () => {
    expect(formatCell(527536, 'weight')).toBe(formatNumber(527536))
    expect(formatNumber(527536)).not.toBe('527536')
  })

  /**
   * A cell's `title` is `String(cell)`, so an id formatted any other way makes the hover
   * disagree with the cell under it — which is the actual bug, rather than the grouping.
   */
  it('agrees with the title the table already shows', () => {
    expect(formatCell(527536, 'neuronId')).toBe(String(527536))
  })

  it('says nothing about a value it was given no column for', () => {
    // Several callers hold a bare value. Absent means "format as a quantity", which is what
    // every one of them did before the column name existed.
    expect(formatCell(527536)).toBe(formatNumber(527536))
  })

  it('leaves null, text and booleans where they were', () => {
    expect(formatCell(null, 'neuronId')).toBe('—')
    expect(formatCell('LC4', 'type')).toBe('LC4')
    expect(formatCell(true, 'traced')).toBe('true')
    expect(formatCell(1.5, 'neuronId')).toBe('1.5')
  })
})
