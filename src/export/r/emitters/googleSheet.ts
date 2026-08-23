/**
 * `Google Sheet`, in readr.
 *
 * The only annotation source with an emitter in **both** languages, and the reason is that it
 * needs no client at all: a sheet shared as "anyone with the link" is a CSV at a URL, so
 * `readr::read_csv` reaches it directly with no credential, no token file and no library
 * specific to it. FlyTable is `sea-serpent`, which has no natverse counterpart; a CAVE table is
 * caveclient, which R refuses the whole graph over. This one is a fetch.
 *
 * The tab is resolved through the same `sheetConfigFrom` and `sheetExportUrl` the node and the
 * Python emitter use — `src/export → src/data` on `neuprintProperty`'s licence, and for its
 * reason: three consumers must agree on which tab a link names, and a second copy of that rule
 * is how a document comes to read a different tab from the card it came from. The *precedence*
 * is half of it: the Tab field overrides the pasted link.
 */

import { sheetConfigFrom, sheetExportUrl } from '../../../data/annotations'
import { namedColumns } from '../../../data/annotations/types'
import { rStr, rVector } from '../r'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

registerEmitter('annotation.googleSheet', (ctx: EmitContext) => {
  const { config, error } = sheetConfigFrom(ctx.params)
  // The sentence `validate` puts on the card and `evaluate` throws, rather than a fourth
  // wording of one refusal.
  if (error) return ctx.todo(error)
  if (!config) return ctx.todo('This node names no sheet.')

  ctx.library('readr')
  ctx.helper('coda_google_sheet')

  const { idColumn } = config
  const columns = namedColumns(config.columns, idColumn)
  const out = ctx.output('annotations')

  const lines: string[] = [
    `${out} <- coda_google_sheet(`,
    `  ${rStr(sheetExportUrl(config.documentId, config.gid))},`,
    `  id_column = ${rStr(idColumn)}${columns.length > 0 ? ',' : ''}`,
    ...(columns.length > 0 ? [`  columns = ${rVector(columns)}`] : []),
    `)`,
  ]

  const upstream = ctx.input('annotations')
  if (upstream) {
    ctx.library('dplyr')
    ctx.helper('coda_join_annotations')
    lines.push(`${out} <- coda_join_annotations(${upstream}, ${out})`)
  }
  return lines
})
