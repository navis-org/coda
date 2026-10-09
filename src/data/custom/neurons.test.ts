/**
 * The neuron table's two halves, held together (invariant 3): the schema the node publishes at
 * edit time and the table it builds at run time, for every shape of id column that arrives.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { idColumnProblem, neuronTable, neuronTableSchema } from './neurons'

const SCHEMA = tableSchema(
  column('cell_type', 'str'),
  column('root_id', 'str'),
  column('side', 'str'),
)

describe('neuronTable', () => {
  it('agrees with neuronTableSchema, whatever the id column is called or typed', () => {
    const cases = [
      { schema: SCHEMA, id: 'root_id' },
      { schema: tableSchema(column('bodyId', 'i64'), column('type', 'str')), id: 'bodyId' },
      // Already called `neuronId`, and chosen: it stays, as text.
      {
        schema: tableSchema(column(ID_COLUMN_NAME, 'i64'), column('type', 'str')),
        id: 'neuronId',
      },
      // Called `neuronId` and *not* chosen: replaced by the chosen column rather than duplicated.
      {
        schema: tableSchema(column(ID_COLUMN_NAME, 'str'), column('skid', 'i64')),
        id: 'skid',
      },
    ]
    for (const { schema, id } of cases) {
      const table = tableFromRows(schema, [])
      expect(neuronTable(table, id).table.schema).toEqual(neuronTableSchema(schema, id))
    }
  })

  it('puts the id first, as text, and keeps the rest in order', () => {
    const schema = neuronTableSchema(SCHEMA, 'root_id')
    expect(schema.columns.map((c) => [c.name, c.dtype])).toEqual([
      [ID_COLUMN_NAME, 'str'],
      ['cell_type', 'str'],
      ['side', 'str'],
    ])
  })

  it('keeps an eighteen-digit id exact and turns integers into text', () => {
    const big = '720575940628857210'
    const out = neuronTable(
      tableFromRows(tableSchema(column('id', 'str')), [{ id: big }]),
      'id',
    ).table
    expect(out.data[ID_COLUMN_NAME]).toEqual([big])

    const ints = neuronTable(
      tableFromRows(tableSchema(column('bodyId', 'i64')), [{ bodyId: 10001 }]),
      'bodyId',
    ).table
    expect(ints.data[ID_COLUMN_NAME]).toEqual(['10001'])
  })

  it('drops rows with no usable id and keeps the first of a repeated one, counting both', () => {
    const table = tableFromRows(SCHEMA, [
      { root_id: '1', cell_type: 'A' },
      { root_id: '', cell_type: 'blank' },
      { root_id: null, cell_type: 'null' },
      { root_id: '1', cell_type: 'again' },
      { root_id: '2', cell_type: 'B' },
    ])
    const { table: out, dropped, duplicates } = neuronTable(table, 'root_id')
    expect(dropped).toBe(2)
    expect(duplicates).toBe(1)
    expect(out.data[ID_COLUMN_NAME]).toEqual(['1', '2'])
    expect(out.data.cell_type).toEqual(['A', 'B'])
    expect(out.kind).toBe('neurons')
  })

  it('shares the columns of a table it keeps whole, rather than holding a second copy', () => {
    const table = tableFromRows(SCHEMA, [
      { root_id: '1', cell_type: 'A', side: 'L' },
      { root_id: '2', cell_type: 'B', side: 'R' },
    ])
    expect(neuronTable(table, 'root_id').table.data.cell_type).toBe(table.data.cell_type)
  })
})

describe('idColumnProblem', () => {
  it('refuses decimals and booleans, and accepts text and integers', () => {
    const schema = tableSchema(
      column('f', 'f64'),
      column('b', 'bool'),
      column('s', 'str'),
      column('i', 'i64'),
    )
    expect(idColumnProblem(schema, 'f')).toMatch(/decimals/)
    expect(idColumnProblem(schema, 'b')).toMatch(/true\/false/)
    expect(idColumnProblem(schema, 's')).toBeUndefined()
    expect(idColumnProblem(schema, 'i')).toBeUndefined()
    // A column the schema lacks is somebody else's to report.
    expect(idColumnProblem(schema, 'missing')).toBeUndefined()
  })
})
