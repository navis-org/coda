/**
 * `Review Suggestions`, in pandas.
 *
 * What is reproducible here is not a computation — it is a **record**. The verdicts are clicks
 * somebody made on the card, stored in a param, and so they travel with the graph: a cell can
 * state them exactly, and a notebook without them would be missing the only thing this node
 * adds. The queue, the filters and the viewer are a reading surface and have nothing to emit.
 *
 * The join is on the **pair**, the neuron and the piece together (`verdictKey`): a verdict is
 * about whether this piece belongs to this neuron, on every tip the piece is listed at. A key of
 * the old `end_uid` shape is no verdict on anything (`verdictPair`) and is left out.
 */

import { ID_COLUMN_NAME } from '../../../core/ids'
import { decodeVerdicts, verdictPair } from '../../../packs/seam/reviewQueue'
import { pyList } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('seam:review', (ctx: EmitContext) => {
  const verdicts = decodeVerdicts(ctx.params['verdicts'])
  const tipsIn = ctx.wired('tips')
  const tips = ctx.output('tips')
  const out = ctx.output('verdicts')
  ctx.require('pandas')

  if (verdicts.size === 0) {
    return [
      `# Nothing judged on this card yet, so the tips pass through with an empty verdict column.`,
      `${out} = pd.DataFrame({"${ID_COLUMN_NAME}": [], "candidateId": [], "verdict": []})`,
      `${tips} = ${tipsIn}.assign(verdict=pd.NA)`,
      ...ctx.note(NOTE),
    ]
  }

  const neurons: string[] = []
  const ids: string[] = []
  const said: string[] = []
  for (const [key, verdict] of [...verdicts.entries()].sort()) {
    const pair = verdictPair(key)
    if (!pair) continue
    neurons.push(pair.neuronId)
    ids.push(pair.candidateId)
    said.push(verdict)
  }

  return [
    `# The verdicts recorded on the card. A record of what somebody decided, not a computation.`,
    `${out} = pd.DataFrame({`,
    `    "${ID_COLUMN_NAME}": ${pyList(neurons)},`,
    `    "candidateId": ${pyList(ids)},`,
    `    "verdict": ${pyList(said)},`,
    `})`,
    ``,
    `# Onto the tips, on the pair: a verdict is about this piece and this neuron, so the`,
    `# candidate alone would carry one neuron's judgement onto another neuron's tip.`,
    `${tips} = ${tipsIn}.merge(${out}, on=["${ID_COLUMN_NAME}", "candidateId"], how="left")`,
    ...ctx.note(NOTE),
  ]
})

const NOTE =
  'The Current and Layers outputs are the card’s own: the pair being looked at, and an ' +
  'annotation layer of it. There is nothing for a notebook to look at.'
