/**
 * The ⤓ in a node card's foot: write this node's result to a file.
 *
 * The counterpart of the viewers' caption-bar button, for every card that has no viewer. A
 * network from Build Network, a roll-up from Group By, a route table from Paths — each was
 * reachable only by wiring a Download node beside it, and a download is a verb people look for
 * on the thing rather than one they expect to have to build a node for.
 *
 * **It goes through `planExport`, which is the whole point.** That is the same function the
 * Download node uses, so a card's ⤓ and a wired Download node cannot disagree about what a
 * value can be written as or what the file is called — and a format added there (GraphML was)
 * appears here with nothing to change.
 *
 * One rule about where it appears: **not on a card that is already drawing a viewer**, which
 * has its own ⤓ an inch above this one. That button is the better of the two there — it can
 * offer the picture as SVG and PNG, which no amount of looking at the value can produce.
 */

import { useMemo } from 'react'

import type { Value } from '../../core/values'
import { DownloadButton } from '../DownloadButton'
import { downloadFiles } from '../export'
import type { ExportFormat } from '../exportValue'
import { formatsFor, planExport } from '../exportValue'

/** Menu row text. `auto`, `svg` and `png` never reach here — `formatsFor` returns none of them. */
const LABEL: Partial<Record<ExportFormat, string>> = {
  csv: 'CSV data',
  graphml: 'GraphML graph',
  json: 'JSON data',
  swc: 'SWC skeletons',
  obj: 'OBJ meshes',
}

export interface ResultDownloadProps {
  value: Value | undefined
  /** Filename stem, without extension. */
  baseName: string
  onError: (message: string) => void
}

export function ResultDownload({ value, baseName, onError }: ResultDownloadProps) {
  const formats = useMemo(() => formatsFor(value), [value])

  const pick = (format: ExportFormat) => {
    const plan = planExport(value, format, baseName)
    if (plan.files.length === 0) throw new Error('Nothing to write yet — run this node first.')
    downloadFiles(plan.files)
    if (plan.truncated) {
      // Not an error — the files were written. But a set silently shorter than the data is the
      // failure the caption idiom exists to avoid, so it is said out loud, in the same words
      // `runDownload` uses for the same cap.
      onError(
        `Wrote the first ${plan.truncated.kept} of ${plan.truncated.total}; a browser stops ` +
          'honouring downloads past about that many.',
      )
    }
  }

  return (
    <DownloadButton
      formats={formats}
      label={(format) => LABEL[format] ?? format.toUpperCase()}
      short={(format) => format.toUpperCase()}
      onPick={pick}
      compact
      onError={onError}
    />
  )
}
