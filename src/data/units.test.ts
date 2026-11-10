/**
 * The scale grammar, which four cards now read and none of them owns.
 *
 * `Voxel size` on Custom CAVE, `Position units` on CAVE table, `Nanometres per unit` on Table to
 * Points, and whatever comes next: all of them are three positive numbers of nanometres per
 * unit. The reason it is tested here rather than beside any one of them is that it belongs to
 * none of them — a test filed under a CAVE heading is a test nobody looks for when the Table to
 * Points field misbehaves.
 *
 * What makes it worth testing at all is the failure: a scale read wrongly does not throw. It
 * puts every coordinate a constant factor from where it belongs, in a cloud that is internally
 * consistent and draws perfectly well.
 */

import { describe, expect, it } from 'vitest'

import { parseScale, scaleRefusal } from './units'

describe('parseScale', () => {
  it('reads three positive numbers, separated however a reader typed them', () => {
    expect(parseScale('1, 1, 1')).toEqual([1, 1, 1])
    expect(parseScale('1,1,1')).toEqual([1, 1, 1])
    expect(parseScale(' 4 4 40 ')).toEqual([4, 4, 40])
    expect(parseScale('0.5, 0.5, 5')).toEqual([0.5, 0.5, 5])
  })

  /**
   * Undefined rather than a partial answer. Two numbers is not "x and y"; a zero is not a scale
   * at all, since nothing survives being multiplied by it; and a negative one mirrors the data
   * without saying so.
   */
  it('refuses anything that is not three positive numbers', () => {
    for (const text of [
      '',
      '   ',
      '1, 1',
      '1, 1, 1, 1',
      '1, 1, x',
      '0, 1, 1',
      '-1, 1, 1',
      'nm',
    ]) {
      expect(parseScale(text), text).toBeUndefined()
    }
  })
})

describe('scaleRefusal', () => {
  /** The field's own name, since that is the only part a reader has to find on their card. */
  it('names the field it is about', () => {
    expect(scaleRefusal('Voxel size')).toContain('`Voxel size`')
    expect(scaleRefusal('Nanometres per unit')).toContain('`Nanometres per unit`')
  })

  /**
   * The one real variation between the cards: a CAVE table left blank means "the units the data
   * is stored in", where a scale a node multiplies by cannot be absent.
   */
  it('offers blank only where blank means something', () => {
    expect(scaleRefusal('Position units', true)).toContain('blank')
    expect(scaleRefusal('Nanometres per unit')).not.toContain('blank')
  })
})
