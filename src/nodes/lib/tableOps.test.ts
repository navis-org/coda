import { describe, expect, it } from 'vitest'

import { compareIds, idText, isNeuronId } from '../../core/ids'
import { CRASH_FLOOR_CELLS, SILENT } from '../../core/limits'
import { column, columnNames, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeMatrix, makeTable, tableFromRows, JOIN_SEPARATOR } from '../../core/values'
import {
  AGG_OPTIONS,
  NUMERIC_AGG_OPTIONS,
  combineSchema,
  combineTable,
  aggColumnName,
  filterTable,
  idColumn,
  groupBySchema,
  groupByTable,
  joinSchema,
  joinTables,
  relabelSchema,
  relabelTable,
  relabelTarget,
  renameMapping,
  renameSchema,
  renameTable,
  matrixLinksSchema,
  matrixToLinks,
  matrixToTable,
  normalizeMatrix,
  PIVOT_CELLS_WARN,
  PIVOT_COLUMNS_WARN,
  pivotTable,
  sampleRowIndices,
  sampleSchema,
  sampleTable,
  selectSchema,
  selectTable,
  stackColumns,
  stackSchema,
  stackTables,
  uploadIsNeurons,
  uploadShapeSchema,
  uploadShapeTable,
  unpivotIssues,
  unpivotSchema,
  unpivotTable,
  sortTable,
} from './tableOps'
import type { UnpivotSpec } from './tableOps'

const CONNECTIVITY = tableSchema(
  column('neuronId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

function conn(): TableValue {
  return tableFromRows(CONNECTIVITY, [
    { neuronId: 1, partnerType: 'DNp02', weight: 30 },
    { neuronId: 1, partnerType: 'DNp02', weight: 10 },
    { neuronId: 1, partnerType: 'PVLP002', weight: 5 },
    { neuronId: 2, partnerType: 'DNp02', weight: 20 },
    { neuronId: 2, partnerType: 'PVLP002', weight: 15 },
    { neuronId: 3, partnerType: 'PLP003', weight: 2 },
  ])
}

/**
 * The invariant that matters most in this file: what `*Schema` promises at edit time is
 * exactly what `*Table` produces at run time. Drift here breaks column pickers after a
 * run, which is the worst kind of bug to debug.
 */
function expectSchemaAgreement(declared: ReturnType<typeof groupBySchema>, actual: TableValue) {
  expect(declared).toBeDefined()
  expect(actual.schema.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual(
    declared!.columns.map((c) => `${c.name}:${c.dtype}`),
  )
}

describe('filter', () => {
  it('compares numerically on numeric columns', () => {
    const out = filterTable(conn(), 'weight', 'ge', '15')
    expect(out.length).toBe(3)
    expect(out.data.weight).toEqual([30, 20, 15])
  })

  it('supports regex on text columns, anchored as written', () => {
    const out = filterTable(conn(), 'partnerType', 'matches', 'DNp.*')
    expect(new Set(out.data.partnerType as string[])).toEqual(new Set(['DNp02']))
  })

  it('rejects a non-numeric comparison value with a clear message', () => {
    expect(() => filterTable(conn(), 'weight', 'gt', 'abc')).toThrow(/not a number/)
  })

  it('preserves the schema', () => {
    const out = filterTable(conn(), 'weight', 'gt', '0')
    expect(out.schema).toEqual(CONNECTIVITY)
  })
})

describe('sort', () => {
  it('sorts descending and applies a limit', () => {
    const out = sortTable(conn(), 'weight', true, 2)
    expect(out.data.weight).toEqual([30, 20])
  })

  it('sorts text naturally', () => {
    const out = sortTable(conn(), 'partnerType', false, 0)
    expect(out.data.partnerType?.[0]).toBe('DNp02')
  })

  it('is stable for equal keys', () => {
    const table = tableFromRows(CONNECTIVITY, [
      { neuronId: 7, partnerType: 'a', weight: 1 },
      { neuronId: 8, partnerType: 'b', weight: 1 },
      { neuronId: 9, partnerType: 'c', weight: 1 },
    ])
    expect(sortTable(table, 'weight', true, 0).data.neuronId).toEqual([7, 8, 9])
  })

  it('sorts nulls last in both directions', () => {
    const table = tableFromRows(CONNECTIVITY, [
      { neuronId: 1, partnerType: 'a', weight: 5 },
      { neuronId: 2, partnerType: 'b', weight: null },
      { neuronId: 3, partnerType: 'c', weight: 9 },
    ])
    expect(sortTable(table, 'weight', true, 0).data.neuronId).toEqual([3, 1, 2])
    expect(sortTable(table, 'weight', false, 0).data.neuronId).toEqual([1, 3, 2])
  })
})

describe('sample', () => {
  const spec = (over: Partial<Parameters<typeof sampleTable>[1]>) => ({
    mode: 'head' as const,
    count: 0,
    step: 1,
    seed: 1,
    ...over,
  })

  it('takes from the top and from the bottom', () => {
    expect(sampleTable(conn(), spec({ mode: 'head', count: 2 })).data.neuronId).toEqual([1, 1])
    expect(sampleTable(conn(), spec({ mode: 'tail', count: 2 })).data.neuronId).toEqual([2, 3])
  })

  it('strides from the first row', () => {
    expect(sampleRowIndices(7, spec({ mode: 'stride', step: 3 }))).toEqual([0, 3, 6])
    expect(sampleRowIndices(7, spec({ mode: 'stride', step: 1 }))).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])
  })

  it('treats the count as a ceiling rather than a demand', () => {
    expect(sampleTable(conn(), spec({ mode: 'head', count: 99 })).length).toBe(6)
    expect(sampleTable(conn(), spec({ mode: 'tail', count: 99 })).length).toBe(6)
    expect(sampleTable(conn(), spec({ mode: 'random', count: 99 })).length).toBe(6)
  })

  it('keeps no rows and the schema when the count is zero', () => {
    const out = sampleTable(conn(), spec({ mode: 'head', count: 0 }))
    expect(out.length).toBe(0)
    expect(out.schema).toEqual(CONNECTIVITY)
  })

  // The seed is the whole reason this mode is allowed to exist: cache keys are provenance,
  // so a draw that varied per call would make the node's own result disagree with itself.
  it('draws the same rows for a seed and different rows for another', () => {
    const draw = (seed: number) =>
      sampleRowIndices(200, spec({ mode: 'random', count: 20, seed }))
    expect(draw(7)).toEqual(draw(7))
    expect(draw(7)).not.toEqual(draw(8))
  })

  it('draws without replacement, in the input order', () => {
    const drawn = sampleRowIndices(200, spec({ mode: 'random', count: 20, seed: 3 }))
    expect(drawn).toHaveLength(20)
    expect(new Set(drawn).size).toBe(20)
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b))
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...drawn)).toBeLessThan(200)
  })

  it('survives an emptied number field rather than sampling NaN rows', () => {
    expect(sampleTable(conn(), spec({ mode: 'head', count: NaN })).length).toBe(0)
    expect(sampleTable(conn(), spec({ mode: 'stride', step: NaN })).length).toBe(6)
  })

  it('preserves the schema, and neurons-ness with it', () => {
    const out = sampleTable(conn(), spec({ mode: 'stride', step: 2 }))
    expectSchemaAgreement(sampleSchema(CONNECTIVITY), out)
    expect(out.data.neuronId).toEqual([1, 1, 2])
  })
})

describe('upload shaping', () => {
  const UPLOAD = tableSchema(
    column('root_id', 'i64'),
    column('cellType', 'str'),
    column('cluster', 'i64'),
  )
  const upload = () =>
    tableFromRows(UPLOAD, [
      { root_id: 101, cellType: 'LC4', cluster: 3 },
      { root_id: 102, cellType: 'LC6', cluster: null },
    ])

  it('renames the id column and agrees with its schema half', () => {
    const declared = uploadShapeSchema(UPLOAD, { idColumn: 'root_id' })
    const out = uploadShapeTable(upload(), { idColumn: 'root_id' })
    expectSchemaAgreement(declared, out)
    expect(out.data.neuronId).toEqual([101, 102])
    expect(out.kind).toBe('neurons')
  })

  it('widens a chosen column to text, and agrees there too', () => {
    const declared = uploadShapeSchema(UPLOAD, { textColumns: ['cluster'] })
    const out = uploadShapeTable(upload(), { textColumns: ['cluster'] })
    expectSchemaAgreement(declared, out)
    // Null is absence and stays absence: `String(null)` is the four-letter word "null", which
    // would read as a value in every picker and chart downstream.
    expect(out.data.cluster).toEqual(['3', null])
    expect(out.kind).toBe('table')
  })

  it('gives the chosen column the name, and suffixes the one that had it', () => {
    const clash = tableSchema(column('root_id', 'i64'), column('neuronId', 'str'))
    const declared = uploadShapeSchema(clash, { idColumn: 'root_id' })
    const out = uploadShapeTable(tableFromRows(clash, [{ root_id: 1, neuronId: 'x' }]), {
      idColumn: 'root_id',
    })
    expectSchemaAgreement(declared, out)
    expect(columnNames(out.schema)).toEqual(['neuronId', 'neuronId_2'])
    expect(out.data.neuronId).toEqual([1])
    expect(out.data.neuronId_2).toEqual(['x'])
  })

  it('leaves the table alone when nothing is configured', () => {
    const out = uploadShapeTable(upload(), {})
    expect(out.schema).toEqual(UPLOAD)
    expect(out.kind).toBe('table')
  })

  it('does not claim neurons-ness for a column that is not there', () => {
    // The predicate both halves share: a schema half saying `neurons` over a value half that
    // is a plain table breaks the neuronId guarantee downstream only after a run.
    expect(uploadIsNeurons(UPLOAD, 'root_id')).toBe(true)
    expect(uploadIsNeurons(UPLOAD, 'missing')).toBe(false)
    expect(uploadIsNeurons(UPLOAD, '')).toBe(false)
    expect(uploadIsNeurons(undefined, 'root_id')).toBe(false)
    expect(uploadShapeTable(upload(), { idColumn: 'missing' }).kind).toBe('table')
  })
})

describe('stack', () => {
  const LEFT = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
  const RIGHT = tableSchema(column('neuronId', 'i64'), column('hemilineage', 'str'))
  const left = () => tableFromRows(LEFT, [{ neuronId: 1, type: 'LC4' }])
  const right = () => tableFromRows(RIGHT, [{ neuronId: 2, hemilineage: '0B' }])

  it('puts the rows end to end and agrees with its schema half', () => {
    const declared = stackSchema(LEFT, LEFT)
    const out = stackTables(left(), left())
    expectSchemaAgreement(declared, out)
    expect(out.length).toBe(2)
    expect(out.data.neuronId).toEqual([1, 1])
  })

  it('keeps every column, filling the gaps with null', () => {
    // The whole design: a column only one side carries is *not recorded* for the other's rows,
    // which is what null already means here. Dropping it would discard data that was wired in.
    const declared = stackSchema(LEFT, RIGHT)
    const out = stackTables(left(), right())
    expectSchemaAgreement(declared, out)
    expect(columnNames(out.schema)).toEqual(['neuronId', 'type', 'hemilineage'])
    expect(out.data.type).toEqual(['LC4', null])
    expect(out.data.hemilineage).toEqual([null, '0B'])
  })

  it('keeps duplicates and input order — UNION ALL, not UNION', () => {
    const out = stackTables(left(), left())
    expect(out.length).toBe(2)
    const ordered = stackTables(right(), left())
    expect(ordered.data.neuronId).toEqual([2, 1])
  })

  it('widens i64 onto f64 without comment', () => {
    // The same kind of thing: a count stacked onto a ratio is still a number.
    const floats = tableSchema(column('neuronId', 'i64'), column('score', 'f64'))
    const ints = tableSchema(column('neuronId', 'i64'), column('score', 'i64'))
    const merged = stackColumns(floats, ints)
    expect(merged.conflicts).toEqual([])
    expect(merged.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual([
      'neuronId:i64',
      'score:f64',
    ])
  })

  it('reports a real dtype clash rather than throwing, so infer can read it', () => {
    // Returned rather than thrown because `inferOutputs` may not throw (invariant 2) and
    // `validate` returns strings. Only `stackTables` refuses, and on exactly this list.
    const asText = tableSchema(column('neuronId', 'str'))
    const clash = stackColumns(LEFT, asText)
    expect(clash.conflicts).toEqual([{ name: 'neuronId', top: 'i64', bottom: 'str' }])
    // The rest of the schema stays readable, which is what keeps the other pickers usable.
    expect(columnNames({ columns: clash.columns })).toEqual(['neuronId', 'type'])
  })

  it('refuses to build a table over a dtype clash, naming both readings', () => {
    const asText = tableFromRows(tableSchema(column('neuronId', 'str')), [{ neuronId: 'x' }])
    expect(() => stackTables(left(), asText)).toThrow(/i64 above and str below/)
  })

  it('drops a unit the two sides do not agree on', () => {
    // Nanometres stacked onto voxels is a column with no single unit, and carrying one of them
    // would label the other's rows wrongly.
    const nm = tableSchema(column('length', 'f64', 'nm'))
    const voxels = tableSchema(column('length', 'f64', 'voxels'))
    expect(stackColumns(nm, nm).columns[0]!.unit).toBe('nm')
    expect(stackColumns(nm, voxels).columns[0]!.unit).toBeUndefined()
  })

  it('labels the rows when asked, appending the column last', () => {
    const options = { sourceColumn: 'source', topLabel: 'A', bottomLabel: 'B' }
    const declared = stackSchema(LEFT, RIGHT, options)
    const out = stackTables(left(), right(), options)
    expectSchemaAgreement(declared, out)
    // Last rather than first: it is this node's annotation, not part of either table.
    expect(columnNames(out.schema)).toEqual(['neuronId', 'type', 'hemilineage', 'source'])
    expect(out.data.source).toEqual(['A', 'B'])
  })

  it('refuses a source column either input already uses', () => {
    expect(() => stackTables(left(), right(), { sourceColumn: 'type' })).toThrow(
      /already exists/,
    )
  })

  it('is Neurons only when both sides are', () => {
    // A `neurons` kind is a claim about the ids; a plain table carrying a neuronId never made it.
    const neurons = tableFromRows(LEFT, [{ neuronId: 1, type: 'LC4' }], 'neurons')
    expect(stackTables(neurons, neurons).kind).toBe('neurons')
    expect(stackTables(neurons, left()).kind).toBe('table')
  })

  it('knows nothing until both sides are known', () => {
    // Publishing the top's schema alone would advertise a table missing every column the
    // bottom contributes, and a picker downstream would be set up against a shape never built.
    expect(stackSchema(LEFT, undefined)).toBeUndefined()
    expect(stackSchema(undefined, RIGHT)).toBeUndefined()
  })

  it('stacks an empty table without inventing a row', () => {
    const empty = tableFromRows(RIGHT, [])
    const out = stackTables(left(), empty)
    expect(out.length).toBe(1)
    expect(out.data.hemilineage).toEqual([null])
  })
})

describe('groupBy', () => {
  it('sums by key and always reports the group size', () => {
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], ['weight'], 'sum')
    const out = groupByTable(conn(), ['partnerType'], ['weight'], 'sum')
    expectSchemaAgreement(declared, out)

    const rows = new Map(
      (out.data.partnerType as string[]).map((t, i) => [
        t,
        { n: (out.data.n as number[])[i], sum: (out.data.sum_weight as number[])[i] },
      ]),
    )
    expect(rows.get('DNp02')).toEqual({ n: 3, sum: 60 })
    expect(rows.get('PVLP002')).toEqual({ n: 2, sum: 20 })
    expect(rows.get('PLP003')).toEqual({ n: 1, sum: 2 })
  })

  it('produces f64 for mean and agrees with the declared schema', () => {
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], ['weight'], 'mean')
    const out = groupByTable(conn(), ['partnerType'], ['weight'], 'mean')
    expectSchemaAgreement(declared, out)
    expect(declared!.columns.at(-1)).toMatchObject({ name: 'mean_weight', dtype: 'f64' })
    const idx = (out.data.partnerType as string[]).indexOf('DNp02')
    expect((out.data.mean_weight as number[])[idx]).toBeCloseTo(20)
  })

  it('emits only n for count', () => {
    const declared = groupBySchema(CONNECTIVITY, ['neuronId'], [], 'count')
    const out = groupByTable(conn(), ['neuronId'], [], 'count')
    expectSchemaAgreement(declared, out)
    expect(out.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'n'])
    expect(aggColumnName('count', 'weight')).toBe('n')
  })

  it('groups on multiple keys', () => {
    const out = groupByTable(conn(), ['neuronId', 'partnerType'], ['weight'], 'sum')
    expect(out.length).toBe(5)
  })

  it('counts distinct values', () => {
    const out = groupByTable(conn(), ['neuronId'], ['partnerType'], 'countDistinct')
    const idx = (out.data.neuronId as number[]).indexOf(1)
    expect((out.data.countDistinct_partnerType as number[])[idx]).toBe(2)
  })

  it('carries the unit through to the aggregate column', () => {
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], ['weight'], 'sum')
    expect(declared!.columns.at(-1)?.unit).toBe('synapses')
  })

  /*
   * Several value columns, one aggregation. The pair has to agree about the *set* of output
   * columns as well as their dtypes now, which is why every case here goes through
   * `expectSchemaAgreement` rather than reading `out.data` alone.
   */
  it('aggregates several value columns in one pass', () => {
    const schema = tableSchema(
      column('type', 'str'),
      column('pre', 'i64', 'synapses'),
      column('post', 'i64', 'synapses'),
    )
    const table = tableFromRows(schema, [
      { type: 'LC4', pre: 1, post: 10 },
      { type: 'LC4', pre: 2, post: 20 },
      { type: 'LC6', pre: 4, post: 40 },
    ])
    const declared = groupBySchema(schema, ['type'], ['pre', 'post'], 'sum')
    const out = groupByTable(table, ['type'], ['pre', 'post'], 'sum')
    expectSchemaAgreement(declared, out)
    expect(out.schema.columns.map((c) => c.name)).toEqual(['type', 'n', 'sum_pre', 'sum_post'])
    const idx = (out.data.type as string[]).indexOf('LC4')
    expect((out.data.n as number[])[idx]).toBe(2)
    expect((out.data.sum_pre as number[])[idx]).toBe(3)
    expect((out.data.sum_post as number[])[idx]).toBe(30)
    // The unit is per column, not per node: both are synapses here, and each got its own.
    expect(out.schema.columns.map((c) => c.unit)).toEqual([
      undefined,
      undefined,
      'synapses',
      'synapses',
    ])
  })

  it('keeps each column independent, which is what a mean over ragged absences shows', () => {
    // One column's nulls cannot reach another's: each has its own slot in every accumulator.
    const schema = tableSchema(column('k', 'str'), column('a', 'f64'), column('b', 'f64'))
    const table = tableFromRows(schema, [
      { k: 'x', a: 2, b: null },
      { k: 'x', a: null, b: 6 },
    ])
    const out = groupByTable(table, ['k'], ['a', 'b'], 'min')
    expect((out.data.min_a as number[])[0]).toBe(2)
    expect((out.data.min_b as number[])[0]).toBe(6)
  })

  /*
   * The null rules, which is where this used to disagree with `pivotTable` in the same file and
   * with both of its own exporters.
   *
   * `mean` divided by `bucket.n` — the *row* count — so a single null pulled the answer towards
   * zero without appearing anywhere; `min`/`max` answered 0 for a group holding no number, which
   * is a manufactured measurement in a column of real ones. Every expectation below is what pandas
   * answers for the same frame, checked against it.
   */
  describe('nulls in the value column', () => {
    const ragged = () =>
      tableFromRows(tableSchema(column('k', 'str'), column('w', 'f64')), [
        { k: 'a', w: 10 },
        { k: 'a', w: null },
        { k: 'a', w: 20 },
        { k: 'b', w: null },
        { k: 'b', w: null },
      ])
    const at = (out: TableValue, name: string, key: string) =>
      (out.data[name] as CellValue[])[(out.data.k as string[]).indexOf(key)]

    it('divides a mean by the values, not by the rows', () => {
      const out = groupByTable(ragged(), ['k'], ['w'], 'mean')
      // 30 / 2, not 30 / 3. `n` still counts rows, which is what it is for.
      expect(at(out, 'mean_w', 'a')).toBe(15)
      expect(at(out, 'n', 'a')).toBe(3)
    })

    it('answers null, never zero, for a group with no values in it', () => {
      for (const agg of ['mean', 'min', 'max'] as const) {
        expect(at(groupByTable(ragged(), ['k'], ['w'], agg), `${agg}_w`, 'b')).toBeNull()
      }
    })

    it('still answers zero for a sum over nothing, which is the identity not a value', () => {
      // pandas and R agree: `sum` of an empty group is 0. Only the three that divide by or pick
      // from the values can fail to have an answer.
      expect(at(groupByTable(ragged(), ['k'], ['w'], 'sum'), 'sum_w', 'b')).toBe(0)
    })

    it('does not count an absence as a distinct value, but does count an empty string', () => {
      const table = tableFromRows(tableSchema(column('k', 'str'), column('t', 'str')), [
        { k: 'a', t: 'x' },
        { k: 'a', t: null },
        { k: 'a', t: 'x' },
        { k: 'b', t: '' },
        { k: 'b', t: null },
      ])
      const out = groupByTable(table, ['k'], ['t'], 'countDistinct')
      // `nunique`'s answers. Somebody typed the empty string; nobody typed the null.
      expect(at(out, 'countDistinct_t', 'a')).toBe(1)
      expect(at(out, 'countDistinct_t', 'b')).toBe(1)
    })
  })

  it('folds a repeated value column away rather than emitting the name twice', () => {
    // Both copies would be called `sum_weight`, and a schema claiming two columns of one name
    // is a table whose data has one — every downstream picker would offer a duplicate.
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], ['weight', 'weight'], 'sum')
    const out = groupByTable(conn(), ['partnerType'], ['weight', 'weight'], 'sum')
    expectSchemaAgreement(declared, out)
    expect(out.schema.columns.map((c) => c.name)).toEqual(['partnerType', 'n', 'sum_weight'])
  })

  it('ignores the value list entirely for count', () => {
    const out = groupByTable(conn(), ['neuronId'], ['weight', 'partnerType'], 'count')
    expect(out.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'n'])
  })

  it('names a value column the table does not have, rather than dropping it', () => {
    // `resolveColumns` drops a name a *known* schema lacks, so this is reachable only where the
    // schema never arrived — and there the honest answer is the sentence naming the column.
    expect(() => groupByTable(conn(), ['partnerType'], ['weight', 'nope'], 'sum')).toThrow(
      /nope/,
    )
  })

  it('joins several text columns at once', () => {
    const schema = tableSchema(column('k', 'str'), column('tag', 'str'), column('side', 'str'))
    const table = tableFromRows(schema, [
      { k: 'a', tag: 'big', side: 'L' },
      { k: 'a', tag: 'big', side: 'R' },
      { k: 'a', tag: 'dim', side: null },
    ])
    const declared = groupBySchema(schema, ['k'], ['tag', 'side'], 'join')
    const out = groupByTable(table, ['k'], ['tag', 'side'], 'join')
    expectSchemaAgreement(declared, out)
    // Distinct and in first-appearance order, per column.
    expect(out.data.join_tag?.[0]).toBe(`big${JOIN_SEPARATOR}dim`)
    expect(out.data.join_side?.[0]).toBe(`L${JOIN_SEPARATOR}R`)
  })
})

describe('select', () => {
  it('keeps the requested columns in order and agrees with its schema', () => {
    const declared = selectSchema(CONNECTIVITY, ['weight', 'neuronId'])
    const out = selectTable(conn(), ['weight', 'neuronId'])
    expect(out.schema.columns.map((c) => c.name)).toEqual(['weight', 'neuronId'])
    expect(declared!.columns.map((c) => c.name)).toEqual(['weight', 'neuronId'])
  })

  it('passes everything through when nothing is selected', () => {
    expect(selectTable(conn(), []).schema.columns).toHaveLength(3)
  })
})

describe('join', () => {
  const LEFT = { leftKey: 'neuronId', rightKey: 'neuronId', how: 'left' } as const
  const NEURONS = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
  const neurons = () =>
    tableFromRows(
      NEURONS,
      [
        { neuronId: 1, type: 'LC4' },
        { neuronId: 2, type: 'LC6' },
      ],
      'neurons',
    )

  it('annotates the left table and matches its declared schema', () => {
    const declared = joinSchema(CONNECTIVITY, NEURONS, LEFT)
    const out = joinTables(conn(), neurons(), LEFT)
    expect(out.schema.columns.map((c) => c.name)).toEqual(declared!.columns.map((c) => c.name))
    expect(out.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'partnerType',
      'weight',
      'type',
    ])
  })

  it('keeps unmatched left rows as null on a left join', () => {
    const out = joinTables(conn(), neurons(), LEFT)
    expect(out.length).toBe(6)
    const idx = (out.data.neuronId as number[]).indexOf(3)
    expect((out.data.type as (string | null)[])[idx]).toBeNull()
  })

  it('drops unmatched left rows on an inner join', () => {
    const out = joinTables(conn(), neurons(), { ...LEFT, how: 'inner' })
    expect(out.length).toBe(5)
    expect(out.data.neuronId).not.toContain(3)
  })

  it('suffixes colliding column names rather than dropping them', () => {
    const right = tableFromRows(
      tableSchema(column('neuronId', 'i64'), column('weight', 'i64')),
      [{ neuronId: 1, weight: 999 }],
    )
    const out = joinTables(conn(), right, LEFT)
    expect(out.schema.columns.map((c) => c.name)).toContain('weight_r')
    expect(out.schema.columns.map((c) => c.name)).toContain('weight')
  })

  /*
   * The two directions that can emit a row the left never had. Both hinge on the same two
   * questions — which right rows count as unmatched, and what the surviving key column holds
   * for them — so they are tested against the same right table, which carries an id the left
   * has (2), one it does not (9), and a *second* row for an id it does (1).
   */
  const WIDER = tableSchema(column('neuronId', 'i64'), column('side', 'str'))
  const wider = () =>
    tableFromRows(WIDER, [
      { neuronId: 2, side: 'R' },
      { neuronId: 9, side: 'L' },
      { neuronId: 1, side: 'L' },
      { neuronId: 1, side: 'R' },
    ])

  it('appends right-only rows on an outer join and fills their key from the right', () => {
    const out = joinTables(conn(), wider(), { ...LEFT, how: 'outer' })
    // Six left rows, then the one right row whose key the left does not carry at all.
    expect(out.length).toBe(7)
    expect(out.data.neuronId).toEqual([1, 1, 1, 2, 2, 3, 9])
    expect(out.data.side).toEqual(['L', 'L', 'L', 'R', 'R', null, 'L'])
    // The right key column is dropped as redundant, so without the fill row 9 has no id at all.
    expect(out.data.partnerType?.[6]).toBeNull()
  })

  it('does not resurrect a duplicate right row whose key did match', () => {
    // `neuronId: 1` appears twice on the right; the second row lost the dedupe. Re-emitting it
    // in the outer tail would reinstate the multiplication that rule exists to prevent, drawn
    // as a left-null row for a key that plainly matched.
    const out = joinTables(conn(), wider(), { ...LEFT, how: 'outer' })
    expect(out.data.neuronId?.filter((id) => id === 1)).toHaveLength(3)
    expect(out.data.side?.[6]).toBe('L')
  })

  it('keeps every right row in the right table order on a right join', () => {
    const out = joinTables(conn(), wider(), { ...LEFT, how: 'right' })
    expect(out.length).toBe(4)
    expect(out.data.neuronId).toEqual([2, 9, 1, 1])
    // Each right row takes the *first* left row carrying its key — the mirror of a left join's
    // dedupe, so a right join annotates rather than multiplying too.
    expect(out.data.weight).toEqual([20, null, 30, 30])
    expect(out.data.side).toEqual(['R', 'L', 'L', 'R'])
  })

  it('leaves the columns in left-then-right order whichever direction it runs', () => {
    const names = (how: 'left' | 'inner' | 'outer' | 'right') =>
      joinTables(conn(), wider(), { ...LEFT, how }).schema.columns.map((c) => c.name)
    // What makes `right` a direction rather than "swap the wires": nothing downstream moves.
    expect(names('right')).toEqual(names('left'))
    expect(names('outer')).toEqual(names('left'))
  })

  it('widens the key to text where the two sides disagree, and only where it can bite', () => {
    const textIds = tableSchema(column('neuronId', 'str'), column('side', 'str'))
    const right = () => tableFromRows(textIds, [{ neuronId: '9', side: 'L' }])
    const spec = { ...LEFT, how: 'outer' } as const

    const out = joinTables(conn(), right(), spec)
    expectSchemaAgreement(joinSchema(CONNECTIVITY, textIds, spec), out)
    expect(out.schema.columns[0]!.dtype).toBe('str')
    // Both sides stringified, or the column's values disagree with its own declaration.
    expect(out.data.neuronId).toEqual(['1', '1', '1', '2', '2', '3', '9'])

    // A left join can never put a right key value in that column, so nothing widens.
    const kept = joinTables(conn(), right(), { ...LEFT, how: 'left' })
    expect(kept.schema.columns[0]!.dtype).toBe('i64')
    expect(kept.data.neuronId).toEqual([1, 1, 1, 2, 2, 3])
  })

  it('reconciles two numeric keys rather than sending them to text', () => {
    /*
     * `mergedDType`, not a bare `!==` — it is this file's one statement of "can these two
     * reconcile, and into what", and it widens `i64` with `f64` exactly as `stackColumns` and
     * `combineColumns` do. Answering `str` here would take the column out of every numeric
     * picker and flip it to locale collation, with three ops in one file disagreeing.
     */
    const floats = tableSchema(column('neuronId', 'f64'), column('side', 'str'))
    const spec = { ...LEFT, how: 'outer' } as const
    const out = joinTables(conn(), tableFromRows(floats, [{ neuronId: 9, side: 'L' }]), spec)
    expectSchemaAgreement(joinSchema(CONNECTIVITY, floats, spec), out)
    expect(out.schema.columns[0]!.dtype).toBe('f64')
    // Numbers on both sides, so nothing is stringified on the way through.
    expect(out.data.neuronId).toEqual([1, 1, 1, 2, 2, 3, 9])
  })

  it('agrees with its declared schema in every direction', () => {
    for (const how of ['left', 'inner', 'outer', 'right'] as const) {
      const spec = { ...LEFT, how }
      expectSchemaAgreement(
        joinSchema(CONNECTIVITY, WIDER, spec),
        joinTables(conn(), wider(), spec),
      )
    }
  })
})

describe('rename', () => {
  const FOREIGN = tableSchema(
    column('root_id', 'str'),
    column('cell_type', 'str'),
    column('w', 'i64', 'synapses'),
  )
  const foreign = (kind: 'table' | 'neurons' = 'table') =>
    tableFromRows(FOREIGN, [{ root_id: '1', cell_type: 'LC4', w: 5 }], kind)

  it('renames only the names, and agrees with its declared schema', () => {
    const renames = [{ from: 'root_id', to: 'neuronId' }]
    const out = renameTable(foreign(), renames)
    expectSchemaAgreement(renameSchema(FOREIGN, renames), out)
    // The dtype and the unit ride along — that is the whole difference between this and the
    // import nodes' `Text columns`, which widens.
    expect(out.schema.columns).toEqual([
      column('neuronId', 'str'),
      column('cell_type', 'str'),
      column('w', 'i64', 'synapses'),
    ])
    expect(out.data.neuronId).toEqual(['1'])
  })

  it('suffixes a column that merely already held the target name', () => {
    // The chosen column wins the name; `joinedColumns`' call about a collision, and the wide
    // pivot's. Without it the table's schema claims two columns its data has one of.
    const clash = tableSchema(column('neuronId', 'i64'), column('root_id', 'str'))
    const out = renameSchema(clash, [{ from: 'root_id', to: 'neuronId' }])
    expect(out!.columns.map((c) => c.name)).toEqual(['neuronId_2', 'neuronId'])
  })

  it('suffixes the second of two renames aiming at one name', () => {
    /*
     * The mapping is not injective, and the Rename card lets somebody express that in two
     * keystrokes. Taking both literally emits two columns of one name, which is `makeTable`'s
     * ragged throw at best and a silently overwritten column at worst.
     */
    const out = renameTable(foreign(), [
      { from: 'root_id', to: 'label' },
      { from: 'cell_type', to: 'label' },
    ])
    expect(out.schema.columns.map((c) => c.name)).toEqual(['label', 'label_2', 'w'])
    expect(out.data.label).toEqual(['1'])
    expect(out.data.label_2).toEqual(['LC4'])
  })

  it('swaps two names rather than collapsing them', () => {
    const out = renameSchema(FOREIGN, [
      { from: 'root_id', to: 'cell_type' },
      { from: 'cell_type', to: 'root_id' },
    ])
    expect(out!.columns.map((c) => c.name)).toEqual(['cell_type', 'root_id', 'w'])
  })

  it('ignores a rename naming a column the table does not carry', () => {
    expect(
      renameSchema(FOREIGN, [{ from: 'gone', to: 'x' }])!.columns.map((c) => c.name),
    ).toEqual(['root_id', 'cell_type', 'w'])
  })

  describe('the kind', () => {
    it('promotes on an applied rename onto neuronId and demotes when it is renamed away', () => {
      expect(renameTable(foreign(), [{ from: 'root_id', to: 'neuronId' }]).kind).toBe('neurons')

      const neurons = tableFromRows(
        tableSchema(column('neuronId', 'str')),
        [{ neuronId: '1' }],
        'neurons',
      )
      expect(renameTable(neurons, [{ from: 'neuronId', to: 'segment' }]).kind).toBe('table')
    })

    it('does not promote a table it did not touch', () => {
      // `core.stack`'s rule: a plain table that happens to carry a `neuronId` never made the
      // claim, so a rename of some *other* column is not the moment it starts making one.
      const carries = tableFromRows(
        tableSchema(column('neuronId', 'str'), column('cell_type', 'str')),
        [{ neuronId: '1', cell_type: 'LC4' }],
      )
      expect(renameTable(carries, [{ from: 'cell_type', to: 'type' }]).kind).toBe('table')
    })
  })

  describe('renameMapping', () => {
    it('answers the finished names, so a collision comes out as the suffix rather than a clash', () => {
      // What an emitter writes. `root_id → neuronId` on a table that already has one is *two*
      // renames, only one of which anybody typed — and emitting the pairs alone would put two
      // columns of one name in somebody's DataFrame.
      const clash = tableSchema(column('neuronId', 'i64'), column('root_id', 'str'))
      expect(renameMapping(clash, [{ from: 'root_id', to: 'neuronId' }])).toEqual([
        ['neuronId', 'neuronId_2'],
        ['root_id', 'neuronId'],
      ])
    })

    it('falls back to the pairs as typed when there is no schema to resolve against', () => {
      // A Pivot upstream, or a first run. The same answer whenever nothing collides, and the
      // honest limit of what can be known at export time.
      expect(renameMapping(undefined, [{ from: 'root_id', to: 'neuronId' }])).toEqual([
        ['root_id', 'neuronId'],
      ])
    })

    it('reports nothing for a rename that changes no name', () => {
      expect(renameMapping(FOREIGN, [{ from: 'gone', to: 'x' }])).toEqual([])
    })
  })
})

/**
 * What a pivot refuses to build.
 *
 * Reported live as a browser eating 6-10 GB on one tab. The Columns field named a property
 * schema discovery had not returned yet, so `resolveColumn` fell back to the first column —
 * which Rows had already taken — and the node pivoted a 15,000-value field against itself.
 * 225 million cells were allocated inside one `evaluate`, cached, and still resident
 * afterwards; the run stalled for ten seconds and the editor never recovered.
 *
 * The ceilings are on the *shape*, checked before a single array exists, because by the time
 * anything is allocated the damage is done.
 */
describe('pivot ceilings', () => {
  /** `count` rows over `types` distinct types and two sides. */
  function wide(types: number, sides: number) {
    return tableFromRows(
      tableSchema(column('type', 'str'), column('side', 'str'), column('v', 'i64')),
      Array.from({ length: types * sides }, (_, i) => ({
        type: `T${i % types}`,
        side: `S${i % sides}`,
        v: i,
      })),
    )
  }

  it('warns about a Columns field wider than a pivot is usually meant to be, and builds it', () => {
    const table = wide(PIVOT_COLUMNS_WARN + 1, 2)
    const said: string[] = []
    // It used to throw here. A 6,000-column connectivity matrix over an optic lobe is a real
    // thing to want, and the old ceiling refused it in the same breath as it caught a
    // misconfigured picker — so the picker case gets a sentence and the matrix gets built.
    const matrix = pivotTable(table, 'side', 'type', 'v', 'sum', { warn: (m) => said.push(m) })
    expect(matrix.colLabels.length).toBe(PIVOT_COLUMNS_WARN + 1)
    expect(said.join(' ')).toContain('"type"')
    expect(said.join(' ')).toContain('Columns is the small axis')
  })

  it('says nothing to a SILENT warner, and still applies the floors below', () => {
    // `SILENT` is "there is nobody to tell", never "skip the check" — which is exactly what the
    // `ctx?: Warner` this replaced could not distinguish, since one condition carried both.
    expect(() =>
      pivotTable(wide(PIVOT_COLUMNS_WARN + 1, 2), 'side', 'type', 'v', 'sum', SILENT),
    ).not.toThrow()
  })

  it('warns on total cells even when each axis is individually unremarkable', () => {
    // 1,500 x 1,500 is unremarkable on both axes and over two million cells.
    const side = 1_500
    const table = tableFromRows(
      tableSchema(column('a', 'str'), column('b', 'str'), column('v', 'i64')),
      Array.from({ length: side }, (_, i) => ({ a: `A${i}`, b: `B${i}`, v: i })),
    )
    const said: string[] = []
    pivotTable(table, 'a', 'b', 'v', 'sum', { warn: (m) => said.push(m) })
    expect(said.join(' ')).toMatch(/cells/)
    expect(side * side).toBeGreaterThan(PIVOT_CELLS_WARN)
  })

  it('still refuses the shape that has no matrix on the other side of it', () => {
    /*
     * The crash floor, and the reason this file keeps one at all: the accumulators are single
     * allocations sized by the product of two independently-resolved pickers, so there is
     * nothing to warn *about* past it. 8,200 squared is 67 million cells — 538 MB of Float64
     * — from a table of 8,200 rows.
     */
    const side = 8_200
    const table = tableFromRows(
      tableSchema(column('a', 'str'), column('b', 'str'), column('v', 'i64')),
      Array.from({ length: side }, (_, i) => ({ a: `A${i}`, b: `B${i}`, v: i })),
    )
    expect(side * side).toBeGreaterThan(CRASH_FLOOR_CELLS)
    expect(() => pivotTable(table, 'a', 'b', 'v', 'sum', SILENT)).toThrow(/would allocate/)
  })

  it('builds the shape a pivot is actually for', () => {
    // The same data the refusal above was about, the right way round: many rows, few columns.
    const matrix = pivotTable(wide(5_000, 3), 'type', 'side', 'v', 'sum', SILENT)
    expect(matrix.rowLabels).toHaveLength(5_000)
    expect(matrix.colLabels).toHaveLength(3)
  })
})

describe('pivot', () => {
  it('builds a labelled matrix with sorted labels', () => {
    const m = pivotTable(conn(), 'neuronId', 'partnerType', 'weight', 'sum', SILENT)
    expect(m.rowLabels).toEqual(['1', '2', '3'])
    expect(m.colLabels).toEqual(['DNp02', 'PLP003', 'PVLP002'])
    const at = (r: number, c: number) => m.values[r * m.colLabels.length + c]
    expect(at(0, 0)).toBe(40) // body 1 -> DNp02: 30 + 10
    expect(at(0, 2)).toBe(5)
    expect(at(2, 1)).toBe(2)
    expect(at(2, 0)).toBe(0) // absent pair reads as zero
  })

  it('counts rows when asked to', () => {
    const m = pivotTable(conn(), 'neuronId', 'partnerType', undefined, 'count', SILENT)
    expect(m.values[0]).toBe(2)
  })

  /**
   * The Pivot node emits both forms, and the wide table is reshaped from the matrix rather
   * than pivoted again — so these assertions are what stop the two halves of one node from
   * describing different pivots.
   */
  it('reshapes the same pivot into a long edge list, non-zero cells only', () => {
    const m = pivotTable(conn(), 'neuronId', 'partnerType', 'weight', 'sum', SILENT)
    const links = matrixToLinks(m)

    // The half `matrixToTable` does not do, and the one a graph wants: `Build Network` reads
    // these three names off a table, which is why they are these three names.
    expect(links.schema).toEqual(matrixLinksSchema())

    // One row per non-zero cell, row-major in the matrix's own axis order — deterministic,
    // because this value reaches a provenance key.
    const expected: Array<[string, string, number]> = []
    for (let r = 0; r < m.rowLabels.length; r++) {
      for (let c = 0; c < m.colLabels.length; c++) {
        const value = m.values[r * m.colLabels.length + c]!
        if (value !== 0) expected.push([m.rowLabels[r]!, m.colLabels[c]!, value])
      }
    }
    expect(links.length).toBe(expected.length)
    expect(links.data.source).toEqual(expected.map((e) => e[0]))
    expect(links.data.target).toEqual(expected.map((e) => e[1]))
    expect(links.data.weight).toEqual(expected.map((e) => e[2]))
  })

  it('drops the zeros a reshape manufactured, rather than emitting a complete graph', () => {
    /*
     * The one judgement in `matrixToLinks`, and the one that looks like a contradiction:
     * `core.unpivot` keeps zeros on the grounds that 0 may have been measured. Here the zero was
     * *manufactured* — a matrix cell has to hold something, so absence became 0 on the way in —
     * so dropping it going back restores the form the data had. The size argument is the same
     * fact from the other end: a 500 × 500 adjacency kept whole is 250,000 rows, nearly all zero,
     * and `Build Network` would make a complete graph of zero-weight links out of it.
     */
    const m = makeMatrix(['a', 'b'], ['x', 'y'], Float64Array.from([3, 0, 0, 5]))
    const links = matrixToLinks(m)
    expect(links.length).toBe(2)
    expect(links.data.source).toEqual(['a', 'b'])
    expect(links.data.target).toEqual(['x', 'y'])
    expect(links.data.weight).toEqual([3, 5])
  })

  it('has nothing to say about an all-zero matrix, and says it with the right columns', () => {
    const empty = matrixToLinks(makeMatrix(['a'], ['x'], Float64Array.from([0])))
    expect(empty.length).toBe(0)
    expect(empty.schema).toEqual(matrixLinksSchema())
  })

  it('reshapes the same pivot into a wide table', () => {
    const m = pivotTable(conn(), 'neuronId', 'partnerType', 'weight', 'sum', SILENT)
    const wide = matrixToTable(m, 'neuronId')

    expect(wide.schema.columns.map((c) => c.name)).toEqual(['neuronId', ...m.colLabels])
    expect(wide.length).toBe(m.rowLabels.length)
    // Row labels are a matrix axis, so they arrive as text even from an i64 column.
    expect(wide.schema.columns[0]!.dtype).toBe('str')
    expect(wide.data.neuronId).toEqual(['1', '2', '3'])

    const cols = m.colLabels.length
    for (let r = 0; r < m.rowLabels.length; r++) {
      for (let c = 0; c < cols; c++) {
        expect(wide.data[m.colLabels[c]!]![r]).toBe(m.values[r * cols + c])
      }
    }
    // An absent pair is zero in both forms, not null in one of them.
    expect(wide.data.PLP003![0]).toBe(0)
  })

  it('keeps both columns when a label collides with the row field', () => {
    const m = makeMatrix(['a'], ['type', 'other'], Float64Array.from([1, 2]), 'n')
    const wide = matrixToTable(m, 'type')
    expect(wide.schema.columns.map((c) => c.name)).toEqual(['type', 'type_2', 'other'])
    expect(wide.data.type).toEqual(['a'])
    expect(wide.data.type_2).toEqual([1])
  })

  it('reshapes an empty pivot to a table of the same width', () => {
    const empty = tableFromRows(CONNECTIVITY, [])
    const wide = matrixToTable(
      pivotTable(empty, 'neuronId', 'partnerType', 'weight', 'sum', SILENT),
      'neuronId',
    )
    expect(wide.length).toBe(0)
    expect(wide.schema.columns.map((c) => c.name)).toEqual(['neuronId'])
  })
})

describe('unpivot', () => {
  const WIDE = tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('DNp02', 'i64', 'synapses'),
    column('PLP003', 'i64', 'synapses'),
  )
  const wide = () =>
    tableFromRows(
      WIDE,
      [
        { neuronId: 1, type: 'LC4', DNp02: 40, PLP003: 0 },
        { neuronId: 2, type: 'LC6', DNp02: null, PLP003: 7 },
      ],
      'neurons',
    )
  const spec = (over: Partial<UnpivotSpec> = {}): UnpivotSpec => ({
    columns: ['DNp02', 'PLP003'],
    keep: [],
    nameInto: 'name',
    valueInto: 'value',
    ...over,
  })

  it('folds the picked columns and agrees with its schema half', () => {
    const declared = unpivotSchema(WIDE, spec())
    const out = unpivotTable(wide(), spec(), SILENT)
    expectSchemaAgreement(declared, out)
    expect(columnNames(out.schema)).toEqual(['neuronId', 'type', 'name', 'value'])
    // Row-major — `tidyr::pivot_longer`'s order, not `pandas.melt`'s: an input row's cells stay
    // together, which is what makes the result checkable against the input at a glance.
    expect(out.data.name).toEqual(['DNp02', 'PLP003', 'DNp02', 'PLP003'])
    expect(out.data.value).toEqual([40, 0, null, 7])
    expect(out.data.neuronId).toEqual([1, 1, 2, 2])
  })

  it('keeps everything not folded, and only what is asked for once Keep is set', () => {
    // Empty Keep is "whatever is left", which is what somebody means by the id columns; an
    // explicit list is in pick order, `selectTable`'s rule.
    expect(columnNames(unpivotTable(wide(), spec({ keep: ['type'] }), SILENT).schema)).toEqual([
      'type',
      'name',
      'value',
    ])
  })

  it('carries the folded columns dtype and unit, and widens where they disagree', () => {
    expect(unpivotSchema(WIDE, spec())!.columns[3]).toEqual({
      name: 'value',
      dtype: 'i64',
      unit: 'synapses',
    })
    // The unit rides along only while every folded column agrees on it — `stackColumns`' rule,
    // since a count folded together with a length has no single unit.
    const mixed = tableSchema(column('n', 'i64', 'synapses'), column('len', 'f64', 'nm'))
    // Both columns are folded, so nothing is kept and the two new ones are the whole schema.
    expect(unpivotSchema(mixed, spec({ columns: ['n', 'len'] }))!.columns[1]).toEqual({
      name: 'value',
      dtype: 'f64',
    })
    // Text and a number cannot reconcile, so the value column keeps every value as text —
    // `combinedDType`'s widening, the same call the coalesce makes.
    const clash = tableSchema(column('n', 'i64'), column('label', 'str'))
    expect(unpivotSchema(clash, spec({ columns: ['n', 'label'] }))!.columns[1]!.dtype).toBe(
      'str',
    )
  })

  it('stringifies into a text value column without inventing the word "null"', () => {
    const clash = tableFromRows(tableSchema(column('n', 'i64'), column('label', 'str')), [
      { n: 7, label: null },
    ])
    const out = unpivotTable(clash, spec({ columns: ['n', 'label'] }), SILENT)
    // A fold emits a row for an absent cell where a coalesce skips past it, so this is the path
    // `combineTable` does not have — and `String(null)` would read as a value everywhere down.
    expect(out.data.value).toEqual(['7', null])
  })

  it('passes the table through when there is nothing to fold or nowhere to put it', () => {
    for (const s of [
      spec({ columns: [] }),
      spec({ columns: ['gone'] }),
      spec({ nameInto: ' ' }),
      spec({ valueInto: '' }),
    ]) {
      const out = unpivotTable(wide(), s, SILENT)
      expect(out.schema).toEqual(WIDE)
      expect(unpivotSchema(WIDE, s)).toEqual(WIDE)
    }
  })

  it('skips a folded column the schema no longer has', () => {
    // `combineTable`'s rule: a name that is gone is one fewer thing to fold, not a question that
    // can no longer be answered.
    const out = unpivotTable(wide(), spec({ columns: ['gone', 'PLP003'] }), SILENT)
    expect(out.data.name).toEqual(['PLP003', 'PLP003'])
    expect(out.length).toBe(2)
  })

  it('folds a column named in both pickers rather than repeating it', () => {
    const out = unpivotTable(wide(), spec({ keep: ['type', 'DNp02'] }), SILENT)
    expect(columnNames(out.schema)).toEqual(['type', 'name', 'value'])
    expect(unpivotIssues(WIDE, spec({ keep: ['type', 'DNp02'] }))).toEqual([
      'DNp02 is both folded and kept — it will only appear as a value',
    ])
  })

  it('yields a colliding output name rather than displacing a kept column', () => {
    // The other half of `combineLayout`'s rule: these two are this node's own spelling of its
    // output, the same standing as the stack's source column, so they suffix themselves.
    const out = unpivotTable(wide(), spec({ nameInto: 'type', valueInto: 'neuronId' }), SILENT)
    expect(columnNames(out.schema)).toEqual(['neuronId', 'type', 'type_2', 'neuronId_2'])
    expect(out.data.type).toEqual(['LC4', 'LC4', 'LC6', 'LC6'])
    expect(out.data.type_2).toEqual(['DNp02', 'PLP003', 'DNp02', 'PLP003'])
  })

  it('drops null and blank on request, and never a zero', () => {
    const out = unpivotTable(wide(), spec({ dropEmpty: true }), SILENT)
    // 0 stays: it is a value somebody may have measured, and a pivot writes it for an absent
    // pair — deciding here that it is absence would quietly undo that.
    expect(out.data.value).toEqual([40, 0, 7])
    expect(out.data.neuronId).toEqual([1, 1, 2])
  })

  it('keeps the neurons kind only while the id column is kept', () => {
    expect(unpivotTable(wide(), spec(), SILENT).kind).toBe('neurons')
    // Folded away, the claim goes with it — `selectTable`'s rule.
    expect(unpivotTable(wide(), spec({ keep: ['type'] }), SILENT).kind).toBe('table')
    const plain = makeTable(wide().schema, { ...wide().data }, 'table')
    expect(unpivotTable(plain, spec(), SILENT).kind).toBe('table')
  })

  it('round-trips a pivot that had one row per pair, zeros included', () => {
    /*
     * What the pair can and cannot promise. The pivot aggregated nothing here — one row per
     * pair — so every input row comes back; the absent pair does not, it comes back as the
     * explicit 0 `matrixToTable` wrote for it. That is the lossy half said out loud.
     */
    const long = tableFromRows(CONNECTIVITY, [
      { neuronId: 1, partnerType: 'DNp02', weight: 30 },
      { neuronId: 2, partnerType: 'PVLP002', weight: 15 },
    ])
    const back = unpivotTable(
      matrixToTable(pivotTable(long, 'neuronId', 'partnerType', 'weight', 'sum', SILENT), 'id'),
      spec({ columns: ['DNp02', 'PVLP002'], nameInto: 'partnerType', valueInto: 'weight' }),
      SILENT,
    )
    expect(back.length).toBe(4)
    expect(back.data.weight).toEqual([30, 0, 0, 15])
  })

  /**
   * `rows` rows of `folded` foldable columns and `kept` others, built column-wise.
   *
   * The shapes these two ceilings are about are wide, not tall: what the floor answers to is
   * `rows x folded x (kept + 2)`, so the input that reaches it is small enough to build in a
   * unit test — which is the point, since the check has to happen before anything is allocated.
   */
  function widePlain(rows: number, folded: number, kept: number): TableValue {
    const names = [
      ...Array.from({ length: folded }, (_, i) => `c${i}`),
      ...Array.from({ length: kept }, (_, i) => `k${i}`),
    ]
    const data: Record<string, ColumnData> = {}
    for (const name of names) data[name] = new Array(rows).fill(1)
    return makeTable(tableSchema(...names.map((n) => column(n, 'i64'))), data)
  }

  const foldedNames = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`)

  it('warns on a fold past the size a reshape is usually meant to have', () => {
    // The same threshold from the other side, deliberately not a second constant: 100 rows
    // folded over 800 columns, each carrying 30 kept ones, is 2.56 million cells.
    const said: string[] = []
    const out = unpivotTable(widePlain(100, 800, 30), spec({ columns: foldedNames(800) }), {
      warn: (m) => said.push(m),
    })
    expect(out.length).toBe(80_000)
    expect(100 * 800 * 32).toBeGreaterThan(PIVOT_CELLS_WARN)
    expect(said.join(' ')).toContain('cells')
    expect(said.join(' ')).toContain('Going ahead anyway')
  })

  it('refuses the fold that has no table on the other side of it, before allocating', () => {
    /*
     * The crash floor. 100 x 1,000 folded columns is 100,000 rows, and each carries 700 kept
     * columns beside the two new ones — 70 million cells, from a table of 170,000. The floor is
     * checked against that count rather than against an allocation that has already happened.
     */
    const table = widePlain(100, 1_000, 700)
    expect(100 * 1_000 * 702).toBeGreaterThan(CRASH_FLOOR_CELLS)
    expect(() => unpivotTable(table, spec({ columns: foldedNames(1_000) }), SILENT)).toThrow(
      /would allocate/,
    )
  })

  it('says what is unset without ever refusing', () => {
    expect(unpivotIssues(WIDE, spec({ columns: [] }))).toEqual([
      'No columns to fold — the table passes through unchanged',
    ])
    expect(unpivotIssues(WIDE, spec({ nameInto: '' }))[0]).toContain('need a name')
    expect(
      unpivotIssues(WIDE, spec({ columns: ['neuronId', 'type', 'DNp02', 'PLP003'] })),
    ).toEqual(['Nothing is kept, so the values cannot be traced back to their rows'])
    // A schema that has not arrived is not a schema without these columns: nothing to say.
    expect(unpivotIssues(undefined, spec())).toEqual([])
  })
})

describe('normalizeMatrix', () => {
  const m = () =>
    makeMatrix(['a', 'b'], ['x', 'y'], Float64Array.from([1, 3, 0, 0]), 'synapses')

  it('normalises by row and leaves all-zero rows at zero', () => {
    const out = normalizeMatrix(m(), 'row', SILENT)
    expect([...out.values]).toEqual([0.25, 0.75, 0, 0])
  })

  it('normalises by column', () => {
    const out = normalizeMatrix(m(), 'column', SILENT)
    expect([...out.values]).toEqual([1, 1, 0, 0])
  })

  it('normalises by global max', () => {
    expect([...normalizeMatrix(m(), 'max', SILENT).values]).toEqual([1 / 3, 1, 0, 0])
  })

  it('passes through unchanged for mode none', () => {
    expect([...normalizeMatrix(m(), 'none', SILENT).values]).toEqual([1, 3, 0, 0])
  })

  it('applies log10(1+x)', () => {
    const out = normalizeMatrix(m(), 'log', SILENT)
    expect(out.values[0]).toBeCloseTo(Math.log10(2))
  })

  /*
   * Signed matrices, which reach this node routinely — NBLAST calls its scores "the value the
   * Heatmap and Normalize already understand", and a mean NBLAST score is negative between two
   * arbors that are not alike. Every mode here used to answer a grid of zeroes for them.
   */
  describe('a matrix that goes negative', () => {
    // Row a holds values and totals -0.6; row b is measured and empty; row c is ordinary.
    const signed = () =>
      makeMatrix(
        ['a', 'b', 'c'],
        ['x', 'y'],
        Float64Array.from([-0.8, 0.2, 0, 0, 3, 1]),
        'NBLAST score',
        'similarity',
      )

    it('empties a line that holds values and still totals zero or less, and says so', () => {
      const warnings: string[] = []
      const out = normalizeMatrix(signed(), 'row', {
        warn: (message) => warnings.push(message),
      })
      expect([...out.values].slice(0, 2).every(Number.isNaN)).toBe(true)
      // The empty row is *measured* and keeps its zeroes; only the unusable one goes blank.
      expect([...out.values].slice(2, 4)).toEqual([0, 0])
      expect([...out.values].slice(4)).toEqual([0.75, 0.25])
      expect(warnings.join(' ')).toMatch(/1 of 3 rows/)
    })

    it('takes the largest magnitude, so the sign survives and nothing collapses to zero', () => {
      // The extreme has to be on the *negative* side for this to say anything: with the largest
      // magnitude positive, `abs` and a bare `>` pick the same number and the old code looks
      // right. All-negative is where `let max = 0` produced a grid of zeroes.
      const down = makeMatrix(['a'], ['x', 'y', 'z'], Float64Array.from([-4, -1, 2]), 'score')
      expect([...normalizeMatrix(down, 'max', SILENT).values]).toEqual([-1, -0.25, 0.5])

      // And a matrix of counts is untouched: `abs` is the identity where nothing is negative.
      expect([...normalizeMatrix(m(), 'max', SILENT).values]).toEqual([1 / 3, 1, 0, 0])
    })

    it('says how many cells a log cannot be taken of', () => {
      const warnings: string[] = []
      const below = makeMatrix(['a'], ['x', 'y'], Float64Array.from([-3, 1]), 'score')
      const out = normalizeMatrix(below, 'log', { warn: (message) => warnings.push(message) })
      expect(Number.isNaN(out.values[0]!)).toBe(true)
      expect(warnings.join(' ')).toMatch(/1 of 2 cells/)
    })
  })
})

/*
 * The bridge into every DataSource call, and the one place a table cell becomes an id.
 *
 * The rule is exactness: a `NeuronId` is decimal text precisely so that an id wider than
 * `Number.MAX_SAFE_INTEGER` survives, which is what neuPrint's nine-to-eleven digit ids never
 * needed and every CAVE root id does.
 */
describe('idColumn', () => {
  const NUM_IDS = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
  const TEXT_IDS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

  it('reads a numeric id column as text', () => {
    const t = tableFromRows(NUM_IDS, [
      { neuronId: 1158187240, type: 'LC4' },
      { neuronId: 10001, type: 'DNp01' },
    ])
    expect(idColumn(t)).toEqual(['1158187240', '10001'])
  })

  it('passes a text id column through untouched, keeping every digit', () => {
    // Reading these as numbers first would round both, which is the entire point.
    const t = tableFromRows(TEXT_IDS, [
      { neuronId: '648518347529750614', type: 'KC' },
      { neuronId: '720575940379279312', type: 'LC4' },
    ])
    expect(idColumn(t)).toEqual(['648518347529750614', '720575940379279312'])
    expect(idColumn(t)[0]).not.toBe(String(Number('648518347529750614')))
  })

  it('skips a null rather than emitting one, as it always has', () => {
    const t = tableFromRows(NUM_IDS, [
      { neuronId: 1, type: 'a' },
      { neuronId: null, type: 'b' },
      { neuronId: 2, type: 'c' },
    ])
    expect(idColumn(t)).toEqual(['1', '2'])
  })

  it('skips a number that has already lost its digits', () => {
    // Computed rather than written, because the literal would round in this file too. By the
    // time it is a float64 there is nothing to recover, so printing it would be a confident
    // wrong id — worse than a missing one.
    const t = tableFromRows(NUM_IDS, [
      { neuronId: 1, type: 'a' },
      { neuronId: Number.MAX_SAFE_INTEGER + 2, type: 'b' },
      { neuronId: 1.5, type: 'c' },
    ])
    expect(idColumn(t)).toEqual(['1'])
  })
})

describe('idText', () => {
  it('answers null for everything that is not an id', () => {
    expect(idText(null)).toBeNull()
    expect(idText(undefined)).toBeNull()
    expect(idText('')).toBeNull()
    expect(idText('   ')).toBeNull()
    expect(idText(true)).toBeNull()
    expect(idText(Number.NaN)).toBeNull()
  })

  it('trims a text cell, since a pasted column carries whitespace', () => {
    expect(idText('  1234 ')).toBe('1234')
  })
})

describe('isNeuronId', () => {
  /*
   * The transport grammar, pinned in one place. It was written four times before it was
   * written once and the copies disagreed about the sign, so the point of this block is that
   * there is now a single answer for the query builders and both exporters to share.
   */
  it('accepts digits at any width', () => {
    expect(isNeuronId('0')).toBe(true)
    expect(isNeuronId('1158187240')).toBe(true)
    expect(isNeuronId('648518347529750614')).toBe(true)
  })

  it('accepts a sign, because a source may hand one back', () => {
    // Stricter than the *typed* grammar in `idList.ts`, which refuses `-1` as a mistyped range.
    // Data is data; authored text is a mistake somebody can fix.
    expect(isNeuronId('-7')).toBe(true)
  })

  it('refuses anything that would not splice into a query as an integer', () => {
    expect(isNeuronId('')).toBe(false)
    expect(isNeuronId('12a')).toBe(false)
    expect(isNeuronId('1.5')).toBe(false)
    expect(isNeuronId('1e3')).toBe(false)
    expect(isNeuronId('+1')).toBe(false)
    expect(isNeuronId(' 1')).toBe(false)
    expect(isNeuronId('1,000')).toBe(false)
    expect(isNeuronId("1' OR 1=1--")).toBe(false)
  })
})

describe('compareIds', () => {
  it('orders by magnitude rather than lexically', () => {
    // A plain string sort puts "10" before "9", which would reshuffle every traversal result.
    expect(['9', '10', '2'].sort(compareIds)).toEqual(['2', '9', '10'])
  })

  it('stays exact where subtracting two numbers would not', () => {
    const a = '648518347529750614'
    const b = '648518347529750615'
    // Both round to the same float64, so `Number(a) - Number(b)` is 0 — the two would be
    // reported equal and their order would depend on the sort's stability.
    expect(Number(a) - Number(b)).toBe(0)
    expect(compareIds(a, b)).toBeLessThan(0)
    expect(compareIds(b, a)).toBeGreaterThan(0)
    expect(compareIds(a, a)).toBe(0)
  })
})

describe('combine columns', () => {
  const ANN = tableSchema(
    column('neuronId', 'i64'),
    column('cell_type', 'str'),
    column('hemibrain_type', 'str'),
  )
  const ann = () =>
    tableFromRows(ANN, [
      { neuronId: 1, cell_type: 'LC4', hemibrain_type: 'LC4b' },
      // The two absences a real annotation dump mixes: a blank field and a missing one.
      { neuronId: 2, cell_type: '', hemibrain_type: 'PS180' },
      { neuronId: 3, cell_type: null, hemibrain_type: 'DNp01' },
      { neuronId: 4, cell_type: null, hemibrain_type: null },
    ])

  const spec = (over: Partial<Parameters<typeof combineTable>[1]> = {}) => ({
    columns: ['cell_type', 'hemibrain_type'],
    into: 'type',
    ...over,
  })

  it('takes the first column with a value, and reads blank as absent', () => {
    const declared = combineSchema(ANN, spec())
    const out = combineTable(ann(), spec())
    expectSchemaAgreement(declared, out)
    // Row 2 is the one that matters: `''` must not stop the search, or a neuron with a blank
    // cell_type is reported as having no type at all while the next column holds one.
    expect(out.data.type).toEqual(['LC4', 'PS180', 'DNp01', null])
  })

  it('honours the picked order rather than the schema order', () => {
    const out = combineTable(ann(), spec({ columns: ['hemibrain_type', 'cell_type'] }))
    expect(out.data.type).toEqual(['LC4b', 'PS180', 'DNp01', null])
  })

  it('backfills in place when the result names one of the picked columns', () => {
    const out = combineTable(ann(), spec({ into: 'cell_type' }))
    expect(columnNames(out.schema)).toEqual(columnNames(ANN))
    expect(out.data.cell_type).toEqual(['LC4', 'PS180', 'DNp01', null])
  })

  it('suffixes a column that merely already held the name', () => {
    const clash = tableSchema(column('a', 'str'), column('type', 'str'))
    const table = tableFromRows(clash, [{ a: 'x', type: 'old' }])
    const at = { columns: ['a'], into: 'type' }
    const declared = combineSchema(clash, at)
    const out = combineTable(table, at)
    expectSchemaAgreement(declared, out)
    // Lossless: the result wins the name and the incumbent is kept beside it, which is the
    // call `renamedColumns` and `joinedColumns` both make.
    expect(columnNames(out.schema)).toEqual(['a', 'type_2', 'type'])
    expect(out.data.type_2).toEqual(['old'])
    expect(out.data.type).toEqual(['x'])
  })

  it('names which column each value came from, and nothing where none did', () => {
    const at = spec({ sourceColumn: 'from' })
    const declared = combineSchema(ANN, at)
    const out = combineTable(ann(), at)
    expectSchemaAgreement(declared, out)
    expect(out.data.from).toEqual(['cell_type', 'hemibrain_type', 'hemibrain_type', null])
  })

  it('widens to text where the picked columns disagree, and keeps a shared dtype', () => {
    const mixed = tableSchema(column('name', 'str'), column('cluster', 'i64'))
    const table = tableFromRows(mixed, [
      { name: null, cluster: 12693 },
      { name: 'LC4', cluster: 7 },
    ])
    const at = { columns: ['name', 'cluster'], into: 'label' }
    const declared = combineSchema(mixed, at)
    const out = combineTable(table, at)
    expectSchemaAgreement(declared, out)
    // A number reaching a text column is converted rather than left as a number, or the dtype
    // is a lie and every consumer reading the column by dtype disagrees with what is in it.
    expect(declared!.columns.at(-1)!.dtype).toBe('str')
    expect(out.data.label).toEqual(['12693', 'LC4'])

    const nums = tableSchema(column('a', 'i64'), column('b', 'i64'))
    expect(combineSchema(nums, { columns: ['a', 'b'], into: 'c' })!.columns.at(-1)!.dtype).toBe(
      'i64',
    )
    const wide = tableSchema(column('a', 'i64'), column('b', 'f64'))
    expect(combineSchema(wide, { columns: ['a', 'b'], into: 'c' })!.columns.at(-1)!.dtype).toBe(
      'f64',
    )
  })

  it('skips a column the table does not have rather than refusing', () => {
    const out = combineTable(ann(), spec({ columns: ['gone', 'hemibrain_type'] }))
    expect(out.data.type).toEqual(['LC4b', 'PS180', 'DNp01', null])
  })

  it('passes the table through when it is not configured', () => {
    expect(combineTable(ann(), { columns: [], into: 'type' }).schema).toEqual(ANN)
    expect(combineTable(ann(), { columns: ['cell_type'], into: '' }).schema).toEqual(ANN)
  })
})

describe('the join aggregation', () => {
  const TAGS = tableSchema(column('neuronId', 'str'), column('tag', 'str'))
  const tags = () =>
    tableFromRows(TAGS, [
      { neuronId: '1', tag: 'left' },
      { neuronId: '1', tag: '' },
      { neuronId: '1', tag: 'left' },
      { neuronId: '2', tag: null },
      { neuronId: '3', tag: 'putative giant fibre' },
    ])

  const joined = (t = tags()) => groupByTable(t, ['neuronId'], ['tag'], 'join')

  it('folds a repeat away, and skips both kinds of absence', () => {
    const out = joined()
    /*
     * Distinct, which is the departure from `string_agg`. This cell exists to be read — it is
     * what a community-annotation table folds into, and two people adding the same tag is the
     * ordinary case there — so a repeat is noise in every use this has.
     */
    expect(out.data.join_tag?.[0]).toBe('left')
    // Null and blank are one absence, the rule `coda_combine` follows one op over.
    expect(out.data.join_tag?.[0]).not.toContain(`${JOIN_SEPARATOR}${JOIN_SEPARATOR}`)
  })

  it('keeps the order values first appeared in', () => {
    const t = tableFromRows(TAGS, [
      { neuronId: '1', tag: 'b' },
      { neuronId: '1', tag: 'a' },
      { neuronId: '1', tag: 'b' },
    ])
    // First appearance, not sorted and not last-wins: the order somebody's rows were in is the
    // only order this has any claim to.
    expect(joined(t).data.join_tag?.[0]).toBe(`b${JOIN_SEPARATOR}a`)
  })

  it('folds on exact text, so two spellings stay two values', () => {
    // `DA?` and `da?` are different text somebody typed; folding them would be an editorial
    // decision an aggregation cannot make.
    const t = tableFromRows(TAGS, [
      { neuronId: '1', tag: 'DA?' },
      { neuronId: '1', tag: 'da?' },
    ])
    expect(joined(t).data.join_tag?.[0]).toBe(`DA?${JOIN_SEPARATOR}da?`)
  })

  it('answers null for a group with nothing in it, never an empty string', () => {
    // `String(null)` is the four-letter word, and `''` reads as a value to every picker
    // downstream. A neuron nobody tagged has no tags.
    expect(joined().data.join_tag?.[1]).toBeNull()
  })

  it('still counts every row in n, including the ones it skipped and folded', () => {
    // `n` is rows, not values: three rows went into one tag, and losing that would hide how
    // much agreement is behind a label.
    expect(joined().data.n?.[0]).toBe(3)
  })

  it('agrees with its schema half, and produces text whatever it was given', () => {
    const declared = groupBySchema(TAGS, ['neuronId'], ['tag'], 'join')
    expectSchemaAgreement(declared, joined())
    expect(declared!.columns.at(-1)!.dtype).toBe('str')

    // A number joined is text, and the *unit* does not ride along: nanometres joined with
    // semicolons are no longer nanometres.
    const nm = tableSchema(column('k', 'str'), column('len', 'i64', 'nm'))
    const out = groupByTable(
      tableFromRows(nm, [
        { k: 'a', len: 1 },
        { k: 'a', len: 2 },
      ]),
      ['k'],
      ['len'],
      'join',
    )
    expectSchemaAgreement(groupBySchema(nm, ['k'], ['len'], 'join'), out)
    expect(out.data.join_len?.[0]).toBe(`1${JOIN_SEPARATOR}2`)
    expect(out.schema.columns.at(-1)!.unit).toBeUndefined()
  })

  it('is not offered where the result has to be a number', () => {
    /*
     * A `MatrixValue` cell is a `Float64Array` slot, so `core.pivot` can only take aggregations
     * that produce one. Derived from `aggDType` rather than listed, so a future text aggregation
     * is excluded by arriving — the failure otherwise is a dropdown entry that silently yields a
     * matrix of zeroes.
     */
    expect(AGG_OPTIONS.map((o) => o.value)).toContain('join')
    expect(NUMERIC_AGG_OPTIONS.map((o) => o.value)).not.toContain('join')
    expect(NUMERIC_AGG_OPTIONS.length).toBe(AGG_OPTIONS.length - 1)
  })
})

describe('relabel', () => {
  /** A connectivity-ish table whose `preType` is what a mapping rewrites. */
  const EDGES = tableSchema(column('preType', 'str'), column('weight', 'i64', 'synapses'))
  const edges = () =>
    tableFromRows(EDGES, [
      { preType: 'LC4', weight: 30 },
      { preType: 'LPLC1', weight: 20 },
      { preType: 'DNp01', weight: 10 },
      { preType: null, weight: 5 },
    ])

  const MAP = tableSchema(column('from', 'str'), column('to', 'str'))
  const mapping = () =>
    tableFromRows(MAP, [
      { from: 'LC4', to: 'LC4_LC6' },
      { from: 'LPLC1', to: 'LPLC1' },
    ])

  const spec = (over: Partial<Parameters<typeof relabelTable>[2]> = {}) => ({
    column: 'preType',
    keyColumn: 'from',
    valueColumn: 'to',
    unmatched: 'null' as const,
    ...over,
  })

  it('rewrites in place and leaves an unmatched value empty', () => {
    const out = relabelTable(edges(), mapping(), spec())
    expect(out.data.preType).toEqual(['LC4_LC6', 'LPLC1', null, null])
    expect(out.length).toBe(4)
    // Everything else rides along untouched, which is what makes this not a Select.
    expect(out.data.weight).toEqual([30, 20, 10, 5])
  })

  it('keeps the original where asked, and widens the column when the two dtypes differ', () => {
    const out = relabelTable(edges(), mapping(), spec({ unmatched: 'keep' }))
    expect(out.data.preType).toEqual(['LC4_LC6', 'LPLC1', 'DNp01', null])

    // The case that decides the dtype: numbers put back into a column of text.
    const numeric = tableSchema(column('from', 'str'), column('cluster', 'i64'))
    const numbers = tableFromRows(numeric, [{ from: 'LC4', cluster: 7 }])
    const kept = relabelTable(
      edges(),
      numbers,
      spec({ valueColumn: 'cluster', unmatched: 'keep' }),
    )
    expectSchemaAgreement(
      relabelSchema(EDGES, numeric, spec({ valueColumn: 'cluster', unmatched: 'keep' })),
      kept,
    )
    expect(kept.schema.columns[0]!.dtype).toBe('str')
    // …and where nothing is put back, the column simply *is* the mapping's values.
    const nulled = relabelTable(edges(), numbers, spec({ valueColumn: 'cluster' }))
    expect(nulled.schema.columns[0]!.dtype).toBe('i64')
    expect(nulled.data.preType).toEqual([7, null, null, null])
  })

  it('drops the rows it could not map, every column together', () => {
    const out = relabelTable(edges(), mapping(), spec({ unmatched: 'drop' }))
    expect(out.data.preType).toEqual(['LC4_LC6', 'LPLC1'])
    expect(out.data.weight).toEqual([30, 20])
    expect(out.length).toBe(2)
  })

  it('appends when given a name, and suffixes rather than overwriting a column that exists', () => {
    const out = relabelTable(edges(), mapping(), spec({ into: 'label' }))
    expect(columnNames(out.schema)).toEqual(['preType', 'weight', 'label'])
    expect(out.data.preType).toEqual(['LC4', 'LPLC1', 'DNp01', null])
    expect(out.data.label).toEqual(['LC4_LC6', 'LPLC1', null, null])

    // A name the table already has is the newcomer's problem, never the incumbent's.
    const clash = relabelTable(edges(), mapping(), spec({ into: 'weight' }))
    expect(columnNames(clash.schema)).toEqual(['preType', 'weight', 'weight_2'])
    expect(clash.data.weight).toEqual([30, 20, 10, 5])

    // Except the column's own name, which means what leaving the field empty means.
    expect(relabelTarget(EDGES, 'preType', 'preType')).toBe('preType')
    expect(
      columnNames(relabelTable(edges(), mapping(), spec({ into: 'preType' })).schema),
    ).toEqual(['preType', 'weight'])
  })

  it('uses a repeated key once and never multiplies rows', () => {
    const repeated = tableFromRows(MAP, [
      { from: 'LC4', to: 'first' },
      { from: 'LC4', to: 'second' },
    ])
    const out = relabelTable(edges(), repeated, spec())
    expect(out.length).toBe(4)
    expect(out.data.preType?.[0]).toBe('first')
  })

  it('matches as text, so a number and its text are one key', () => {
    // `rowKey`'s rule, and the reason a Relabel and a Join cannot disagree about a key.
    const numeric = tableSchema(column('id', 'i64'), column('weight', 'i64'))
    const table = tableFromRows(numeric, [{ id: 42, weight: 1 }])
    const text = tableFromRows(MAP, [{ from: '42', to: 'answer' }])
    const out = relabelTable(table, text, spec({ column: 'id' }))
    expect(out.data.id).toEqual(['answer'])
  })

  it('treats a null as its own key rather than as a value that matches nothing', () => {
    const withNull = tableFromRows(MAP, [{ from: null, to: 'untyped' }])
    const out = relabelTable(edges(), withNull, spec())
    expect(out.data.preType).toEqual([null, null, null, 'untyped'])
  })

  it('carries the unit only where every value came from the mapping', () => {
    const measured = tableSchema(column('from', 'str'), column('length', 'f64', 'nm'))
    const lengths = tableFromRows(measured, [{ from: 'LC4', length: 1200 }])
    const mapped = relabelSchema(EDGES, measured, spec({ valueColumn: 'length' }))
    expect(mapped!.columns[0]).toEqual(column('preType', 'f64', 'nm'))
    // With `keep`, half the column is type names — nanometres would be a claim about those too.
    const kept = relabelSchema(
      EDGES,
      measured,
      spec({ valueColumn: 'length', unmatched: 'keep' }),
    )
    expect(kept!.columns[0]).toEqual(column('preType', 'str'))
    expectSchemaAgreement(
      mapped,
      relabelTable(edges(), lengths, spec({ valueColumn: 'length' })),
    )
  })

  it('passes the schema through rather than blanking it while a picker is unresolved', () => {
    // A schema that has not arrived is not a schema without these columns in it — the rule
    // `resolveColumn` keeps, and blanking it here empties every picker downstream.
    expect(relabelSchema(EDGES, undefined, spec())).toEqual(EDGES)
    expect(relabelSchema(EDGES, MAP, spec({ column: '' }))).toEqual(EDGES)
    expect(relabelSchema(undefined, MAP, spec())).toBeUndefined()
  })

  it('keeps a neuron table a neuron table', () => {
    const neurons = tableFromRows(EDGES, [{ preType: 'LC4', weight: 1 }], 'neurons')
    expect(relabelTable(neurons, mapping(), spec()).kind).toBe('neurons')
  })

  it('refuses a column it was told to use and cannot find', () => {
    expect(() => relabelTable(edges(), mapping(), spec({ keyColumn: 'gone' }))).toThrow(/gone/)
    expect(() => relabelTable(edges(), mapping(), spec({ column: 'gone' }))).toThrow(/gone/)
  })
})
