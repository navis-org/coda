/**
 * A Custom Dataset's neuron table: any table, with one of its columns named as the neuron id.
 *
 * The schema half and the value half, side by side for invariant 3 — the node publishes the
 * first on its type so every column picker downstream is right before a Run, and the second is
 * what arrives. `neurons.test.ts` holds them together.
 *
 * The id column comes out first as `neuronId`, **text**, whatever it was called and typed going
 * in (invariant 8): a table from an upload, a sheet or a Parquet file calls it `root_id`,
 * `bodyId` or `skid`, and this is the one place that says which. A column already called
 * `neuronId` that is *not* the one chosen is dropped rather than suffixed — it is being replaced,
 * and two `neuronId`s is a table no reader can address.
 */

import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import type { ColumnData, TableValue } from '../../core/values'
import { makeTable, selectRows } from '../../core/values'

/** The schema a table becomes once `idColumn` is its neuron id. */
export function neuronTableSchema(schema: TableSchema, idColumn: string): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...schema.columns.filter((c) => c.name !== idColumn && c.name !== ID_COLUMN_NAME),
  )
}

export interface NeuronTableResult {
  readonly table: TableValue
  /** Rows whose id cell was empty or not an exact integer — dropped, and said. */
  readonly dropped: number
  /** Rows repeating an id already seen — the first is kept, `joinTables`' rule. */
  readonly duplicates: number
}

/** The value half: the rows, keyed by `idColumn` as text, one per neuron. */
export function neuronTable(table: TableValue, idColumn: string): NeuronTableResult {
  const schema = neuronTableSchema(table.schema, idColumn)
  const cells = table.data[idColumn] ?? []
  const keep: number[] = []
  const ids: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  let duplicates = 0
  for (let i = 0; i < table.length; i++) {
    const id = idText(cells[i])
    if (id === null) {
      dropped++
      continue
    }
    if (seen.has(id)) {
      duplicates++
      continue
    }
    seen.add(id)
    keep.push(i)
    ids.push(id)
  }
  // Every row kept is the ordinary case — a clean sheet or upload — and then the columns are
  // shared rather than copied: values are never mutated, and the upstream table stays cached, so
  // a copy would hold a second 140k-row table for nothing. Otherwise `selectRows` picks them.
  const rows = keep.length === table.length ? table : selectRows(table, keep)
  const data: Record<string, ColumnData> = { [ID_COLUMN_NAME]: ids }
  for (const col of schema.columns) {
    if (col.name !== ID_COLUMN_NAME) data[col.name] = rows.data[col.name] ?? []
  }
  return { table: makeTable(schema, data, 'neurons'), dropped, duplicates }
}

/**
 * Why a column cannot be a neuron id, or undefined when it can.
 *
 * One sentence for `validate` and `evaluate`, since the first is only a warning and the second
 * has to refuse the same thing. A float column is refused outright rather than converted: an
 * eighteen-digit id held as a double has *already* become a different neuron before it reached
 * this node, and nothing downstream could tell — the edge importer's `requireExactIds` rule.
 * A column the schema does not have is not this function's to report: undefined.
 */
export function idColumnProblem(schema: TableSchema, name: string): string | undefined {
  const dtype = findColumn(schema, name)?.dtype
  if (dtype === 'f64') {
    return (
      `"${name}" holds decimals, and a neuron id stored as one has already lost digits — ` +
      `it would name a different neuron. Read the file with that column as text or integers.`
    )
  }
  if (dtype === 'bool') return `"${name}" holds true/false values, not neuron ids.`
  return undefined
}
