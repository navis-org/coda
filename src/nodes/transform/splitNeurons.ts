import { registerNode } from '../../core/registry'
import { T, columnNames } from '../../core/types'
import { resolveRows } from '../../data/filterRows'
import { FILTERS_PARAM_ID, rowGrammarNote, rowsFromParams } from '../lib/filterRowParams'
import {
  SPLIT_KINDS,
  isSplitCollection,
  isSplitKind,
  matchesNothing,
  nothingMatchesReason,
  splitCollection,
  unresolvedRowsReason,
  wrongKindReason,
} from '../lib/splitRows'
import { geometryTypeOf } from '../lib/transformOps'

/**
 * How a plan writes this node's filters.
 *
 * The grammar is `rowGrammarNote`'s and generated; the two sentences supplied here are the ones
 * about this node. Both differ from Find Neurons' — a field comes from the **attribute table the
 * collection carries** rather than from a dataset's neuron schema, and an empty list is a card
 * nobody has configured rather than a query that refuses to run.
 */
function filtersNote(): string {
  return rowGrammarNote({
    fields: [
      '`f` is a column of the attribute table the skeletons or meshes carry — `type`, `status`,',
      '`cableLength`, `size`, or a `source` column a Stack Neurons upstream added. Read it off',
      'the `carries:` line on the wire; a field the collection does not have refuses the run.',
    ],
    empty: [
      'An empty list matches nothing: every neuron leaves on `rest` and `matched` is empty. There',
      'is no way to say "split on nothing" usefully, so ask the user what the two halves should',
      'be rather than emitting a node with no rows.',
    ],
  })
}

/**
 * Split a collection of neurons in two: the ones matching a set of filter rows, and the rest.
 *
 * **`Stack Neurons` run backwards**, and that is the shape to hold on to. Stacking puts several
 * collections end to end and writes a column saying which input each neuron came from; this asks
 * the attribute table a question and hands back both answers. Taking a stacked scene apart again
 * is the case the pair exists for — one row, `source is hemibrain`, on the column the stack
 * itself wrote — and the general one is any question the geometry's attributes can answer:
 * `type matches LC4.*`, `cableLength >= 50000`, `status is Traced`.
 *
 * **Both halves, from one pass, is the whole point.** The alternative a graph can already
 * express is a filter upstream of the fetch, run twice with opposite conditions — which is not
 * merely two cards but usually **wrong**: the negation of two ANDed rows is not a single
 * condition, so the "rest" arm silently drops the neurons that fail one row and pass the other.
 * Here every item lands on exactly one port and the two counts sum to the input's. It is also
 * the only route at all once the geometry is in hand: after a Stack Neurons or a Transform there
 * is no table upstream left to filter.
 *
 * **Skeletons and meshes, and the two exclusions are decisions.** `Points` is refused although
 * `Stack Neurons` accepts it, because a point cloud's attribute rows are synapses — splitting one
 * would divide connectors under a name about neurons. A table is refused because `Filter Table`
 * filters tables, and both refusals name what to use instead (`wrongKindReason`). The port is
 * `T.any()` on `core.selectOne`'s reasoning: the type system cannot say "skeletons or meshes",
 * so the port says `any` and the refusal is a validation question.
 *
 * The filters are **Find Neurons' rows**: same widget, same operator vocabulary, same codec
 * (`data/filterRows.ts`), read through the same `rowsFromParams`. What differs is where a field
 * comes from and therefore what an empty set of rows means — see `nodes/lib/splitRows.ts`, which
 * holds every decision that is about the rows rather than about the node.
 *
 * **A row naming a column the attributes do not have refuses the run**, which is Find Neurons'
 * stance rather than the Table viewer's: dropping the row would still return a partition, of a
 * question nobody asked, with neurons on the wrong side of it. `validate` reports it on the card
 * first, since the wire carries its attribute schema at edit time.
 *
 * Cheap: item references and one attribute-table pass, no geometry copied and nothing fetched,
 * so it re-splits as you type a value with nothing waiting for Run.
 */
registerNode({
  type: 'neuron.splitNeurons',
  label: 'Split Neurons',
  category: 'transform',
  // Find Neurons' width, because it is the same editor — `FilterRowsEditor` draws both cards, so
  // a width that fits three controls on one card fits them on the other.
  cardWidth: 360,
  description:
    'Split skeletons or meshes in two by their attributes: the matches, and the rest.',
  guide:
    'Stack Neurons run backwards: it asks the attribute table a question and hands back both answers, so one row on the stack’s own source column takes a scene apart again. Reach for it instead of filtering twice with opposite conditions — the negation of several ANDed rows is not one condition. With no filters nothing matches.',
  cost: 'cheap',
  /*
   * `any`, like `neuron.stack` and `core.selectOne`: "skeletons or meshes" is not something the
   * type system can say, so the port says nothing and `validate` does the refusing.
   */
  inputs: [{ id: 'in', label: 'Neurons', type: T.any(), kinds: SPLIT_KINDS }],
  /*
   * `matched` first, so a link dragged off the node starts at the half somebody asked about —
   * `neuron.connectivity`'s rule for its two outputs, and `out.table`'s for its pass-through.
   */
  outputs: [
    { id: 'matched', label: 'Matching', type: T.any(), kinds: SPLIT_KINDS },
    { id: 'rest', label: 'Rest', type: T.any(), kinds: SPLIT_KINDS },
  ],
  params: [
    {
      /*
       * The rows, as the opaque `string[]` the card owns — Find Neurons' param, same id and same
       * codec, so `FilterRowsEditor` draws both and neither can grow a second encoding. Never
       * `presentational`: this decides which neurons go where.
       */
      id: FILTERS_PARAM_ID,
      kind: 'ids',
      label: 'Filters',
      noun: 'filters',
      help: 'Filter rows, combined with AND, asked of the attribute table these neurons carry. Neurons matching all of them leave on Matching, the rest on Rest — so with none set, nothing matches.',
      catalogueNote: filtersNote(),
      default: [],
    },
  ],

  /*
   * Both halves are subsets, so both carry the input's kind and attribute schema exactly — which
   * is what keeps either port pluggable into the 3D View, NBLAST or Download. Unknown until the
   * kind is: `geometryTypeOf` answers `any` for anything this node will refuse, so an
   * unconfigured socket advertises nothing rather than promising skeletons.
   */
  inferOutputs: (ctx) => {
    const kind = ctx.inputs.in?.kind
    // `ctx.attributes`, the same read `validate` makes and the same answer `schemaOfGeometry`
    // gives for the kinds `isSplitKind` admits — one source for the schema across all three
    // surfaces, which is what this node's own docs claim.
    const out = isSplitKind(kind) ? geometryTypeOf(kind, ctx.attributes('in')) : T.any()
    return { matched: out, rest: out }
  },

  /*
   * Two refusals and no third. A kind this node cannot split, and a row naming a column the
   * attributes do not have — knowable the moment it is typed, since the wire carries its schema
   * at edit time. Deliberately no issue for a card with *no* rows: an unconfigured node is not a
   * broken one, and a badge on every freshly-dropped card is how a badge stops meaning anything.
   * `evaluate`'s `ctx.warn` is what explains an empty `Matching` to somebody who ran it.
   */
  validate: (ctx) => {
    const kind = ctx.inputs.in?.kind
    if (!isSplitKind(kind)) return [wrongKindReason(kind)]
    return resolveRows(ctx.attributes('in'), rowsFromParams(ctx.params)).problems.map(
      (problem) => problem.message,
    )
  },

  evaluate: (ctx) => {
    const value = ctx.input('in')
    if (!isSplitCollection(value)) throw new Error(wrongKindReason(value?.kind))

    const rows = rowsFromParams(ctx.params)
    const { terms, problems } = resolveRows(value.attributes.schema, rows)
    // Refused rather than applied without the broken row — the sentence is shared with both
    // emitters, or the canvas and the notebook give different accounts of one refusal.
    if (problems.length > 0) {
      throw new Error(unresolvedRowsReason(problems, columnNames(value.attributes.schema)))
    }

    if (matchesNothing(rows)) {
      ctx.warn(
        `${nothingMatchesReason()} Add a filter row — or filter the neuron table upstream if ` +
          'you only want one half.',
      )
    }

    // Destructured rather than returned whole: `RowSplit`'s fields are the two port ids, but an
    // interface is not assignable to `Record<string, Value>` without an index signature.
    const { matched, rest } = splitCollection(value, terms)
    return { matched, rest }
  },
})
