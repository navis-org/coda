/**
 * The param shape both Stack nodes share, in one place.
 *
 * `Stack Tables` and `Stack Neurons` are the same control surface over two different value
 * kinds: how many inputs, what column names them, and what each one is called in that column.
 * They were written out twice and had already drifted in the way this module exists to prevent —
 * `stackNeurons.ts` records it: the params declared `First`/`Second` while the reader that
 * fills in an absent one said `Top`/`Bottom`, so which name a row ended up carrying depended on
 * whether the param had ever been written.
 *
 * ## The first two ids are historical, and that is the point
 *
 * Both nodes had a fixed pair of label params called `topLabel` and `bottomLabel`. Suffixing
 * every index uniformly would have given `label1 … labelN` and quietly dropped a name somebody
 * typed: `normalizeParams` reads only declared params, so an undeclared `topLabel` is not
 * migrated, it is ignored. So index 1 and 2 keep the ids they have always had and only index 3
 * upwards is suffixed. The ids are not user-visible; the labels are, and those are uniform.
 *
 * `PortGroupDef.formerIds` is the same argument one layer over, for the *ports*.
 *
 * ## The defaults moved, so the old ones are `absentMeans`
 *
 * A stack's inputs are `Input 1 … Input N` now, at every arity — `Top`, `Bottom`, `Input 3` is
 * not a vocabulary. But a saved graph that never touched its labels was emitting `Top`/`Bottom`
 * (or `First`/`Second`, `Stack Neurons` having chosen differently), and a new default would
 * silently rewrite a column of *data* in it. That is exactly `ParamBase.absentMeans`' case:
 * absence and the declared default are different answers, so absence is recorded on load and the
 * new default reaches new nodes only. `normalizeParams` reads an absent param as its default, so
 * writing the old value in on load leaves this param's contribution to the provenance key exactly
 * where it was — the node re-runs on first load anyway, `inputCount` being a param it did not
 * have, and that is a cheap concatenation rather than a fetch.
 */

import type { NumberParam, ParamDef, ParamValues } from '../../core/node'
import type { StackOptions } from './tableOps'
import { stackLabelAt } from './tableOps'
import { repeatParams } from './repeatParams'

/**
 * How many inputs one stack may take.
 *
 * Unlike `Match Cell Types`' four, this is a statement about the *card* rather than about the
 * science or the machine: stacking is buffer concatenation with no fetch behind it, so nothing
 * here gets expensive, and the limit is how many sockets fit on a node somebody has to wire. The
 * wizard never asks for more than `maxWizardDatasets()` (four, read off the comparison nodes),
 * so this is deliberately above that rather than equal to it — a hand-built graph combining six
 * datasets is a reasonable thing to want and needs no permission from the wizard.
 */
export const STACK_MAX_INPUTS = 8

/**
 * The arity, declared once and shared by **both** nodes.
 *
 * One object rather than one per node, which `registerNode` is happy with (it only reads the
 * range off it) and which buys the property that the two nodes cannot come to have different
 * ceilings — a graph that stacks six tables and six collections should not stop being buildable
 * halfway along. `repeatParams` and `PortGroupDef.repeat` both read this same declaration, which
 * is the copy `core/ports.ts` removed from `PortGroupDef`.
 */
export const stackCountParam = {
  id: 'inputCount',
  kind: 'int',
  label: 'Inputs',
  help: 'How many inputs to combine, end to end. Each gets its own socket.',
  default: 2,
  min: 2,
  max: STACK_MAX_INPUTS,
} as const satisfies NumberParam

/**
 * The label param ids the first indices keep — see the header.
 *
 * Length 2 because that is how many sockets both nodes had before they were variadic; it is a
 * record of history, not a scheme, and nothing should be appended to it.
 */
const FORMER_LABEL_IDS = ['topLabel', 'bottomLabel'] as const

/** The label param at one index: `topLabel`, `bottomLabel`, `label3`, `label4` … */
export function stackLabelParamId(index: number): string {
  return FORMER_LABEL_IDS[index - 1] ?? `label${index}`
}

/**
 * The per-input label params, hidden past the arity **and** while nothing names a column.
 *
 * `repeatParams` supplies the id suffix and the arity `visibleIf`; the source-column condition is
 * returned by the builder and ANDed onto it there. Both halves matter to invariant 4: a label for
 * an input that is not connected, or for a stack that is not labelling anything, is a control
 * nobody can see whose edits would still restale every node downstream.
 *
 * `formerDefaults` is what each of the first two labels *used* to default to on this node — see
 * the header on why that is `absentMeans` rather than the default itself.
 */
export function stackLabelParams(formerDefaults: readonly [string, string]): ParamDef[] {
  return repeatParams({
    count: stackCountParam,
    build: (slot) => {
      const former = formerDefaults[slot.index - 1]
      return [
        {
          id: stackLabelParamId(slot.index),
          kind: 'string',
          label: `Input ${slot.index} label`,
          default: stackLabelAt(undefined, slot.index),
          advanced: true,
          ...(former !== undefined ? { absentMeans: former } : {}),
          visibleIf: (params: ParamValues) => String(params.sourceColumn ?? '').trim() !== '',
        },
      ]
    },
  })
}

/**
 * One reader for the schema half and the value half, so they cannot disagree about a name.
 *
 * `count` comes from `ctx.inputPorts().length` rather than from the param, so the labels are as
 * long as the sockets actually are — `countIn` has already clamped a stored count that was
 * written by a build with a different range, and reading the raw param here would undo that.
 *
 * The trim on the source column is the part that decides whether a column is added at all, which
 * is why it is here rather than at each of the four call sites.
 */
export function readStackOptions(params: ParamValues, count: number): StackOptions {
  return {
    sourceColumn: String(params.sourceColumn ?? '').trim(),
    labels: Array.from({ length: count }, (_, i) => {
      const stored = params[stackLabelParamId(i + 1)]
      return stored === undefined ? stackLabelAt(undefined, i + 1) : String(stored)
    }),
  }
}
