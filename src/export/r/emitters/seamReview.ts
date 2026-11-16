/**
 * `Review Suggestions`, in dplyr. The Python emitter's reasoning applies unchanged: what travels
 * is a **record** of what somebody decided, not a computation, and the join is on the pair.
 */

import { ID_COLUMN_NAME } from '../../../core/ids'
import { decodeVerdicts, verdictPair } from '../../../packs/seam/reviewQueue'
import { rVector } from '../r'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('seam:review', (ctx: EmitContext) => {
  const verdicts = decodeVerdicts(ctx.params['verdicts'])
  const tipsIn = ctx.wired('tips')
  const tips = ctx.output('tips')
  const out = ctx.output('verdicts')
  ctx.library('dplyr')

  if (verdicts.size === 0) {
    return [
      `# Nothing judged on this card yet, so the tips pass through with an empty verdict column.`,
      `${out} <- data.frame(${ID_COLUMN_NAME} = character(0), candidateId = character(0), verdict = character(0))`,
      `${tips} <- dplyr::mutate(${tipsIn}, verdict = NA_character_)`,
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
    `${out} <- data.frame(`,
    `  ${ID_COLUMN_NAME} = ${rVector(neurons)},`,
    `  candidateId = ${rVector(ids)},`,
    `  verdict = ${rVector(said)},`,
    `  stringsAsFactors = FALSE`,
    `)`,
    ``,
    `# Onto the tips, on the pair: a verdict is about this piece and this neuron, so the`,
    `# candidate alone would carry one neuron's judgement onto another neuron's tip.`,
    `${tips} <- dplyr::left_join(${tipsIn}, ${out}, by = c("${ID_COLUMN_NAME}", "candidateId"))`,
    ...ctx.note(NOTE),
  ]
})

const NOTE =
  'The Current and Layers outputs are the card’s own: the pair being looked at, and an ' +
  'annotation layer of it. There is nothing for a document to look at.'
