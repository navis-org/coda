/**
 * Coda objects inside a document.
 *
 * A help document embeds a node, or a small pipeline, by naming node **types** — never by
 * drawing one. Everything a figure shows about a node is read out of its `NodeDefinition` at the
 * moment the document is rendered: the label, the category tint, the sockets with their real
 * shapes and colour families, the settings with the values the pickers would show. So a figure
 * cannot drift. Rename a port, add a setting, change a default, and every document that draws
 * that node is correct on the next reload with nobody opening this directory — the same property
 * `src/nodeguide/data.ts` buys the node guide, for the same reason.
 *
 * ## Headless, and that is the point
 *
 * No React, no store, no DOM. What this module produces is a **model** — cards with positions
 * and sizes, wires with an SVG path — and a renderer turns it into elements. The app's renderer
 * is `src/ui/help/FigureView.tsx`; the node guide page, which has no React at all, can grow a
 * second one over the same model without a line of content moving. That is why the geometry is
 * here rather than in a component, and it is also what makes it testable: jsdom performs no
 * layout, so a figure whose positions came out of CSS would be covered by nothing.
 *
 * ## Nothing here throws
 *
 * A document is data, and a typo in one is not a reason for an overlay to render white. Every
 * failure — an unknown node type, a port that does not exist, a wire between incompatible types
 * — lands in `problems` and is drawn as a visible complaint. `help.test.ts` asserts that every
 * document in the repository produces none, which is what turns "renders a complaint" from a
 * tolerated state into a build-time check.
 *
 * ## The registry has to be loaded already
 *
 * This module deliberately does not `import '../nodes'`. Doing so would pull the whole node
 * registry — `src/core`, `src/data`, a corner of `src/ui` — into anything that so much as asks
 * whether a document exists. The app has it loaded via `graphStore.ts`; tests import it
 * themselves.
 */

import type { NodeCategory, NodeDefinition, ParamDef, PortDef } from '../core/node'
import { getNodeDef } from '../core/registry'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'
import { isAssignable, typeLabel } from '../core/types'
import { backendForNodeType } from '../nodes/lib/datasetFamilies'
import { socketStyle } from '../ui/socketStyle'
import type { SocketFamily, SocketShape } from '../ui/socketStyle'
import { paramIsPicker, paramValueLabel } from './paramText'

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface FigurePort {
  id: string
  label: string
  family: SocketFamily
  shape: SocketShape
  required: boolean
  /** The declared type, for the socket's title attribute. */
  type: string
  /** Centre of the socket, relative to the card's top edge. */
  y: number
}

export interface FigureParam {
  id: string
  label: string
  value: string
  picker: boolean
  /** Named in the figure's own source, rather than shown because the card shows everything. */
  called: boolean
}

export interface FigureCard {
  alias: string
  type: string
  label: string
  category: NodeCategory
  /** Dataset nodes are tinted by backend on the canvas; a figure follows. */
  backend?: string
  annotation: boolean
  inputs: FigurePort[]
  outputs: FigurePort[]
  params: FigureParam[]
  /** Settings the card is not drawing, counted the way the real card counts them. */
  more: number
  /** Drawn with a ring: the node this document is about, or one named by `focus:`. */
  focus: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface FigureWire {
  from: string
  fromPort: string
  to: string
  toPort: string
  family: SocketFamily
  /** An SVG path in the figure's own coordinate space. */
  path: string
}

export interface FigureGraph {
  kind: 'graph'
  cards: FigureCard[]
  wires: FigureWire[]
  width: number
  height: number
  caption?: string
  problems: string[]
}

export interface FigureParamRow {
  id: string
  label: string
  kind: ParamDef['kind']
  value: string
  help?: string
  advanced: boolean
}

export interface FigureParams {
  kind: 'params'
  type: string
  label: string
  rows: FigureParamRow[]
  caption?: string
  problems: string[]
}

export type HelpFigure = FigureGraph | FigureParams

/** The fence languages this module answers to. Anything else is a code sample. */
export const FIGURE_LANGS = ['coda-node', 'coda-graph', 'coda-params'] as const
export type FigureLang = (typeof FIGURE_LANGS)[number]

export function isFigureLang(lang: string): lang is FigureLang {
  return (FIGURE_LANGS as readonly string[]).includes(lang)
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * What the help overlay can draw without scrolling sideways.
 *
 * Not a limit — a figure wider than this scrolls inside its own box, which is the right
 * behaviour for wide content and the same one the tables and code samples get. It is the width a
 * figure should *aim* at, and `help.test.ts` fails a document whose figure exceeds it, because a
 * figure that silently needs scrolling reads as a figure with cards missing off the right.
 *
 * The metrics below are sized so a **five-layer pipeline fits**, which is the longest chain a
 * document has wanted: `Dataset → Find Neurons → Skeletons → NBLAST → Heatmap`. Six scrolls.
 *
 * `.help-panel`'s `max-width` in `editor.css` is this plus its 28px padding on each side. CSS
 * cannot import a constant, so that relationship lives in a comment at both ends.
 */
export const FIGURE_FIT_WIDTH = 988

/**
 * Figure metrics, in figure units — which are CSS pixels, since a figure is drawn at 1:1 and
 * scrolled by its container rather than scaled by a transform. **A figure shrunk to fit is a
 * figure whose 10px labels are 7px**, which is why the width above is a target for the author
 * rather than a scale factor for the renderer.
 *
 * A card here is narrower than the 232px one on the canvas, and the arithmetic above is why: at
 * canvas width, five of them plus their gaps is 1450px, and no reading panel is that wide.
 */
const CARD_WIDTH = 156
const HEADER_H = 25
const ROW_H = 17
const BAND_PAD = 5
const MORE_H = 15
/** Horizontal gap between layers. Wide enough that a wire's curve is readable as a curve. */
const COL_GAP = 52
const ROW_GAP = 22

/** Rows the card draws before it starts counting instead — the node guide's own cap. */
const MAX_PARAM_ROWS = 5

function cardHeight(card: {
  inputs: readonly unknown[]
  outputs: readonly unknown[]
  params: readonly unknown[]
  more: number
}): number {
  const portRows = Math.max(card.inputs.length, card.outputs.length)
  let h = HEADER_H
  if (portRows > 0) h += BAND_PAD + portRows * ROW_H
  if (card.params.length > 0) h += BAND_PAD + card.params.length * ROW_H
  if (card.more > 0) h += MORE_H
  return h + BAND_PAD
}

/** Centre of port row `index`, relative to the card's top edge. */
function portY(index: number): number {
  return HEADER_H + BAND_PAD + index * ROW_H + ROW_H / 2
}

/**
 * A cubic bezier between two sockets, matching the canvas.
 *
 * React Flow's `getBezierPath` is what draws an unbent wire in the editor, and this is the same
 * curve written out — six lines against an import that would make this module depend on
 * `@xyflow/react`, i.e. on React, i.e. on the one thing the node guide page cannot have.
 */
function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const d = Math.max(28, Math.abs(x2 - x1) * 0.5)
  return `M ${r(x1)} ${r(y1)} C ${r(x1 + d)} ${r(y1)}, ${r(x2 - d)} ${r(y2)}, ${r(x2)} ${r(y2)}`
}

/** Two decimals. A path full of `104.99999999999999` is a diff nobody can read. */
function r(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// The figure source
// ---------------------------------------------------------------------------

interface NodeLine {
  alias: string
  type: string
  title?: string
  params: Record<string, string>
}

interface WireLine {
  from: string
  fromPort?: string
  to: string
  toPort?: string
}

interface FigureSource {
  nodes: NodeLine[]
  wires: WireLine[]
  caption?: string
  focus: string[]
  problems: string[]
}

/** `type as alias "Title" { k: v, k2: v2 }` — everything after the type optional. */
const NODE_LINE = /^([\w.]+)(?:\s+as\s+([\w-]+))?\s*(?:"([^"]*)")?\s*(?:\{(.*)\})?\s*$/
/** `a -> b`, `a:out -> b:in`. */
const WIRE_LINE = /^([\w-]+)(?::([\w-]+))?\s*(?:->|→)\s*([\w-]+)(?::([\w-]+))?$/
const DIRECTIVE = /^(caption|focus)\s*:\s*(.*)$/

/**
 * Read a figure's source into a declaration list.
 *
 * The syntax is line-oriented and deliberately not YAML or JSON: a figure is read and edited far
 * more often than it is written, and the shape worth optimising for is the one where a wire is a
 * line that looks like a wire. The whole grammar is four forms — a directive, a node, a wire, a
 * comment — and nothing nests.
 *
 * An alias defaults to the type, so a figure with one of each node needs no `as` at all and the
 * wires read `dataset.hemibrain -> query.findNeurons`. It is only when a figure holds *two*
 * skeleton nodes that naming them earns its keep.
 */
export function parseFigureSource(text: string): FigureSource {
  const src: FigureSource = { nodes: [], wires: [], focus: [], problems: [] }
  const seen = new Set<string>()

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const directive = DIRECTIVE.exec(line)
    if (directive) {
      if (directive[1] === 'caption') src.caption = directive[2]!.trim()
      else src.focus.push(...directive[2]!.split(/[,\s]+/).filter(Boolean))
      continue
    }

    const wire = WIRE_LINE.exec(line)
    if (wire) {
      src.wires.push({
        from: wire[1]!,
        ...(wire[2] ? { fromPort: wire[2] } : {}),
        to: wire[3]!,
        ...(wire[4] ? { toPort: wire[4] } : {}),
      })
      continue
    }

    const node = NODE_LINE.exec(line)
    // A type with no dot in it is almost always a mistyped wire, so it is worth saying which
    // of the two the line failed to be rather than reporting "not a node".
    if (node && node[1]!.includes('.')) {
      const alias = node[2] ?? node[1]!
      if (seen.has(alias)) src.problems.push(`Duplicate name "${alias}" in this figure`)
      seen.add(alias)
      src.nodes.push({
        alias,
        type: node[1]!,
        ...(node[3] ? { title: node[3] } : {}),
        params: parseParamList(node[4] ?? '', src.problems),
      })
      continue
    }

    src.problems.push(`Not a node or a wire: "${line}"`)
  }

  return src
}

/** `k: v, k2: "v with a comma"` — values are text, and the param definition interprets them. */
function parseParamList(body: string, problems: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of splitTopLevel(body)) {
    if (part.trim() === '') continue
    const at = part.indexOf(':')
    if (at === -1) {
      problems.push(`Setting "${part.trim()}" has no value`)
      continue
    }
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    out[key] = value.replace(/^"(.*)"$/, '$1')
  }
  return out
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const ch of body) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

// ---------------------------------------------------------------------------
// Resolving against the registry
// ---------------------------------------------------------------------------

export interface FigureOptions {
  /**
   * The node type this document is about, drawn with a focus ring wherever it appears.
   *
   * Passed by the caller rather than written in every figure: a document about NBLAST that draws
   * four pipelines would otherwise repeat `focus: nblast` four times and get it wrong once.
   */
  focusType?: string
}

/**
 * Build a drawable figure from a fence.
 *
 * `coda-node` and `coda-graph` differ in exactly one thing, and it is not the number of cards —
 * a `coda-node` figure with two nodes and a wire is a `coda-graph`. What differs is **which
 * settings a card draws**: `coda-node` is an anatomy diagram, so it shows the full band the real
 * card would; `coda-graph` is about the shape of a pipeline, so each card shows only the
 * settings the figure names, and counts the rest. Four cards each showing eleven settings is a
 * figure nobody reads.
 */
export function buildFigure(
  lang: FigureLang,
  text: string,
  options: FigureOptions = {},
): HelpFigure {
  if (lang === 'coda-params') return buildParamsFigure(text, options)

  const src = parseFigureSource(text)
  const problems = [...src.problems]
  const showAllParams = lang === 'coda-node'

  const cards: FigureCard[] = []
  const defs = new Map<string, NodeDefinition>()

  for (const line of src.nodes) {
    const def = getNodeDef(line.type)
    if (!def) {
      problems.push(`No node type "${line.type}"`)
      continue
    }
    defs.set(line.alias, def)
    cards.push(makeCard(line, def, { showAllParams, options, problems }))
  }

  const byAlias = new Map(cards.map((c) => [c.alias, c]))
  const wires = resolveWires(src.wires, byAlias, defs, problems)
  const { width, height } = layout(cards, wires)
  attachPaths(wires, byAlias)

  return {
    kind: 'graph',
    cards,
    wires,
    width,
    height,
    ...(src.caption ? { caption: src.caption } : {}),
    problems,
  }
}

function makeCard(
  line: NodeLine,
  def: NodeDefinition,
  ctx: { showAllParams: boolean; options: FigureOptions; problems: string[] },
): FigureCard {
  const all = (def.params ?? []).filter((p) => !p.internal)
  /*
   * `advanced` params are drawn only when the figure names one. The real card hides them in the
   * inspector, so showing them unasked would make the figure disagree with the node beside it;
   * naming one is a statement that this document is about that setting, which is the case where
   * disagreeing is the point.
   */
  const shown = all.filter((p) =>
    p.id in line.params ? true : ctx.showAllParams && !p.advanced,
  )
  for (const id of Object.keys(line.params)) {
    if (!all.some((p) => p.id === id)) {
      ctx.problems.push(`"${line.type}" has no setting "${id}"`)
    }
  }

  const params: FigureParam[] = shown.slice(0, MAX_PARAM_ROWS).map((p) => ({
    id: p.id,
    label: p.label,
    value: paramValueLabel(p, line.params[p.id]),
    picker: paramIsPicker(p),
    called: p.id in line.params,
  }))

  const backend = backendForNodeType(def.type)
  const card: FigureCard = {
    alias: line.alias,
    type: def.type,
    label: line.title ?? def.label,
    category: def.category,
    ...(backend ? { backend: backend.id } : {}),
    annotation: def.annotation === true,
    inputs: portsOf(defaultInputPorts(def)),
    outputs: portsOf(defaultOutputPorts(def)),
    params,
    more: all.length - shown.length + Math.max(0, shown.length - MAX_PARAM_ROWS),
    focus: ctx.options.focusType === def.type || false,
    x: 0,
    y: 0,
    width: CARD_WIDTH,
    height: 0,
  }
  card.height = cardHeight(card)
  return card
}

function portsOf(ports: readonly PortDef[]): FigurePort[] {
  return ports.map((port, index) => ({
    id: port.id,
    label: port.label ?? port.id,
    ...socketStyle(port.type),
    required: port.required !== false,
    type: typeLabel(port.type),
    y: portY(index),
  }))
}

/**
 * Turn wire lines into port-to-port connections.
 *
 * **Both ends may be left out, and the rules differ.** A source with no port named takes the
 * node's first output, because a node with several outputs is rare and the first is the one it
 * is for. A target with no port named takes the first input the source's type is *assignable*
 * to — which is what lets `q -> nb` mean the obvious thing on a node whose second input is a
 * Table and whose first is a Dataset. Falling back to the first input when nothing is
 * assignable is deliberate: the figure then draws the wire the author asked for and the type
 * mismatch is reported, which is more useful than a figure with a missing wire and a complaint
 * about a port.
 */
function resolveWires(
  lines: readonly WireLine[],
  cards: ReadonlyMap<string, FigureCard>,
  defs: ReadonlyMap<string, NodeDefinition>,
  problems: string[],
): FigureWire[] {
  const wires: FigureWire[] = []

  for (const line of lines) {
    const fromDef = defs.get(line.from)
    const toDef = defs.get(line.to)
    if (!fromDef || !toDef) {
      problems.push(
        `Wire names ${!fromDef ? `"${line.from}"` : `"${line.to}"`}, which this figure does not declare`,
      )
      continue
    }

    /*
     * At the arity a fresh node opens at. A figure names node *types* and the wires between
     * them; nothing in the DSL says how many repeats a variadic node has, and a diagram of a
     * comparison node at its default two datasets is what a reader wants anyway.
     */
    const outputs = defaultOutputPorts(fromDef)
    const inputs = defaultInputPorts(toDef)
    const out = line.fromPort ? outputs.find((p) => p.id === line.fromPort) : outputs[0]
    if (!out) {
      problems.push(`"${fromDef.type}" has no output "${line.fromPort ?? '(first)'}"`)
      continue
    }
    const into = line.toPort
      ? inputs.find((p) => p.id === line.toPort)
      : (inputs.find((p) => isAssignable(out.type, p.type)) ?? inputs[0])
    if (!into) {
      problems.push(`"${toDef.type}" has no input "${line.toPort ?? '(first)'}"`)
      continue
    }
    if (!isAssignable(out.type, into.type)) {
      problems.push(
        `${fromDef.type}:${out.id} (${typeLabel(out.type)}) does not fit ${toDef.type}:${into.id} (${typeLabel(into.type)})`,
      )
    }

    void cards
    wires.push({
      from: line.from,
      fromPort: out.id,
      to: line.to,
      toPort: into.id,
      family: socketStyle(out.type).family,
      path: '',
    })
  }

  return wires
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Layer left to right, then pull each card towards the cards feeding it.
 *
 * Sugiyama's first two phases and none of the rest: layers by longest path, then one downward
 * pass placing each card at the mean height of its upstream sockets and pushing overlaps apart.
 * That is enough because a figure is four or five cards — the crossing-reduction phase a real
 * layout engine spends its time in has nothing to reduce at this size, and ELK, which the canvas
 * uses, is asynchronous and 200 kB.
 *
 * **A cycle cannot hang this**: the depth pass relaxes a bounded number of times and stops,
 * which puts the back edge's target in the same layer rather than in an infinite one. Figures of
 * cyclic pipelines are not a thing Coda has, but a typo that makes one is.
 */
function layout(
  cards: FigureCard[],
  wires: readonly FigureWire[],
): { width: number; height: number } {
  if (cards.length === 0) return { width: 0, height: 0 }

  const depth = new Map<string, number>(cards.map((c) => [c.alias, 0]))
  for (let pass = 0; pass < cards.length; pass++) {
    let moved = false
    for (const wire of wires) {
      const next = (depth.get(wire.from) ?? 0) + 1
      if (next > (depth.get(wire.to) ?? 0)) {
        depth.set(wire.to, next)
        moved = true
      }
    }
    if (!moved) break
  }

  const columns: FigureCard[][] = []
  for (const card of cards) {
    const d = depth.get(card.alias) ?? 0
    const column = columns[d] ?? []
    column.push(card)
    columns[d] = column
  }

  let x = 0
  for (const column of columns) {
    if (!column) continue
    const widest = Math.max(...column.map((c) => c.width))
    for (const card of column) card.x = x
    x += widest + COL_GAP
  }

  const upstream = new Map<string, FigureWire[]>()
  for (const wire of wires) {
    const feeds = upstream.get(wire.to) ?? []
    feeds.push(wire)
    upstream.set(wire.to, feeds)
  }
  const byAlias = new Map(cards.map((c) => [c.alias, c]))

  for (const column of columns) {
    if (!column) continue
    for (const card of column) {
      const feeds = upstream.get(card.alias) ?? []
      const anchors = feeds
        .map((wire) => {
          const source = byAlias.get(wire.from)
          if (!source) return undefined
          const port = source.outputs.find((p) => p.id === wire.fromPort)
          return source.y + (port?.y ?? source.height / 2)
        })
        .filter((v): v is number => v !== undefined)
      if (anchors.length === 0) continue
      const mean = anchors.reduce((a, b) => a + b, 0) / anchors.length
      const port = card.inputs.find((p) => p.id === (feeds[0]?.toPort ?? ''))
      card.y = mean - (port?.y ?? card.height / 2)
    }
    // Sorted before separating, so a card pulled above one declared before it keeps that order
    // rather than being pushed back down through it.
    const order = [...column].sort((a, b) => a.y - b.y)
    let floor = -Infinity
    for (const card of order) {
      if (card.y < floor) card.y = floor
      floor = card.y + card.height + ROW_GAP
    }
  }

  const top = Math.min(...cards.map((c) => c.y))
  for (const card of cards) card.y -= top

  return {
    width: Math.max(...cards.map((c) => c.x + c.width)),
    height: Math.max(...cards.map((c) => c.y + c.height)),
  }
}

function attachPaths(wires: FigureWire[], cards: ReadonlyMap<string, FigureCard>): void {
  for (const wire of wires) {
    const from = cards.get(wire.from)
    const to = cards.get(wire.to)
    if (!from || !to) continue
    const out = from.outputs.find((p) => p.id === wire.fromPort)
    const into = to.inputs.find((p) => p.id === wire.toPort)
    wire.path = wirePath(
      from.x + from.width,
      from.y + (out?.y ?? from.height / 2),
      to.x,
      to.y + (into?.y ?? to.height / 2),
    )
  }
}

// ---------------------------------------------------------------------------
// The settings figure
// ---------------------------------------------------------------------------

/**
 * `coda-params` — a node's settings as prose rows, with the `help` the app itself shows.
 *
 * The reason this exists rather than a markdown table: a settings table written by hand goes
 * stale the day a default changes, and the two things worth saying about a setting — what it
 * defaults to and what its tooltip says — are both already in the definition. What the document
 * adds is *which* settings are worth a paragraph, which is the one thing the registry cannot
 * know.
 *
 * Body is a node type, then the setting ids to show, one per line or comma-separated. No ids at
 * all means every non-advanced setting.
 */
function buildParamsFigure(text: string, options: FigureOptions): FigureParams {
  const problems: string[] = []
  let caption: string | undefined
  const tokens: string[] = []
  let type = ''

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const directive = DIRECTIVE.exec(line)
    if (directive) {
      if (directive[1] === 'caption') caption = directive[2]!.trim()
      continue
    }
    const at = line.indexOf(':')
    if (at !== -1 && type === '') {
      type = line.slice(0, at).trim()
      tokens.push(
        ...line
          .slice(at + 1)
          .split(/[,\s]+/)
          .filter(Boolean),
      )
      continue
    }
    if (type === '') {
      type = line
      continue
    }
    tokens.push(...line.split(/[,\s]+/).filter(Boolean))
  }

  const def = type ? getNodeDef(type) : undefined
  if (!def) {
    return {
      kind: 'params',
      type,
      label: type,
      rows: [],
      ...(caption ? { caption } : {}),
      problems: [type ? `No node type "${type}"` : 'No node type given'],
    }
  }
  void options

  const all = (def.params ?? []).filter((p) => !p.internal)
  const wanted = tokens.length
    ? tokens.map((id) => {
        const hit = all.find((p) => p.id === id)
        if (!hit) problems.push(`"${type}" has no setting "${id}"`)
        return hit
      })
    : all.filter((p) => !p.advanced)

  const rows: FigureParamRow[] = wanted
    .filter((p): p is ParamDef => p !== undefined)
    .map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      value: paramValueLabel(p),
      ...(p.help ? { help: p.help } : {}),
      advanced: p.advanced === true,
    }))

  return {
    kind: 'params',
    type: def.type,
    label: def.label,
    rows,
    ...(caption ? { caption } : {}),
    problems,
  }
}
