/**
 * Select One: step through a collection and emit the element you are looking at.
 *
 * The manual counterpart to a `For each`. Where that would apply a sub-workflow to every element
 * and collect the results, this walks the same collection by hand — forward, back — and hands
 * one element to whatever is wired after it. `Explore → Select One → Skeletons → 3D` is the
 * shape it exists for: a way to look at one neuron of a result at a time without editing a
 * filter for each.
 *
 * ## Two indices, because browsing and deciding are different acts
 *
 * `index` is what the card is showing and is **presentational**, so stepping stays out of the
 * provenance key and costs no run. `selected` is what the output port carries and is not, so
 * committing marks the node stale and re-runs what is downstream of it. That is Profile's
 * pager/pin split exactly, and it is here for the same reason: on a chain with an expensive node
 * in it, an arrow button that fires a full pass per press — and with auto-run on, fires it per
 * press *automatically* — is not a browsing surface, it is a way to spend ten minutes of queries
 * on a gesture.
 *
 * ## `Live` is the opt-out, and it is presentational too
 *
 * Off, the arrows move `index` alone and `Use this` commits. On, they move both, so the output
 * follows the arrows immediately — which is what anybody wants on a cheap chain and exactly what
 * they do not want on a costly one. The flag itself changes nothing about what `evaluate`
 * returns: `evaluate` reads `selected` and has no opinion on how it got there. So it is
 * presentational, and toggling the mode does not invalidate a result — the same call `Download`
 * makes about every one of its params.
 *
 * ## The choice is a position, not an identity
 *
 * `selected` is an index. That is the deliberate half of a real trade: an index works on
 * everything — a `groupBy` roll-up with no id column, an uploaded CSV of embeddings, a mesh
 * collection — where an id-keyed selection (`rowIds.ts`, which Scatter and Profile use) survives
 * an upstream re-sort but needs a column that names each element. What it costs is that
 * reordering upstream re-points the output at a different element. What it must not cost is a
 * *silent* wrong answer, which is why an index past the end emits the empty collection rather
 * than clamping to the last element, and why the card says so in words.
 *
 * ## `any` in, `any` out
 *
 * The type system cannot say "a table, skeletons or meshes", so the port says `any` and the
 * refusal is a validation question — the same call `out.profile` makes about needing a `neuronId`.
 * The output type is the input type untouched: one row of a Neurons table is still Neurons with
 * the same columns, so nothing downstream loses a column picker when this node is dropped in.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import {
  elementAt,
  elementCount,
  emptyElement,
  isIterableKind,
  isIterableValue,
} from '../lib/iterables'

export const selectOneNode = registerNode({
  type: 'core.selectOne',
  label: 'Select One',
  category: 'transform',
  description: 'Step through a table, skeletons or meshes and emit one element at a time.',
  guide:
    'Step through a collection one element at a time — the manual For each. Explore → Select One → Skeletons → 3D View. Stepping is free (arrows move the card), Use this commits (re-runs downstream). Live mode couples browsing and committing.',
  // No network and no serious CPU: taking one element of a collection already in hand.
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Items', type: T.any() }],
  outputs: [{ id: 'item', label: 'Item', type: T.any() }],
  params: [
    {
      /*
       * The only param anybody sets by hand, which is why it is the only non-advanced one — a
       * custom body renders exactly the non-advanced set, so this is the card's one field.
       */
      id: 'live',
      kind: 'boolean',
      label: 'Live',
      help: 'Arrows update the output directly. Off, stepping is free and “Use this” commits — which is what you want with an expensive node downstream.',
      default: false,
      // It cannot change a byte of what `evaluate` returns; it decides what the *buttons write*.
      // In the key it would make switching modes invalidate every downstream result.
      presentational: true,
    },
    {
      id: 'index',
      kind: 'int',
      label: 'Showing',
      help: 'Which element the card is showing. Browsing never invalidates anything.',
      default: 0,
      min: 0,
      // The whole point of the split: looking is not deciding, so this stays out of the
      // provenance key. Written by the pager, so it is nothing anybody set — `ParamBase.internal`.
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      /*
       * Not `internal`: a committed choice is a decision, exactly as Profile's `selection` is,
       * and it should be countable in the card's "… 1 more (1 changed)" hint. Advanced because
       * the pager is how it is set — a raw index field beside a pager showing a different number
       * is two controls arguing about one thing.
       */
      id: 'selected',
      kind: 'int',
      label: 'Emitting',
      help: 'The element the Item port carries. Set by “Use this”, or by the arrows while Live is on.',
      default: 0,
      min: 0,
      advanced: true,
    },
  ],

  /*
   * A pass-through: taking one element changes the length, never the kind or the schema. That is
   * what keeps a Select One droppable mid-chain — a Neurons edge stays Neurons, and every column
   * picker downstream keeps its options.
   */
  inferOutputs: (ctx) => ({ item: ctx.inputs.in ?? T.any() }),

  validate: (ctx) => {
    const input = ctx.inputs.in
    // Unwired says nothing: an empty socket is a graph somebody has not finished, which the
    // scheduler already reports as `blocked`.
    if (!input || isIterableKind(input.kind)) return []
    return [
      `Select One steps through a Table, Skeletons or Meshes. A ${input.kind} has no elements to step through.`,
    ]
  },

  evaluate: (ctx) => {
    const value = ctx.input('in')
    if (!isIterableValue(value)) {
      throw new Error(
        'Select One needs a Table, Skeletons or Meshes — this input carries something else.',
      )
    }

    const index = Math.floor(Number(ctx.params.selected ?? 0))
    const count = elementCount(value)
    /*
     * Out of range emits nothing rather than the nearest element. An upstream filter that
     * shrank the collection has not moved the choice, it has removed it, and clamping would
     * answer with a different neuron under the same number. The card reports the state; every
     * downstream node already handles an empty collection.
     */
    if (!(index >= 0 && index < count)) return { item: emptyElement(value) }
    return { item: elementAt(value, index) }
  },
})
