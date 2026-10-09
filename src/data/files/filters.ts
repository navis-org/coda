/**
 * The row conditions a Filter Table leaves on a table file, as a reader applies them.
 *
 * A Filter Table wired below a Link Table reads nothing: it hands on the same file with its
 * condition added (`TableFileValue.filters`), and whatever reads rows out of the file — Read Rows,
 * a Custom Dataset's synapse lookup, its edge-list build — drops the rows that fail it from the
 * rows it fetched. That is sound because a condition is **row-local**: whether a row is kept
 * depends on that row alone, so filtering after a lookup by id keeps exactly what filtering first
 * would have, and a lookup never has to scan the file for the filter's sake. It is also why only
 * a row filter can be deferred this way — a dedupe, a sort or a join answers per row from the
 * other rows.
 *
 * **One predicate, `core/rowPredicate.ts`, on the cell as the node reads it.** Each cell is
 * decoded the way the file's schema types it (`decoderFor`) before it is tested, so a condition
 * means on the file what it means on the same rows once Read Rows has made them a table — the
 * agreement `nodes/table/filterFile.test.ts` holds the two to.
 */

import { rowPredicate } from '../../core/rowPredicate'
import type { FilterOp } from '../../core/rowPredicate'
import type { DType } from '../../core/types'
import { findColumn } from '../../core/types'
import type { TableFileColumn, TableFileValue } from '../../core/values'
import { decoderFor, fileColumn } from './columns'

/** A condition with what a reader needs to test it: how its column is stored and read. */
export interface RowCondition {
  readonly column: TableFileColumn
  readonly dtype: DType
  readonly op: FilterOp
  readonly value: string
}

/** A file's conditions, resolved against its own columns. */
export function rowConditions(
  file: Pick<TableFileValue, 'filters' | 'columns' | 'schema'>,
): RowCondition[] {
  return (file.filters ?? []).map(({ column: name, op, value }) => {
    const column = fileColumn(file.columns, name)
    // The schema is the columns' own typing, so a column the file has is a column it types.
    const dtype = findColumn(file.schema, name)?.dtype ?? 'str'
    return { column, dtype, op, value }
  })
}

/** `names`, then the columns the conditions test that it lacks — read, whether output or not. */
export function withConditionColumns(
  names: readonly string[],
  conditions: readonly RowCondition[],
): string[] {
  return [...new Set([...names, ...conditions.map((c) => c.column.name)])]
}

/**
 * Whether a row of a block passes every condition, given each column's raw cells — or undefined
 * with no conditions, so a reader with none pays nothing per row.
 */
export function rowTest(
  conditions: readonly RowCondition[],
  cellsOf: (name: string) => (row: number) => unknown,
): ((row: number) => boolean) | undefined {
  if (conditions.length === 0) return undefined
  const tests = conditions.map(({ column, dtype, op, value }) => {
    const get = cellsOf(column.name)
    const decode = decoderFor(column, dtype)
    const pass = rowPredicate(dtype, op, value)
    return (row: number) => pass(decode(get(row)))
  })
  return tests.length === 1 ? tests[0]! : (row) => tests.every((test) => test(row))
}
