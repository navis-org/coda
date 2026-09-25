/**
 * The Cortex gallery's wall: cells projected into the cortical frame, laid out in rows, drawn.
 *
 * Kept free of React so the arithmetic — how wide a cell is, where it lands — is testable in
 * jsdom, which lays nothing out. What a cell looks like is decided here too, by the frame and the
 * skeleton's own compartment labels, never by anything computed: an unlabelled point draws in the
 * neutral ink rather than being guessed at.
 */

import type { SkeletonGeometry } from '../../core/values'
import { quantileSorted } from '../../core/stats'
import type { ColumnWidths } from '../../packs/cortex/cells'
import type { CorticalFrame } from '../../packs/cortex/frames'
import { projector } from '../../packs/cortex/frames'
import type { Mode } from '../colors'
import { CHART_INK } from '../colors'
import { axonDendriteInk } from '../compartmentInk'
import { canvasFont } from '../viewers/canvas2d'

/** Which ink a segment takes, from the SWC code of its child point. */
export type Ink = 'axon' | 'dendrite' | 'neutral'

/** One skeleton in the frame, projected once: segments in µm by ink, the soma, the extent. */
export interface CellGeometry {
  /** (lateral, depth) of each segment's two ends, µm, relative to the soma laterally. */
  segments: Record<Ink, Float32Array>
  /** The soma's depth below the pia, µm. Laterally it is 0 by construction. */
  somaDepth: number
  /** Lateral extent either side of the soma, µm (`left` ≤ 0 ≤ `right`). */
  left: number
  right: number
}

const projected = new WeakMap<SkeletonGeometry, CellGeometry>()

const inkOf = (code: number): Ink =>
  code === 2 ? 'axon' : code === 3 || code === 4 ? 'dendrite' : 'neutral'

/**
 * A skeleton in the frame. Remembered per skeleton object, so a re-render, a resize or a re-layout
 * never projects a neuron twice — the projection is the one pass over every vertex.
 *
 * The soma is the point labelled soma where the source labels one, the root otherwise; lateral
 * positions are relative to it, so a column is centred on its cell body. Segments are bucketed by
 * ink here, once, rather than classified again on every draw.
 */
export function cellGeometry(skeleton: SkeletonGeometry, frame: CorticalFrame): CellGeometry {
  const held = projected.get(skeleton)
  if (held) return held
  const points = projector(frame).project(skeleton.positions)
  const count = skeleton.parents.length
  const labels = skeleton.compartments
  const labelledSoma = labels ? labels.indexOf(1) : -1
  const soma = labelledSoma >= 0 ? labelledSoma : Math.max(0, skeleton.parents.indexOf(-1))
  const somaLateral = points[soma * 3] ?? 0

  const buckets: Record<Ink, Float32Array> = {
    axon: new Float32Array(count * 4),
    dendrite: new Float32Array(count * 4),
    neutral: new Float32Array(count * 4),
  }
  const fill: Record<Ink, number> = { axon: 0, dendrite: 0, neutral: 0 }
  let left = 0
  let right = 0
  for (let i = 0; i < count; i++) {
    const lateral = points[i * 3]! - somaLateral
    if (lateral < left) left = lateral
    if (lateral > right) right = lateral
    const parent = skeleton.parents[i]!
    // A parent outside the tree is a malformed file, not a segment to draw off into nowhere.
    if (parent < 0 || parent >= count) continue
    const ink = inkOf(labels?.[i] ?? 0)
    const at = fill[ink]
    const out = buckets[ink]
    out[at] = lateral
    out[at + 1] = points[i * 3 + 1]!
    out[at + 2] = points[parent * 3]! - somaLateral
    out[at + 3] = points[parent * 3 + 1]!
    fill[ink] = at + 4
  }
  const geometry: CellGeometry = {
    segments: {
      axon: buckets.axon.subarray(0, fill.axon),
      dendrite: buckets.dendrite.subarray(0, fill.dendrite),
      neutral: buckets.neutral.subarray(0, fill.neutral),
    },
    somaDepth: points[soma * 3 + 1] ?? 0,
    left,
    right,
  }
  projected.set(skeleton, geometry)
  return geometry
}

/** How a row maps depth to pixels: the depth at its top edge, and the scale. */
export interface RowScale {
  top: number
  pxPerUm: number
}

/** A row `height` px tall showing a little above the pia to past the white-matter boundary. */
export function rowScale(frame: CorticalFrame, height: number): RowScale {
  const top = -frame.aboveTolerance
  const bottom = frame.layers[frame.layers.length - 1]!.top + 60
  return { top, pxPerUm: height / (bottom - top) }
}

/**
 * The narrowest a column is, µm — a cell whose skeleton has not landed, or a very small arbour,
 * still a column somebody can click: ~24 px on the card, ~55 px full size.
 */
export const MIN_COLUMN_UM = 150

/** Automatic even widths move in these steps, so a wall filling in re-lays itself out rarely. */
const EVEN_STEP_UM = 50

/**
 * A cell's extent, µm: twice its farther reach from the soma, since it is drawn centred on its
 * soma — sizing by the whole span would clip a lopsided arbour on its long side.
 */
export function cellExtent(geometry: CellGeometry): number {
  return 2 * Math.max(-geometry.left, geometry.right)
}

/**
 * The width every column takes in `even` mode, µm: the one asked for, or the median extent of the
 * cells that have landed, rounded up to `EVEN_STEP_UM` — the floor while nothing has.
 */
export function evenColumnWidth(
  geometries: readonly (CellGeometry | undefined)[],
  asked: number | undefined,
): number {
  if (asked !== undefined) return Math.max(MIN_COLUMN_UM, asked)
  const extents = geometries
    .filter((g): g is CellGeometry => g !== undefined)
    .map(cellExtent)
    .sort((a, b) => a - b)
  if (extents.length === 0) return MIN_COLUMN_UM
  const median = quantileSorted(extents, 0.5)
  return Math.max(MIN_COLUMN_UM, Math.ceil(median / EVEN_STEP_UM) * EVEN_STEP_UM)
}

/**
 * Each cell's width on screen, px. **Decided in µm and only then scaled**, so a card and the
 * full-size view — two row heights, two scales — make the same decision about the same cell; a
 * clamp in pixels clipped at ~630 µm on the card and ~270 µm full size, which is what made the two
 * look different.
 */
export function columnWidths(
  geometries: readonly (CellGeometry | undefined)[],
  pxPerUm: number,
  widths: ColumnWidths,
): number[] {
  if (widths.mode === 'even') {
    const px = Math.round(evenColumnWidth(geometries, widths.um) * pxPerUm)
    return geometries.map(() => px)
  }
  return geometries.map((g) =>
    Math.round(Math.max(MIN_COLUMN_UM, g ? cellExtent(g) : 0) * pxPerUm),
  )
}

/**
 * Cells into rows of at most `available` pixels, in order — each row as full as it goes, a cell
 * wider than the whole row given one to itself rather than lost.
 */
export function packRows(
  widths: readonly number[],
  available: number,
  gap: number,
): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  widths.forEach((width, i) => {
    const needed = row.length === 0 ? width : used + gap + width
    if (row.length > 0 && needed > available) {
      rows.push(row)
      row = [i]
      used = width
    } else {
      row.push(i)
      used = needed
    }
  })
  if (row.length > 0) rows.push(row)
  return rows
}

/** A run of cells that starts on a row of its own — a group in rows or compare mode. */
export interface WallSection {
  /** Indices into the widths, in drawing order. */
  members: readonly number[]
  /** Drawn over its first row, where there is one. */
  label?: string
}

/** Where everything sits — every cell, ruler and label placed absolutely. */
export interface WallLayout {
  /**
   * Per cell index: its left edge, its row and its drawn width — its own, or wider on a full row.
   * Absent for a cell in no section.
   */
  cells: ({ x: number; row: number; width: number } | undefined)[]
  /**
   * Every row of every column that holds cells, as the band drawn under it: the ruler naming the
   * layers at its left, and the layer bands across the whole column behind the cells.
   */
  rulers: { x: number; row: number; width: number }[]
  labels: { x: number; row: number; text: string }[]
  rows: number
}

/** The gallery's three ways of arranging its groups. */
export type WallMode = 'lineup' | 'rows' | 'compare'

/**
 * A mode as the columns `layoutWall` takes: line-up is every section's cells run on as one,
 * unlabelled; rows is the sections one under another; compare is each section a column of its own.
 */
export function wallColumns(mode: WallMode, sections: readonly WallSection[]): WallSection[][] {
  if (mode === 'compare') return sections.map((section) => [section])
  if (mode === 'rows') return [[...sections]]
  return [[{ members: sections.flatMap((section) => section.members) }]]
}

/**
 * The wall laid out as columns of sections: line-up is one column of one section, rows mode one
 * column with a section per group, compare two columns side by side. Each section starts on a row
 * of its own and is packed after its column's ruler (`packRows`).
 *
 * **A full row is justified**: every row of a section but its last shares the width it did not
 * use evenly among its cells, so the wall has one right edge instead of a ragged one. A cell is
 * drawn centred on its soma, so the extra is margin either side of the arbour and never a
 * stretch of it. The last row keeps its cells' own widths, as the last line of justified text
 * does — spreading three cells across a whole row would say they were as wide as the row.
 *
 * Absolute positions rather than a row per element, so a cell that moves row when an earlier one
 * lands is a style change — never an unmount, a fresh canvas and a redraw of every segment it has.
 */
export function layoutWall(
  widths: readonly number[],
  available: number,
  columns: readonly (readonly WallSection[])[],
  { ruler, gap, columnGap }: { ruler: number; gap: number; columnGap: number },
): WallLayout {
  const layout: WallLayout = {
    cells: new Array(widths.length),
    rulers: [],
    labels: [],
    rows: 0,
  }
  const width = (available - columnGap * (columns.length - 1)) / Math.max(1, columns.length)
  const inner = width - ruler - gap
  columns.forEach((sections, c) => {
    const left = c * (width + columnGap)
    let row = 0
    for (const section of sections) {
      if (section.members.length === 0) continue
      if (section.label) layout.labels.push({ x: left, row, text: section.label })
      // Each packed row as indices into `widths`, once.
      const packed = packRows(
        section.members.map((i) => widths[i]!),
        inner,
        gap,
      ).map((members) => members.map((k) => section.members[k]!))
      packed.forEach((members, r) => {
        layout.rulers.push({ x: left, row, width: Math.floor(width) })
        const used = members.reduce((sum, i) => sum + widths[i]!, 0)
        const full = r < packed.length - 1
        // Whole pixels, the remainder to the leftmost cells, so the row ends exactly at its edge.
        const spare = full
          ? Math.max(0, Math.floor(inner - used - gap * (members.length - 1)))
          : 0
        let x = left + ruler + gap
        members.forEach((i, j) => {
          const extra =
            Math.floor(spare / members.length) + (j < spare % members.length ? 1 : 0)
          const drawn = widths[i]! + extra
          layout.cells[i] = { x, row, width: drawn }
          x += drawn + gap
        })
        row++
      })
    }
    layout.rows = Math.max(layout.rows, row)
  })
  return layout
}

/** Which ink a segment draws in, and the soma's — one table for the canvas and the SVG export. */
export function cellInks(mode: Mode): Record<Ink, string> & { soma: string } {
  return {
    ...axonDendriteInk(mode),
    neutral: CHART_INK[mode].secondary,
    soma: CHART_INK[mode].primary,
  }
}

/** The order inks are drawn in: the unlabelled first, so the labelled lie over it. */
export const INK_ORDER = ['neutral', 'dendrite', 'axon'] as const

/** The soma dot's radius, px. */
export const SOMA_RADIUS = 2.5

/** A depth's height in a row, px from its top — the one mapping bands, cells and the pia share. */
export function depthY(scale: RowScale): (depth: number) => number {
  return (depth) => (depth - scale.top) * scale.pxPerUm
}

/**
 * Where a cell's points land in a box `width` wide: centred laterally on the soma, depth by the
 * row's scale. The canvas and the SVG export both place through this, so a figure is the wall.
 */
export function cellMapping(
  scale: RowScale,
  width: number,
): { x: (lateral: number) => number; y: (depth: number) => number } {
  return { x: (lateral) => width / 2 + lateral * scale.pxPerUm, y: depthY(scale) }
}

/** A stripe above each cell, the group label over a section, and the space between rows, px. */
export const STRIPE = 6
const LABEL = 16
const ROW_GAP = 8

/** How a row stacks vertically: its label, its stripes, its drawing, and the gap below. */
export interface RowMetrics {
  /** The drawing's height. */
  height: number
  labelHeight: number
  stripe: number
  /** Above the drawing: the label, then the stripes. */
  head: number
  /** From one row's top to the next's. */
  stride: number
}

/** A row's stacking, for a drawing `height` tall under `stripes` stripes, labelled or not. */
export function rowMetrics(height: number, labelled: boolean, stripes: number): RowMetrics {
  const labelHeight = labelled ? LABEL : 0
  const head = labelHeight + stripes * STRIPE
  return { height, labelHeight, stripe: STRIPE, head, stride: head + height + ROW_GAP }
}

/** One band of a row: where it starts and ends, px from the row's top, and whether it is filled. */
export interface LayerBand {
  name: string
  from: number
  to: number
  /** Every other band is filled, so neighbours read apart. */
  filled: boolean
  /** Where its name is centred, within the row. */
  labelY: number
}

/** A row's layer bands, `height` tall — the canvas's and the SVG export's one geometry. */
export function layerBands(frame: CorticalFrame, scale: RowScale, height: number): LayerBand[] {
  const y = depthY(scale)
  return frame.layers.map((band, i) => {
    const from = y(band.top)
    const next = frame.layers[i + 1]
    const to = next ? y(next.top) : height
    return {
      name: band.name,
      from,
      to,
      filled: i % 2 === 1,
      labelY: (Math.max(0, from) + Math.min(height, to)) / 2,
    }
  })
}

/** Where the pia — depth 0 — sits in a row, px from its top. */
export function piaY(scale: RowScale): number {
  return depthY(scale)(0)
}

/**
 * A row's layer bands, the layers named at its left (the ruler): every other band filled in the
 * grid ink, which is chrome — under the non-text contrast floor by design, so the bands read as
 * ground, never as data.
 */
export function drawBands(
  context: CanvasRenderingContext2D,
  frame: CorticalFrame,
  scale: RowScale,
  width: number,
  height: number,
  mode: Mode,
): void {
  const ink = CHART_INK[mode]
  context.font = canvasFont(10)
  context.textBaseline = 'middle'
  for (const band of layerBands(frame, scale, height)) {
    if (band.filled) {
      context.fillStyle = ink.grid
      context.fillRect(0, band.from, width, band.to - band.from)
    }
    context.fillStyle = ink.muted
    context.fillText(band.name, 4, band.labelY)
  }
  // The pia itself, a line rather than a band: where depth 0 is.
  context.strokeStyle = ink.axis
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(0, piaY(scale) + 0.5)
  context.lineTo(width, piaY(scale) + 0.5)
  context.stroke()
}

/**
 * One cell: its segments in the axon or dendrite ink by the source's labels, the neutral ink where
 * the source labels nothing, and the soma as a dot. One path per ink, centred on the soma.
 */
export function drawCell(
  context: CanvasRenderingContext2D,
  geometry: CellGeometry,
  scale: RowScale,
  width: number,
  mode: Mode,
): void {
  const inks = cellInks(mode)
  const { x, y } = cellMapping(scale, width)
  context.lineWidth = 1
  context.lineCap = 'round'
  for (const ink of INK_ORDER) {
    const segments = geometry.segments[ink]
    if (segments.length === 0) continue
    context.strokeStyle = inks[ink]
    context.beginPath()
    for (let o = 0; o < segments.length; o += 4) {
      context.moveTo(x(segments[o]!), y(segments[o + 1]!))
      context.lineTo(x(segments[o + 2]!), y(segments[o + 3]!))
    }
    context.stroke()
  }
  context.fillStyle = inks.soma
  context.beginPath()
  context.arc(x(0), y(geometry.somaDepth), SOMA_RADIUS, 0, Math.PI * 2)
  context.fill()
}
