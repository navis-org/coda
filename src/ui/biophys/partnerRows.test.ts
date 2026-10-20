import { describe, expect, it } from 'vitest'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { filterPartners, partnerRows, sortPartners, withFiring } from './partnerRows'

const PARTNERS = {
  id: ['101', '202', '303'],
  type: ['LC4', 'LPLC1', null],
  synapses: Int32Array.of(12, 3, 7),
  inhibitory: Int32Array.of(0, 3, 2),
}

/** A summary from a run that ran 202 and 101 alone, and a partner the model no longer has. */
const SUMMARY = makeTable(
  tableSchema(
    column('partnerId', 'str'),
    column('somaPeak', 'f64'),
    column('localPeak', 'f64'),
    column('attenuation', 'f64'),
    column('somaSpike', 'bool'),
  ),
  {
    partnerId: ['202', '101', '999'],
    somaPeak: [0.5, 2, 9],
    localPeak: [5, 4, 9],
    attenuation: [0.1, 0.5, 1],
    somaSpike: [false, true, false],
  },
)

describe('partnerRows', () => {
  it('lists every partner in the model’s order, firing unless silenced', () => {
    const rows = partnerRows(PARTNERS, ['202'], undefined)
    expect(rows.map((r) => [r.id, r.fires, r.synapses])).toEqual([
      ['101', true, 12],
      ['202', false, 3],
      ['303', true, 7],
    ])
    expect(rows.every((r) => r.somaPeak === null)).toBe(true)
    // Which socket each came on: all, some or none of its synapses inhibitory.
    expect(rows.map((r) => r.sign)).toEqual(['excitatory', 'inhibitory', 'mixed'])
  })

  it('under a top N, fires only the strongest of the ticked, the rest ticked and quiet', () => {
    // 101 (12 synapses) is silenced, so the top 1 of what is left is 303 (7), not 202 (3).
    const rows = partnerRows(PARTNERS, ['101'], undefined, 1)
    expect(rows.map((r) => [r.id, r.ticked, r.fires])).toEqual([
      ['101', false, false],
      ['202', true, false],
      ['303', true, true],
    ])
  })

  it('joins the last run’s summary by id, empty where a partner did not run alone', () => {
    const rows = partnerRows(PARTNERS, [], SUMMARY)
    expect(rows.map((r) => r.somaPeak)).toEqual([2, 0.5, null])
    expect(rows.map((r) => r.somaSpike)).toEqual([true, false, null])
  })

  it('reads no summary from a Partners table run without one', () => {
    const plain = makeTable(tableSchema(column('partnerId', 'str')), { partnerId: ['101'] })
    expect(partnerRows(PARTNERS, [], plain)[0]!.somaPeak).toBeNull()
  })
})

describe('filterPartners', () => {
  const rows = partnerRows(PARTNERS, [], undefined)
  const ids = (query: string) => filterPartners(rows, query).rows.map((r) => r.id)

  it('matches the id or the type, case-insensitively', () => {
    expect(ids('lc4')).toEqual(['101'])
    expect(ids('LC')).toEqual(['101', '202'])
    expect(ids('30')).toEqual(['303'])
    expect(ids('')).toEqual(['101', '202', '303'])
  })

  it('negates over both: a negated type does not survive on its id', () => {
    expect(ids('!LC4')).toEqual(['202', '303'])
  })

  it('takes a regex, and keeps every row with the reason when one will not compile', () => {
    expect(ids('/^LC4$/')).toEqual(['101'])
    const bad = filterPartners(rows, '/[')
    expect(bad.rows).toHaveLength(3)
    expect(bad.error).toBeTruthy()
  })
})

describe('sortPartners', () => {
  const rows = partnerRows(PARTNERS, [], SUMMARY)
  const order = (key: Parameters<typeof sortPartners>[1]) =>
    sortPartners(rows, key).map((r) => r.id)

  it('sorts numbers and text either way, empty cells last both ways', () => {
    expect(order({ column: 'somaPeak', descending: true })).toEqual(['101', '202', '303'])
    expect(order({ column: 'somaPeak', descending: false })).toEqual(['202', '101', '303'])
    expect(order({ column: 'type', descending: false })).toEqual(['101', '202', '303'])
    expect(order({ column: 'synapses', descending: false })).toEqual(['202', '303', '101'])
    expect(order(undefined)).toEqual(['101', '202', '303'])
  })
})

describe('withFiring', () => {
  it('ticking removes ids from the silenced list, unticking appends the new ones in order', () => {
    expect(withFiring(['a', 'b', 'c'], ['b'], true)).toEqual(['a', 'c'])
    expect(withFiring(['a'], ['c', 'a', 'b'], false)).toEqual(['a', 'c', 'b'])
  })
})
