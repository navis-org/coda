/**
 * The download / expand controls that sit in every viewer's caption bar.
 *
 * Formats are declared by the viewer, not assumed here: a table offers CSV, a chart offers
 * CSV plus SVG and PNG, and the network adds GraphML. When only one format is available the
 * button downloads directly instead of opening a one-item menu.
 */

import { useContext, useEffect, useRef } from 'react'

import { DownloadButton } from '../DownloadButton'
import { downloadCsv, downloadPng, downloadSvg, downloadText } from '../export'
import { GRAPHML_MIME } from '../exportValue'
import { ExportNodeContext, registerExportSource } from './exportRegistry'

export interface ExportSource {
  /** Called lazily — a large CSV is only built when the user actually asks for it. */
  csv?: () => string[]
  /**
   * The whole graph as one GraphML document, for a viewer whose value is a network.
   *
   * Its own accessor rather than a second `csv`, because the two answer different questions: a
   * spreadsheet wants the node table, and Cytoscape wants both halves with their dtypes. Built
   * lazily for the same reason as the CSV.
   */
  graphml?: () => string[]
  /** Live chart element, for vector and raster export. */
  svg?: () => SVGSVGElement | null
}

export interface ViewerActionsProps {
  /** Filename stem, without extension. */
  baseName: string
  source: ExportSource
  /** Provided when the viewer can be enlarged; omitted when it already is. */
  onExpand?: () => void
  /** Hide labels and shrink hit areas for the in-node preview. */
  compact?: boolean
  onError?: (message: string) => void
}

type Format = 'csv' | 'graphml' | 'svg' | 'png'

const FORMAT_LABEL: Record<Format, string> = {
  csv: 'CSV data',
  graphml: 'GraphML graph',
  svg: 'SVG vector',
  png: 'PNG image',
}

/** What the single-format button prints beside the arrow. */
const FORMAT_SHORT: Record<Format, string> = {
  csv: 'CSV',
  graphml: 'GraphML',
  svg: 'SVG',
  png: 'PNG',
}

export function ViewerActions({
  baseName,
  source,
  onExpand,
  compact = false,
  onError,
}: ViewerActionsProps) {
  /*
   * Publish this viewer's export source so the Download node can reach its picture.
   *
   * Through a ref, because `source` is rebuilt on every render of the viewer above and
   * registering the object itself would churn the map on every frame of a pan. The stable
   * wrapper closes over the ref, so what the registry hands out is always current.
   */
  const nodeId = useContext(ExportNodeContext)
  const sourceRef = useRef(source)
  sourceRef.current = source
  useEffect(() => {
    if (!nodeId) return
    return registerExportSource(nodeId, {
      csv: () => sourceRef.current.csv?.(),
      graphml: () => sourceRef.current.graphml?.(),
      svg: () => sourceRef.current.svg?.() ?? null,
    } as ExportSource)
  }, [nodeId])

  const formats: Format[] = []
  if (source.csv) formats.push('csv')
  if (source.graphml) formats.push('graphml')
  if (source.svg) formats.push('svg', 'png')

  // Throws rather than reports: `DownloadButton` owns the busy state and the notice channel,
  // so a viewer whose chart is not rendered yet says so through the same path a failed
  // rasterisation does.
  const run = async (format: Format) => {
    if (format === 'csv') {
      const parts = source.csv?.()
      if (!parts) throw new Error('Nothing to export')
      downloadCsv(parts, `${baseName}.csv`)
      return
    }
    if (format === 'graphml') {
      const parts = source.graphml?.()
      if (!parts) throw new Error('Nothing to export')
      downloadText(parts, `${baseName}.graphml`, GRAPHML_MIME)
      return
    }
    const svg = source.svg?.()
    if (!svg) throw new Error('Chart is not rendered yet')
    if (format === 'svg') {
      downloadSvg(svg, `${baseName}.svg`)
      return
    }
    await downloadPng(svg, `${baseName}.png`)
  }

  return (
    <div className="viewer-actions">
      <DownloadButton
        formats={formats}
        label={(format) => FORMAT_LABEL[format]}
        short={(format) => FORMAT_SHORT[format]}
        onPick={run}
        compact={compact}
        {...(onError ? { onError } : {})}
      />

      {onExpand && (
        <button
          type="button"
          className="viewer-actions__btn nodrag"
          title="Expand (double-click the preview)"
          aria-label="Expand viewer"
          onClick={onExpand}
        >
          ⤢
        </button>
      )}
    </div>
  )
}
