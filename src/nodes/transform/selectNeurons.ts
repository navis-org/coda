/**
 * Select Neurons: the skeletons or meshes a neuron table names, and nothing else.
 *
 * The node for the gesture every scene eventually needs — *draw these ones* — where "these ones"
 * is a table the graph already computed rather than a condition somebody can type. A Connectivity
 * result, a Cut Tree cluster, an NBLAST shortlist, a Find Neurons run, an uploaded CSV: all of
 * them are neuron tables, and until this existed none of them could reach geometry that had
 * already been fetched.
 *
 * ## Why not filter upstream
 *
 * Usually you should, and the card says so in its own guide: filtering the neuron table *before*
 * the Skeletons or Meshes node fetches less and is the same picture. This is for the cases where
 * that is not available — the geometry is downstream of a `Stack Neurons`, a `Transform` or a
 * `Mirror` with no table left in front of it; the table naming the subset is itself computed
 * *from* the geometry (an NBLAST score, a distance, a topology measure); or the fetch is
 * `expensive` and the question being asked is which twelve of the hundred to look at, which is a
 * question somebody asks six times in a row.
 *
 * ## Four decisions
 *
 * **Not a second input on `Split Neurons`**, which is the nearest neighbour and the obvious place
 * to put this. Its filter rows already have `isIn`, so "id is one of these" is expressible there
 * today — but only against a list somebody *types* into a param, where the whole point here is a
 * table the graph computed. The deciding reason is the identity: that node asks the **attribute
 * table** a question (`fieldTermsMatch` over the rows), this matches `item.id`, and invariant 8's
 * rule is that those two come apart after an `Attach Attributes`. A mode toggling which identity
 * is matched would put two match semantics behind one control on a card whose guide is entirely
 * about attribute columns — and behind one *emitter*, where Python refuses Split Neurons outright
 * (navis has no attribute frame) and emits this node happily, because `Neuron.id` is always there.
 *
 * **The match is on the geometry's own id**, never on its `neuronId` attribute column — see
 * `nodes/lib/selectNeurons.ts`, which holds every rule that is about the selection rather than
 * about the node.
 *
 * **One output, where `Split Neurons` has two.** That node's two ports exist because the negation
 * of several ANDed filter rows is not one condition, so the complement has to be computed rather
 * than asked for again. A list of ids has no such problem: the complement is a `Join` away on the
 * table, and the cases people actually reach for — *show me the cluster*, *show me the top
 * matches* — want one collection to wire into a viewer. A `Rest` port here would be a second
 * socket on every card to serve the rarer half.
 *
 * **Nothing is refused for not matching.** A table naming 400 partners wired to the 12 skeletons
 * somebody fetched is the ordinary state, not an error, so the shortfall is a `ctx.warn` with a
 * number in it. The one thing that gets its own sentence is *nothing* matching, because that is
 * what a mis-picked ID column looks like from the outside: a perfectly plausible run that hands
 * back an empty scene — unless the table is *empty*, which names no neurons and is therefore an
 * empty result nobody needs telling about.
 *
 * Cheap: item references and one pass over a column, no geometry copied and nothing fetched, so
 * the scene re-selects as the table above it changes.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  ID_COLUMN_PARAM,
  SELECT_KINDS,
  isSelectableCollection,
  isSelectableKind,
  nothingSelectedReason,
  readSelection,
  selectByIds,
  skippedNeuronsReason,
  unselectableKindReason,
  wantedIds,
} from '../lib/selectNeurons'
import { geometryTypeOf } from '../lib/transformOps'

registerNode({
  type: 'neuron.selectNeurons',
  label: 'Select Neurons',
  category: 'transform',
  description:
    'Keep only the skeletons or meshes whose ids appear in a neuron table. Columns are untouched — the geometry arrives with the attributes it already had.',
  guide:
    'Takes a collection of skeletons or meshes and a table of neurons, and keeps the geometry whose ids the table names — so a Cut Tree cluster, an NBLAST shortlist or a Connectivity result can pick what a 3D View draws without re-fetching anything. Filtering the neuron table before the Skeletons or Meshes node is cheaper where that is still possible; this is for geometry that has no table left in front of it, or a subset chosen from something measured off the geometry itself. Ids the collection has no geometry for are counted and reported, never refused.',
  cost: 'cheap',

  /*
   * `any` with `kinds`, like `neuron.splitNeurons` and `neuron.attachAttributes`: "skeletons or
   * meshes" is not something `CodaType` can say, so the set is declared and `validate` answers
   * for the one case a kind set cannot — an upstream socket that has not resolved yet.
   */
  inputs: [
    { id: 'in', label: 'Geometry', type: T.any(), kinds: SELECT_KINDS },
    { id: 'neurons', label: 'Neurons', type: T.table() },
  ],
  outputs: [{ id: 'out', label: 'Geometry', type: T.any(), kinds: SELECT_KINDS }],

  params: [
    {
      id: ID_COLUMN_PARAM,
      kind: 'column',
      label: 'ID column',
      from: 'neurons',
      /*
       * `resolveColumn`'s rule 3 is the trap this node lives with, and `validate` below is the
       * answer: on a table with no `neuronId` — a Cut Tree keys on `label`, an uploaded CSV on
       * `bodyId` — a required picker sitting on its declared default resolves to the **first
       * compatible column**, which may be a column of cell types and would match nothing while
       * looking configured. Deliberately no `dtypes`: an id is `str` from every source here, but
       * an uploaded CSV of nine-digit hemibrain ids arrives as `i64` and refusing it at the
       * picker would be refusing the data rather than the mistake.
       */
      default: ID_COLUMN_NAME,
      help: 'The table column holding neuron ids, matched against the ids the geometry carries. A Cut Tree, Reduce Matrix or Embedding keys on “label”.',
    },
  ],

  /*
   * A subset, so the output is the input's kind with the input's attribute schema exactly —
   * which is what keeps the result pluggable into the 3D View, NBLAST or Download, and what
   * fills a downstream "colour by" picker before anything has run.
   *
   * **The kind is checked first, and that guard is load-bearing**: `geometryTypeOf` answers
   * `T.points(...)` for a point cloud, which is a geometry kind this node refuses, so without it
   * a wired cloud would advertise `points` downstream while `validate` flags the card and
   * `evaluate` throws. An unresolved socket falls through the same guard to `any`, which is what
   * keeps a half-built graph promising nothing rather than promising skeletons.
   */
  inferOutputs: (ctx) => ({
    out: isSelectableKind(ctx.inputs.in?.kind)
      ? geometryTypeOf(ctx.inputs.in?.kind, ctx.attributes('in'))
      : T.any(),
  }),

  /*
   * One refusal and no second. A kind this node cannot subset — and deliberately nothing about
   * the picker, which is `neuron.attachAttributes`' recorded stance for the identical trap:
   * `validateColumnParams` runs for every node on every mutation and already says
   * `Column "neuronId" is gone — using "label"` for exactly the rule-3 substitution, so a line
   * here would be the same fact twice. What edit time genuinely cannot see is whether the
   * substituted column holds ids, and that is `evaluate`'s warning.
   */
  validate: (ctx) => {
    const kind = ctx.inputs.in?.kind
    return isSelectableKind(kind) ? [] : [unselectableKindReason(kind)]
  },

  evaluate: (ctx) => {
    const value = ctx.input('in')
    if (!isSelectableCollection(value)) throw new Error(unselectableKindReason(value?.kind))
    const table = ctx.input('neurons')
    if (!isTableValue(table)) throw new Error('Second input is not a table of neurons')

    const column = readSelection(ctx)
    const wanted = wantedIds(table, column)
    const { kept, missing } = selectByIds(value, wanted)

    /*
     * **A table with no rows is not a mis-picked column**, and it is checked before either
     * report rather than folded into them. An empty result there is the arithmetic — a `Filter
     * Table` that matched nothing, a loop pass with an empty share, a search that found none —
     * so the only thing a warning adds is an accusation against the one part of the card that
     * is set correctly. Asked of the *table* rather than of `wanted`: a table that has rows and
     * no ids in that column is the picker again, and keeps its sentence.
     */
    if (table.length === 0) return { out: kept }

    /*
     * Exclusive by construction — nothing kept means everything wanted is missing — and the
     * empty case gets the sentence rather than the number, because an empty scene reads as broken
     * geometry and is almost always a mis-picked column. The examples are what tell the two apart
     * at a glance: ids beside ids means the collection genuinely holds none of them.
     */
    if (kept.items.length === 0) ctx.warn(nothingSelectedReason(column, wanted))
    else if (missing.length > 0) ctx.warn(skippedNeuronsReason(column, missing, wanted.length))

    return { out: kept }
  },
})
