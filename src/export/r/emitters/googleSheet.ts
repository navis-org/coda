/**
 * `Google Sheet`, in readr.
 *
 * The one annotation source that needs no client at all: a sheet shared as "anyone with the link"
 * is a CSV at a URL, so `readr::read_csv` reaches it directly with no credential, no token file and
 * no library specific to it. FlyTable and SeaTable need seatabler and a token, a CAVE table fafbseg
 * and Python. This one is a fetch.
 *
 * The tab is resolved through the same `sheetConfigFrom` and `sheetExportUrl` the node and the
 * Python emitter use — `src/export → src/data` on `neuprintProperty`'s licence, and for its
 * reason: three consumers must agree on which tab a link names, and a second copy of that rule
 * is how a document comes to read a different tab from the card it came from. The *precedence*
 * is half of it: the Tab field overrides the pasted link.
 */

import { googleSheetPlan } from '../../plans/query'
import { rStr, rVector } from '../r'
import { chainAnnotations } from './common'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('annotation.googleSheet', (ctx: EmitContext) => {
  const plan = googleSheetPlan(ctx.params)
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)

  ctx.library('readr')
  ctx.helper('coda_google_sheet')

  const { idColumn, columns } = plan
  const out = ctx.output('annotations')

  return [
    `${out} <- coda_google_sheet(`,
    `  ${rStr(plan.url)},`,
    `  id_column = ${rStr(idColumn)}${columns.length > 0 ? ',' : ''}`,
    ...(columns.length > 0 ? [`  columns = ${rVector(columns)}`] : []),
    `)`,
    ...chainAnnotations(ctx, out),
  ]
})
