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
 * ## The rename is declared, not spelled
 *
 * Both nodes had a fixed pair of label params called `topLabel` and `bottomLabel`, and the ids
 * are `label{n}` now like every other repeated param. Nothing here suffixes them by hand:
 * `repeatParams` supplies the id and `ParamBase.formerId` carries the stored value across, which
 * is `PortGroupDef.formerIds` for the *ports* one layer over. Written as a private id scheme
 * instead — `topLabel` kept at index 1 and `label3` upwards — this module would have had to
 * export it and both node files, both emitters and the wizard would have had to import it, for a
 * hole in `repeatParams`' scheme that no future rename could reuse.
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
import { stackInputName } from './tableOps'
import { repeatParamId, repeatParams } from './repeatParams'

/**
 * How many inputs one stack may take.
 *
 * Unlike `Match Cell Types`' four, this is a statement about the *card* rather than about the
 * science or the machine: stacking is buffer concatenation with no fetch behind it, so nothing
 * here gets expensive, and the limit is how many sockets fit on a node somebody has to wire. The
 * wizard never asks for more than `maxWizardDatasets()` (four, read off the comparison nodes),
 * so this is deliberately above that rather than equal to it — a hand-built graph combining six
 * datasets is a reasonable thing to want and needs no permission from the wizard. That ordering
 * is asserted in `wizard.test.ts`: derived as it is, raising a comparison node past this would
 * have `buildWorkflow` emit an `inputCount` the stack clamps, dropping datasets in silence.
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

/** The label param at one index. `repeatParams`' scheme, with no exceptions in it. */
export function stackLabelParamId(index: number): string {
  return repeatParamId('label', index)
}

/**
 * The ids the first two labels answered to before the pair became a repeat.
 *
 * Length 2 because that is how many sockets both nodes had; it is a record of history, not a
 * scheme, and nothing should be appended to it. `registerNode` refuses a `formerId` that collides
 * with a live param id, so this cannot quietly start shadowing something.
 */
const FORMER_LABEL_IDS = ['topLabel', 'bottomLabel'] as const

/**
 * The per-input label params, hidden past the arity **and** while nothing names a column.
 *
 * `repeatParams` supplies the id and the arity `visibleIf`; the source-column condition is
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
      const formerId = FORMER_LABEL_IDS[slot.index - 1]
      const formerDefault = formerDefaults[slot.index - 1]
      return [
        {
          id: slot.id('label'),
          kind: 'string',
          label: `${stackInputName(slot.index)} label`,
          default: stackInputName(slot.index),
          advanced: true,
          ...(formerId !== undefined ? { formerId } : {}),
          ...(formerDefault !== undefined ? { absentMeans: formerDefault } : {}),
          visibleIf: (params: ParamValues) => stackSourceColumn(params) !== '',
        },
      ]
    },
  })
}

/**
 * The trimmed source column, which is what decides whether one is added at all.
 *
 * Here rather than at each of the six call sites for that reason: `'  '` is not a column name,
 * and a reader that skipped the trim would add one anyway.
 */
export function stackSourceColumn(params: ParamValues): string {
  return String(params.sourceColumn ?? '').trim()
}

/**
 * The labels, in socket order — read by `evaluate` and the two emitters, and by nothing on the
 * inference path.
 *
 * Split from `stackSourceColumn` deliberately: `inferOutputs` and `validate` need only the column
 * name, `stackColumns` never looks at a label, and this allocates an array per call on the pass
 * that runs on **every graph mutation**. Measured at 196 ns of a 976 ns `inferOutputs`, entirely
 * discarded. So the schema half asks for what it reads and the value half asks for the rest.
 *
 * `count` comes from `ctx.inputPorts().length` rather than from the param, so the labels are as
 * long as the sockets actually are — `countIn` has already clamped a stored count written by a
 * build with a different range, and reading the raw param here would undo that.
 *
 * Values are passed through verbatim, blanks included: `stackLabelAt` owns what an unnamed input
 * is called, and defaulting here as well would put that rule in two layers with only one of them
 * able to see a *cleared* field.
 */
export function readStackOptions(params: ParamValues, count: number): StackOptions {
  const labels = new Array<string>(count)
  for (let i = 0; i < count; i++) labels[i] = String(params[stackLabelParamId(i + 1)] ?? '')
  return { sourceColumn: stackSourceColumn(params), labels }
}
