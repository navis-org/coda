/**
 * What a Stack export does, before either language says it — for `core.stack` and
 * `neuron.stack`, which share both the decision and, on points, the code.
 *
 * `core.stack` always stacks frames. `neuron.stack` stacks neuron objects, except on points: a
 * point cloud is a data frame in both translations, so its stack is `core.stack`'s code. Read off
 * the *first* input's type, which is the one `checkStackable` measures the rest against, and
 * unknown takes the neuron branch, which is what that node is overwhelmingly used for.
 *
 * The sockets come through `inputPorts` rather than a hand-built `in1 … inN`, so the exporter and
 * the canvas read one statement of both the id rule and the clamp on a stored arity — `portIdAt`'s
 * reason, and the one that bites here is a `.coda.json` written by a build whose max was higher.
 * The labels come through `readStackOptions` and `stackLabelAt`, the node's own readers, so an
 * unnamed input is called what the canvas calls it.
 */

import { inputPorts } from '../../core/ports'
import { readStackOptions } from '../../nodes/lib/stackParams'
import { stackLabelAt } from '../../nodes/lib/tableOps'
import type { NeutralContext } from '../neutral'

/**
 * Whether it stacks frames or neuron objects, the variable on each socket in order, and the
 * source column with each input's label in that column, when one is asked for.
 */
export interface StackPlan {
  as: 'frames' | 'neurons'
  inputs: string[]
  /** Absent when no source column is asked for; `labels` is aligned with `inputs`. */
  source?: { column: string; labels: string[] }
}

type StackContext = Pick<NeutralContext, 'def' | 'node' | 'wired' | 'inputType' | 'params'>

export function stackPlan(ctx: StackContext, geometry: boolean): StackPlan {
  const ports = inputPorts(ctx.def, ctx.node.params)
  const inputs = ports.map((port) => ctx.wired(port.id))
  const options = readStackOptions(ctx.params, inputs.length)
  const column = options.sourceColumn
  const points = geometry && ctx.inputType(ports[0]?.id ?? '')?.kind === 'points'
  return {
    as: geometry && !points ? 'neurons' : 'frames',
    inputs,
    source: column
      ? { column, labels: inputs.map((_, i) => stackLabelAt(options.labels, i + 1)) }
      : undefined,
  }
}
