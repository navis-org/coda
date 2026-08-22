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

import {
  formatAge,
  formatCell,
  formatCompact,
  formatMeasure,
  formatNumber,
  isIdentifierColumn,
} from './format'

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

describe('formatAge', () => {
  it('rounds to the largest whole unit, with no decimals', () => {
    expect(formatAge(0)).toBe('0s')
    expect(formatAge(40_000)).toBe('40s')
    expect(formatAge(12 * 60_000)).toBe('12m')
    expect(formatAge(5 * 3_600_000)).toBe('5h')
    expect(formatAge(3 * 86_400_000)).toBe('3d')
  })

  it('floors, so nothing is reported as older than it is', () => {
    // 23h59m is not a day. Rounding would call it one, on a surface whose whole job is to say
    // how stale a copy of somebody's annotation base is.
    expect(formatAge(86_400_000 - 60_000)).toBe('23h')
    expect(formatAge(60_000 - 1)).toBe('59s')
    // And the boundary itself steps exactly once.
    expect(formatAge(86_400_000)).toBe('1d')
  })

  it('does not go negative on a clock that moved', () => {
    expect(formatAge(-5000)).toBe('0s')
  })
})

describe('a measurement in the unit somebody reads it in', () => {
  /*
   * The reported case. Nanometres are the right storage unit and the wrong display one for
   * anything the size of a neuron: `formatCompact` is unit-blind, so 2,980,158 nm read as "3M" —
   * a magnitude carried entirely by a suffix that means *million* next to a unit that means
   * *nano*, which is about as misleading as a number can be.
   */
  it('reads a fly neuron’s cable length in millimetres', () => {
    expect(formatMeasure(2_980_158.182, 'nm')).toBe('2.98 mm')
    expect(formatMeasure(22_484_326.7, 'nm')).toBe('22.48 mm')
  })

  it('climbs the ladder with the magnitude', () => {
    expect(formatMeasure(999, 'nm')).toBe('999 nm')
    expect(formatMeasure(12_500, 'nm')).toBe('12.5 µm')
    expect(formatMeasure(12e9, 'nm')).toBe('12 m')
  })

  // Floored at nm, so a sub-micron length stays a number rather than becoming "0 µm" — and
  // below the floor it keeps `formatCompact`'s own tail rather than rounding away to "0 nm".
  it('does not round a short length away', () => {
    expect(formatMeasure(0, 'nm')).toBe('0 nm')
    expect(formatMeasure(4, 'nm')).toBe('4 nm')
    expect(formatMeasure(0.004, 'nm')).toBe('4.0e-3 nm')
  })

  /*
   * The rung is chosen from the raw value and the number is rounded afterwards, so a value just
   * under a rung would print `1,000 µm` — a thousands separator, which is the one thing the
   * ladder exists to remove. Promoted only when the *rounded* figure has climbed, so a value
   * that still fits keeps its own rung and its own precision.
   */
  it('promotes a value that rounds up into the next rung, and only then', () => {
    expect(formatMeasure(999_999, 'nm')).toBe('1 mm')
    expect(formatMeasure(999_999_999, 'nm')).toBe('1 m')
    expect(formatMeasure(999_994, 'nm')).toBe('999.99 µm')
  })

  /*
   * The unit is looked up in the ladder rather than tested against `'nm'`. Gating on the storage
   * unit would silently drop the unit and reinstate "3M" the moment a column declared one of the
   * other three — which the ladder already names.
   */
  it('reads a length stored in any rung, not only in nanometres', () => {
    expect(formatMeasure(2980.158182, 'µm')).toBe('2.98 mm')
    expect(formatMeasure(0.0025, 'mm')).toBe('2.5 µm')
    expect(formatMeasure(2.98, 'mm')).toBe('2.98 mm')
  })

  it('keeps the sign, which is a rung question and not a magnitude one', () => {
    expect(formatMeasure(-2_980_158.182, 'nm')).toBe('-2.98 mm')
  })

  /*
   * A count has no ladder — 12.9K synapses is already what somebody wants, and a voxel is not a
   * fraction of anything. So those keep `formatCompact`'s bare number, and the unit stays where
   * the caller was already putting it.
   */
  it('leaves a count alone, unit and all', () => {
    expect(formatMeasure(12_900, 'synapses')).toBe(formatCompact(12_900))
    expect(formatMeasure(2_980_158, 'voxels')).toBe('3M')
    expect(formatMeasure(2_980_158, undefined)).toBe('3M')
  })

  it('degrades rather than printing a scaled NaN', () => {
    expect(formatMeasure(Number.NaN, 'nm')).toBe('—')
  })
})
