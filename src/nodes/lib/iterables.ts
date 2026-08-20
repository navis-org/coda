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

import type { CodaType } from '../../core/types'
import type { MeshesValue, SkeletonsValue, TableValue, Value } from '../../core/values'
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
  const i = Math.floor(index)
  return sliceElements(v, i >= 0 && i < elementCount(v) ? [i] : [])
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
      // Carried through for the same reason `detail` is, one branch below: units are a fact
      // about where the coordinates came from, and taking one neuron out does not change it.
      // Dropping them would leave a single skeleton claiming to be in units nobody knows.
      ...(v.units ? { units: v.units } : {}),
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
   * The geometry's own `bodyId` first, not the attribute table's. They agree by construction,
   * but the geometry is where the id is authoritative — an attribute table can be rebuilt or
   * re-ordered by something upstream, and a silhouette labelled with the wrong neuron's id is
   * worse than one labelled with none.
   */
  const bodyId = v.items[i]?.bodyId
  const name = labelFromRow(v.attributes, i, ['bodyId'])
  const id = bodyId === undefined ? '' : String(bodyId)
  return name && name !== id ? `${name} ${id}`.trim() : id
}

function labelFromRow(table: TableValue, index: number, skip: string[] = []): string {
  if (index >= table.length) return ''
  const row = getRow(table, index)
  for (const name of NAME_COLUMNS) {
    if (skip.includes(name)) continue
    const value = row[name]
    if (value !== null && value !== undefined && value !== '') return String(value)
  }
  if (!skip.includes('bodyId')) {
    const bodyId = row['bodyId']
    if (bodyId !== null && bodyId !== undefined && bodyId !== '') return String(bodyId)
  }
  for (const col of table.schema.columns) {
    if (skip.includes(col.name)) continue
    const value = row[col.name]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}
