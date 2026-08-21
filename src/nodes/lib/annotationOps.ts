/**
 * Joining one annotation table onto another, which is what a chain of sources does.
 *
 * Headless, and its own module rather than a private helper in the node, for `tableOps`' reason:
 * the rules below each produce a plausible wrong table rather than an error, and a function
 * nobody can call is a function nobody can test.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { tableSchema } from '../../core/types'
import type { ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'

/**
 * Two annotation tables into one, keyed on the id column.
 *
 * **An outer join, not an inner one.** Two bases routinely cover different populations — a cell
 * typing table and a hemilineage table overlap only where somebody has done both — and an inner
 * join would silently return their intersection, which on real data is a fraction of either.
 * Every neuron either side knows about comes out, with nulls where the other had nothing.
 *
 * **The later table wins a name collision**, which is what makes the order of a chain on the
 * canvas mean something: `A → B` is "B's labels, falling back to A's". Not suffixed like `Join`
 * does, because these are not two tables being widened side by side — they are two answers to
 * the same question, and `cell_type` and `cell_type_2` in one neuron table is a picker nobody
 * can choose between.
 *
 * **Matched as text**, the `joinTables` rule: a root id is a string on both providers today, but
 * a CAVE column typed `i64` and a SeaTable one typed text would otherwise fail to match on a
 * default wiring rather than on an exotic one.
 *
 * The key is always `neuronId` — the one thing every provider renames onto — so it is not a
 * parameter. It was, with one caller passing the default explicitly.
 */
export function joinAnnotations(left: TableValue, right: TableValue): TableValue {
  const leftIds = left.data[ID_COLUMN_NAME] ?? []
  const rightIds = right.data[ID_COLUMN_NAME] ?? []

  /*
   * One forward pass per side, first occurrence winning. It was three — a `seen` set and an
   * `order` array forward, then `leftAt` built *backwards* to make the first row win — which is
   * two idioms for one rule and an extra pass over 58,000 rows.
   */
  const leftAt = new Map<string, number>()
  const order: string[] = []
  for (let i = 0; i < left.length; i++) {
    const id = String(leftIds[i] ?? '')
    if (!id || leftAt.has(id)) continue
    leftAt.set(id, i)
    order.push(id)
  }

  const rightAt = new Map<string, number>()
  for (let i = 0; i < right.length; i++) {
    const id = String(rightIds[i] ?? '')
    if (!id || rightAt.has(id)) continue
    rightAt.set(id, i)
    if (!leftAt.has(id)) order.push(id)
  }

  const schema = joinedSchema(left.schema, right.schema)
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  const ids = data[ID_COLUMN_NAME]!

  /*
   * Columns resolved once. Per cell this was `rightNames.has(name)` plus two string-keyed loads,
   * over 58,340 rows and 60 columns — millions of hash lookups to answer a question fixed before
   * the loop began. A column either has a right-hand array or it does not, which is exactly what
   * the Set stood in for.
   */
  const targets = schema.columns
    .filter((c) => c.name !== ID_COLUMN_NAME)
    .map((c) => ({
      into: data[c.name]!,
      fromRight: right.data[c.name],
      fromLeft: left.data[c.name],
    }))

  for (const id of order) {
    ids.push(id)
    const l = leftAt.get(id)
    const r = rightAt.get(id)
    for (const { into, fromRight, fromLeft } of targets) {
      // Later wins, falling back to the earlier source where the later one has no value.
      const value = r === undefined ? null : (fromRight?.[r] ?? null)
      into.push(value !== null ? value : l === undefined ? null : (fromLeft?.[l] ?? null))
    }
  }
  return makeTable(schema, data)
}

/**
 * The id column first, then the left's columns, then the right's — a later one replacing.
 *
 * Exported because the *edit-time* half of this join needs the identical rule: `chainSchema`
 * publishes what a node's output will contain, and this builds what it does contain. Two copies
 * is invariant 3's own example, and they had already parted company on where the id column sits.
 */
export function joinedSchema(left: TableSchema, right: TableSchema): TableSchema {
  const byName = new Map<string, TableSchema['columns'][number]>()
  for (const col of left.columns) if (col.name !== ID_COLUMN_NAME) byName.set(col.name, col)
  for (const col of right.columns) if (col.name !== ID_COLUMN_NAME) byName.set(col.name, col)
  const id =
    left.columns.find((c) => c.name === ID_COLUMN_NAME) ??
    right.columns.find((c) => c.name === ID_COLUMN_NAME)
  return tableSchema(...(id ? [id] : []), ...byName.values())
}
