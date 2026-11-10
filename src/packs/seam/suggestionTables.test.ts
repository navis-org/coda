/**
 * The field tables, which are invariant 3 met by derivation rather than by agreement.
 *
 * `schemaOf` and `tableOf` read one list, so a column renamed on one side is renamed on both and
 * the pair cannot drift. What is left to test is the derivation itself, plus the two decisions
 * inside the lists that a reader downstream depends on and a type cannot express: that the id
 * columns are named so `isIdentifierColumn` recognises them, and that the coordinates carry their
 * unit in the schema rather than in the name.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME, isIdentifierColumn } from '../../core/ids'
import { columnNames } from '../../core/types'
import {
  CANDIDATE_FIELDS,
  TIP_FIELDS,
  neuronsSchema,
  neuronsTable,
  published,
  schemaOf,
  tableOf,
} from './suggestionTables'

const FIELD_LISTS = [
  ['tips', TIP_FIELDS],
  ['candidates', CANDIDATE_FIELDS],
] as const

describe.each(FIELD_LISTS)('the %s fields', (_what, fields) => {
  it('builds a schema and a table that agree, column for column', () => {
    const data = Object.fromEntries(fields.map((f) => [f.from, [null, null]]))
    const got = tableOf(fields, data)
    expect(got.schema).toEqual(schemaOf(fields))
    expect(Object.keys(got.data).sort()).toEqual(columnNames(got.schema).sort())
    expect(got.length).toBe(2)
    // A `check` field is read and left out of the table, never half-published.
    for (const field of fields.filter((f) => f.check)) {
      expect(got.data[field.name]).toBeUndefined()
    }
  })

  it('publishes no column twice, under either name', () => {
    expect(new Set(fields.map((f) => f.name)).size).toBe(fields.length)
    expect(new Set(fields.map((f) => f.from)).size).toBe(fields.length)
  })

  /**
   * The rename that earns its keep. `isIdentifierColumn` is how the rest of Coda keeps a root id
   * out of a float (invariant 8), and it recognises a name whose last word is `id` — which
   * `cand_root` and `neuron` are not.
   *
   * Over the *published* fields only: the tips file's own copy of the first candidate's id is a
   * `check` field and never reaches a table, so there is no picker to offer it to.
   */
  it('names its id columns so the rest of Coda recognises them', () => {
    const ids = published(fields).filter(
      (f) => f.dtype === 'str' && /neuron|root|candidate/.test(f.from),
    )
    expect(ids.length).toBeGreaterThan(0)
    for (const field of ids) expect(isIdentifierColumn(field.name)).toBe(true)
  })

  /** The other rename: a unit a reader can see is not a unit the app can use. */
  it('carries the coordinates’ unit in the schema, not in the name', () => {
    for (const field of fields.filter((f) => /_nm$/.test(f.from))) {
      expect(field.unit).toBe('nm')
      expect(field.name).not.toMatch(/_nm$/)
    }
  })

  /** A missing column is invariant 3's failure arriving through a file. It is named, not absent. */
  it('refuses a read missing one of its columns, naming it', () => {
    const first = published(fields)[0]!
    const data = Object.fromEntries(
      published(fields)
        .slice(1)
        .map((f) => [f.from, [null]]),
    )
    expect(() => tableOf(fields, data)).toThrow(new RegExp(`\`${first.from}\``))
  })
})

describe('the per-neuron fold', () => {
  const neurons = ['1', '2', '3']

  it('gives a neuron the manifest names but the tips file does not a row of zeroes', () => {
    const got = neuronsTable(
      neurons,
      new Map([['2', { tips: 4, shown: 1, expectedRight: 0.7 }]]),
    )
    expect(got.schema).toEqual(neuronsSchema())
    expect(got.kind).toBe('neurons')
    expect(got.data[ID_COLUMN_NAME]).toEqual(neurons)
    expect(got.data['tips']).toEqual([0, 4, 0])
    expect(got.data['expectedRight']).toEqual([0, 0.7, 0])
  })

  /** The manifest's order, so a tips file sorted by score cannot reorder the neuron list. */
  it('keeps the manifest’s order rather than the map’s', () => {
    const got = neuronsTable(
      neurons,
      new Map([
        ['3', { tips: 1, shown: 0, expectedRight: 0 }],
        ['1', { tips: 2, shown: 0, expectedRight: 0 }],
      ]),
    )
    expect(got.data[ID_COLUMN_NAME]).toEqual(['1', '2', '3'])
    expect(got.data['tips']).toEqual([2, 0, 1])
  })
})
