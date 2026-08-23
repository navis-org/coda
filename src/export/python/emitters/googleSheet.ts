/**
 * `Google Sheet`, in pandas.
 *
 * The one annotation source whose translation is genuinely a line of code: a sheet shared as
 * "anyone with the link" is a CSV at a URL, so there is no client library, no credential and
 * nothing to authenticate — `pd.read_csv` reaches it directly, and the notebook a reader is
 * handed does exactly what the canvas did.
 *
 * **The tab is resolved here rather than re-derived**, through the same `sheetConfigFrom` and
 * `sheetExportUrl` the node and the provider use. `src/export → src/data` is a licensed import —
 * `neuprintProperty` is the precedent — and it is licensed for this reason: three consumers have
 * to agree on which tab a link names, and a second copy of that rule is how the notebook comes
 * to read a different tab from the card it was exported from. Note the *precedence* is half of
 * it: the Tab field overrides the pasted link, and writing that out per consumer leaves the
 * failure the sharing was for still reachable.
 *
 * It is the **only** annotation source with an emitter in both languages, which is not a gap in
 * the other two: FlyTable is `sea-serpent`, which has no natverse counterpart, and a CAVE table
 * is caveclient, which R refuses the whole graph over. This one needs neither.
 */

import { sheetConfigFrom, sheetExportUrl } from '../../../data/annotations'
import { namedColumns } from '../../../data/annotations/types'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('annotation.googleSheet', (ctx: EmitContext) => {
  const { config, error } = sheetConfigFrom(ctx.params)
  // The same sentence `validate` puts on the card and `evaluate` throws, rather than a fourth
  // wording of one refusal.
  if (error) return ctx.todo(error)
  if (!config) return ctx.todo('This node names no sheet.')

  ctx.require('pandas')
  ctx.helper('coda_google_sheet')

  const { idColumn } = config
  const columns = namedColumns(config.columns, idColumn)
  const out = ctx.output('annotations')

  const lines: string[] = [
    `${out} = coda_google_sheet(`,
    `    ${pyStr(sheetExportUrl(config.documentId, config.gid))},`,
    `    id_column=${pyStr(idColumn)},`,
    ...(columns.length > 0 ? [`    columns=${pyList(columns)},`] : []),
    `)`,
  ]

  const upstream = ctx.input('annotations')
  if (upstream) {
    ctx.helper('coda_join_annotations')
    lines.push(`${out} = coda_join_annotations(${upstream}, ${out})`)
  }
  return lines
})
