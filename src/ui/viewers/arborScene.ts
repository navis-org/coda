/**
 * The Neuron Dendrogram's picture as a list of marks — one description, three readers.
 *
 * The canvas paints it, the ⤓ turns it into an SVG (and a PNG of that SVG), and the hover reads
 * where every synapse tick ended up. The heatmap learned why this is one function: two drawings
 * carrying the same numbers part company within an afternoon, and a downloaded figure that does
 * not match the card is worse than none (`docs/viewers.md`, "The chrome is shared").
 *
 * Everything is in screen pixels and built from `PieceGeometry` — each drawn piece's two ends — so
 * the animation, which interpolates only those ends, gets every tick, colour stop and highlight
 * moving with it for free.
 */

import type { ArborShape } from '../../nodes/lib/arborLayout'
import type { KeyTree } from '../../nodes/lib/arborOps'
import type { PieceGeometry, PlotTransform, SubSegments, SynapseMarks } from './arborPlot'
import { canvasFont } from './canvas2d'
import { SVG_NS, element, svgRoot, textNode } from './svgElement'

/** Straight segments (and arcs) drawn in one style. `lines` is x0, y0, x1, y1 per segment. */
export interface Stroke {
  readonly color: string
  readonly width: number
  readonly alpha: number
  readonly dash?: readonly number[]
  readonly lines: readonly number[]
  readonly arcs?: ReadonlyArray<{ cx: number; cy: number; r: number; a0: number; a1: number }>
}

export interface SceneText {
  readonly x: number
  readonly y: number
  readonly text: string
  readonly color: string
  readonly anchor: 'start' | 'middle' | 'end'
}

export interface Scene {
  readonly width: number
  readonly height: number
  readonly background: string
  readonly title: string
  /** In drawing order: branches, connectors, joins, the distal highlight, then synapse ticks. */
  readonly strokes: readonly Stroke[]
  readonly dots: ReadonlyArray<{ x: number; y: number; r: number; color: string }>
  readonly texts: readonly SceneText[]
  /** A colour ramp, left to right, for the branch colouring's key. */
  readonly ramp?: {
    x: number
    y: number
    width: number
    height: number
    stops: readonly string[]
  }
  /** Where each synapse's tick starts, x and y per synapse; NaN where it is not drawn. */
  readonly tickAt: Float64Array
}

/** Branches drawn per skeleton edge, grouped by look — see `branchGroups`. */
export interface BranchGroup {
  readonly color: string
  readonly width: number
  /** Indices into `SubSegments`. */
  readonly sub: Int32Array
}

/** Synapse ticks grouped by colour, with the unlit ones dimmed. */
export interface TickGroup {
  readonly color: string
  readonly alpha: number
  readonly rows: Int32Array
}

export interface SceneInput {
  readonly width: number
  readonly height: number
  readonly background: string
  readonly title: string
  readonly ink: { readonly line: string; readonly text: string; readonly accent: string }
  readonly shape: ArborShape
  readonly transform: PlotTransform
  readonly pieces: PieceGeometry
  /**
   * False while the drawing is moving between two layouts. Connectors are then drawn as plain
   * links from each piece's parent end to its own start — a bar or an arc between two half-moved
   * layouts is neither — and the exact ones return when it settles.
   */
  readonly settled: boolean
  readonly tree: KeyTree
  readonly lineWidth: number
  /**
   * Per-edge colour or width; absent draws every piece in `ink.line` at `lineWidth`.
   * `landmarkColor` colours each connector by its branch point, so a coloured tree's bars and arcs
   * are not left grey.
   */
  readonly branches?: {
    readonly sub: SubSegments
    readonly groups: readonly BranchGroup[]
    readonly landmarkColor?: readonly string[]
  }
  /** Pieces carrying a healed join, drawn dashed. */
  readonly dashed?: Uint8Array
  /** Pieces wholly beyond the clicked point, and the one it sits on, from the point outwards. */
  readonly distal?: {
    readonly pieces: Uint8Array
    readonly focus: { readonly piece: number; readonly along: number }
  }
  readonly marks?: SynapseMarks
  readonly ticks: readonly TickGroup[]
  readonly synapseSize: number
  /** The synapse colouring's key, top right: a swatch per value, and how many more are not listed. */
  readonly key?: {
    readonly entries: ReadonlyArray<{ readonly label: string; readonly color: string }>
    readonly more: number
  }
  readonly scaleBar?: { readonly px: number; readonly label: string }
  /** The branch colouring's key. `lo` absent means the measure is one value everywhere. */
  readonly legend?: {
    readonly title: string
    readonly stops: readonly string[]
    readonly lo?: string
    readonly hi: string
  }
}

/** A point `along` a piece, in screen pixels. */
function onPiece(p: PieceGeometry, k: number, along: number): [number, number] {
  return [p.ax[k]! + along * (p.bx[k]! - p.ax[k]!), p.ay[k]! + along * (p.by[k]! - p.ay[k]!)]
}

export function buildScene(input: SceneInput): Scene {
  const { pieces: p, tree, shape, transform: t, ink } = input
  const n = p.ax.length
  const strokes: Stroke[] = []

  // Branches: per edge when coloured or sized by a value, per piece otherwise.
  if (input.branches) {
    const { sub, groups } = input.branches
    for (const group of groups) {
      const lines: number[] = []
      for (const i of group.sub) {
        const k = sub.piece[i]!
        const [x0, y0] = onPiece(p, k, sub.f0[i]!)
        const [x1, y1] = onPiece(p, k, sub.f1[i]!)
        lines.push(x0, y0, x1, y1)
      }
      strokes.push({ color: group.color, width: group.width, alpha: 1, lines })
    }
  } else {
    const lines: number[] = []
    for (let k = 1; k < n; k++) {
      if (input.dashed?.[k]) continue
      lines.push(p.ax[k]!, p.ay[k]!, p.bx[k]!, p.by[k]!)
    }
    strokes.push({ color: ink.line, width: input.lineWidth, alpha: 1, lines })
  }

  // Connectors: exact once settled, plain links while moving — each in its branch point's colour.
  const colorAt = (k: number): string => input.branches?.landmarkColor?.[k] ?? ink.line
  type Arc = NonNullable<Stroke['arcs']>[number]
  const connectors = new Map<string, { lines: number[]; arcs: Arc[] }>()
  const connectorFor = (k: number) => {
    const color = colorAt(k)
    let group = connectors.get(color)
    if (!group) connectors.set(color, (group = { lines: [], arcs: [] }))
    return group
  }
  if (input.settled) {
    const hx = t.width / 2
    const hy = t.height / 2
    for (const c of shape.connectors) {
      if (c.kind === 'line') {
        const x = (c.x - t.cx) * t.sx + hx
        connectorFor(c.at).lines.push(
          x,
          (c.y0 - t.cy) * t.sy + hy,
          x,
          (c.y1 - t.cy) * t.sy + hy,
        )
      } else {
        connectorFor(c.at).arcs.push({
          cx: -t.cx * t.sx + hx,
          cy: -t.cy * t.sy + hy,
          r: c.r * t.sx,
          a0: c.a0,
          a1: c.a1,
        })
      }
    }
  } else if (shape.connectors.length > 0) {
    for (let k = 1; k < n; k++) {
      const parent = tree.parent[k]!
      if (parent < 0) continue
      connectorFor(parent).lines.push(p.bx[parent]!, p.by[parent]!, p.ax[k]!, p.ay[k]!)
    }
  }
  for (const [color, group] of connectors) {
    strokes.push({
      color,
      width: input.lineWidth,
      alpha: 1,
      lines: group.lines,
      arcs: group.arcs,
    })
  }

  // Healed joins: cable nobody traced, and the picture says so.
  if (input.dashed && !input.branches) {
    const lines: number[] = []
    for (let k = 1; k < n; k++) {
      if (input.dashed[k]) lines.push(p.ax[k]!, p.ay[k]!, p.bx[k]!, p.by[k]!)
    }
    if (lines.length > 0) {
      strokes.push({ color: ink.line, width: input.lineWidth, alpha: 1, dash: [4, 3], lines })
    }
  }

  // The subtree beyond the clicked point, over the top in the accent.
  const dots: Array<{ x: number; y: number; r: number; color: string }> = []
  if (input.distal) {
    const { pieces: beyond, focus } = input.distal
    const lines: number[] = []
    for (let k = 1; k < n; k++) {
      if (beyond[k]) lines.push(p.ax[k]!, p.ay[k]!, p.bx[k]!, p.by[k]!)
    }
    const [fx, fy] = onPiece(p, focus.piece, focus.along)
    if (focus.piece > 0) lines.push(fx, fy, p.bx[focus.piece]!, p.by[focus.piece]!)
    strokes.push({ color: ink.accent, width: input.lineWidth + 1.2, alpha: 1, lines })
    dots.push({ x: fx, y: fy, r: 4, color: ink.accent })
  }

  // Synapse ticks across their branch: outputs to one side, inputs to the other, so polarity reads
  // from position even where colour is spent on something else.
  const marks = input.marks
  const tickAt = new Float64Array((marks?.piece.length ?? 0) * 2).fill(NaN)
  if (marks) {
    const size = input.synapseSize
    const width = Math.max(1, size * 0.28)
    for (const group of input.ticks) {
      const lines: number[] = []
      for (const s of group.rows) {
        const k = marks.piece[s]!
        const dx = p.bx[k]! - p.ax[k]!
        const dy = p.by[k]! - p.ay[k]!
        const len = Math.hypot(dx, dy) || 1
        const out = size * marks.side[s]!
        const [x, y] = onPiece(p, k, marks.along[s]!)
        tickAt[s * 2] = x
        tickAt[s * 2 + 1] = y
        lines.push(x, y, x - (dy / len) * out, y + (dx / len) * out)
      }
      strokes.push({ color: group.color, width, alpha: group.alpha, lines })
    }
  }

  // The root, under the clicked point's dot.
  dots.unshift({ x: p.bx[0]!, y: p.by[0]!, r: 3.5, color: ink.text })

  // The scale bar, bottom left, and the branch colouring's key, bottom right.
  const texts: SceneText[] = []
  if (input.scaleBar) {
    const y = input.height - 10
    strokes.push({
      color: ink.text,
      width: 1.5,
      alpha: 1,
      lines: [12, y, 12 + input.scaleBar.px, y],
    })
    texts.push({
      x: 12,
      y: y - 5,
      text: input.scaleBar.label,
      color: ink.text,
      anchor: 'start',
    })
  }
  // The synapse key, top right: a tick-sized swatch and the value, one row each.
  if (input.key) {
    const right = input.width - 12
    let y = 16
    for (const entry of input.key.entries) {
      strokes.push({
        color: entry.color,
        width: 2,
        alpha: 1,
        lines: [right, y - 7, right, y - 1],
      })
      texts.push({ x: right - 6, y, text: entry.label, color: ink.text, anchor: 'end' })
      y += 14
    }
    if (input.key.more > 0) {
      texts.push({
        x: right - 6,
        y,
        text: `+${input.key.more} more`,
        color: ink.text,
        anchor: 'end',
      })
    }
  }

  // Right-aligned against the plot's edge, so a long title runs inwards rather than off the card.
  let ramp: Scene['ramp']
  if (input.legend) {
    const width = 130
    const right = input.width - 12
    const y = input.height - 26
    const { title, stops, lo, hi } = input.legend
    texts.push({ x: right, y: y - 5, text: title, color: ink.text, anchor: 'end' })
    if (lo === undefined) {
      texts.push({ x: right, y: y + 16, text: `all ${hi}`, color: ink.text, anchor: 'end' })
    } else {
      ramp = { x: right - width, y, width, height: 6, stops }
      texts.push({ x: right - width, y: y + 18, text: lo, color: ink.text, anchor: 'start' })
      texts.push({ x: right, y: y + 18, text: hi, color: ink.text, anchor: 'end' })
    }
  }

  return {
    width: input.width,
    height: input.height,
    background: input.background,
    title: input.title,
    strokes,
    dots,
    texts,
    ...(ramp ? { ramp } : {}),
    tickAt,
  }
}

/** Paint a scene onto a canvas already sized for it (`prepareCanvas`). */
export function paintScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.clearRect(0, 0, scene.width, scene.height)
  ctx.lineCap = 'round'
  for (const stroke of scene.strokes) {
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.width
    ctx.globalAlpha = stroke.alpha
    ctx.setLineDash(stroke.dash ? [...stroke.dash] : [])
    ctx.beginPath()
    const l = stroke.lines
    for (let i = 0; i < l.length; i += 4) {
      ctx.moveTo(l[i]!, l[i + 1]!)
      ctx.lineTo(l[i + 2]!, l[i + 3]!)
    }
    for (const arc of stroke.arcs ?? []) {
      ctx.moveTo(arc.cx + arc.r * Math.cos(arc.a0), arc.cy + arc.r * Math.sin(arc.a0))
      ctx.arc(arc.cx, arc.cy, arc.r, arc.a0, arc.a1)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.setLineDash([])
  for (const dot of scene.dots) {
    ctx.fillStyle = dot.color
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, dot.r, 0, 2 * Math.PI)
    ctx.fill()
  }
  if (scene.ramp) {
    const { x, y, width, height, stops } = scene.ramp
    const gradient = ctx.createLinearGradient(x, 0, x + width, 0)
    stops.forEach((color, i) => gradient.addColorStop(i / Math.max(1, stops.length - 1), color))
    ctx.fillStyle = gradient
    ctx.fillRect(x, y, width, height)
  }
  ctx.font = canvasFont(10.5)
  for (const text of scene.texts) {
    ctx.fillStyle = text.color
    ctx.textAlign =
      text.anchor === 'middle' ? 'center' : text.anchor === 'end' ? 'right' : 'left'
    ctx.fillText(text.text, text.x, text.y)
  }
}

/** The same scene as a standalone `<svg>`, for the ⤓. `font` is the UI family, carried explicitly. */
export function sceneToSvg(scene: Scene, font: string): SVGSVGElement {
  const svg = svgRoot({
    width: scene.width,
    height: scene.height,
    background: scene.background,
    title: scene.title,
  })
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `text{font-family:${font};font-size:10.5px;}`
  svg.append(style)

  for (const stroke of scene.strokes) {
    let d = ''
    const l = stroke.lines
    for (let i = 0; i < l.length; i += 4) {
      d += `M${l[i]!.toFixed(2)} ${l[i + 1]!.toFixed(2)}L${l[i + 2]!.toFixed(2)} ${l[i + 3]!.toFixed(2)}`
    }
    for (const arc of stroke.arcs ?? []) {
      const x0 = arc.cx + arc.r * Math.cos(arc.a0)
      const y0 = arc.cy + arc.r * Math.sin(arc.a0)
      const x1 = arc.cx + arc.r * Math.cos(arc.a1)
      const y1 = arc.cy + arc.r * Math.sin(arc.a1)
      const large = arc.a1 - arc.a0 > Math.PI ? 1 : 0
      d += `M${x0.toFixed(2)} ${y0.toFixed(2)}A${arc.r.toFixed(2)} ${arc.r.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
    }
    if (!d) continue
    svg.append(
      element('path', {
        d,
        fill: 'none',
        stroke: stroke.color,
        'stroke-width': stroke.width,
        'stroke-linecap': 'round',
        ...(stroke.alpha < 1 ? { 'stroke-opacity': stroke.alpha } : {}),
        ...(stroke.dash ? { 'stroke-dasharray': stroke.dash.join(' ') } : {}),
      }),
    )
  }
  for (const dot of scene.dots) {
    svg.append(element('circle', { cx: dot.x, cy: dot.y, r: dot.r, fill: dot.color }))
  }
  if (scene.ramp) {
    const { x, y, width, height, stops } = scene.ramp
    const defs = document.createElementNS(SVG_NS, 'defs')
    const gradient = element('linearGradient', {
      id: 'coda-arbor-ramp',
      x1: 0,
      x2: 1,
      y1: 0,
      y2: 0,
    })
    stops.forEach((color, i) =>
      gradient.append(
        element('stop', { offset: i / Math.max(1, stops.length - 1), 'stop-color': color }),
      ),
    )
    defs.append(gradient)
    svg.append(defs)
    svg.append(element('rect', { x, y, width, height, fill: 'url(#coda-arbor-ramp)' }))
  }
  for (const text of scene.texts) {
    svg.append(
      textNode(text.text, {
        x: text.x,
        y: text.y,
        fill: text.color,
        'text-anchor': text.anchor,
      }),
    )
  }
  return svg
}

/** The synapse whose tick starts nearest a screen point, within `tolerance` pixels. */
export function nearestTick(
  scene: Scene,
  x: number,
  y: number,
  tolerance = 6,
): number | undefined {
  let best: number | undefined
  let bestDist = tolerance * tolerance
  const at = scene.tickAt
  for (let s = 0; s < at.length / 2; s++) {
    const dx = at[s * 2]! - x
    if (Number.isNaN(dx)) continue
    const d = dx * dx + (at[s * 2 + 1]! - y) ** 2
    if (d <= bestDist) {
      bestDist = d
      best = s
    }
  }
  return best
}

/**
 * Interpolate two piece geometries — the animation's only moving part.
 *
 * Pieces are matched by the skeleton node they end at, so a re-layout, a new root or a change in
 * which twigs are hidden all animate: a piece that was drawn before slides from where it was, and
 * one that was not grows out of its parent's old end. `t` is eased by the caller.
 */
export function blendPieces(
  from: { pieces: PieceGeometry; nodes: Int32Array },
  to: { pieces: PieceGeometry; tree: KeyTree },
  t: number,
): PieceGeometry {
  const where = new Map<number, number>()
  from.nodes.forEach((node, k) => where.set(node, k))
  const n = to.pieces.ax.length
  const ax = new Float64Array(n)
  const ay = new Float64Array(n)
  const bx = new Float64Array(n)
  const by = new Float64Array(n)
  // Start positions, in pre-order so a new piece's parent already has one.
  const sx0 = new Float64Array(n)
  const sy0 = new Float64Array(n)
  const sx1 = new Float64Array(n)
  const sy1 = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const old = where.get(to.tree.nodes[k]!)
    if (old !== undefined) {
      sx0[k] = from.pieces.ax[old]!
      sy0[k] = from.pieces.ay[old]!
      sx1[k] = from.pieces.bx[old]!
      sy1[k] = from.pieces.by[old]!
    } else {
      const parent = to.tree.parent[k]!
      // Grows from its parent's start-of-animation end; the root falls back to where it lands.
      const ox = parent >= 0 ? sx1[parent]! : to.pieces.bx[k]!
      const oy = parent >= 0 ? sy1[parent]! : to.pieces.by[k]!
      sx0[k] = sx1[k] = ox
      sy0[k] = sy1[k] = oy
    }
    ax[k] = sx0[k]! + t * (to.pieces.ax[k]! - sx0[k]!)
    ay[k] = sy0[k]! + t * (to.pieces.ay[k]! - sy0[k]!)
    bx[k] = sx1[k]! + t * (to.pieces.bx[k]! - sx1[k]!)
    by[k] = sy1[k]! + t * (to.pieces.by[k]! - sy1[k]!)
  }
  return { ax, ay, bx, by }
}
