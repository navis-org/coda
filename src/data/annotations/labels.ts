/**
 * A geometry value's attribute rows, labelled out of an annotation table by id.
 *
 * Lived privately in `CaveSource` until a second source needed the same rows: the Custom Dataset
 * builds a geometry value's attributes from its neuron table exactly as CAVE builds them from a
 * chain. The whole row is shared, not only the lookup, because the row's shape — which columns,
 * in which order, with `points` — is the invariant-3 agreement `withAnnotations` states for the
 * edit-time half; two copies of it are two places a new column reaches only one of.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { CellValue, DatasetAnnotations, TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { SourceSchemas } from '../source'
import { withAnnotations } from './schema'

/**
 * One attribute row per geometry item: its id, its labels, anything the source adds, and its
 * point count — to the morphology schema `schemasFromType` publishes for the same dataset.
 *
 * Synchronous, so a partial answer can be assembled inside an `onPartial` callback. Only the id
 * and the point count are read off an item, which both geometry kinds carry, so meshes and
 * skeletons share it. `fallback` is a source's own columns (CAVE's `type` where no chain is
 * wired), written *before* the labels so a chain wins any name they share — the socket's promise
 * that what the chain produces is the label half, whose breaking was once CAVE's own bug.
 */
export function morphologyAttributes(
  schemas: SourceSchemas,
  annotations: DatasetAnnotations | undefined,
  items: ReadonlyArray<{ id: string; positions: Float32Array }>,
  fallback?: (id: string) => Record<string, CellValue>,
): TableValue {
  return tableFromRows(
    withAnnotations(schemas, annotations?.table.schema).morphology,
    items.map((item) => ({
      [ID_COLUMN_NAME]: item.id,
      ...fallback?.(item.id),
      ...labelsFor(annotations, item.id),
      points: item.positions.length / 3,
    })),
  )
}

/** One neuron's labels out of a chain, by id. */
function labelsFor(
  annotations: DatasetAnnotations | undefined,
  id: string,
): Record<string, CellValue> {
  if (!annotations) return {}
  const index = annotationIndex(annotations.table)
  const row = index.get(id)
  if (row === undefined) return {}
  const labels: Record<string, CellValue> = {}
  for (const col of annotations.table.schema.columns) {
    if (col.name === ID_COLUMN_NAME) continue
    labels[col.name] = annotations.table.data[col.name]?.[row] ?? null
  }
  return labels
}

/**
 * Row index of an annotation table, built once per table.
 *
 * A `WeakMap` on the table itself, `typesOf`'s idiom: `labelsFor` is called per item, and
 * rebuilding a 58,000-entry map twenty times over to place twenty meshes is the case that memo
 * exists for.
 */
const annotationRows = new WeakMap<TableValue, Map<string, number>>()

export function annotationIndex(table: TableValue): Map<string, number> {
  const cached = annotationRows.get(table)
  if (cached) return cached
  const index = new Map<string, number>()
  const ids = table.data[ID_COLUMN_NAME] ?? []
  for (let i = 0; i < table.length; i++) {
    const id = String(ids[i] ?? '')
    if (id && !index.has(id)) index.set(id, i)
  }
  annotationRows.set(table, index)
  return index
}
