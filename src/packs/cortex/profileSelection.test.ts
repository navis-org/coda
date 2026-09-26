/**
 * Laminar Profile's stored selection: a depth range, within one facet where it names one — so a
 * bar clicked in one neuron's panel selects that neuron's rows at those depths and nobody else's.
 * The entry names its facet column, so what it selects does not depend on the `Facet by` param.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { encodeProfileMark, rowsInProfileMarks } from './profileSelection'

const TABLE = makeTable(
  tableSchema(column('neuronId', 'str'), column('type', 'str'), column('depth', 'f64')),
  {
    neuronId: ['a', 'a', 'b', 'b', null],
    type: ['23P', '23P', 'BC', 'BC', 'BC'],
    depth: [10, 50, 10, 50, 10],
  },
)
const ids = (selection: string[]) =>
  rowsInProfileMarks(TABLE, 'depth', selection).data['neuronId']
const shallow = { lo: 0, hi: 20 }

describe('a faceted selection', () => {
  it('selects the depths within the facet it was clicked in', () => {
    expect(ids([encodeProfileMark(shallow, { column: 'neuronId', label: 'a' })])).toEqual(['a'])
    expect(ids([encodeProfileMark(shallow, { column: 'type', label: 'BC' })])).toEqual([
      'b',
      null,
    ])
    // The no-value facet is addressable like any other.
    expect(ids([encodeProfileMark(shallow, { column: 'neuronId', label: '—' })])).toEqual([
      null,
    ])
  })

  it('reads a bare range as every row’s, and a facet whose column is gone as nobody’s', () => {
    expect(ids([encodeProfileMark(shallow)])).toEqual(['a', 'b', null])
    // Not every row at those depths: that would widen one panel's bar into the whole population.
    expect(ids([encodeProfileMark(shallow, { column: 'gone', label: 'a' })])).toEqual([])
  })

  it('keeps a label holding the separator, and a column holding it', () => {
    const table = makeTable(tableSchema(column('a|b', 'str'), column('depth', 'f64')), {
      'a|b': ['x|y', 'z'],
      depth: [10, 10],
    })
    const mark = encodeProfileMark(shallow, { column: 'a|b', label: 'x|y' })
    expect(rowsInProfileMarks(table, 'depth', [mark]).data['a|b']).toEqual(['x|y'])
  })

  it('skips an entry it cannot read rather than guessing', () => {
    expect(
      ids([
        'nonsense|a',
        '0:20|a',
        // A stray `%` in the column: unreadable, skipped rather than thrown.
        '0:20|%E0|a',
        encodeProfileMark({ lo: 40, hi: 60 }, { column: 'neuronId', label: 'b' }),
      ]),
    ).toEqual(['b'])
  })
})
