/**
 * `Review Suggestions`, in pandas.
 *
 * What is reproducible here is not a computation — it is a **record**. The verdicts are clicks
 * somebody made on the card, stored in a param, and so they travel with the graph: a cell can
 * state them exactly, and a notebook without them would be missing the only thing this node
 * adds. The queue, the filters and the viewer are a reading surface and have nothing to emit.
 *
 * The join is on the **pair**, `end_uid` and `candidateId` together, because a verdict is about
 * a pair: a piece can be on two tips' lists (it can touch the neuron in two places), so joining
 * on the candidate alone would carry one tip's judgement onto another's row.
 */

import { decodeVerdicts } from '../../../packs/seam/reviewQueue'
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
      `${out} = pd.DataFrame({"end_uid": [], "candidateId": [], "verdict": []})`,
      `${tips} = ${tipsIn}.assign(verdict=pd.NA)`,
      ...ctx.note(NOTE),
    ]
  }

  const ends: string[] = []
  const ids: string[] = []
  const said: string[] = []
  for (const [key, verdict] of [...verdicts.entries()].sort()) {
    const at = key.indexOf(':')
    // Keys are built by `verdictKey`; one that is not is a param somebody hand-edited.
    if (at <= 0) continue
    ends.push(key.slice(0, at))
    ids.push(key.slice(at + 1))
    said.push(verdict)
  }

  return [
    `# The verdicts recorded on the card. A record of what somebody decided, not a computation.`,
    `${out} = pd.DataFrame({`,
    `    "end_uid": ${pyList(ends.map(Number))},`,
    `    "candidateId": ${pyList(ids)},`,
    `    "verdict": ${pyList(said)},`,
    `})`,
    ``,
    `# Onto the tips, on the pair: a piece can be on two tips' lists, so the candidate alone`,
    `# would carry one tip's judgement onto another tip's row.`,
    `${tips} = ${tipsIn}.merge(${out}, on=["end_uid", "candidateId"], how="left")`,
    ...ctx.note(NOTE),
  ]
})

const NOTE =
  'The Current and Layers outputs are the card’s own: the pair being looked at, and an ' +
  'annotation layer of it. There is nothing for a notebook to look at.'
