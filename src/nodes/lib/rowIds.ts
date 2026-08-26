/**
 * What a row of a table is *called* when a viewer hands a selection back to the graph.
 *
 * A selection is provenance: it lives in the saved file and in every downstream cache key.
 * So the answer has to mean the same thing to the viewer writing the ids and to the node
 * resolving them back into rows — one module, imported by both, rather than two agreeing
 * implementations that drift the first time either is touched.
 *
 * Ids are preferred and the row index is the fallback, in that order and for that reason:
 * an id is stable under an upstream re-run, where a row index silently re-points at a
 * different neuron the moment anything upstream reorders or filters. The fallback exists
 * anyway because the alternative is no selection at all on the tables least likely to carry
 * an id — an uploaded CSV of embeddings, a `groupBy` roll-up — and a fragile selection the
 * caption admits to beats a dead lasso. See the ID column param on `out.scatter`.
 */

import type { TableValue } from '../../core/values'
import { makeTable, selectRows } from '../../core/values'

/**
 * Name each row, given the chosen id column — `undefined` meaning "no usable id column",
 * which falls back to the row's position.
 *
 * Returns an accessor rather than a materialised array: a viewer calls it per hovered point
 * and per lasso test over a table that can be the whole of male-CNS.
 */
export function rowKeys(
  table: TableValue,
  idColumn: string | undefined,
): (row: number) => string {
  const ids = idColumn ? table.data[idColumn] : undefined
  if (!ids) return (row) => String(row)
  return (row) => {
    const value = ids[row]
    // A null id is not a name. Falling back to the index keeps the point selectable rather
    // than making every unlabelled row share one key and select each other.
    return value === null || value === undefined ? String(row) : String(value)
  }
}

/**
 * The rows a selection names, in the table's own order.
 *
 * Table order rather than selection order, so the result is a subset of the input in the
 * sense every downstream node already expects, and so two selections of the same set are
 * the same table.
 */
export function rowsWithKeys(
  table: TableValue,
  selection: unknown,
  idColumn: string | undefined,
): TableValue {
  return rowsMatching(table, rowKeys(table, idColumn), selection)
}

/**
 * The rows a selection names, given whatever names them.
 *
 * The half of `rowsWithKeys` that has nothing to do with ids, split out when a second kind of
 * selection arrived: `chartSelection.rowsWithLabels` is this loop with `markLabel` in place of
 * `rowKeys`, and had been the same eight lines written again with the arguments in a different
 * order. What a mark is *called* differs between the two (see that module's header); which rows
 * a set of names picks out does not.
 */
export function rowsMatching(
  table: TableValue,
  nameAt: (row: number) => string,
  selection: unknown,
): TableValue {
  const wanted = new Set((Array.isArray(selection) ? selection : []).map(String))
  const rows: number[] = []
  if (wanted.size > 0) {
    for (let row = 0; row < table.length; row++) {
      if (wanted.has(nameAt(row))) rows.push(row)
    }
  }
  return selectRows(table, rows)
}

/** An empty result of the same schema and kind — what an unrun or empty selection yields. */
export function emptyLike(table: TableValue): TableValue {
  return makeTable(
    table.schema,
    Object.fromEntries(table.schema.columns.map((c) => [c.name, []])),
    table.kind,
  )
}
