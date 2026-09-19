/**
 * Keeping the neurons a table names, out of a collection of skeletons or meshes.
 *
 * The value half of `Select Neurons`, and the one decision worth stating up front is **which id
 * is matched**. A geometry collection carries two: `item.id`, the draw key every renderer,
 * exporter and selection is already using, and a `neuronId` column in the attribute table beside
 * it. They agree when a source builds a collection and can stop agreeing afterwards — an
 * `Attach Attributes` writes over columns, and only the *attributes* can be re-ordered or
 * rewritten by something upstream. So this matches on `item.id`, which is `elementIdentity`'s
 * rule and invariant 8's: the id is the identity, the column is a label beside it.
 *
 * **The wanted ids are `idColumn`'s**, which is the one place that reads a cell as an id. Its
 * rule comes with it: `idText` per cell, so an eighteen-digit CAVE root id survives where
 * `String(cell)` would round it into a different neuron, and a cell that is not an id is skipped
 * rather than refused — a wired column is *data*, and a node that would not run because one
 * upstream row carried a null is unusable. Deliberately **not** `idList.ts`' `idsFromColumn`,
 * which additionally enforces the *typed* grammar: that one reads a value somebody chose, where
 * this reads a column a backend published, and `core.qualifyIds` mints perfectly good `dataset:id`
 * item ids that the typed grammar refuses.
 *
 * **Nothing is refused for not matching.** A neuron listed in the table with no geometry in the
 * collection is the ordinary state — a table of 400 partners wired to the 12 skeletons somebody
 * fetched — so the shortfall is counted and said (`ctx.warn`), never raised. The one case worth a
 * sentence of its own is *nothing* matching, because that is what a mis-picked ID column looks
 * like from the outside: a picker sitting on a column of cell types resolves perfectly well, runs
 * perfectly well, and hands back an empty scene. **An empty table is the exception and is silent**
 * — it names no neurons, so nothing was expected; see `nothingSelectedReason`.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { CodaType, Kind } from '../../core/types'
import { kindIn } from '../../core/types'
import type { MeshesValue, SkeletonsValue, TableValue, Value } from '../../core/values'
import { keepElements } from './iterables'
import { idColumn } from './tableOps'

/** The id column picker. Here rather than on the node, so both emitters reach it through lib. */
export const ID_COLUMN_PARAM = 'idColumn'

/** How many ids a warning names before it stops listing them. */
const NAMED_IN_WARNING = 5

/**
 * What this node subsets: a collection of neurons drawn as geometry.
 *
 * **A sixth kind list, and the fifth — `DISTANCE_KINDS` — is the one that shares its reason.**
 * `SPLIT_KINDS` holds the same two members for a different reason: `Split Neurons` declines a
 * point cloud because its attribute rows are *connectors*, so asking them a question and
 * answering in items divides synapses under a name about neurons. That argument does not reach
 * here — keeping the synapses of the neurons a table names is a perfectly sensible thing to want.
 * What stops it is structural, and it is `geometryDistance.ts`' reason exactly: a `PointsValue`
 * has no `items`, so it carries no id of its own, and the match would have to run against an
 * attribute column, which on a synapse cloud is *two* columns with nothing to say which end was
 * meant. Shared with `DISTANCE_KINDS` anyway, on that file's own argument: two refusals resting on
 * one list come apart the moment either node changes its mind, which is the thing a shared list
 * cannot express.
 */
export const SELECT_KINDS = ['skeletons', 'meshes'] as const satisfies readonly Kind[]

export type SelectableCollection = SkeletonsValue | MeshesValue

/*
 * Over the list, on `isSplitCollection`'s reasoning — a list and a disjunction of the same
 * members is the pair that comes to disagree. Not `kindIn`: a value has arrived, so the
 * `any`/`undefined` arm that keeps an unresolved socket from being a refusal is wrong here.
 */
export function isSelectableCollection(v: Value | undefined): v is SelectableCollection {
  return !!v && (SELECT_KINDS as readonly string[]).includes(v.kind)
}

/**
 * Whether a *type* could carry something selectable, which is what `validate` asks.
 *
 * `any` and `undefined` count, on `isIterableKind`'s rule: unknown is not a refusal, and an
 * unresolved socket is the ordinary state before anything upstream has run.
 */
export function isSelectableKind(kind: CodaType['kind'] | undefined): boolean {
  return kindIn(SELECT_KINDS, kind)
}

/**
 * The column the ids are read from, resolved once — infer, evaluate and both emitters.
 *
 * `readAttach`'s shape and for its reason: a reader that **supplies the default** is what stops
 * each surface deciding the missing-column case for itself. `ctx.column` answers the stored name
 * for every table that has columns at all (invariant 5), so the fallback is reachable only on a
 * schema-known table with none — where naming `neuronId` produces the same empty result that
 * `nothingSelectedReason` already explains, rather than a third refusal nobody can act on.
 *
 * Structural rather than `InferContext | EvalContext`, so an `EmitContext` fits it too.
 */
export function readSelection(ctx: { column(paramId: string): string | undefined }): string {
  return ctx.column(ID_COLUMN_PARAM) ?? ID_COLUMN_NAME
}

/**
 * The ids a column names, as exact text, in first-appearance order and deduplicated.
 *
 * `[...new Set(idColumn(...))]` is the idiom `normalizeTargets` and `copyIds` already use, and
 * both halves earn their keep here: the count is the denominator in "2 of the 3 neurons", so a
 * table listing a neuron twice would otherwise inflate it, and the order is what makes the
 * unmatched report and the example ids read in the table's own order.
 *
 * Guarded rather than delegated straight through, because `getColumn` throws on a column the
 * table does not have and a picker pointed at a vanished column is an ordinary edit-time state.
 */
export function wantedIds(table: TableValue | undefined, column: string | undefined): string[] {
  if (!table || !column || !table.data[column]) return []
  return [...new Set(idColumn(table, column))]
}

export interface IdSelection<V extends SelectableCollection> {
  /** The collection holding just the named neurons, in the collection's own order. */
  kept: V
  /** Ids the table named that the collection has no geometry for, in the table's order. */
  missing: string[]
}

/**
 * The neurons named by `wanted`, in the **collection's** order rather than the table's.
 *
 * The order is a decision and it is the conservative one: a subset is still the scene it came
 * from, so anything already keyed on position — a stacked `source` column, a `Select One` index,
 * a 3D viewer's legend order — keeps meaning what it meant. Re-ordering to match the table would
 * make this a sort as well as a filter, which is `core.sort`'s job on the table upstream.
 *
 * `keepElements` rather than a slice here: `iterables.ts` owns everything about taking a subset of
 * a collection — the index-aligned attribute rows, bounds recomputed, `units`/`space`/
 * `provenance`/`detail` carried, and the identity fast path that hands the whole collection back
 * untouched when every neuron is wanted. Deliberately not `partitionElements`, whose complement is
 * not free: it copies every attribute column of the discarded rows and walks their coordinate
 * buffers to recompute a bounding box nothing here reads.
 *
 * `missing` is derived from what was kept rather than recorded by the predicate, which keeps that
 * predicate pure and cannot come to disagree with the answer: the kept items *are* the ids that
 * were present.
 */
export function selectByIds<V extends SelectableCollection>(
  value: V,
  wanted: readonly string[],
): IdSelection<V> {
  const want = new Set(wanted)
  const items = value.items
  const kept = keepElements(value, (index) => want.has(items[index]!.id))
  const present = new Set(kept.items.map((item) => item.id))
  return { kept, missing: wanted.filter((id) => !present.has(id)) }
}

/**
 * Why a collection this node cannot subset was refused, naming what to use instead.
 *
 * Deliberately **not** `wrongKindReason`, which `splitRows.ts` already exports with a different
 * sentence: both are reached by path, and an emitter importing the wrong of two identically-named
 * functions compiles cleanly and writes the other node's explanation into somebody's notebook.
 * The branches are `wrongKindReason`'s reasoning — a table and a point cloud are refused for
 * different reasons and each has a different remedy, so listing what is accepted tells somebody
 * holding one of them nothing they can act on.
 */
export function unselectableKindReason(kind: CodaType['kind'] | undefined): string {
  if (kind === 'table' || kind === 'neurons') {
    return (
      'Select Neurons takes skeletons or meshes. For a table of neurons, Join keeps the rows ' +
      'another table names, and Filter Table keeps the rows matching a condition.'
    )
  }
  if (kind === 'points') {
    return (
      'Select Neurons takes skeletons or meshes. A synapse cloud carries no id of its own — a ' +
      'row is a connector with a neuron at each end — so there is no one column to match on. ' +
      'Filter the neuron table above the node that fetched the synapses.'
    )
  }
  return `Select Neurons takes skeletons or meshes, not ${kind ?? 'this'}.`
}

/**
 * Why an empty result is the picker rather than the data.
 *
 * **Reached only where the table had rows**, which the node checks before calling this: a table
 * with none names no neurons, so its empty result is the arithmetic and saying anything about the
 * picker there accuses the one part of the card that is set correctly. What survives is the pair
 * this sentence is for — a column of cell types, which holds plenty that are not ids, and a column
 * holding nothing an id can be read out of, which is the ` no ids` branch below.
 *
 * Two surfaces — `validate` says nothing about the picker, so this is `evaluate`'s warning and the
 * test's assertion. A function rather than a literal for the test's sake: asserting against the
 * sentence is what stops the warning being reworded without anyone noticing which case it names.
 * Neither emitter renders it, and neither could: nothing at emit time knows a result is empty.
 *
 * The column is named because that is the thing to change — `resolveColumn`'s rule 3 hands a
 * required picker the first compatible column when the stored one is gone, so a table keyed on
 * `label` or `bodyId` matches nothing while looking entirely configured.
 */
export function nothingSelectedReason(column: string, wanted: readonly string[]): string {
  const sample = wanted.length > 0 ? ` It holds ${namedFew(wanted)}.` : ' It holds no ids.'
  return (
    `None of the ids in "${column}" name a neuron in this collection, so the result is ` +
    `empty.${sample} Check that the picker names the table's neuron id column.`
  )
}

/**
 * How many of the named neurons had no geometry here, and which.
 *
 * Beside `nothingSelectedReason` rather than inline in the node, because the two are one `else`
 * apart and one of each is the drift shape this repo names — the extracted one gets asserted
 * against and the inline one gets asserted by fragment, so only one of them is pinned. Single
 * surface today, deliberately: both emitters emit nothing for this, and say why.
 */
export function skippedNeuronsReason(
  column: string,
  missing: readonly string[],
  wanted: number,
): string {
  return (
    `${missing.length} of the ${wanted} neurons in "${column}" have no geometry here and were ` +
    `skipped: ${namedFew(missing)}. Fetch them above this node if you want them drawn.`
  )
}

/** A few ids by name, then an ellipsis. The inline idiom three other node files spell out. */
function namedFew(ids: readonly string[]): string {
  const named = ids.slice(0, NAMED_IN_WARNING).join(', ')
  return ids.length > NAMED_IN_WARNING ? `${named}, …` : named
}
