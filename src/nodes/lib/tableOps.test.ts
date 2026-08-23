import { describe, expect, it } from 'vitest'

import { compareIds, idText, isNeuronId } from '../../core/ids'
import { column, columnNames, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { makeMatrix, tableFromRows, JOIN_SEPARATOR } from '../../core/values'
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
  renameMapping,
  renameSchema,
  renameTable,
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
    const declared = groupBySchema(CONNECTIVITY, ['neuronId'], undefined, 'count')
    const out = groupByTable(conn(), ['neuronId'], undefined, 'count')
    expectSchemaAgreement(declared, out)
    expect(out.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'n'])
    expect(aggColumnName('count', 'weight')).toBe('n')
  })

  it('groups on multiple keys', () => {
    const out = groupByTable(conn(), ['neuronId', 'partnerType'], 'weight', 'sum')
    expect(out.length).toBe(5)
  })

  it('counts distinct values', () => {
    const out = groupByTable(conn(), ['neuronId'], 'partnerType', 'countDistinct')
    const idx = (out.data.neuronId as number[]).indexOf(1)
    expect((out.data.countDistinct_partnerType as number[])[idx]).toBe(2)
  })

  it('carries the unit through to the aggregate column', () => {
    const declared = groupBySchema(CONNECTIVITY, ['partnerType'], 'weight', 'sum')
    expect(declared!.columns.at(-1)?.unit).toBe('synapses')
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
      expectSchemaAgreement(joinSchema(CONNECTIVITY, WIDER, spec), joinTables(conn(), wider(), spec))
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
    expect(renameSchema(FOREIGN, [{ from: 'gone', to: 'x' }])!.columns.map((c) => c.name)).toEqual([
      'root_id',
      'cell_type',
      'w',
    ])
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
    const m = pivotTable(conn(), 'neuronId', 'partnerType', 'weight', 'sum')
    expect(m.rowLabels).toEqual(['1', '2', '3'])
    expect(m.colLabels).toEqual(['DNp02', 'PLP003', 'PVLP002'])
    const at = (r: number, c: number) => m.values[r * m.colLabels.length + c]
    expect(at(0, 0)).toBe(40) // body 1 -> DNp02: 30 + 10
    expect(at(0, 2)).toBe(5)
    expect(at(2, 1)).toBe(2)
    expect(at(2, 0)).toBe(0) // absent pair reads as zero
  })

  it('counts rows when asked to', () => {
    const m = pivotTable(conn(), 'neuronId', 'partnerType', undefined, 'count')
    expect(m.values[0]).toBe(2)
  })

  /**
   * The Pivot node emits both forms, and the wide table is reshaped from the matrix rather
   * than pivoted again — so these assertions are what stop the two halves of one node from
   * describing different pivots.
   */
  it('reshapes the same pivot into a wide table', () => {
    const m = pivotTable(conn(), 'neuronId', 'partnerType', 'weight', 'sum')
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
      pivotTable(empty, 'neuronId', 'partnerType', 'weight', 'sum'),
      'neuronId',
    )
    expect(wide.length).toBe(0)
    expect(wide.schema.columns.map((c) => c.name)).toEqual(['neuronId'])
  })
})

describe('normalizeMatrix', () => {
  const m = () =>
    makeMatrix(['a', 'b'], ['x', 'y'], Float64Array.from([1, 3, 0, 0]), 'synapses')

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

  const joined = (t = tags()) => groupByTable(t, ['neuronId'], 'tag', 'join')

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
    const declared = groupBySchema(TAGS, ['neuronId'], 'tag', 'join')
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
      'len',
      'join',
    )
    expectSchemaAgreement(groupBySchema(nm, ['k'], 'len', 'join'), out)
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
