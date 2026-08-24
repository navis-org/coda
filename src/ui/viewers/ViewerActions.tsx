/**
 * The download / expand controls that sit in every viewer's caption bar.
 *
 * Formats are declared by the viewer, not assumed here: a table offers CSV, a chart offers
 * CSV plus SVG and PNG, and the network adds GraphML. When only one format is available the
 * button downloads directly instead of opening a one-item menu.
 */

import { useContext, useEffect, useRef } from 'react'

import { DownloadButton } from '../DownloadButton'
import { downloadCsv, downloadDataUrl, downloadPng, downloadSvg, downloadText } from '../export'
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
  /**
   * The current view as a standalone `<svg>`, for vector and raster export.
   *
   * The live element where the picture is in the DOM (the bar chart, the dendrogram), and one
   * synthesised on demand where it is not — the network is WebGL, and the scatter and the
   * heatmap paint to a canvas, so all three rebuild the view from the spec they drew it from.
   * Either way it is the picture *as it stands*, which is what makes the exported file match
   * the screen rather than being a second drawing of the same data.
   */
  svg?: () => SVGSVGElement | null
  /**
   * The current frame as a `data:` URL, for a viewer whose picture is a WebGL buffer.
   *
   * Separate from `svg` because it is not a shortcut past it — the 3D scene has no vector
   * form to offer. Everything else here renders to SVG and rasterises *that*, which is why
   * those viewers get SVG and PNG from one accessor; this one can only ever give PNG.
   *
   * It must render and read back inside a single task (see `downloadDataUrl`), so it returns
   * a finished string rather than a canvas somebody else might read a frame too late.
   */
  png?: (options?: { transparent?: boolean }) => string | null
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

type Format = 'csv' | 'graphml' | 'svg' | 'png' | 'pngAlpha'

const FORMAT_LABEL: Record<Format, string> = {
  csv: 'CSV data',
  graphml: 'GraphML graph',
  svg: 'SVG vector',
  png: 'PNG image',
  pngAlpha: 'PNG, no background',
}

/** What the single-format button prints beside the arrow. */
const FORMAT_SHORT: Record<Format, string> = {
  csv: 'CSV',
  graphml: 'GraphML',
  svg: 'SVG',
  png: 'PNG',
  pngAlpha: 'PNG',
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
    /*
     * Only the accessors this viewer actually has, which is what makes *presence* mean
     * something to a reader. The Download node has to ask "could this node give me a PNG"
     * without paying for one — a 3D scene answers that question by rendering a frame and
     * reading the buffer back — so the cheap check is whether the key is here at all. Relaying
     * all four unconditionally made every viewer look capable of everything.
     */
    const current = sourceRef.current
    const relay: ExportSource = {}
    if (current.csv) relay.csv = () => sourceRef.current.csv?.() ?? []
    if (current.graphml) relay.graphml = () => sourceRef.current.graphml?.() ?? []
    if (current.svg) relay.svg = () => sourceRef.current.svg?.() ?? null
    if (current.png) relay.png = (options) => sourceRef.current.png?.(options) ?? null
    return registerExportSource(nodeId, relay)
  }, [nodeId])

  const formats: Format[] = []
  if (source.csv) formats.push('csv')
  if (source.graphml) formats.push('graphml')
  if (source.svg) formats.push('svg', 'png')
  /*
   * The cut-out is offered only by the read-back path, and that is not an omission. A viewer
   * that rasterises its own SVG has no background painted into it in the first place — what it
   * writes is already only the marks. A WebGL frame is a *cleared* buffer, so "no background"
   * there is a real second thing to ask for.
   */
  else if (source.png) formats.push('png', 'pngAlpha')

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
    // A viewer with no vector form takes its own read-back path; one with both never reaches
    // here for PNG through `png`, because `svg` already claimed the format above.
    if (!source.svg && source.png) {
      const transparent = format === 'pngAlpha'
      const dataUrl = source.png({ transparent })
      if (!dataUrl) throw new Error('Scene is not rendered yet')
      downloadDataUrl(dataUrl, `${baseName}${transparent ? '-cutout' : ''}.png`)
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
