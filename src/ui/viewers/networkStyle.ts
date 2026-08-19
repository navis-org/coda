/**
 * Focus, dimming, tooltips and the two canvas drawers the network viewer hands to sigma.
 *
 * Split out of `NetworkViewer` because none of it needs a GPU. jsdom has no WebGL, so
 * anything left inside that component is untestable by construction — which is why
 * CLAUDE.md has to record that this viewer's pixels have never been verified by anyone.
 * Everything here is a pure function over colours, ids and attribute rows, so it is as much
 * of the drawing as can be pinned down headlessly.
 */

import type { NodeHoverDrawingFunction, NodeLabelDrawingFunction } from 'sigma/rendering'

import type { TableSchema } from '../../core/types'
import type { NetworkValue, TableValue } from '../../core/values'
import type { Mode } from '../colors'
import { CHART_INK, chartSurface, mixHex } from '../colors'
import { formatNumber } from '../format'

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

export interface FocusSets {
  /** What the focus hangs off: the hovered node, or the selection. */
  anchors: Set<string>
  /** Anchors plus their neighbours — everything drawn at full strength. */
  focus: Set<string>
}

/** Nothing anchored, so the whole graph reads at full strength. */
export const NO_FOCUS: FocusSets = { anchors: new Set(), focus: new Set() }

/**
 * The ego network around a set of anchors.
 *
 * Takes a neighbour lookup rather than a graph so it stays independent of graphology, which
 * is what lets it be tested against a plain object.
 */
export function focusSets(
  neighbours: (id: string) => Iterable<string>,
  anchorIds: Iterable<string>,
): FocusSets {
  const anchors = new Set(anchorIds)
  if (anchors.size === 0) return NO_FOCUS
  const focus = new Set(anchors)
  for (const id of anchors) for (const near of neighbours(id)) focus.add(near)
  return { anchors, focus }
}

/**
 * Is this link part of the focused ego network?
 *
 * It has to *touch an anchor*, not merely join two focused nodes. Lighting every link
 * between neighbours would draw the whole neighbourhood's internal structure the moment you
 * hovered a hub, which is the hairball the focus view exists to cut through.
 */
export function edgeInFocus(sets: FocusSets, source: string, target: string): boolean {
  return sets.anchors.has(source) || sets.anchors.has(target)
}

// ---------------------------------------------------------------------------
// Dimming
// ---------------------------------------------------------------------------

/**
 * How far a de-emphasised mark travels towards the surface it sits on.
 *
 * Deliberately under the 3:1 non-text contrast floor: a dimmed mark is context, and the
 * point of a focus view is that only the ego network carries data. Links recede further than
 * nodes because there are far more of them — at equal recession the dimmed link mat still
 * reads as a hairball.
 *
 * These are recession levels applied to colours the palette has already validated, not new
 * hues, so the all-pairs colourblind gate does not apply to them. Dimming also never touches
 * a mark that is in focus, so nothing carrying information is affected.
 *
 * Note this blends each mark's *own* colour towards the surface rather than replacing it
 * with a flat grey. The previous flat `CHART_INK.axis` threw the categorical encoding away
 * the instant anything was selected, so the context you were keeping had no structure left
 * in it — and on the dark surface `#383835` against `#1a1a19` is close enough to invisible
 * that selecting one node read as deleting every other.
 */
export const DIM_NODE = 0.8
export const DIM_EDGE = 0.88

/**
 * Memo across the whole session, because the input set is tiny and the call rate is not.
 *
 * The reducers run `dimColor` per node *and* per link on every `sigma.refresh()`, and a
 * refresh fires on each `enterNode`/`leaveNode` — continuously while the pointer crosses the
 * graph. The encoding caps categorical colour at 8 slots plus the muted fallback, so at most
 * a handful of distinct inputs are ever seen, while a 5k-node connectome asks ~50k times per
 * hover transition. `mixHex` is pure, so this only trades a Map lookup for six hex parses.
 */
const dimmed = new Map<string, string>()

export function dimColor(color: string, mode: Mode, amount: number): string {
  const key = `${color}|${mode}|${amount}`
  let out = dimmed.get(key)
  if (out === undefined) {
    out = mixHex(color || CHART_INK[mode].muted, chartSurface(mode), amount)
    dimmed.set(key, out)
  }
  return out
}

// ---------------------------------------------------------------------------
// Canvas drawers
// ---------------------------------------------------------------------------

/** Ring thickness in screen pixels, outside the node's own radius. */
export const RING_WIDTH = 2

/**
 * Sigma passes the node's key alongside its display data — see the hover render pass in
 * `sigma/dist/sigma.esm.js`, which spreads `{ key: node }` into the argument — but the
 * published `NodeHoverDrawingFunction` type omits it. Read it narrowly rather than widening
 * the whole parameter.
 */
function hoverKey(data: unknown): string {
  const key = (data as { key?: unknown }).key
  return typeof key === 'string' ? key : ''
}

/**
 * A ring around each selected node, replacing sigma's own hover drawing.
 *
 * Sigma's default draws a hardcoded `#FFF` label box with a black drop shadow, and routes
 * every node carrying `highlighted` through it — so marking a selection lit a white blob on
 * the `#1a1a19` dark canvas, in a colour belonging to no palette.
 *
 * Two things worth knowing about the construction:
 *
 *  - It fills a *disc* slightly larger than the node, not a stroked circle. Sigma repaints
 *    the highlighted nodes in WebGL on top of this canvas, so the node's own colour covers
 *    the middle and what survives is a clean annulus.
 *  - The ring is achromatic on purpose. `--accent` is `#2a78d6` / `#3987e5`, byte-identical
 *    to categorical slot 0, so an accent-coloured ring would be invisible on exactly the
 *    nodes it was marking. Ink `primary` is maximally distinct from every slot and from both
 *    surfaces, and being achromatic it never competes with the categorical encoding — the
 *    same argument that puts link ink on `muted`.
 *
 * Sigma calls this for the hovered node as well as the selected ones, hence the predicate:
 * hover already reports itself through the focus dimming and the tooltip, and a hovered node
 * wearing the selection ring would read as having just been selected.
 */
export function makeSelectionRingDrawer(
  mode: Mode,
  isSelected: (id: string) => boolean,
): NodeHoverDrawingFunction {
  const ring = CHART_INK[mode].primary
  return (context, data) => {
    if (!isSelected(hoverKey(data))) return
    context.beginPath()
    context.arc(data.x, data.y, data.size + RING_WIDTH, 0, Math.PI * 2)
    context.closePath()
    context.fillStyle = ring
    context.fill()
  }
}

/** Halo width around label text, matching the `stroke-width` the SVG export uses. */
export const LABEL_HALO_WIDTH = 3

/**
 * Node labels with a halo.
 *
 * `networkToSvg` already haloes its labels — `paint-order: stroke` over a 3px stroke in the
 * background colour — because a label sitting on a bundle of links is otherwise unreadable.
 * Sigma's default drawer is a plain `fillText`, so until now the *exported file* was more
 * legible than the screen it was exported from.
 *
 * The offsets mirror sigma's `drawDiscNodeLabel` (`x + size + 3`, `y + size / 3`) so labels
 * keep the placement the rest of the viewer's geometry — the export included — assumes.
 */
export function makeNodeLabelDrawer(mode: Mode): NodeLabelDrawingFunction {
  const halo = chartSurface(mode)
  return (context, data, settings) => {
    if (!data.label) return
    const size = settings.labelSize
    const color = settings.labelColor.attribute
      ? String(
          (data as Record<string, unknown>)[settings.labelColor.attribute] ??
            settings.labelColor.color ??
            CHART_INK[mode].secondary,
        )
      : (settings.labelColor.color ?? CHART_INK[mode].secondary)

    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`
    const x = data.x + data.size + 3
    const y = data.y + size / 3

    context.strokeStyle = halo
    context.lineWidth = LABEL_HALO_WIDTH
    context.lineJoin = 'round'
    context.strokeText(data.label, x, y)
    context.fillStyle = color
    context.fillText(data.label, x, y)
  }
}

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

export interface TipContent {
  title: string
  lines: string[]
}

/** Roll-ups `BuildNetwork` always emits, shown after whatever the encodings named. */
const ROLLUP_COLUMNS = ['degreeIn', 'degreeOut', 'weightIn', 'weightOut']

/** A tooltip is a glance, not a table. */
export const MAX_TIP_ROWS = 6

/**
 * Which node attributes a tooltip should report.
 *
 * The encoded columns come first, because they are what the picture is *saying* and the only
 * values a reader has no other way to recover — colour and size announce that a node is big
 * and orange without ever saying what number that was. The degree roll-ups follow, since
 * `BuildNetwork` always emits them and they are what a connectome reader reaches for.
 *
 * Nothing is named that the schema does not have, the same rule Profile's tiles follow: a
 * row of dashes says less than an absent row.
 */
export function tipColumns(
  schema: TableSchema | undefined,
  encoded: Array<string | undefined>,
): string[] {
  if (!schema) return []
  const present = new Set(schema.columns.map((c) => c.name))
  const chosen: string[] = []
  const add = (name: string | undefined) => {
    if (!name || name === 'id') return
    if (!present.has(name) || chosen.includes(name)) return
    if (chosen.length < MAX_TIP_ROWS) chosen.push(name)
  }
  for (const name of encoded) add(name)
  for (const name of ROLLUP_COLUMNS) add(name)
  return chosen
}

function showCell(table: TableValue, name: string, row: number): string {
  const value = table.data[name]?.[row]
  if (value === null || value === undefined || value === '') return '—'
  return typeof value === 'number' ? formatNumber(value) : String(value)
}

export function describeNodeTip(
  network: NetworkValue,
  row: number,
  columns: string[],
  label?: string | undefined,
): TipContent {
  const id = String(network.nodes.data['id']?.[row] ?? '?')
  return {
    // The label is usually the id; saying it twice wastes the one wide line a tooltip has.
    title: label && label !== id ? `${label} · ${id}` : id,
    lines: columns.map((name) => `${name} ${showCell(network.nodes, name, row)}`),
  }
}

export function describeEdgeTip(network: NetworkValue, row: number): TipContent {
  const arrow = network.directed ? '→' : '–'
  const source = String(network.edges.data['source']?.[row] ?? '?')
  const target = String(network.edges.data['target']?.[row] ?? '?')
  const lines: string[] = []
  for (const name of ['weight', 'edges']) {
    const value = network.edges.data[name]?.[row]
    if (value === null || value === undefined) continue
    lines.push(`${name} ${showCell(network.edges, name, row)}`)
  }
  return { title: `${source} ${arrow} ${target}`, lines }
}
