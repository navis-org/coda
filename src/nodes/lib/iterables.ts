/**
 * What "an iterable" means here, and how to take one element out of it.
 *
 * Three of Coda's value kinds are collections of independently meaningful things: a table is
 * rows, a `SkeletonsValue` is neurons, a `MeshesValue` is neurons. `Select One` steps through
 * any of them, so the "which kind is this and how long is it" question needed one answer rather
 * than a switch statement per call site.
 *
 * **A `PointsValue` is deliberately not an iterable.** It is the same shape — positions plus one
 * attribute row each — and stepping through it one synapse at a time is not a gesture anybody
 * makes; a hundred thousand presses of an arrow button is not a browsing surface. That is a
 * judgement about the data rather than about the type, which is why the exclusion lives here in
 * a named list instead of falling out of a structural test.
 *
 * **Taking one element preserves the kind and the schema**, which is what lets `inferOutputs`
 * be a pass-through: one row of a Neurons table is still Neurons, one skeleton is still
 * Skeletons carrying the same attribute columns. Only the *counts* change, so a downstream
 * column picker never empties out because somebody stepped.
 *
 * The one thing that must not pass through is **bounds**. They are a roll-up over the geometry,
 * exactly as `degreeIn`/`degreeOut` are roll-ups over a network's links — a single skeleton
 * still claiming the bounding box of the twenty it came from would frame a 3D viewer on empty
 * space around it, which reads as a broken renderer rather than as a selection. Same rule and
 * same reason as `filterNetwork` recomputing its degrees.
 */

import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { CodaType } from '../../core/types'
import type { CellValue, MeshesValue, SkeletonsValue, TableValue, Value } from '../../core/values'
import { EMPTY_BOUNDS, boundsOf, getRow, isTableValue, selectRows } from '../../core/values'

/** The value kinds `Select One` can step through. */
export type IterableValue = TableValue | SkeletonsValue | MeshesValue

export function isIterableValue(v: Value | undefined): v is IterableValue {
  return !!v && (isTableValue(v) || v.kind === 'skeletons' || v.kind === 'meshes')
}

/**
 * Whether a *type* could carry something steppable, which is the question `validate` and the
 * card's foot line both ask — one to refuse, one to say why. `any` counts: unknown is not a
 * refusal, the same distinction `columnSchemaFor` draws between an absent schema and an empty
 * one.
 *
 * One list rather than one per caller. Two copies is how a node starts refusing a kind its own
 * card still offers to step through.
 */
const ITERABLE_KINDS = new Set<CodaType['kind']>([
  'any',
  'table',
  'neurons',
  'skeletons',
  'meshes',
])

export function isIterableKind(kind: CodaType['kind'] | undefined): boolean {
  return kind === undefined || ITERABLE_KINDS.has(kind)
}

/** What one element of this value is called, singular. For captions and messages. */
export function elementNoun(v: IterableValue | undefined): string {
  if (!v) return 'item'
  if (v.kind === 'skeletons') return 'skeleton'
  if (v.kind === 'meshes') return 'mesh'
  return 'row'
}

export function elementCount(v: IterableValue): number {
  return v.kind === 'skeletons' || v.kind === 'meshes' ? v.items.length : v.length
}

/**
 * The collection with every element removed — the same kind and the same schema, holding
 * nothing.
 *
 * This is what an out-of-range choice yields, and it is why stepping past the end of a table
 * that has shrunk upstream is a visible empty result rather than a silent substitution of
 * whoever now occupies that position. Emptiness is a state every downstream node already
 * handles; a different neuron wearing the same index is not.
 */
export function emptyElement(v: IterableValue): IterableValue {
  return sliceElements(v, [])
}

/**
 * The element at `index`, as a collection of one.
 *
 * A collection rather than a bare element, so the output type is the input type and the node
 * can sit anywhere the whole collection could. Out of range yields the empty collection rather
 * than clamping: clamping answers a question nobody asked, with nothing on screen to say the
 * answer moved.
 */
export function elementAt(v: IterableValue, index: number): IterableValue {
  return elementsFrom(v, index, 1)
}

/**
 * A run of elements starting at `start`, as a collection.
 *
 * `elementAt` widened, and the widening is what a **batched** loop is: one pass carrying twenty
 * neurons rather than one. That matters because every backend already fetches concurrently —
 * `mapWithConcurrency`, six in flight on neuPrint, eight on CATMAID — and asking for a single
 * neuron per pass is what reduces that to one. A batch hands the whole run down at once and gets
 * the concurrency back, while still holding only a batch rather than the whole collection.
 *
 * Clamped rather than padded at the end: the last batch of 412 elements taken twenty at a time
 * is twelve, not twenty with eight empties, and nothing downstream should have to tell the
 * difference between a short batch and a full one.
 */
export function elementsFrom(v: IterableValue, start: number, size: number): IterableValue {
  const total = elementCount(v)
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(total, from + Math.max(0, Math.floor(size)))
  const indices: number[] = []
  for (let i = from; i < to; i++) indices.push(i)
  return sliceElements(v, indices)
}

/**
 * The table whose rows line up with this collection's elements, one for one.
 *
 * A table is its own; a geometry collection's is its attribute table, which `SkeletonsValue`
 * documents as one row per item *in the same order*. That contract is what lets one set of
 * indices address both halves, and it is the only reason grouping works on geometry at all —
 * "every mesh whose `type` is LC4" is a question asked of the attributes and answered in items.
 */
function keyTable(v: IterableValue): TableValue {
  return isTableValue(v) ? v : v.attributes
}

/** What the elements with no value in the grouping column are called. */
export const UNGROUPED = '(none)'

/**
 * One cell's group name.
 *
 * A named function rather than the expression twice, because `groupKeys` and `groupOf` have to
 * agree exactly: the first names a group and the second is asked to find it, so a normalisation
 * that differed by a character would produce a pass named `LC4` that selects nothing.
 */
function groupKeyOf(raw: CellValue | undefined): string {
  return raw === null || raw === undefined || raw === '' ? UNGROUPED : String(raw)
}

/**
 * Which rows fall in which group, built once per (collection, column) and held weakly.
 *
 * **The memo is what makes group mode linear rather than quadratic.** A loop over 400 groups
 * asks `groupKeys` once per pass to name the pass and `groupOf` once per pass to select it, and
 * both were full scans of the key column with a `String` allocation per row — so a 165k-row
 * neuron table cost about 66 million string conversions and 400 discarded Sets, on the main
 * thread, during the loop whose progress bar somebody is watching. Built once it is one scan.
 *
 * Keyed on the value's identity, which is sound for the same reason `geometryCache` can hand
 * back the array it holds: table columns are immutable by convention here — nodes always build
 * new arrays — so a `TableValue` that is the same object has the same rows in it. Weak, so an
 * index costs nothing once the collection it describes is no longer referenced.
 */
const groupIndexes = new WeakMap<TableValue, Map<string, Map<string, number[]>>>()

function groupIndex(v: IterableValue, column: string): Map<string, number[]> {
  const table = keyTable(v)
  let byColumn = groupIndexes.get(table)
  if (!byColumn) {
    byColumn = new Map()
    groupIndexes.set(table, byColumn)
  }
  const held = byColumn.get(column)
  if (held) return held

  const index = new Map<string, number[]>()
  const data = table.data[column]
  if (data) {
    for (let i = 0; i < table.length; i++) {
      const key = groupKeyOf(data[i])
      const rows = index.get(key)
      if (rows) rows.push(i)
      else index.set(key, [i])
    }
  }
  byColumn.set(column, index)
  return index
}

/**
 * The distinct values of a column, in first-appearance order.
 *
 * First-appearance rather than sorted, because the order a loop visits its groups in should be
 * the order the data is in — an upstream Sort is how somebody says they want it otherwise, and
 * a hidden sort here would quietly override it. `Map` iterates in insertion order, which is what
 * makes the index above answer this without a second pass. Nulls and empties collapse into one
 * group named by `UNGROUPED`, since "the neurons with no type" is a group somebody means rather
 * than an error, and leaving each null its own group would make one group per row.
 */
export function groupKeys(v: IterableValue, column: string): string[] {
  return [...groupIndex(v, column).keys()]
}

/**
 * Every element sharing one value of a column, as a collection of the same kind.
 *
 * The group half of `elementAt`, and it keeps that function's rule: a key that is not in the
 * collection yields the *empty* collection rather than the nearest one. An upstream edit that
 * removed a cell type has not moved the group, it has removed it, and answering with a
 * different type's neurons under the same name is the silent wrong answer `Select One`'s own
 * out-of-range note argues against.
 */
export function groupOf(v: IterableValue, column: string, key: string): IterableValue {
  return sliceElements(v, groupIndex(v, column).get(key) ?? [])
}

function sliceElements(v: IterableValue, indices: number[]): IterableValue {
  if (isTableValue(v)) return selectRows(v, indices)

  // The attribute table is one row per item *in the same order* (see `SkeletonsValue`), so the
  // same indices address both halves. That contract is the only reason this is one function.
  const attributes = selectRows(v.attributes, indices)

  if (v.kind === 'skeletons') {
    const items = indices.map((i) => v.items[i]!)
    return {
      kind: 'skeletons',
      items,
      attributes,
      bounds: items.length ? boundsOf(items.map((item) => item.positions)) : EMPTY_BOUNDS,
      // Carried through for the same reason `detail` is, one branch below: units and template
      // space are facts about where the coordinates came from, and taking one neuron out does
      // not change either. Dropping them would leave a single skeleton claiming to be in units
      // nobody knows, in a space nothing downstream could refuse to mirror.
      ...(v.units ? { units: v.units } : {}),
      ...(v.space ? { space: v.space } : {}),
    }
  }

  const items = indices.map((i) => v.items[i]!)
  return {
    kind: 'meshes',
    items,
    attributes,
    bounds: items.length ? boundsOf(items.map((item) => item.positions)) : EMPTY_BOUNDS,
    // Carried through: the level of detail is a fact about the *fetch*, and taking one neuron
    // out of the batch does not re-fetch it at a finer level. Dropping it would have the
    // viewer's `mesh LOD n/m` caption disappear the moment anything selected a single mesh.
    ...(v.detail ? { detail: v.detail } : {}),
    ...(v.units ? { units: v.units } : {}),
    ...(v.space ? { space: v.space } : {}),
  }
}

/**
 * Column names that name a thing, in the order a reader would want them.
 *
 * Shared with nothing on purpose — `rowFields.ts` answers the neighbouring question (which
 * fields become coloured chips, from a *dataset's* schema) and lives in the UI. This one has to
 * work on an uploaded CSV of clusters as well as on a neuron table, so it ends at "the first
 * column carrying text".
 */
const NAME_COLUMNS = ['type', 'instance', 'name', 'label']

/**
 * A short human name for one element, for the card's readout.
 *
 * Headless and therefore testable: the alternative is deriving it in the component, where jsdom
 * renders it and nothing checks that a mesh says which body it is.
 */
export function elementLabel(v: IterableValue, index: number): string {
  const i = Math.floor(index)
  if (i < 0 || i >= elementCount(v)) return ''

  if (isTableValue(v)) return labelFromRow(v, i)

  /*
   * The geometry's own id first, not the attribute table's — the two are index-aligned here
   * and the geometry cannot be re-ordered by something upstream, where an attribute table can,
   * and a silhouette labelled with the wrong neuron's id is worse than one labelled with none.
   */
  const id = v.items[i]?.id ?? ''
  const name = labelFromRow(v.attributes, i, ['neuronId'])
  return name && name !== id ? `${name} ${id}`.trim() : id
}

/**
 * The most *identifying* short name for one element — an id where there is one.
 *
 * `elementLabel`'s sibling, and the split is deliberate rather than a duplication. That one
 * answers "what should this card say it is showing", where a cell type is the useful answer:
 * somebody browsing a result wants to read `LC11`. This answers "what should this pass be
 * *called*", and there the useful answer is the one that differs between passes — a loop over
 * six LC11s labelled `LC11` six times names a progress line that never changes and six files
 * that are told apart only by their ordinal.
 *
 * Probed on the mock optic lobe: `LC.*` limit 6 returns six neurons of one type, so
 * `elementLabel` said `LC11` for every pass. The id is what a folder of SWCs has to carry.
 *
 * Falls back to `elementLabel` when there is no id, because an uploaded CSV of clusters has no
 * `neuronId` and a name is better than a number.
 */
export function elementIdentity(v: IterableValue, index: number): string {
  const i = Math.floor(index)
  if (i < 0 || i >= elementCount(v)) return ''

  // The geometry's own id first, not the attribute table's, on `elementLabel`'s reasoning: the
  // two are index-aligned here and only the attribute table can be re-ordered upstream.
  if (!isTableValue(v)) return v.items[i]?.id || elementLabel(v, i)

  // `idText`, never `String(...)`: an id crosses into the UI as text and a float64 round trip
  // renames an 18-digit root id to a different neuron (invariant 8). It answers null for a cell
  // that is not one, which is the same "nothing to name this by" the fallback already handles.
  return idText(v.data[ID_COLUMN_NAME]?.[i]) ?? elementLabel(v, i)
}

function labelFromRow(table: TableValue, index: number, skip: string[] = []): string {
  if (index >= table.length) return ''
  const row = getRow(table, index)
  for (const name of NAME_COLUMNS) {
    if (skip.includes(name)) continue
    const value = row[name]
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  if (!skip.includes('neuronId')) {
    const neuronId = row['neuronId']
    if (neuronId !== null && neuronId !== undefined && neuronId !== '') return String(neuronId)
  }
  for (const col of table.schema.columns) {
    if (skip.includes(col.name)) continue
    const value = row[col.name]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}
