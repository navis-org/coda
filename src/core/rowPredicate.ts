/**
 * One row condition, `Filter Table`'s: a column, an operator and the value typed beside it.
 *
 * In `core` rather than beside `filterTable` because two kinds of reader apply it — a table in
 * memory (`nodes/lib/tableOps.ts`) and a table file's rows as a worker reads them
 * (`data/files/filters.ts`) — and a condition that meant one thing on a table and another on the
 * same rows out of a file would be a threshold that moved when a Read Rows was added.
 */

import type { DType } from './types'
import { isNumericDType } from './types'
import type { CellValue } from './values'

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'notEmpty'
  | 'isTrue'
  | 'isFalse'

/**
 * The test a condition applies to one cell, as that cell's column is typed.
 *
 * Note that this does **not** agree with the Table viewer's header filters, which borrow
 * Explore's grammar instead: text compares here are case-*sensitive*, and `Number(null)` is 0
 * so a null matches `== 0`. Neither is wrong on its own and the divergence is recorded in
 * `nodes/lib/tableFilter.ts`; the point is that a graph can hold both an inch apart. Throws for a value the operator cannot use, which is how `evaluate`
 * refuses one before anything is read.
 */
export function rowPredicate(
  dtype: DType,
  op: FilterOp,
  rawValue: string,
): (cell: CellValue) => boolean {
  if (op === 'isTrue') return (c) => c === true || c === 1
  if (op === 'isFalse') return (c) => c === false || c === 0
  if (op === 'isEmpty') return (c) => c === null || c === ''
  if (op === 'notEmpty') return (c) => c !== null && c !== ''

  if (isNumericDType(dtype)) {
    const target = Number(rawValue)
    if (!Number.isFinite(target)) {
      throw new Error(`"${rawValue}" is not a number`)
    }
    switch (op) {
      case 'eq':
        return (c) => Number(c) === target
      case 'ne':
        return (c) => Number(c) !== target
      case 'gt':
        return (c) => c !== null && Number(c) > target
      case 'ge':
        return (c) => c !== null && Number(c) >= target
      case 'lt':
        return (c) => c !== null && Number(c) < target
      case 'le':
        return (c) => c !== null && Number(c) <= target
      default:
        throw new Error(`Operator "${op}" does not apply to numeric columns`)
    }
  }

  const needle = rawValue
  switch (op) {
    case 'eq':
      return (c) => String(c ?? '') === needle
    case 'ne':
      return (c) => String(c ?? '') !== needle
    case 'contains':
      return (c) => String(c ?? '').includes(needle)
    case 'notContains':
      return (c) => !String(c ?? '').includes(needle)
    case 'startsWith':
      return (c) => String(c ?? '').startsWith(needle)
    case 'endsWith':
      return (c) => String(c ?? '').endsWith(needle)
    case 'matches': {
      let re: RegExp
      try {
        re = new RegExp(needle)
      } catch (err) {
        throw new Error(`Invalid regex /${needle}/: ${(err as Error).message}`)
      }
      return (c) => re.test(String(c ?? ''))
    }
    default:
      throw new Error(`Operator "${op}" does not apply to text columns`)
  }
}
