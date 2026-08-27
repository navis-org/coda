/**
 * For Each: apply everything downstream to one element at a time.
 *
 * The automatic counterpart to `Select One`, and built on exactly the same insight — with one
 * addition that turns a browsing aid into a loop. Select One emits element *n* and lets you
 * press an arrow; this advances *n* itself, waits for the region downstream to finish, and goes
 * again.
 *
 * ## Nothing here knows how to run a graph
 *
 * The whole of the iteration is one number in the provenance key. `Scheduler.loopIndex` holds
 * which element this node is on and folds it into `hash(type, params, upstream)`; advancing it
 * re-keys this node, invariant 4 carries that to every descendant, and the region re-runs
 * because from a downstream node's point of view a new pass is indistinguishable from somebody
 * having edited a param upstream. There is no second execution model, no nested graph and
 * nothing new in a saved file.
 *
 * That is also why the region is not a *subgraph*. The obvious design — a collapsible group with
 * the body built inside it — needs boundary ports, a nested document and a `parentId` that
 * re-bases every child's `position`, which five subsystems read absolutely (see
 * `docs/canvas.md`). The region is derived from the wires instead: everything reachable from
 * this node that is not past a `Collect`.
 *
 * ## The index is not a param, and that is load-bearing
 *
 * Four hundred passes through `setParam` would be four hundred undo steps, four hundred
 * autosaves, and an `index: 399` serialised into whatever file you sent a colleague — a number
 * that means nothing to whoever opens it. Held in the scheduler as session state instead, so
 * **running a loop leaves the document byte-identical**. It still takes part in the key, which
 * is what invariant 4 asks of any hidden mutable state; what it does not do is take part in the
 * graph.
 *
 * ## `expensive`, and here that is entirely a safety property
 *
 * Slicing one element out of a collection already in hand is as cheap as work gets — `Select
 * One` is `cheap` for exactly that reason. But `cheap` means the 180ms pass after every
 * keystroke, and a loop that fires four hundred backend queries and writes four hundred files
 * per keystroke is not a node anybody can leave on a canvas. Same call `Download` makes, for the
 * same reason, and it has the same consequence: a loop runs on **Run**, and the auto pass defers
 * it whole.
 *
 * ## What is on the output port when it finishes
 *
 * The last element. That is honest rather than convenient: this port carries *one* element by
 * construction, and what the loop produced is in the files it wrote and in whatever a `Collect`
 * accumulated. A port claiming to hold four hundred results would be claiming the thing the loop
 * exists to avoid holding.
 *
 * ## Two ways to divide a collection
 *
 * `element` is one row, one skeleton, one mesh. `group` is every element sharing a value of a
 * column — "for each cell type", which is the more common connectomics gesture and is not
 * expressible by stepping, because the number of passes is a property of the data rather than
 * of the collection's length. Both emit the input's own kind, so what is downstream cannot tell
 * which mode produced it.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { elementNoun, emptyElement, isIterableKind, isIterableValue } from '../lib/iterables'
import { isGroupMode, loopPlanFor, loopSliceFor } from './plan'

export const forEachNode = registerNode({
  type: 'flow.forEach',
  label: 'For Each',
  category: 'utility',
  description: 'Run everything downstream once per element, or once per group.',
  guide:
    'Runs everything wired after it once per element — a row, a skeleton, a mesh, or every ' +
    'element sharing a value of a column. Pair it with Download to write a file per neuron, or ' +
    'with Collect to stack the results into one value. Only one element is ever in memory, ' +
    'which is what makes a set too large to load still possible to save. Start it with the ' +
    'card’s Run loop button, not Run.',
  /*
   * Not about cost — see the header. `cheap` would run the whole loop on the 180ms pass after
   * every keystroke, which for a loop that writes files is unusable.
   */
  cost: 'expensive',
  loop: 'begin',
  inputs: [{ id: 'in', label: 'Items', type: T.any() }],
  outputs: [{ id: 'item', label: 'Item', type: T.any() }],
  params: [
    {
      id: 'mode',
      kind: 'enum',
      label: 'For each',
      help: 'One element at a time, or every element sharing a value of a column.',
      default: 'element',
      options: [
        { value: 'element', label: 'element' },
        { value: 'group', label: 'group of a column' },
      ],
    },
    {
      id: 'groupBy',
      kind: 'column',
      label: 'Group by',
      help: 'One pass per distinct value. Elements with no value form a single “(none)” group.',
      from: 'in',
      default: '',
      visibleIf: (params) => isGroupMode(params),
    },
    {
      /*
       * **The parallelism, delivered through the layer that already has it.**
       *
       * Every backend fans out over neuron ids with a bounded concurrency — `mapWithConcurrency`,
       * six in flight on neuPrint, eight on CATMAID, sixteen for CAVE's chunk graphs — and a loop
       * asking for *one* neuron per pass reduces that to one. So `For Each → Skeletons` at a
       * batch of 1 is about six times slower than the same node outside a loop, which is a
       * property of the division rather than of the work.
       *
       * A batch hands the whole run down at once and gets the concurrency back, while still
       * holding a batch rather than the whole collection — the memory bound the loop exists for,
       * moved from one element to twenty rather than given up.
       *
       * **The default is 1 because there is no safe larger one.** A batch is free when the pass
       * writes a file per neuron: the exporter already names each file by its own id, so twenty
       * SWCs come out of one pass exactly as twenty passes would produce them. It is wrong when
       * the pass *renders* — a viewer handed twenty neurons draws one picture of twenty, not
       * twenty pictures. Those are both stated uses of this node, so the choice is the user's and
       * the card says so on a loop where it would help.
       */
      id: 'batch',
      kind: 'int',
      label: 'Batch size',
      help: 'Elements per pass. Raising it lets the backend fetch several at once — much faster for downloads — at the cost of holding that many at a time. Leave at 1 when each pass renders a picture.',
      default: 1,
      min: 1,
      advanced: true,
      visibleIf: (params) => !isGroupMode(params),
    },
    {
      /*
       * A ceiling somebody sets, rather than one this node imposes. `docs/limits.md`: a limit
       * warns and does not refuse, and the number that would be right here is a property of what
       * the region does per pass — unknowable from a collection's length. So the default is
       * every element, and this is the control for trying a loop on the first ten before
       * committing an afternoon to it.
       */
      id: 'limit',
      kind: 'int',
      label: 'First N',
      help: 'Stop after this many elements — not passes, so it means the same neurons whatever the batch size. 0 runs the whole collection.',
      default: 0,
      min: 0,
      advanced: true,
    },
  ],

  /*
   * A pass-through, on `Select One`'s reasoning: dividing a collection changes how many elements
   * are in it, never the kind or the schema. That is what keeps every column picker downstream
   * of a loop filled in before the loop has ever run.
   */
  inferOutputs: (ctx) => ({ item: ctx.inputs.in ?? T.any() }),

  validate: (ctx) => {
    const input = ctx.inputs.in
    // Unwired says nothing: an empty socket is a graph somebody has not finished, which the
    // scheduler already reports as `blocked`.
    if (!input) return []
    const issues: string[] = []
    if (!isIterableKind(input.kind)) {
      issues.push(
        `For Each iterates a Table, Skeletons or Meshes. A ${input.kind} has no elements to iterate.`,
      )
    }
    if (isGroupMode(ctx.params) && !ctx.column('groupBy')) {
      issues.push('Pick a column to group by, or switch back to iterating elements.')
    }
    return issues
  },

  /**
   * How many passes, and what to call each one. Asked once, before anything iterates.
   *
   * Delegated to `loopPlanFor` rather than written here, because the card and the canvas frame
   * have to answer the same question at edit time and cannot build an `EvalContext` to ask it.
   * Three copies is what that was, and they had already disagreed — see `plan.ts`.
   *
   * Must not throw: the same contract `inferOutputs` has and for a related reason — this decides
   * whether the region runs at all, and a throw would report a collection somebody can see on the
   * wire as a broken node. A count of 0 is a real answer meaning the region does not run.
   */
  loopPlan: (ctx) => loopPlanFor(ctx.params, ctx.input('in'), ctx.column('groupBy')),

  /**
   * Emit the element this pass is on.
   *
   * `ctx.iteration` is absent outside a loop — on the automatic pass, and in any consumer that
   * evaluates this node on its own — and index 0 is the right answer there: it makes the card
   * show the first element rather than nothing, exactly as `Select One` sitting at its default
   * does.
   */
  evaluate: (ctx) => {
    const value = ctx.input('in')
    if (!isIterableValue(value)) {
      throw new Error(
        'For Each iterates a Table, Skeletons or Meshes — this input carries something else.',
      )
    }
    if (isGroupMode(ctx.params) && !ctx.column('groupBy')) {
      throw new Error(
        `No column to group by. Pick one from the input, or switch “For each” back to ${elementNoun(value)}.`,
      )
    }

    /*
     * The same arithmetic the plan used, not a second spelling of it — `loopSliceFor` is the
     * value half of `loopPlanFor` and they live side by side for `tableOps`' reason. Two
     * divisions of one collection is how a pass comes to emit a different element from the one
     * its progress line and its filename name, with nothing anywhere to say so.
     *
     * `ctx.iteration` is absent outside a loop — on the automatic pass, and in any consumer that
     * evaluates this node on its own — and index 0 is the right answer there: the card shows the
     * first element rather than nothing, exactly as `Select One` at its default does.
     */
    const item = loopSliceFor(
      ctx.params,
      value,
      ctx.column('groupBy'),
      ctx.iteration?.index ?? 0,
    )
    return { item: item ?? emptyElement(value) }
  },
})
