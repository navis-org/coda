/**
 * Export helpers: data as CSV, charts as SVG or PNG.
 *
 * Two constraints shape this file:
 *
 *  - Tables can be large. CSV is assembled into chunked string parts handed straight to
 *    `Blob`, rather than one giant concatenation, so a 500k-row export doesn't build a
 *    30MB string in a single allocation.
 *  - Exported SVG must stand alone. On screen the charts inherit `font-family` from a CSS
 *    variable; a serialised copy has no stylesheet, so the resolved font is inlined. All
 *    other colours are already literal hex (the viewers compute them in JS), which is what
 *    makes vector export nearly free here.
 */

import type { MatrixValue, TableValue } from '../core/values'
import type { CodaGraph } from '../core/graph'
import { canExportNotebook } from '../export/canExport'
import type { ExportRefusal } from '../export/canExport'
import { serializeGraph } from '../core/graph'

const SVG_NS = 'http://www.w3.org/2000/svg'
const CSV_CHUNK_ROWS = 2000

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

export function tableToCsvParts(table: TableValue): string[] {
  const columns = table.schema.columns
  const parts: string[] = [`${columns.map((c) => csvCell(c.name)).join(',')}\n`]

  let chunk: string[] = []
  for (let row = 0; row < table.length; row++) {
    const cells: string[] = []
    for (const col of columns) cells.push(csvCell(table.data[col.name]?.[row] ?? null))
    chunk.push(`${cells.join(',')}\n`)
    if (chunk.length >= CSV_CHUNK_ROWS) {
      parts.push(chunk.join(''))
      chunk = []
    }
  }
  if (chunk.length) parts.push(chunk.join(''))
  return parts
}

export function tableToCsv(table: TableValue): string {
  return tableToCsvParts(table).join('')
}

/**
 * Matrices export wide: a corner cell, then one column per column label. That is the shape
 * people paste into a spreadsheet or read back with `pandas.read_csv(index_col=0)`.
 */
export function matrixToCsv(matrix: MatrixValue): string {
  const header = ['', ...matrix.colLabels].map(csvCell).join(',')
  const cols = matrix.colLabels.length
  const lines: string[] = [header]
  for (let r = 0; r < matrix.rowLabels.length; r++) {
    const cells: string[] = [csvCell(matrix.rowLabels[r])]
    for (let c = 0; c < cols; c++) {
      // `String` on a number gives full precision and no locale formatting — a thousands
      // separator here would split the field and corrupt the file.
      cells.push(String(matrix.values[r * cols + c] ?? 0))
    }
    lines.push(cells.join(','))
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe slug. One copy: the graph download and the chart exports had the same two
 * regexes side by side and differed only in what an empty result falls back to.
 */
export function slugify(text: string, fallback: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  )
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // Revoke on the next tick — Safari needs the URL alive through the click handler.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadCsv(parts: string[], filename: string): void {
  triggerDownload(new Blob(parts, { type: 'text/csv;charset=utf-8' }), filename)
}

/**
 * Write several files from one gesture, for the Download node.
 *
 * A network is two CSVs and a skeleton set is one SWC per neuron, so a single press routinely
 * has to produce more than one file. They go out in a plain loop rather than staggered: browsers
 * gate *multiple downloads from one user gesture* behind a permission prompt, and spacing them
 * out with timers loses the gesture and gets them blocked outright instead of asked about once.
 */
export function downloadFiles(
  files: Array<{ name: string; parts: BlobPart[]; mime: string }>,
): void {
  for (const file of files) {
    triggerDownload(new Blob(file.parts, { type: file.mime }), file.name)
  }
}

/**
 * Save the working graph as a file.
 *
 * Here rather than in `persistence.ts`, which is about *storing* a graph — the browser shelf,
 * the autosave, `localStorage`. This is a download, and it shares the Safari revoke-on-next-
 * tick workaround and the slug with every other download in this file; the store cannot reach
 * either without importing the UI layer, which it otherwise never does.
 */
export function downloadGraph(graph: CodaGraph): void {
  const blob = new Blob([serializeGraph(graph)], { type: 'application/json' })
  triggerDownload(blob, `${slugify(graph.meta?.name ?? '', 'untitled')}.coda.json`)
}

/**
 * Save the working graph as a Jupyter notebook.
 *
 * **The exporter is loaded on demand, and that is the point of the `await import`.** Every
 * emitter and every generated Python helper is inert string-building that only runs when
 * somebody asks for a notebook; statically importing it put 54 kB (17.6 kB gzipped) into the
 * main chunk, paid on first paint by everyone. Same doctrine as elkjs, three.js and sigma —
 * verify with `pnpm build` that `python-*.js` stays its own chunk.
 *
 * Async as a consequence, and the refusal is checked *before* the import so a graph that
 * cannot be exported never pays for the download either. Returns the refusal rather than
 * throwing: the one case that refuses is not an error, and the caller has to put it in front
 * of somebody as a sentence they can act on.
 */
export async function downloadNotebook(
  graph: CodaGraph,
  options: { now?: string; appVersion?: string } = {},
): Promise<{ ok: true; warnings: string[] } | ({ ok: false } & ExportRefusal)> {
  const refusal = canExportNotebook(graph)
  if (refusal) return { ok: false, ...refusal }

  const { exportNotebook, serializeNotebook } = await import('../export/python/exporter')
  const result = exportNotebook(graph, options)
  if (!result.ok) return result

  const blob = new Blob([serializeNotebook(result.notebook)], {
    type: 'application/x-ipynb+json',
  })
  triggerDownload(blob, `${slugify(graph.meta?.name ?? '', 'untitled')}.ipynb`)
  return { ok: true, warnings: result.warnings }
}

/**
 * Save the working graph as an R Markdown document.
 *
 * The sibling of `downloadNotebook`, and lazy for the same measured reason — the R emitters are
 * a second chunk of inert string-building nobody loads unless they ask for it. The refusal is
 * checked first and comes from the same `canExportNotebook`, so the two formats cannot disagree
 * about which graphs are exportable.
 */
export async function downloadRmd(
  graph: CodaGraph,
  options: { now?: string; appVersion?: string } = {},
): Promise<{ ok: true; warnings: string[] } | ({ ok: false } & ExportRefusal)> {
  const refusal = canExportNotebook(graph)
  if (refusal) return { ok: false, ...refusal }

  const { exportRmd } = await import('../export/r/exporter')
  const result = exportRmd(graph, options)
  if (!result.ok) return result

  const blob = new Blob([result.source], { type: 'text/markdown' })
  triggerDownload(blob, `${slugify(graph.meta?.name ?? '', 'untitled')}.Rmd`)
  return { ok: true, warnings: result.warnings }
}

/** Filesystem-safe basename from a graph name and a node label. */
export function exportBaseName(graphName: string | undefined, nodeLabel: string): string {
  const graph = slugify(graphName ?? '', '')
  const node = slugify(nodeLabel, 'output')
  return graph ? `${graph}_${node}` : node
}

// ---------------------------------------------------------------------------
// Chart export
// ---------------------------------------------------------------------------

/**
 * Clone an on-screen `<svg>` into a standalone document string: namespaced, explicitly
 * sized, and with the inherited font inlined.
 */
export function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', SVG_NS)
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')

  const width = svg.getAttribute('width') ?? String(svg.clientWidth || 800)
  const height = svg.getAttribute('height') ?? String(svg.clientHeight || 400)
  clone.setAttribute('width', width)
  clone.setAttribute('height', height)
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`)

  // The live chart gets its font from a CSS variable that won't travel with the file.
  const font =
    typeof getComputedStyle === 'function'
      ? getComputedStyle(svg).fontFamily || 'sans-serif'
      : 'sans-serif'
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `text{font-family:${font}}`
  clone.insertBefore(style, clone.firstChild)

  return new XMLSerializer().serializeToString(clone)
}

export function downloadSvg(svg: SVGSVGElement, filename: string): void {
  const blob = new Blob([serializeSvg(svg)], { type: 'image/svg+xml;charset=utf-8' })
  triggerDownload(blob, filename)
}

/**
 * Rasterise the SVG through an offscreen canvas. `scale` 2 gives a retina-quality PNG.
 * Rejects rather than downloading a blank file if the image fails to decode.
 */
export async function downloadPng(
  svg: SVGSVGElement,
  filename: string,
  scale = 2,
): Promise<void> {
  const source = serializeSvg(svg)
  const width = Number(svg.getAttribute('width')) || svg.clientWidth || 800
  const height = Number(svg.getAttribute('height')) || svg.clientHeight || 400

  const svgBlob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)

  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not get a 2D canvas context')
    context.scale(scale, scale)
    context.drawImage(image, 0, 0, width, height)

    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!pngBlob) throw new Error('Canvas produced no PNG data')
    triggerDownload(pngBlob, filename)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', () => reject(new Error('Could not rasterise the chart')))
    image.src = url
  })
}
