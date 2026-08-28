/**
 * The per-column summary's arithmetic.
 *
 * Two classes of failure are worth guarding and only one of them is arithmetic. A statistic
 * that is subtly wrong shows up as a number somebody has to already distrust to check; a
 * statistic printed for a column it does not *mean* anything for — a lexicographic min over
 * cell types, a mean over neuron ids — reads exactly like a correct one. So most of what is
 * pinned here is which cells are null and which columns are left blank on purpose.
 */

import { describe, expect, it } from 'vitest'

import { column, columnNames, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { emptyTable, tableFromRows } from '../../core/values'
import { describeSchema, describeTable } from './describeOps'

const SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('weight', 'i64', 'synapses'),
  column('flagged', 'bool'),
)

function table(): TableValue {
  return tableFromRows(SCHEMA, [
    { neuronId: 1, type: 'LC4', weight: 0, flagged: true },
    { neuronId: 2, type: 'LC4', weight: 10, flagged: false },
    { neuronId: 3, type: '', weight: 20, flagged: false },
    { neuronId: 4, type: 'LC6', weight: 30, flagged: null },
    { neuronId: 5, type: null, weight: null, flagged: true },
  ])
}

/** One summary row as a plain object, keyed by the statistic. */
function row(summary: TableValue, name: string): Record<string, CellValue> {
  const index = (summary.data['column'] as string[]).indexOf(name)
  expect(index, `no row for ${name}`).toBeGreaterThanOrEqual(0)
  const out: Record<string, CellValue> = {}
  for (const col of summary.schema.columns) out[col.name] = summary.data[col.name]![index]!
  return out
}

describe('shape', () => {
  it('emits one row per input column, in the input order, and agrees with its schema half', () => {
    const summary = describeTable(table())
    expect(summary.length).toBe(4)
    expect(summary.data['column']).toEqual(['neuronId', 'type', 'weight', 'flagged'])
    // Invariant 3: the declared half and the value half, side by side.
    expect(columnNames(summary.schema)).toEqual(columnNames(describeSchema()))
  })

  /*
   * The property that lets `inferOutputs` type the Summary port exactly, before anything has
   * run and before anything is wired — unlike Pivot, whose columns are named by its data.
   */
  it('declares the same columns whatever the input', () => {
    expect(columnNames(describeTable(emptyTable(SCHEMA)).schema)).toEqual(
      columnNames(describeTable(table()).schema),
    )
  })

  it('summarises a table with no rows as a table with no values', () => {
    const summary = describeTable(emptyTable(SCHEMA))
    expect(summary.length).toBe(4)
    expect(row(summary, 'weight')).toMatchObject({ non_nulls: 0, nulls: 0, unique: 0, min: null })
  })

  it('summarises a table with no columns as no rows at all', () => {
    expect(describeTable(emptyTable(tableSchema())).length).toBe(0)
  })
})

describe('counts', () => {
  /*
   * An empty string is *absence*, not a value — `datasetStats`' rule, shared rather than
   * restated, because neuPrint publishes `null` and `''` for the same missing annotation
   * depending on the property. Counting `''` as a category would report this column as
   * complete and as holding one more cell type than it does.
   */
  it('counts an empty string as missing, in both the nulls and the distinct values', () => {
    expect(row(describeTable(table()), 'type')).toMatchObject({
      non_nulls: 3,
      nulls: 2,
      unique: 2,
    })
  })

  it('counts false as a real answer rather than as absence', () => {
    // Three flags recorded, one row without one; `false` is an answer and `true`/`false` are
    // two distinct values. `Boolean(cell)` here would report a column of flags as half empty.
    expect(row(describeTable(table()), 'flagged')).toMatchObject({
      non_nulls: 4,
      nulls: 1,
      unique: 2,
    })
  })

  it('leaves non_nulls + nulls equal to the input row count on every row', () => {
    const input = table()
    const summary = describeTable(input)
    for (let i = 0; i < summary.length; i++) {
      expect(
        Number(summary.data['non_nulls']![i]) + Number(summary.data['nulls']![i]),
      ).toBe(input.length)
    }
  })
})

describe('numeric columns', () => {
  it('reports the spread, the mean and the non-zero count', () => {
    // 0, 10, 20, 30 present and one null. Type-7 quantiles, the definition numpy and R default
    // to — shared with the Distribution viewer rather than reimplemented, so the two cannot
    // quote different medians of the same column.
    expect(row(describeTable(table()), 'weight')).toMatchObject({
      dtype: 'i64',
      non_nulls: 4,
      nulls: 1,
      non_zero: 3,
      unique: 4,
      min: 0,
      q1: 7.5,
      median: 15,
      q3: 22.5,
      max: 30,
      mean: 15,
    })
  })

  it('answers 0 rather than null for the non-zero count of a column that is all nulls', () => {
    const schema = tableSchema(column('x', 'f64'))
    const summary = describeTable(tableFromRows(schema, [{ x: null }, { x: null }]))
    // A count over nothing is zero; a minimum over nothing is not a number, and saying `0`
    // there would put a value into the range of a column that has none.
    expect(row(summary, 'x')).toMatchObject({ non_nulls: 0, non_zero: 0, min: null, mean: null })
  })

  it('keeps a NaN out of the sort while still counting it as present', () => {
    const schema = tableSchema(column('x', 'f64'))
    const summary = describeTable(
      tableFromRows(schema, [{ x: 1 }, { x: Number.NaN }, { x: 3 }]),
    )
    // Present and distinct — it arrived — but it takes no part in the spread, where it would
    // land wherever the comparator left it and drag a quartile with it.
    expect(row(summary, 'x')).toMatchObject({ non_nulls: 3, non_zero: 2, min: 1, max: 3, mean: 2 })
  })
})

describe('columns that are not quantities', () => {
  /*
   * The failure this is about is silent: a lexicographic minimum in a column of minima reads
   * exactly like a numeric one, and nothing on the row says which kind it is.
   */
  it('leaves every statistic blank on a text column, and on a boolean one', () => {
    const summary = describeTable(table())
    for (const name of ['type', 'flagged']) {
      expect(row(summary, name)).toMatchObject({
        non_zero: null,
        min: null,
        q1: null,
        median: null,
        q3: null,
        max: null,
        mean: null,
      })
    }
  })

  /*
   * Invariant 8, one step on. `neuronId` is `i64` here and numeric by dtype, and it is still
   * not a quantity: a mean neuron id identifies nothing, and `CellValue` being a float64 means
   * that on an 18-digit id the arithmetic would not even be over the ids. Counts stay, because
   * they compare cells rather than adding them.
   */
  it('counts the id column and never measures it', () => {
    expect(row(describeTable(table()), 'neuronId')).toMatchObject({
      dtype: 'i64',
      non_nulls: 5,
      nulls: 0,
      unique: 5,
      non_zero: null,
      min: null,
      max: null,
      mean: null,
    })
  })

  it('counts wide ids exactly, where measuring them could not', () => {
    // Two ids one apart, both past Number.MAX_SAFE_INTEGER: as text they are two neurons, and
    // the float64 arithmetic a min or a mean would do cannot tell them apart.
    const schema = tableSchema(column('neuronId', 'str'))
    const summary = describeTable(
      tableFromRows(schema, [
        { neuronId: '648518346341351798' },
        { neuronId: '648518346341351799' },
      ]),
    )
    expect(row(summary, 'neuronId')).toMatchObject({ non_nulls: 2, unique: 2, min: null })
  })
})

describe('memoisation', () => {
  /*
   * `evaluate` and the card both call this with the node's own pass-through output — the same
   * object. Without the memo a `cheap` node sorts every numeric column twice per edit; and the
   * viewer would be handed a fresh table on every render, which resets its page under whoever
   * is reading it.
   */
  it('hands the same summary back for the same table', () => {
    const input = table()
    expect(describeTable(input)).toBe(describeTable(input))
  })

  it('summarises an equal-but-distinct table separately', () => {
    expect(describeTable(table())).not.toBe(describeTable(table()))
  })
})
