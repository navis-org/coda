/**
 * Collect: gather what a `For Each` produced back into one value.
 *
 * A loop's exit, and the node that lets a loop be composable rather than terminal. `For Each →
 * Skeletons → Collect → 3D View` fetches four hundred neurons one at a time and hands the whole
 * set on; without it the only way out of a loop is a side effect.
 *
 * ## It is a fold, not a special case
 *
 * The scheduler runs this **once per pass**, handing it what it returned last time as
 * `ctx.accumulated`. So `evaluate` is `(accumulated, input) => accumulated'` — an ordinary
 * function of its arguments, deterministic, and testable without a scheduler. The alternative
 * was a node the scheduler assembled the answer *for*, which would have put `stackTables` and
 * `stackGeometry` in `src/core` and inverted the layering for the sake of one call.
 *
 * The consequence worth knowing: the value on this port is a **running total** while the loop is
 * going, and the final one only after the last pass. That is why the region stops here — every
 * node after a Collect reads the finished accumulation, and re-running them per element would be
 * both wrong and expensive.
 *
 * ## What it can stack is what `Stack Tables` and `Stack Neurons` can stack
 *
 * Deliberately those two functions rather than a third: a loop's output is the same union
 * problem those nodes already solved — column sets that differ between passes, geometry that has
 * to agree on units and space. A neuron missing a column in pass 7 fills with null, exactly as
 * `stackTables` documents, because quietly dropping a column in a scientific pipeline is worse
 * than an untidy result.
 *
 * No source column, and that is the one place this departs from them. There, two inputs mean two
 * things worth telling apart; here every pass is the same node and the thing that distinguishes
 * them is already in the data. A column of `First`/`Second` repeated four hundred times says
 * nothing.
 *
 * ## Outside a loop it is a pass-through
 *
 * Not an error. A Collect somebody has wired up before adding the `For Each` above it is a graph
 * halfway through being built, and refusing would put an error on the node that is *not* the one
 * to fix. `validate` says so as a warning instead, which is the same call `Select One` makes
 * about an unwired socket.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { stackTables } from '../lib/tableOps'
import { isGeometryValue, stackGeometry } from '../lib/transformOps'

export const collectNode = registerNode({
  type: 'flow.collect',
  label: 'Collect',
  category: 'utility',
  description: 'Stack what each pass of a For Each produced into one value.',
  guide:
    'The exit of a For Each loop: it folds each pass’s result onto the last, so a loop that ' +
    'fetches one neuron at a time hands on the whole collection. Everything wired after it runs ' +
    'once, on the finished total, which is what makes it the boundary of the loop. Tables stack ' +
    'like Stack Tables and geometry like Stack Neurons, so passes that carry different columns ' +
    'fill with null rather than losing them.',
  // Concatenating a value already in hand onto a running total, once per pass. The cost of a
  // loop is in the region above this, never here.
  cost: 'cheap',
  loop: 'end',
  /*
   * `any` on both ports, on `core.selectOne`'s reasoning: the type system cannot say "a table,
   * skeletons or meshes", so the port says `any` and the refusal is a validation question.
   */
  inputs: [{ id: 'in', label: 'Result', type: T.any() }],
  outputs: [{ id: 'out', label: 'Collected', type: T.any() }],

  /*
   * A pass-through of the *kind*, which is right for both halves of what this does: stacking N
   * tables yields a table with at least the columns any one pass had, and stacking N skeleton
   * collections yields skeletons. The row count changes and nothing downstream is keyed on it.
   */
  inferOutputs: (ctx) => ({ out: ctx.inputs.in ?? T.any() }),

  validate: (ctx) => {
    const input = ctx.inputs.in
    if (!input) return []
    if (input.kind !== 'any' && !isCollectableKind(input.kind)) {
      return [`Collect stacks Tables, Skeletons, Meshes or Points. A ${input.kind} cannot be stacked.`]
    }
    return []
  },

  /**
   * Fold this pass onto the running total.
   *
   * `ctx.accumulated` is absent on the first pass and outside a loop entirely, and both mean the
   * same thing here — there is nothing to fold onto, so the input *is* the answer. That is what
   * makes a Collect on its own a pass-through rather than a node that needs a loop to work.
   */
  evaluate: (ctx) => {
    const value = ctx.input('in')
    if (value === undefined) throw new Error('Nothing is connected to Result')

    const previous = ctx.accumulated?.['out']
    if (previous === undefined) return { out: value }

    if (isTableValue(previous) && isTableValue(value)) {
      return { out: stackTables(previous, value) }
    }
    if (isGeometryValue(previous) && isGeometryValue(value)) {
      return { out: stackGeometry(previous, value) }
    }
    /*
     * Two passes of one loop produced different kinds, which means something upstream is
     * branching on the element rather than transforming it. Named rather than silently keeping
     * the newer one: a Collect that quietly held only the last pass would look like a loop that
     * had not run.
     */
    throw new Error(
      `Pass ${(ctx.iteration?.index ?? 0) + 1} produced ${value.kind} where the passes before ` +
        `it produced ${previous.kind}. Every pass of a loop has to produce the same kind for ` +
        `Collect to stack them.`,
    )
  },
})

/** The kinds `stackTables` or `stackGeometry` can put end to end. */
function isCollectableKind(kind: string): boolean {
  return (
    kind === 'table' ||
    kind === 'neurons' ||
    kind === 'skeletons' ||
    kind === 'meshes' ||
    kind === 'points'
  )
}
