import { describe, expect, it } from 'vitest'

import { column, columnNames, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { makeMatrix, tableFromRows } from '../../core/values'
import {
  aggColumnName,
  filterTable,
  groupBySchema,
  groupByTable,
  joinSchema,
  joinTables,
  matrixToTable,
  normalizeMatrix,
  MAX_PIVOT_CELLS,
  MAX_PIVOT_COLUMNS,
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
  sortTable,
} from './tableOps'

const CONNECTIVITY = tableSchema(
  column('bodyId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

function conn(): TableValue {
  return tableFromRows(CONNECTIVITY, [
    { bodyId: 1, partnerType: 'DNp02', weight: 30 },
    { bodyId: 1, partnerType: 'DNp02', weight: 10 },
    { bodyId: 1, partnerType: 'PVLP002', weight: 5 },
    { bodyId: 2, partnerType: 'DNp02', weight: 20 },
    { bodyId: 2, partnerType: 'PVLP002', weight: 15 },
    { bodyId: 3, partnerType: 'PLP003', weight: 2 },
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
      { bodyId: 7, partnerType: 'a', weight: 1 },
      { bodyId: 8, partnerType: 'b', weight: 1 },
      { bodyId: 9, partnerType: 'c', weight: 1 },
    ])
    expect(sortTable(table, 'weight', true, 0).data.bodyId).toEqual([7, 8, 9])
  })

  it('sorts nulls last in both directions', () => {
    const table = tableFromRows(CONNECTIVITY, [
      { bodyId: 1, partnerType: 'a', weight: 5 },
      { bodyId: 2, partnerType: 'b', weight: null },
      { bodyId: 3, partnerType: 'c', weight: 9 },
    ])
    expect(sortTable(table, 'weight', true, 0).data.bodyId).toEqual([3, 1, 2])
    expect(sortTable(table, 'weight', false, 0).data.bodyId).toEqual([1, 3, 2])
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
    expect(sampleTable(conn(), spec({ mode: 'head', count: 2 })).data.bodyId).toEqual([1, 1])
    expect(sampleTable(conn(), spec({ mode: 'tail', count: 2 })).data.bodyId).toEqual([2, 3])
  })

  it('strides from the first row', () => {
    expect(sampleRowIndices(7, spec({ mode: 'stride', step: 3 }))).toEqual([0, 3, 6])
    expect(sampleRowIndices(7, spec({ mode: 'stride', step: 1 }))).toEqual([0, 1, 2, 3, 4, 5, 6])
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
    const draw = (seed: number) => sampleRowIndices(200, spec({ mode: 'random', count: 20, seed }))
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
    expect(out.data.bodyId).toEqual([1, 1, 2])
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
    const declared = uploadShapeSchema(UPLOAD, 'root_id', [])
    const out = uploadShapeTable(upload(), 'root_id', [])
    expectSchemaAgreement(declared, out)
    expect(out.data.bodyId).toEqual([101, 102])
    expect(out.kind).toBe('neurons')
  })

  it('widens a chosen column to text, and agrees there too', () => {
    const declared = uploadShapeSchema(UPLOAD, '', ['cluster'])
    const out = uploadShapeTable(upload(), '', ['cluster'])
    expectSchemaAgreement(declared, out)
    // Null is absence and stays absence: `String(null)` is the four-letter word "null", which
    // would read as a value in every picker and chart downstream.
    expect(out.data.cluster).toEqual(['3', null])
    expect(out.kind).toBe('table')
  })

  it('gives the chosen column the name, and suffixes the one that had it', () => {
    const clash = tableSchema(column('root_id', 'i64'), column('bodyId', 'str'))
    const declared = uploadShapeSchema(clash, 'root_id', [])
    const out = uploadShapeTable(tableFromRows(clash, [{ root_id: 1, bodyId: 'x' }]), 'root_id', [])
    expectSchemaAgreement(declared, out)
    expect(columnNames(out.schema)).toEqual(['bodyId', 'bodyId_2'])
    expect(out.data.bodyId).toEqual([1])
    expect(out.data.bodyId_2).toEqual(['x'])
  })

  it('leaves the table alone when nothing is configured', () => {
    const out = uploadShapeTable(upload(), '', [])
    expect(out.schema).toEqual(UPLOAD)
    expect(out.kind).toBe('table')
  })

  it('does not claim neurons-ness for a column that is not there', () => {
    // The predicate both halves share: a schema half saying `neurons` over a value half that
    // is a plain table breaks the bodyId guarantee downstream only after a run.
    expect(uploadIsNeurons(UPLOAD, 'root_id')).toBe(true)
    expect(uploadIsNeurons(UPLOAD, 'missing')).toBe(false)
    expect(uploadIsNeurons(UPLOAD, '')).toBe(false)
    expect(uploadIsNeurons(undefined, 'root_id')).toBe(false)
    expect(uploadShapeTable(upload(), 'missing', []).kind).toBe('table')
  })
})

describe('stack', () => {
  const LEFT = tableSchema(column('bodyId', 'i64'), column('type', 'str'))
  const RIGHT = tableSchema(column('bodyId', 'i64'), column('hemilineage', 'str'))
  const left = () => tableFromRows(LEFT, [{ bodyId: 1, type: 'LC4' }])
  const right = () => tableFromRows(RIGHT, [{ bodyId: 2, hemilineage: '0B' }])

  it('puts the rows end to end and agrees with its schema half', () => {
    const declared = stackSchema(LEFT, LEFT)
    const out = stackTables(left(), left())
    expectSchemaAgreement(declared, out)
    expect(out.length).toBe(2)
    expect(out.data.bodyId).toEqual([1, 1])
  })

  it('keeps every column, filling the gaps with null', () => {
    // The whole design: a column only one side carries is *not recorded* for the other's rows,
    // which is what null already means here. Dropping it would discard data that was wired in.
    const declared = stackSchema(LEFT, RIGHT)
    const out = stackTables(left(), right())
    expectSchemaAgreement(declared, out)
    expect(columnNames(out.schema)).toEqual(['bodyId', 'type', 'hemilineage'])
    expect(out.data.type).toEqual(['LC4', null])
    expect(out.data.hemilineage).toEqual([null, '0B'])
  })

  it('keeps duplicates and input order — UNION ALL, not UNION', () => {
    const out = stackTables(left(), left())
    expect(out.length).toBe(2)
    const ordered = stackTables(right(), left())
    expect(ordered.data.bodyId).toEqual([2, 1])
  })

  it('widens i64 onto f64 without comment', () => {
    // The same kind of thing: a count stacked onto a ratio is still a number.
    const floats = tableSchema(column('bodyId', 'i64'), column('score', 'f64'))
    const ints = tableSchema(column('bodyId', 'i64'), column('score', 'i64'))
    const merged = stackColumns(floats, ints)
    expect(merged.conflicts).toEqual([])
    expect(merged.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual(['bodyId:i64', 'score:f64'])
  })

  it('reports a real dtype clash rather than throwing, so infer can read it', () => {
    // Returned rather than thrown because `inferOutputs` may not throw (invariant 2) and
    // `validate` returns strings. Only `stackTables` refuses, and on exactly this list.
    const asText = tableSchema(column('bodyId', 'str'))
    const clash = stackColumns(LEFT, asText)
    expect(clash.conflicts).toEqual([{ name: 'bodyId', top: 'i64', bottom: 'str' }])
    // The rest of the schema stays readable, which is what keeps the other pickers usable.
    expect(columnNames({ columns: clash.columns })).toEqual(['bodyId', 'type'])
  })

  it('refuses to build a table over a dtype clash, naming both readings', () => {
    const asText = tableFromRows(tableSchema(column('bodyId', 'str')), [{ bodyId: 'x' }])
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
    expect(columnNames(out.schema)).toEqual(['bodyId', 'type', 'hemilineage', 'source'])
    expect(out.data.source).toEqual(['A', 'B'])
  })

  it('refuses a source column either input already uses', () => {
    expect(() => stackTables(left(), right(), { sourceColumn: 'type' })).toThrow(/already exists/)
  })

  it('is Neurons only when both sides are', () => {
    // A `neurons` kind is a claim about the ids; a plain table carrying a bodyId never made it.
    const neurons = tableFromRows(LEFT, [{ bodyId: 1, type: 'LC4' }], 'neurons')
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
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], 'weight', 'sum')
    const out = groupByTable(conn(), ['partnerType'], 'weight', 'sum')
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
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], 'weight', 'mean')
    const out = groupByTable(conn(), ['partnerType'], 'weight', 'mean')
    expectSchemaAgreement(declared, out)
    expect(declared!.columns.at(-1)).toMatchObject({ name: 'mean_weight', dtype: 'f64' })
    const idx = (out.data.partnerType as string[]).indexOf('DNp02')
    expect((out.data.mean_weight as number[])[idx]).toBeCloseTo(20)
  })

  it('emits only n for count', () => {
    const declared = groupBySchema(CONNECTIVITY, ['bodyId'], undefined, 'count')
    const out = groupByTable(conn(), ['bodyId'], undefined, 'count')
    expectSchemaAgreement(declared, out)
    expect(out.schema.columns.map((c) => c.name)).toEqual(['bodyId', 'n'])
    expect(aggColumnName('count', 'weight')).toBe('n')
  })

  it('groups on multiple keys', () => {
    const out = groupByTable(conn(), ['bodyId', 'partnerType'], 'weight', 'sum')
    expect(out.length).toBe(5)
  })

  it('counts distinct values', () => {
    const out = groupByTable(conn(), ['bodyId'], 'partnerType', 'countDistinct')
    const idx = (out.data.bodyId as number[]).indexOf(1)
    expect((out.data.countDistinct_partnerType as number[])[idx]).toBe(2)
  })

  it('carries the unit through to the aggregate column', () => {
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], 'weight', 'sum')
    expect(declared!.columns.at(-1)?.unit).toBe('synapses')
  })
})

describe('select', () => {
  it('keeps the requested columns in order and agrees with its schema', () => {
    const declared = selectSchema(CONNECTIVITY, ['weight', 'bodyId'])
    const out = selectTable(conn(), ['weight', 'bodyId'])
    expect(out.schema.columns.map((c) => c.name)).toEqual(['weight', 'bodyId'])
    expect(declared!.columns.map((c) => c.name)).toEqual(['weight', 'bodyId'])
  })

  it('passes everything through when nothing is selected', () => {
    expect(selectTable(conn(), []).schema.columns).toHaveLength(3)
  })
})

describe('join', () => {
  const NEURONS = tableSchema(column('bodyId', 'i64'), column('type', 'str'))
  const neurons = () =>
    tableFromRows(
      NEURONS,
      [
        { bodyId: 1, type: 'LC4' },
        { bodyId: 2, type: 'LC6' },
      ],
      'neurons',
    )

  it('annotates the left table and matches its declared schema', () => {
    const declared = joinSchema(CONNECTIVITY, NEURONS, 'bodyId', '_r')
    const out = joinTables(conn(), neurons(), 'bodyId', 'bodyId', 'left')
    expect(out.schema.columns.map((c) => c.name)).toEqual(declared!.columns.map((c) => c.name))
    expect(out.schema.columns.map((c) => c.name)).toEqual([
      'bodyId',
      'partnerType',
      'weight',
      'type',
    ])
  })

  it('keeps unmatched left rows as null on a left join', () => {
    const out = joinTables(conn(), neurons(), 'bodyId', 'bodyId', 'left')
    expect(out.length).toBe(6)
    const idx = (out.data.bodyId as number[]).indexOf(3)
    expect((out.data.type as (string | null)[])[idx]).toBeNull()
  })

  it('drops unmatched left rows on an inner join', () => {
    const out = joinTables(conn(), neurons(), 'bodyId', 'bodyId', 'inner')
    expect(out.length).toBe(5)
    expect(out.data.bodyId).not.toContain(3)
  })

  it('suffixes colliding column names rather than dropping them', () => {
    const right = tableFromRows(tableSchema(column('bodyId', 'i64'), column('weight', 'i64')), [
      { bodyId: 1, weight: 999 },
    ])
    const out = joinTables(conn(), right, 'bodyId', 'bodyId', 'left')
    expect(out.schema.columns.map((c) => c.name)).toContain('weight_r')
    expect(out.schema.columns.map((c) => c.name)).toContain('weight')
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

  it('refuses a Columns field with more distinct values than a pivot can be wide', () => {
    const table = wide(MAX_PIVOT_COLUMNS + 1, 2)
    // Counts are localised in the message, so match the rendered form rather than the digits.
    expect(() => pivotTable(table, 'side', 'type', 'v', 'sum')).toThrow(
      `${(MAX_PIVOT_COLUMNS + 1).toLocaleString()} distinct values`,
    )
  })

  it('names the field and says which way round a pivot goes', () => {
    // The message has to be actionable by someone who did not choose this shape on purpose,
    // because in the reported case nobody did.
    try {
      pivotTable(wide(MAX_PIVOT_COLUMNS + 1, 2), 'side', 'type', 'v', 'sum')
      expect.unreachable('should have refused')
    } catch (error) {
      const message = String(error)
      expect(message).toContain('"type"')
      expect(message).toContain('Columns should be the small field')
    }
  })

  it('refuses on total cells even when each axis is individually allowed', () => {
    // 1,500 x 1,500 is under the column cap on both axes and over two million cells.
    const side = 1_500
    const table = tableFromRows(
      tableSchema(column('a', 'str'), column('b', 'str'), column('v', 'i64')),
      Array.from({ length: side }, (_, i) => ({ a: `A${i}`, b: `B${i}`, v: i })),
    )
    expect(() => pivotTable(table, 'a', 'b', 'v', 'sum')).toThrow(/cells/)
    expect(side * side).toBeGreaterThan(MAX_PIVOT_CELLS)
  })

  it('builds the shape a pivot is actually for', () => {
    // The same data the refusal above was about, the right way round: many rows, few columns.
    const matrix = pivotTable(wide(5_000, 3), 'type', 'side', 'v', 'sum')
    expect(matrix.rowLabels).toHaveLength(5_000)
    expect(matrix.colLabels).toHaveLength(3)
  })
})

describe('pivot', () => {
  it('builds a labelled matrix with sorted labels', () => {
    const m = pivotTable(conn(), 'bodyId', 'partnerType', 'weight', 'sum')
    expect(m.rowLabels).toEqual(['1', '2', '3'])
    expect(m.colLabels).toEqual(['DNp02', 'PLP003', 'PVLP002'])
    const at = (r: number, c: number) => m.values[r * m.colLabels.length + c]
    expect(at(0, 0)).toBe(40) // body 1 -> DNp02: 30 + 10
    expect(at(0, 2)).toBe(5)
    expect(at(2, 1)).toBe(2)
    expect(at(2, 0)).toBe(0) // absent pair reads as zero
  })

  it('counts rows when asked to', () => {
    const m = pivotTable(conn(), 'bodyId', 'partnerType', undefined, 'count')
    expect(m.values[0]).toBe(2)
  })

  /**
   * The Pivot node emits both forms, and the wide table is reshaped from the matrix rather
   * than pivoted again — so these assertions are what stop the two halves of one node from
   * describing different pivots.
   */
  it('reshapes the same pivot into a wide table', () => {
    const m = pivotTable(conn(), 'bodyId', 'partnerType', 'weight', 'sum')
    const wide = matrixToTable(m, 'bodyId')

    expect(wide.schema.columns.map((c) => c.name)).toEqual(['bodyId', ...m.colLabels])
    expect(wide.length).toBe(m.rowLabels.length)
    // Row labels are a matrix axis, so they arrive as text even from an i64 column.
    expect(wide.schema.columns[0]!.dtype).toBe('str')
    expect(wide.data.bodyId).toEqual(['1', '2', '3'])

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
    const wide = matrixToTable(pivotTable(empty, 'bodyId', 'partnerType', 'weight', 'sum'), 'bodyId')
    expect(wide.length).toBe(0)
    expect(wide.schema.columns.map((c) => c.name)).toEqual(['bodyId'])
  })
})

describe('normalizeMatrix', () => {
  const m = () => makeMatrix(['a', 'b'], ['x', 'y'], Float64Array.from([1, 3, 0, 0]), 'synapses')

  it('normalises by row and leaves all-zero rows at zero', () => {
    const out = normalizeMatrix(m(), 'row')
    expect([...out.values]).toEqual([0.25, 0.75, 0, 0])
  })

  it('normalises by column', () => {
    const out = normalizeMatrix(m(), 'column')
    expect([...out.values]).toEqual([1, 1, 0, 0])
  })

  it('normalises by global max', () => {
    expect([...normalizeMatrix(m(), 'max').values]).toEqual([1 / 3, 1, 0, 0])
  })

  it('passes through unchanged for mode none', () => {
    expect([...normalizeMatrix(m(), 'none').values]).toEqual([1, 3, 0, 0])
  })

  it('applies log10(1+x)', () => {
    const out = normalizeMatrix(m(), 'log')
    expect(out.values[0]).toBeCloseTo(Math.log10(2))
  })
})
