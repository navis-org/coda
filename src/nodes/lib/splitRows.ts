/**
 * One collection of neurons, two collections: the ones matching a set of filter rows, and the
 * rest.
 *
 * The value half of `Split Neurons`, which is `Stack Neurons` run backwards — that node puts
 * several collections end to end and adds a column saying where each neuron came from, and this
 * one takes a collection apart again by asking its attribute table a question. Splitting a
 * stacked scene back into its datasets is the case the pair was built around, and the row that
 * does it is `source is hemibrain`, on the very column the stack wrote.
 *
 * **The question is asked of the attributes and answered in items**, and that sentence is
 * `iterables.ts`' subject rather than this file's — a `SkeletonsValue` carries one attribute row
 * per item *in the same order*, which is the contract `groupOf`, `elementAt` and
 * `partitionElements` all rest on. So what is here is only the part that is about *filter rows*:
 * lowering them to terms and handing `partitionElements` the predicate. `fieldTermsMatch` is
 * asked once per item and its answer picks the side, so the two halves cannot come to disagree
 * about a null cell (a missing value satisfies `ne` and no other operator).
 *
 * **No rows sends everything to `rest`.** An empty set of rows is a predicate that has matched
 * nothing, so `matched` is empty and the collection arrives whole on the second port: the total
 * is preserved, and the port that does the asking is the one that answers empty. The
 * alternative, everything to `matched`, reads as "an AND over no clauses is true" and is
 * defensible; what settled it is that a half-built card would then be indistinguishable from a
 * finished one whose filters happen to match every neuron.
 */

import type { FilterRow, RowProblem } from '../../data/filterRows'
import type { MeshesValue, SkeletonsValue, Value } from '../../core/values'
import type { CodaType } from '../../core/types'
import type { FieldTerm } from '../../data/terms'
import { fieldTermsMatch, prepareFieldTerms } from '../../data/terms'
import { partitionElements } from './iterables'

/**
 * What this node splits: a collection of neurons drawn as geometry.
 *
 * **Narrower than the lists that already exist, and the two exclusions are the argument.**
 * `isGeometryKind` also admits `points`, whose attribute rows are *synapses* — one row per
 * connector rather than per neuron — so "split these neurons" would silently mean "split these
 * synapses", and `Points` is consequently the one kind you can stack but not split. `IterableValue`
 * also admits a table, which `Filter Table` already filters; a table wired here is refused with
 * that node named, rather than quietly doing its job under a name about neurons. A third list is
 * the honest way to say a third thing: two callers sharing a list that is right for neither is
 * how a node comes to refuse a kind its own card still offers.
 */
export type SplitCollection = SkeletonsValue | MeshesValue

export function isSplitCollection(v: Value | undefined): v is SplitCollection {
  return !!v && (v.kind === 'skeletons' || v.kind === 'meshes')
}

/**
 * Whether a *type* could carry something splittable, which is what `validate` asks.
 *
 * `any` and `undefined` count, on `isIterableKind`' rule: unknown is not a refusal, and an
 * unresolved socket is the ordinary state before anything upstream has run.
 */
export function isSplitKind(kind: CodaType['kind'] | undefined): boolean {
  return kind === undefined || kind === 'any' || kind === 'skeletons' || kind === 'meshes'
}

/**
 * The two halves, in the input's order, each carrying the collection's schema and kind.
 *
 * A predicate handed to `partitionElements`, which owns everything about *taking a subset of a
 * collection* — the index-aligned attribute rows, the identity fast path for a whole side, the
 * bounds recomputed and the frame carried. What this adds is the one line that is about filter
 * rows: `fieldTermsMatch` against the prepared terms, asked per item.
 *
 * **A short attribute table sends its tail to `rest`.** The one-row-per-item contract is a
 * promise every source keeps today; if one ever did not, an item with no attribute row satisfies
 * no term, which is the same answer `fieldTermsMatch` gives for a row of nulls.
 */
export function splitCollection<V extends SplitCollection>(
  value: V,
  terms: readonly FieldTerm[],
): { matched: V; rest: V } {
  const prepared = prepareFieldTerms(value.attributes, terms)
  const rows = value.attributes.length
  return partitionElements(
    value,
    /*
     * `terms.length > 0` is load-bearing rather than a shortcut: `fieldTermsMatch` is an AND, so
     * over *no* terms it answers true for every row — which would send the whole collection to
     * `Matching` and mean the opposite of the rule this file states. It stands where
     * `partitionElements`' identity exit can still see it, so a card with no filters allocates
     * nothing and hands the input straight back on `rest`.
     */
    (item) => terms.length > 0 && item < rows && fieldTermsMatch(prepared, item),
  )
}

/**
 * Whether this set of rows matches nothing at all — in which case the whole collection leaves on
 * `rest`.
 *
 * `asksNothing`' arrangement, and for its reason: **four surfaces read it**, and each reading it
 * for itself is how the card comes to say one thing while the notebook does another. The card
 * asked `stored.length === 0` and the other three asked `terms.length === 0` until this existed;
 * those agree only because `decodeRows` applies `keptRows`, which is a fact about a *different*
 * file and one nothing here stated.
 */
export function matchesNothing(rows: readonly FilterRow[]): boolean {
  return rows.length === 0
}

/**
 * Why a card with no filters sends everything one way, as one sentence three surfaces render.
 *
 * `noFiltersReason`'s arrangement — deliberately **not** its name, since Find Neurons exports
 * that one with a different sentence and both are reached by path: an emitter importing the
 * wrong of two identically-named functions compiles cleanly and writes the other node's
 * explanation into somebody's notebook.
 */
export function nothingMatchesReason(): string {
  return (
    'This Split Neurons has no filters, so nothing matches: every neuron leaves on Rest and ' +
    'Matching is empty.'
  )
}

/**
 * Why an unresolvable row refuses the whole split, as one sentence two surfaces render.
 *
 * The clause that carries the meaning is the second one, and it is exactly the kind that drifts
 * when written per surface. `synapseUnitRefusal` is the model — one function, `validate` and
 * `evaluate` reading it — and here the exporters read it too.
 *
 * `columns` is what the attribute table actually has, and it is **required** — both callers hold
 * a schema (`evaluate` the collection's, the emitter `ctx.attributes`), and an optional argument
 * one of them declined to pass is how the document came to carry the less useful of the two
 * sentences. `columnNames(undefined)` is already `[]`, which is the "nothing arrived" case.
 */
export function unresolvedRowsReason(
  problems: readonly RowProblem[],
  columns: readonly string[],
): string {
  const why =
    `${problems.map((problem) => problem.message).join('; ')} — a split cannot drop a filter ` +
    'row and answer anyway: the two halves would still partition the collection, of a different ' +
    'question.'
  return columns.length > 0 ? `${why} These neurons carry: ${columns.join(', ')}` : why
}

/**
 * Why a collection this node cannot split was refused, naming what to use instead.
 *
 * A table and a point cloud are refused for *different* reasons and each has a different
 * remedy, so the sentence branches rather than listing what is accepted: "wire skeletons or
 * meshes" tells somebody holding a neuron table nothing they can act on.
 */
export function wrongKindReason(kind: CodaType['kind'] | undefined): string {
  if (kind === 'table' || kind === 'neurons') {
    return (
      'Split Neurons takes skeletons or meshes. For a table of neurons, Filter Table keeps the ' +
      'rows matching a condition.'
    )
  }
  if (kind === 'points') {
    return (
      'Split Neurons takes skeletons or meshes. A synapse cloud has one attribute row per ' +
      'connector rather than per neuron, so splitting it would divide synapses, not neurons.'
    )
  }
  return `Split Neurons takes skeletons or meshes, not ${kind ?? 'this'}.`
}
