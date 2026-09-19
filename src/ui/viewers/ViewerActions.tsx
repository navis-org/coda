/**
 * The download / expand controls that sit in every viewer's caption bar.
 *
 * Formats are declared by the viewer, not assumed here: a table offers CSV, a chart offers
 * CSV plus SVG and PNG, and the network adds GraphML and CX2. When only one format is available the
 * button downloads directly instead of opening a one-item menu.
 */

import { useContext, useEffect, useRef } from 'react'

import { DownloadButton } from '../DownloadButton'
import {
  downloadCsv,
  downloadDataUrl,
  downloadFiles,
  downloadPng,
  downloadSvg,
  downloadText,
} from '../export'
import type { ExportFile } from '../exportValue'
import { EXPORT_LABEL, GRAPHML_MIME } from '../exportValue'
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
   * The graph as a CX2 file for Cytoscape Web, `name` being both its stem and its name there.
   *
   * Unlike `graphml` this carries the **layout on screen**: Cytoscape Web opens a file with
   * positions as it is and lays out one without, and the arrangement somebody was looking at is
   * the thing worth taking across. Which is why it is the viewer's accessor at all — the Download
   * node writes the same file from a wire, where there is no layout, and so writes none. Files
   * rather than parts, from `cx2Files`, so the name and type are the ones `planExport` writes.
   */
  cx2?: (name: string) => ExportFile[]
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
  /**
   * Further tables a viewer can hand over as CSV, each a row of its own in the download menu.
   *
   * For a card holding more than one table worth taking away — NeuronBridge's lines on screen
   * *and* the matches pinned across every neuron. Card-only: not relayed to the Download node, whose
   * "could this node give me a CSV" question is about the one `csv` above.
   */
  tables?: readonly ExportTable[]
}

/** One extra table in a viewer's download menu. */
export interface ExportTable {
  /** Stable key, and the filename suffix: `<baseName>-<id>.csv`. */
  id: string
  /** Menu row text, e.g. `Pinned matches (CSV)`. */
  label: string
  /** Built lazily, like `csv`; throw to say why there is nothing (the notice channel shows it). */
  csv: () => string[]
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

/**
 * One row of the download menu: what it says, the extension it names, and what it writes.
 *
 * Built once per render as a map, so every callback `DownloadButton` asks — label, short name,
 * extension, the download itself — is one lookup. A row's key is only a key: the extension is its
 * own field, which is what used to be read off the key and printed `.pngAlpha` and `.table:pinned`.
 */
interface ExportRow {
  label: string
  /** What the single-format button prints beside the arrow. */
  short: string
  extension: string
  run: () => void | Promise<void>
}

/** The rows a source offers, in menu order. Throws from `run`, never here: see `DownloadButton`. */
function exportRows(source: ExportSource, baseName: string): Map<string, ExportRow> {
  const rows = new Map<string, ExportRow>()
  const { csv, graphml, cx2, svg, png } = source
  if (csv) {
    rows.set('csv', {
      label: EXPORT_LABEL.csv,
      short: 'CSV',
      extension: 'csv',
      run: () => downloadCsv(csv(), `${baseName}.csv`),
    })
  }
  if (graphml) {
    rows.set('graphml', {
      label: EXPORT_LABEL.graphml,
      short: 'GraphML',
      extension: 'graphml',
      run: () => downloadText(graphml(), `${baseName}.graphml`, GRAPHML_MIME),
    })
  }
  if (cx2) {
    rows.set('cx2', {
      label: EXPORT_LABEL.cx2,
      short: 'CX2',
      extension: 'cx2',
      run: () => downloadFiles(cx2(baseName)),
    })
  }
  if (svg) {
    // Throws rather than reports: `DownloadButton` owns the busy state and the notice channel,
    // so a viewer whose chart is not rendered yet says so through the same path a failed
    // rasterisation does.
    const rendered = () => {
      const element = svg()
      if (!element) throw new Error('Chart is not rendered yet')
      return element
    }
    rows.set('svg', {
      label: 'SVG vector',
      short: 'SVG',
      extension: 'svg',
      run: () => downloadSvg(rendered(), `${baseName}.svg`),
    })
    rows.set('png', {
      label: 'PNG image',
      short: 'PNG',
      extension: 'png',
      run: () => downloadPng(rendered(), `${baseName}.png`),
    })
  } else if (png) {
    /*
     * The cut-out is offered only by the read-back path, and that is not an omission. A viewer
     * that rasterises its own SVG has no background painted into it in the first place — what it
     * writes is already only the marks. A WebGL frame is a *cleared* buffer, so "no background"
     * there is a real second thing to ask for.
     */
    const frame = (transparent: boolean, name: string) => {
      const dataUrl = png({ transparent })
      if (!dataUrl) throw new Error('Scene is not rendered yet')
      downloadDataUrl(dataUrl, name)
    }
    rows.set('png', {
      label: 'PNG image',
      short: 'PNG',
      extension: 'png',
      run: () => frame(false, `${baseName}.png`),
    })
    rows.set('pngAlpha', {
      label: 'PNG, no background',
      short: 'PNG',
      extension: 'png',
      run: () => frame(true, `${baseName}-cutout.png`),
    })
  }
  for (const table of source.tables ?? []) {
    rows.set(`table:${table.id}`, {
      label: table.label,
      short: 'CSV',
      extension: 'csv',
      run: () => downloadCsv(table.csv(), `${baseName}-${table.id}.csv`),
    })
  }
  return rows
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

  const rows = exportRows(source, baseName)

  return (
    <div className="viewer-actions">
      <DownloadButton
        formats={[...rows.keys()]}
        label={(format) => rows.get(format)!.label}
        short={(format) => rows.get(format)!.short}
        onPick={(format) => rows.get(format)!.run()}
        extension={(format) => rows.get(format)!.extension}
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
