/**
 * Table to Points' two halves, and the one rule a reader would not guess: a row without three
 * numbers has no position.
 *
 * That is the case worth testing because every wrong answer here is a *plausible* one. A blank
 * cell read as 0 puts a point at the origin, a column picked by accident puts the whole cloud
 * somewhere else, and both draw. Nothing throws.
 */

import { describe, expect, it } from 'vitest'

import { column, columnNames, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { CellValue, TableValue } from '../../core/values'
import { SOURCE_ROW_COLUMN, tablePointsSchema, tablePointsValue } from './tablePoints'

const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('x', 'f64', 'nm'),
  column('y', 'f64', 'nm'),
  column('z', 'f64', 'nm'),
  column('score', 'f64'),
)

const table = (over: Record<string, CellValue[]> = {}): TableValue =>
  makeTable(SCHEMA, {
    neuronId: ['1', '2', '3'],
    x: [1, 2, 3],
    y: [10, 20, 30],
    z: [100, 200, 300],
    score: [0.5, 0.6, 0.7],
    ...over,
  })

const AXES = { x: 'x', y: 'y', z: 'z' }

describe('tablePointsSchema', () => {
  it('is the carried columns, with the dtypes they had upstream', () => {
    const schema = tablePointsSchema(SCHEMA, ['neuronId', 'score'])
    expect(columnNames(schema)).toEqual(['neuronId', 'score', SOURCE_ROW_COLUMN])
    // Invariant 8: a carried id stays text through this node.
    expect(schema.columns[0]!.dtype).toBe('str')
  })

  /**
   * The minted column is not a nicety: a `PointsValue`'s length *is* its attribute table's, and
   * `makeTable` takes that from the columns it was given — so a cloud carrying nothing would be
   * a table of no columns, a length of 0, and a viewer drawing none of the positions in the
   * buffer. That is exactly what this node did before the column was minted.
   */
  it('always mints the source row, so a cloud carrying nothing still has a length', () => {
    expect(columnNames(tablePointsSchema(SCHEMA, []))).toEqual([SOURCE_ROW_COLUMN])
    expect(columnNames(tablePointsSchema(SCHEMA, ['score', 'score']))).toEqual([
      'score',
      SOURCE_ROW_COLUMN,
    ])
  })

  /**
   * The case the two halves can disagree about. A table with its own `row` column that nobody
   * picked still gets the *minted* one — the schema decides on what was asked for, so the values
   * have to as well. Asking the table instead ("has it a column of this name?") wrote the
   * upstream values into the minted `i64` slot, so `row` said source row and held something else.
   */
  it('mints the source row even when the table has a `row` column nobody carried', () => {
    const withRow = makeTable(
      tableSchema(
        column('row', 'str'),
        column('x', 'f64'),
        column('y', 'f64'),
        column('z', 'f64'),
      ),
      { row: ['a', 'b', 'c'], x: [1, 2, 3], y: [1, 2, 3], z: [1, 2, 3] },
    )
    const { points } = tablePointsValue(withRow, AXES, [], undefined)
    expect(points.attributes.data[SOURCE_ROW_COLUMN]).toEqual([0, 1, 2])
  })

  /** Folded, so a table with a `row` column of its own keeps one column rather than two. */
  it('folds a carried column of the same name rather than growing a second', () => {
    const withRow = tableSchema(column(SOURCE_ROW_COLUMN, 'str'), column('x', 'f64'))
    expect(columnNames(tablePointsSchema(withRow, [SOURCE_ROW_COLUMN]))).toEqual([
      SOURCE_ROW_COLUMN,
    ])
  })

  /** A column the upstream has not got is dropped rather than invented — `pickColumns`' rule. */
  it('drops a carried column the table does not have', () => {
    expect(columnNames(tablePointsSchema(SCHEMA, ['score', 'nope']))).toEqual([
      'score',
      SOURCE_ROW_COLUMN,
    ])
  })

  it('answers only the minted column where nothing upstream has resolved yet', () => {
    expect(columnNames(tablePointsSchema(undefined, ['score']))).toEqual([SOURCE_ROW_COLUMN])
  })
})

describe('tablePointsValue', () => {
  it('reads three columns as a position, and carries what it was asked to', () => {
    const { points, dropped } = tablePointsValue(table(), AXES, ['neuronId'], undefined)
    expect([...points.positions]).toEqual([1, 10, 100, 2, 20, 200, 3, 30, 300])
    expect(points.attributes.data['neuronId']).toEqual(['1', '2', '3'])
    expect(points.units).toBe('nm')
    expect(dropped).toBe(0)
    expect(points.bounds).toEqual({ min: [1, 10, 100], max: [3, 30, 300] })
  })

  /**
   * The rule that matters. `Number(null)` and `Number('')` are both 0, so a test on the number
   * would put every blank row at the origin — a cluster of points nobody put there, in a cloud
   * that otherwise looks right.
   */
  it('drops a row whose coordinates are not three numbers, and counts it', () => {
    const { points, dropped } = tablePointsValue(
      table({ y: [10, null, 30] }),
      AXES,
      ['neuronId'],
      undefined,
    )
    expect(dropped).toBe(1)
    expect([...points.positions]).toEqual([1, 10, 100, 3, 30, 300])
    expect(points.attributes.data['neuronId']).toEqual(['1', '3'])
    expect(points.attributes.length).toBe(2)
  })

  it('treats a blank, a non-number and an infinity as no position', () => {
    for (const bad of ['', '  ', 'left', null, Number.NaN, Infinity]) {
      const { dropped } = tablePointsValue(table({ x: [1, bad, 3] }), AXES, [], undefined)
      expect(dropped, String(bad)).toBe(1)
    }
  })

  /** A CSV read column by column arrives as text, and a position is no less one for it. */
  it('reads numeric text as a coordinate', () => {
    const { points, dropped } = tablePointsValue(
      table({ x: ['1', '2', '3'] }),
      AXES,
      [],
      undefined,
    )
    expect(dropped).toBe(0)
    expect(points.positions[0]).toBe(1)
  })

  /** An unset picker means no geometry at all rather than a cloud at the origin. */
  it('keeps no row at all when a coordinate column is unset', () => {
    const { points, dropped } = tablePointsValue(
      table(),
      { ...AXES, z: undefined },
      [],
      undefined,
    )
    expect(points.positions.length).toBe(0)
    expect(dropped).toBe(3)
  })

  /**
   * The bug this column exists for, asserted where a reader will meet it: a cloud that carries
   * nothing is still a cloud. It drew nothing at all before.
   */
  it('makes a cloud with nothing carried, and says which rows it came from', () => {
    const { points } = tablePointsValue(table(), AXES, [], undefined)
    expect(points.attributes.length).toBe(3)
    expect(points.positions.length).toBe(9)
    expect(points.attributes.data[SOURCE_ROW_COLUMN]).toEqual([0, 1, 2])
  })

  /** And the dropped rows are the numbers missing from it. */
  it('numbers the rows it kept, not the points', () => {
    const { points } = tablePointsValue(table({ y: [10, null, 30] }), AXES, [], undefined)
    expect(points.attributes.data[SOURCE_ROW_COLUMN]).toEqual([0, 2])
  })

  /**
   * The scale is the one thing a table cannot say about itself, so the card says it and this
   * applies it — and the cloud is **always** nanometres afterwards. Leaving it to a `units: 'voxels'`
   * tag instead would hand every reader downstream a refusal about a dataset's `voxelSize`, for
   * a cloud built from a CSV that has no dataset.
   */
  it('scales the coordinates to nanometres, and says so', () => {
    const { points } = tablePointsValue(table(), AXES, [], [4, 4, 40])
    expect([...points.positions.slice(0, 3)]).toEqual([4, 40, 4000])
    expect(points.units).toBe('nm')
  })

  it('leaves the numbers alone when the scale is already nanometres', () => {
    expect([
      ...tablePointsValue(table(), AXES, [], undefined).points.positions.slice(0, 3),
    ]).toEqual([1, 10, 100])
  })

  it('an empty table is an empty cloud', () => {
    const empty = makeTable(SCHEMA, { neuronId: [], x: [], y: [], z: [], score: [] })
    const { points, dropped } = tablePointsValue(empty, AXES, ['neuronId'], undefined)
    expect(points.positions.length).toBe(0)
    expect(points.attributes.length).toBe(0)
    expect(dropped).toBe(0)
  })

  /** Invariant 3: the value half and the schema half are built from the same list. */
  it('builds an attribute table that agrees with the schema', () => {
    const carry = ['score', 'neuronId']
    const { points } = tablePointsValue(table(), AXES, carry, undefined)
    expect(points.attributes.schema).toEqual(tablePointsSchema(SCHEMA, carry))
    expect(Object.keys(points.attributes.data).sort()).toEqual(
      columnNames(points.attributes.schema).sort(),
    )
    // Picked order, then the minted column.
    expect(columnNames(points.attributes.schema)).toEqual([
      'score',
      'neuronId',
      SOURCE_ROW_COLUMN,
    ])
  })
})
