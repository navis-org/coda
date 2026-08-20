/**
 * Node-link network viewer, on Sigma's WebGL renderer.
 *
 * Sigma owns camera, hit-testing and drawing; this component owns the *encoding* — which
 * column drives colour, which drives size — through the shared `resolveColor`/`resolveSize`
 * pair, so the palette rules hold here exactly as they do in the bar chart.
 *
 * Two effects, deliberately:
 *
 *  - **structure** builds the graphology graph and the Sigma instance. It runs only when the
 *    data or the layout changes, because building one resets the camera.
 *  - **style** pushes colours, sizes, labels and arrowheads onto the existing graph. Every
 *    restyle, every selection change and every theme flip goes through here, so the view
 *    you framed survives them.
 *
 * Keeping those apart is the whole reason clicking a node no longer throws the camera back
 * to its default framing: a selection is a style change, not a rebuild.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type Graph from 'graphology'
import type Sigma from 'sigma'

import type { NetworkValue } from '../../core/values'
import { getColumn } from '../../core/values'
import type { ColorSpec, SizeSpec } from '../../nodes/lib/encodingParams'
import type { Mode } from '../colors'
import { CHART_INK, chartSurface, currentMode, withAlpha } from '../colors'
import type { ResolvedColor, ResolvedSize } from '../encoding'
import { resolveColor, resolveSize } from '../encoding'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCell } from '../format'
import { NetworkLegend } from './NetworkLegend'
import type { SvgEdge, SvgNode } from './networkDraw'
import { assignCurvatures, networkToSvg } from './networkDraw'
import { recallLayout, rememberLayout } from './layoutMemo'
import type {
  BarnesHut,
  ForceSeed,
  ForceSupervisor,
  LayoutName,
  Orientation,
  Positioned,
} from './networkLayout'
import {
  computeLayout,
  needsForceWorker,
  settleDuration,
  skipToSettled,
  startForceLayout,
} from './networkLayout'
import type { FocusSets, TipContent } from './networkStyle'
import {
  DIM_EDGE,
  DIM_NODE,
  NO_FOCUS,
  describeEdgeTip,
  describeNodeTip,
  dimColor,
  edgeInFocus,
  focusSets,
  makeNodeLabelDrawer,
  makeSelectionRingDrawer,
  tipColumns,
} from './networkStyle'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useStable } from './useStable'
import { errorMessage } from '../../core/errors'

export interface NetworkViewerProps {
  network: NetworkValue
  layout: LayoutName
  /**
   * Positions from the node's `Layout` input, which override `layout` when present.
   *
   * Absent for every network that has nothing wired to that socket, which is why it is not
   * folded into `LayoutName`: the mode somebody chose stays chosen and comes back the moment
   * the wire is pulled.
   */
  given?: Readonly<Record<string, { x: number; y: number }>> | undefined
  iterations: number
  xColumn?: string | undefined
  yColumn?: string | undefined
  /** `layered` only. */
  orientation?: Orientation
  layerColumn?: string | undefined
  /** `grouped` only. */
  groupColumn?: string | undefined
  /** `forceatlas2` only. */
  seed?: ForceSeed
  barnesHut?: BarnesHut
  /** How much link weight pulls in the force layout. 0 ignores it, 1 is proportional. */
  weightInfluence?: number
  /**
   * Stable identity for the layout cache — the graph node this viewer is showing.
   *
   * Given one, a settled layout survives closing the viewer and is shared between the card,
   * the inspector and the overlay. Without one the cache is per-mount, which is the behaviour
   * this had before: positions live only as long as the component.
   */
  viewerId?: string | undefined
  nodeColor: ColorSpec
  nodeSize: SizeSpec
  /** Outline in the surface colour, in screen pixels. 0 removes it. */
  nodeBorderWidth?: number
  edgeColor: ColorSpec
  edgeSize: SizeSpec
  /** Constant alpha over every link, for reading a dense graph. */
  edgeOpacity?: number
  showLabels: boolean
  labelColumn?: string | undefined
  /** Arrowheads on a directed network. Ignored when the network is undirected. */
  arrows?: boolean
  /** Draw each link's weight alongside it. */
  edgeLabels?: boolean
  edgeLabelColumn?: string | undefined
  selection: string[]
  /**
   * Size of the network *before* the node's filters ran, so the caption can say what is
   * missing. Absent when the viewer is not showing a filtered node's output.
   */
  sourceCounts?: { nodes: number; links: number }
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Past this, a force layout takes long enough that it needs a different approach. */
const MAX_NODES = 20_000

/**
 * Hover tooltips need sigma's edge picking pass, which renders every link a second time
 * into an off-screen texture. Worth it for a readable weight; not worth it on a hairball
 * nobody can hover a single link in anyway.
 */
const EDGE_EVENT_LIMIT = 8_000

/** Above this, links are dropped while the camera moves so panning stays smooth. */
const HIDE_EDGES_ON_MOVE_ABOVE = 4_000

/**
 * Below these, every label is *forced* — drawn regardless of sigma's culling.
 *
 * Sigma's defaults thin labels three ways at once: a node smaller than
 * `labelRenderedSizeThreshold` (6px) never gets one, at most `labelDensity` labels are drawn
 * per 100px grid cell, and an edge label appears only if *both* its endpoints' labels are
 * already drawn. Together that makes labels come and go with zoom and pan, and makes link
 * labels impossible with node labels switched off. For a graph small enough to label
 * exhaustively — which is most type-level connectomes — asking for labels should just mean
 * labels. Above the cap the culling comes back, and the caption says so.
 */
const FORCE_NODE_LABELS_BELOW = 250
const FORCE_EDGE_LABELS_BELOW = 400

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

/** Counter behind the per-mount cache key; see `memoKey`. */
let anonymousViewers = 0

/**
 * A cheap stand-in for a set of given positions, for the layout memo's signature.
 *
 * Not `JSON.stringify` of the positions: that is two floats per node in a string rebuilt on
 * every render of the structure effect's dependency list, on a value that may carry thousands
 * of nodes. Summing the coordinates alongside the count catches every change that actually
 * moves something — the node *set* is already compared separately, by id, before a memo is
 * reused at all.
 */
export function fingerprintPositions(
  positions: Readonly<Record<string, { x: number; y: number }>> | undefined,
): string {
  if (!positions) return ''
  let count = 0
  let sum = 0
  for (const key in positions) {
    const at = positions[key]
    if (!at) continue
    count += 1
    sum += at.x + at.y
  }
  return `${count}:${Math.round(sum)}`
}

interface Rendered {
  graph: Graph
  sigma: Sigma
  /** Node ids in insertion order; the index is also the attribute-table row. */
  nodeIds: string[]
  /** Sigma edge keys paired with the edge-table row they came from. */
  edges: Array<{ key: string; row: number }>
  /** Present only for the force layout, which is the only one that keeps moving. */
  supervisor?: ForceSupervisor | undefined
}

interface Placement {
  /** Container-relative pixels, tracking the pointer. */
  x: number
  y: number
  /** Anchor to the tooltip's right edge / below the pointer, near the viewer's edges. */
  flip: boolean
  below: boolean
}

interface Tip extends TipContent, Placement {
  /** Which mark summoned it, so a link under the pointer cannot displace a node's tooltip. */
  kind: 'node' | 'edge'
}

/**
 * Tooltip geometry, mirrored by `.network-tip` in the stylesheet.
 *
 * There are no text metrics without layout, so the height is estimated from the row count
 * rather than measured — the same approach the SVG legend takes. It only has to be close:
 * its whole job is deciding which side of the pointer the box hangs off.
 */
const TIP_MAX_WIDTH = 200
const TIP_TITLE_HEIGHT = 18
const TIP_ROW_HEIGHT = 14
const TIP_GAP = 8

/**
 * Keep the tooltip inside the viewer. It lives in an `overflow: hidden` box, so a tooltip
 * that overhangs is not merely awkward — it is cut off.
 *
 * A node's tooltip carries a title and up to six rows, so unlike the single-line link
 * tooltip this grew from, it is tall enough that "is there room above the pointer?" has to
 * be asked against its actual row count.
 */
function tipPlacement(
  size: { width: number; height: number },
  event: { x: number; y: number },
  rows: number,
): Placement {
  const tall = TIP_TITLE_HEIGHT + rows * TIP_ROW_HEIGHT + TIP_GAP
  return {
    x: event.x,
    y: event.y,
    flip: event.x > size.width - TIP_MAX_WIDTH,
    below: event.y < tall,
  }
}

/** Neighbour lookup tolerating ids the graph lacks — a selection can outlive its node. */
function neighbourLookup(graph: Graph): (id: string) => Iterable<string> {
  return (id) => (graph.hasNode(id) ? graph.neighbors(id) : [])
}

interface NetworkStyle {
  colors: ResolvedColor
  sizes: ResolvedSize
  borderWidth: number
  edgeColors: ResolvedColor
  edgeOpacity: number
  edgeWidths: ResolvedSize
  /** Undefined when labels are switched off. */
  nodeLabels: string[] | undefined
  edgeLabels: string[] | undefined
  curvatures: number[]
  arrows: boolean
  mode: Mode
}

/**
 * `useStable` for a set of positions, keyed by the cheap fingerprint rather than by JSON.
 *
 * A layout arrives from the scheduler's cache and so is *already* identity-stable in practice
 * — but the structure effect is the most expensive dependency list in this component (see
 * `networkRebuild.test.tsx`), and "in practice" is what it went wrong on last time. This costs
 * one pass over the record per render and no allocation, where `useStable` would stringify two
 * floats per node.
 */
function useStablePositions(
  value: Readonly<Record<string, { x: number; y: number }>> | undefined,
): Readonly<Record<string, { x: number; y: number }>> | undefined {
  const key = fingerprintPositions(value)
  const held = useRef<{
    key: string
    value: Readonly<Record<string, { x: number; y: number }>> | undefined
  }>({ key, value })
  if (held.current.key !== key) held.current = { key, value }
  return held.current.value
}

/** Sigma edge program for a link, given whether it needs an arrowhead and whether it bows. */
function edgeType(arrow: boolean, curved: boolean): string {
  if (curved) return arrow ? 'curvedArrow' : 'curve'
  return arrow ? 'arrow' : 'line'
}

/**
 * Links take *muted* ink, not grid ink.
 *
 * A link is a mark carrying data, not chrome. Grid ink is 1.27:1 against the dark surface
 * and 1.33:1 against the light one — below the 3:1 floor for non-text, which is to say
 * invisible, and an arrowhead nobody can see indicates no direction at all. Muted is
 * 4.9:1 dark / 3.5:1 light and stays achromatic, so it never competes with the categorical
 * node colours. Labels stay in text ink, a step brighter, so they read on top of the lines.
 */
function linkColor(mode: Mode): string {
  return CHART_INK[mode].muted
}

/** Push the current encoding onto an existing graph, then repaint. */
function applyStyle(
  rendered: Rendered,
  style: NetworkStyle,
  directed: boolean,
  isSelected: (id: string) => boolean,
): void {
  const { graph, sigma } = rendered
  const ink = CHART_INK[style.mode]
  const links = linkColor(style.mode)
  const border = chartSurface(style.mode)

  const forceNodeLabels =
    style.nodeLabels !== undefined && graph.order <= FORCE_NODE_LABELS_BELOW
  const forceEdgeLabels =
    style.edgeLabels !== undefined && graph.size <= FORCE_EDGE_LABELS_BELOW

  // Bulk updaters, not per-item setters: graphology fires one aggregate event for these,
  // where a `setNodeAttribute` loop fires one refresh per node.
  graph.updateEachNodeAttributes(
    (_id, attrs) => {
      const row = Number(attrs.row)
      return {
        ...attrs,
        color: style.colors.at(row),
        // The border eats *inward* from the radius, so the encoded size is added back to it.
        // Without that a size-4 node loses 44% of its area to a 1px outline, and the size
        // encoding stops meaning what its legend says.
        size: style.sizes.at(row) + style.borderWidth,
        borderColor: border,
        borderSize: style.borderWidth,
        label: style.nodeLabels?.[row] ?? '',
        forceLabel: forceNodeLabels,
      }
    },
    { attributes: ['color', 'size', 'borderColor', 'borderSize', 'label', 'forceLabel'] },
  )

  const arrows = directed && style.arrows
  graph.updateEachEdgeAttributes(
    (_key, attrs) => {
      const row = Number(attrs.row)
      const curvature = style.curvatures[row] ?? 0
      return {
        ...attrs,
        size: style.edgeWidths.at(row),
        color: withAlpha(style.edgeColors.at(row), style.edgeOpacity),
        curvature,
        type: edgeType(arrows, curvature !== 0),
        label: style.edgeLabels?.[row] ?? '',
        forceLabel: forceEdgeLabels,
      }
    },
    { attributes: ['size', 'color', 'curvature', 'type', 'label', 'forceLabel'] },
  )

  sigma.setSettings({
    renderLabels: style.nodeLabels !== undefined,
    renderEdgeLabels: style.edgeLabels !== undefined,
    labelColor: { color: ink.secondary },
    edgeLabelColor: { color: ink.secondary },
    defaultEdgeColor: links,
    // Both drawers replace a sigma default that is wrong here rather than merely plain: its
    // labels carry no halo where the SVG export's do, and its hover draws a hardcoded white
    // pill that every *selected* node was being routed through. See `networkStyle.ts`.
    defaultDrawNodeLabel: makeNodeLabelDrawer(style.mode),
    defaultDrawNodeHover: makeSelectionRingDrawer(style.mode, isSelected),
    // Forced labels are drawn every frame anyway, so dropping them mid-gesture would only
    // make them flicker. Above the cap they are being culled regardless, and skipping the
    // 2D-canvas text pass is the cheapest way to keep a pan smooth.
    hideLabelsOnMove: !forceNodeLabels,
  })
  sigma.refresh()
}

export function NetworkViewer({
  network,
  given,
  layout,
  iterations,
  xColumn,
  yColumn,
  orientation,
  layerColumn,
  groupColumn,
  seed,
  barnesHut,
  weightInfluence,
  viewerId,
  nodeColor,
  nodeSize,
  nodeBorderWidth = 1,
  edgeColor,
  edgeSize,
  edgeOpacity = 1,
  showLabels,
  labelColumn,
  arrows = true,
  edgeLabels = false,
  edgeLabelColumn,
  selection,
  sourceCounts,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: NetworkViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef<Rendered | null>(null)
  /*
   * Cache key. Falls back to a per-mount id so a viewer with no identity behaves as it always
   * did — positions surviving a rebuild, but not an unmount.
   */
  const fallbackKey = useRef<string>(`anon-${++anonymousViewers}`)
  const memoKey = viewerId ?? fallbackKey.current
  /*
   * A boolean, not a tri-state. It was `'idle' | 'laying-out' | 'ready'`, but only
   * `'laying-out'` was ever distinguished at the render site — so `'idle'` and `'ready'` were
   * interchangeable, including on the error path, which set `'idle'` and looked like it was
   * signalling something.
   */
  const [layingOut, setLayingOut] = useState(false)
  const [tip, setTip] = useState<Tip | null>(null)
  /** Whether the force layout is still moving. Undefined for the static layouts. */
  const [settling, setSettling] = useState<boolean | undefined>(undefined)
  const [query, setQuery] = useState('')
  /*
   * Bumped to re-run the layout from scratch. It sits in the structure effect's dependency
   * list, so a bump rebuilds — which is heavy, and is exactly what "lay it out again" means.
   * The camera survives, because `sameIds` still matches and the saved state is restored.
   */
  const [layoutNonce, setLayoutNonce] = useState(0)
  const mode = currentMode()

  // Every spec below arrives as a fresh object each render; pin them by value so the
  // memoised encodings — and the effects keyed on them — only change when they mean to.
  const stableGiven = useStablePositions(given)
  const stableNodeColor = useStable(nodeColor)
  const stableNodeSize = useStable(nodeSize)
  const stableEdgeColor = useStable(edgeColor)
  const stableEdgeSize = useStable(edgeSize)
  const stableSelection = useStable(selection)

  const selectionSet = useMemo(() => new Set(stableSelection), [stableSelection])
  const selectionRef = useRef(selectionSet)
  selectionRef.current = selectionSet
  const isSelected = useCallback((id: string) => selectionRef.current.has(id), [])

  /*
   * What the focus view is anchored on, and which node the pointer is over.
   *
   * Refs rather than state because the sigma reducers read them on every repaint: routing
   * either through React would put a re-render between a pointer move and the frame that
   * answers it. `hoveredNodeRef` is also how a hover overrides the selection's focus and
   * hands it back on leave.
   */
  const focusRef = useRef<FocusSets>(NO_FOCUS)
  const hoveredNodeRef = useRef<string | null>(null)
  // Read by the selection effect, which must not take the focus back from a live search.
  const queryRef = useRef(query)
  queryRef.current = query

  const networkRef = useRef(network)
  networkRef.current = network
  const iterationsRef = useRef(iterations)
  iterationsRef.current = iterations
  const barnesHutRef = useRef(barnesHut)
  barnesHutRef.current = barnesHut
  const weightInfluenceRef = useRef(weightInfluence)
  weightInfluenceRef.current = weightInfluence
  const onSelectionRef = useRef(onSelectionChange)
  onSelectionRef.current = onSelectionChange
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const nodeIds = useMemo(
    () => getColumn(network.nodes, 'id').map((cell) => String(cell ?? '')),
    [network.nodes],
  )

  const colors = useMemo(
    () => resolveColor(network.nodes, stableNodeColor, mode),
    [network.nodes, stableNodeColor, mode],
  )
  const sizes = useMemo(
    () => resolveSize(network.nodes, stableNodeSize),
    [network.nodes, stableNodeSize],
  )
  const edgeColors = useMemo(
    () => resolveColor(network.edges, stableEdgeColor, mode),
    [network.edges, stableEdgeColor, mode],
  )
  const edgeWidths = useMemo(
    () => resolveSize(network.edges, stableEdgeSize, { areaScaled: false }),
    [network.edges, stableEdgeSize],
  )
  const curvatures = useMemo(() => assignCurvatures(network), [network])

  const nodeLabels = useMemo(() => {
    if (!showLabels) return undefined
    const column = labelColumn ? network.nodes.data[labelColumn] : undefined
    return nodeIds.map((id, i) => String(column?.[i] ?? id))
  }, [nodeIds, network.nodes, labelColumn, showLabels])

  const edgeLabelText = useMemo(() => {
    if (!edgeLabels) return undefined
    const column = network.edges.data[edgeLabelColumn || 'weight']
    if (!column) return undefined
    return Array.from({ length: network.edges.length }, (_, i) => {
      const cell = column[i]
      if (cell === null || cell === undefined) return ''
      return formatCell(cell, edgeLabelColumn || 'weight')
    })
  }, [network.edges, edgeLabels, edgeLabelColumn])

  const nodeLabelsRef = useRef(nodeLabels)
  nodeLabelsRef.current = nodeLabels

  // The columns a node tooltip reports: whatever the encodings named, then the roll-ups.
  const tipFields = useMemo(
    () => tipColumns(network.nodes.schema, [stableNodeColor.column, stableNodeSize.column]),
    [network.nodes.schema, stableNodeColor.column, stableNodeSize.column],
  )
  const tipFieldsRef = useRef(tipFields)
  tipFieldsRef.current = tipFields

  const style = useMemo<NetworkStyle>(
    () => ({
      colors,
      sizes,
      borderWidth: Math.max(0, nodeBorderWidth),
      edgeColors,
      edgeOpacity,
      edgeWidths,
      nodeLabels,
      edgeLabels: edgeLabelText,
      curvatures,
      arrows,
      mode,
    }),
    [
      colors,
      sizes,
      nodeBorderWidth,
      edgeColors,
      edgeOpacity,
      edgeWidths,
      nodeLabels,
      edgeLabelText,
      curvatures,
      arrows,
      mode,
    ],
  )
  // Read by the structure effect, which finishes asynchronously and so cannot rely on the
  // style effect having run.
  const styleRef = useRef(style)
  styleRef.current = style

  const exportSource: ExportSource = useMemo(
    () => ({
      // Nodes and edges are two tables; the node table is the one people want in a
      // spreadsheet, and the edge table is reachable from the passthrough output.
      csv: () => tableToCsvParts(network.nodes),
      svg: () => buildSvg(renderedRef.current, styleRef.current, network),
    }),
    [network],
  )

  const tooBig = network.nodes.length > MAX_NODES
  const empty = network.nodes.length === 0

  // What the node's filters removed. Silence here would leave a graph that is simply smaller
  // than the data with nothing on screen to say why — the same failure `labels thinned` was
  // added to avoid.
  const hiddenNodes = Math.max(0, (sourceCounts?.nodes ?? 0) - network.nodes.length)
  const hiddenLinks = Math.max(0, (sourceCounts?.links ?? 0) - network.edges.length)
  const filteredNote = [
    hiddenNodes > 0 ? `${hiddenNodes.toLocaleString()} nodes` : '',
    hiddenLinks > 0 ? `${hiddenLinks.toLocaleString()} links` : '',
  ]
    .filter(Boolean)
    .join(', ')

  // Labels past these caps are thinned by the renderer. Say so rather than let people
  // conclude the viewer is unreliable.
  const thinned =
    (showLabels && network.nodes.length > FORCE_NODE_LABELS_BELOW) ||
    (edgeLabels && network.edges.length > FORCE_EDGE_LABELS_BELOW)

  // Both read through refs so they stay stable: the structure effect lists them as
  // dependencies, and a fresh identity per render would rebuild the renderer.
  const describeEdge = useCallback(
    (row: number): TipContent => describeEdgeTip(networkRef.current, row),
    [],
  )
  const describeNode = useCallback(
    (row: number): TipContent =>
      describeNodeTip(
        networkRef.current,
        row,
        tipFieldsRef.current,
        nodeLabelsRef.current?.[row],
      ),
    [],
  )

  // --- structure: graph + renderer -----------------------------------------
  useEffect(() => {
    if (tooBig || empty) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let hoveredEdge: string | null = null
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    setLayingOut(true)

    /*
     * Everything that decides the arrangement. A stored layout is restored only while this
     * still matches, so switching algorithm, orientation or seed recomputes — and so does
     * pressing re-layout, since the nonce is in here.
     */
    const signature = JSON.stringify([
      fingerprintPositions(stableGiven),
      layout,
      iterations,
      xColumn,
      yColumn,
      orientation,
      layerColumn,
      groupColumn,
      seed,
      barnesHut,
      weightInfluence,
      layoutNonce,
    ])
    const remembered = recallLayout(memoKey, nodeIds, signature)

    const run = async () => {
      try {
        const [
          { default: Graphology },
          { default: SigmaRenderer },
          rendering,
          curve,
          nodeBorder,
          positions,
        ] = await Promise.all([
          import('graphology'),
          import('sigma'),
          import('sigma/rendering'),
          import('@sigma/edge-curve'),
          import('@sigma/node-border'),
          // A remembered layout skips the computation outright — including, for the force
          // layout, the settling that earned it.
          remembered?.positions ??
            computeLayout(network, {
              ...(stableGiven ? { given: stableGiven } : {}),
              layout,
              iterations,
              xColumn,
              yColumn,
              orientation,
              layerColumn,
              groupColumn,
              ...(seed ? { seed } : {}),
              ...(barnesHut ? { barnesHut } : {}),
              ...(weightInfluence === undefined ? {} : { weightInfluence }),
            }),
        ])
        if (cancelled) return

        const graph = new Graphology({
          type: network.directed ? 'directed' : 'undirected',
          multi: false,
        })

        nodeIds.forEach((id, row) => {
          const position = positions.get(id) ?? { x: 0, y: 0 }
          // `row` ties a graph node back to its attribute-table row, which is what every
          // encoding is indexed by. Insertion order would do the same job until the day
          // something reorders the graph.
          graph.addNode(id, {
            x: position.x,
            y: position.y,
            row,
            size: 4,
            color: '',
            label: '',
          })
        })

        const sourceColumn = getColumn(network.edges, 'source')
        const targetColumn = getColumn(network.edges, 'target')
        /*
         * `weight` is for the *layout*, not for drawing — sigma reads `size` for thickness and
         * ignores this. It has to be here because the worker settles this graph directly, and
         * graphology's weight getter coerces a missing attribute to 1 without complaint: the
         * force layout silently ignored synapse counts on every graph big enough to need the
         * worker, while every smaller one — which goes through `toGraphology` — used them.
         */
        const weightColumn = network.edges.data['weight']
        const edges: Rendered['edges'] = []
        for (let row = 0; row < network.edges.length; row++) {
          const source = String(sourceColumn[row] ?? '')
          const target = String(targetColumn[row] ?? '')
          if (source === target) continue
          if (!graph.hasNode(source) || !graph.hasNode(target)) continue
          if (graph.hasEdge(source, target)) continue
          const weight = Number(weightColumn?.[row] ?? 1)
          edges.push({
            key: graph.addEdge(source, target, {
              row,
              size: 1,
              label: '',
              weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
            }),
            row,
          })
        }

        if (cancelled) return
        renderedRef.current?.sigma.kill()

        const sigma = new SigmaRenderer(graph, container, {
          labelSize: 11,
          labelFont: FONT,
          edgeLabelFont: FONT,
          edgeLabelSize: 10,
          minCameraRatio: 0.05,
          maxCameraRatio: 20,
          // Sigma's wheel defaults animate a 1.7× jump over 250ms and swallow any further
          // tick inside 50ms of the last. On a trackpad, which emits a stream of small
          // deltas, that reads as lag: most events are dropped and the survivors overshoot.
          // Smaller steps over a shorter animation track the gesture instead.
          zoomingRatio: 1.25,
          zoomDuration: 110,
          // Sigma hides a label whose node renders smaller than this, which with a default
          // node size of 4 means "no labels until you zoom in". Importance is already
          // expressed by the label grid, which ranks candidates by size.
          labelRenderedSizeThreshold: 0,
          hideEdgesOnMove: network.edges.length > HIDE_EDGES_ON_MOVE_ABOVE,
          enableEdgeEvents: network.edges.length <= EDGE_EVENT_LIMIT,
          edgeProgramClasses: {
            line: rendering.EdgeLineProgram,
            arrow: rendering.EdgeArrowProgram,
            curve: curve.default,
            curvedArrow: curve.EdgeCurvedArrowProgram,
          },
          /*
           * Bordered discs. Sigma ships no such program, and a border is what stops a node
           * dissolving into the links crossing behind it.
           *
           * `mode: 'pixels'` keeps the outline one screen pixel at every zoom, rather than
           * growing with the camera. Note this deliberately passes no `drawLabel`/`drawHover`:
           * sigma prefers a program's own drawers over the settings, so supplying them here
           * would quietly discard the haloed labels and the selection ring.
           */
          nodeProgramClasses: {
            circle: nodeBorder.createNodeBorderProgram({
              borders: [
                {
                  color: { attribute: 'borderColor' },
                  size: { attribute: 'borderSize', defaultValue: 0, mode: 'pixels' },
                },
                { color: { attribute: 'color' }, size: { fill: true } },
              ],
            }),
          },
          /*
           * Everything outside the focused ego network *recedes*; nothing is erased.
           *
           * Each mark keeps its own hue and travels towards the surface instead, so the
           * context around a focus still has structure in it. Replacing the colour with a
           * flat ink — which this did — threw the categorical encoding away the moment
           * anything was selected, and on the dark canvas that ink was close enough to the
           * background that selecting one node read as deleting every other.
           *
           * `highlighted` is what routes a node through the hover canvas, which is where its
           * selection ring is drawn. See `makeSelectionRingDrawer`.
           */
          nodeReducer: (node, data) => {
            const selected = selectionRef.current.has(node)
            const { focus } = focusRef.current
            if (focus.size === 0 || focus.has(node)) {
              return selected ? { ...data, highlighted: true } : data
            }
            return {
              ...data,
              color: dimColor(String(data.color ?? ''), styleRef.current.mode, DIM_NODE),
              label: '',
            }
          },
          edgeReducer: (edge, data) => {
            const sets = focusRef.current
            if (sets.focus.size === 0) return data
            if (edgeInFocus(sets, graph.source(edge), graph.target(edge))) return data
            return {
              ...data,
              color: dimColor(String(data.color ?? ''), styleRef.current.mode, DIM_EDGE),
              label: '',
            }
          },
        })

        const refocus = (anchors: Iterable<string>) => {
          focusRef.current = focusSets(neighbourLookup(graph), anchors)
          sigma.refresh()
        }

        sigma.on('clickNode', ({ node }) => {
          const selected = selectionRef.current
          const next = selected.has(node)
            ? [...selected].filter((id) => id !== node)
            : [...selected, node]
          onSelectionRef.current?.(next)
        })
        sigma.on('clickStage', () => {
          if (selectionRef.current.size > 0) onSelectionRef.current?.([])
        })
        // Hovering a node focuses its ego network and reports what colour and size are
        // encoding — the numbers a reader can see the *effect* of and has no other way to
        // recover. Focus overrides the selection's rather than compounding it: a hover is a
        // momentary "show me this instead", and the selection returns on leave.
        sigma.on('enterNode', ({ node, event }) => {
          hoveredNodeRef.current = node
          refocus([node])
          const row = Number(graph.getNodeAttribute(node, 'row'))
          if (!Number.isFinite(row)) return
          const content = describeNode(row)
          setTip({
            ...tipPlacement(sigma.getDimensions(), event, content.lines.length),
            ...content,
            kind: 'node',
          })
        })
        sigma.on('leaveNode', () => {
          hoveredNodeRef.current = null
          refocus(selectionRef.current)
          setTip((current) => (current?.kind === 'node' ? null : current))
        })

        sigma.on('enterEdge', ({ edge, event }) => {
          // The node is drawn on top of its links, so it is what the pointer is really on;
          // a link entering underneath must not displace its tooltip.
          if (hoveredNodeRef.current) return
          const row = Number(graph.getEdgeAttribute(edge, 'row'))
          if (!Number.isFinite(row)) return
          hoveredEdge = edge
          const content = describeEdge(row)
          setTip({
            ...tipPlacement(sigma.getDimensions(), event, content.lines.length),
            ...content,
            kind: 'edge',
          })
        })
        sigma.on('leaveEdge', () => {
          hoveredEdge = null
          setTip((current) => (current?.kind === 'edge' ? null : current))
        })
        // Sigma announces the mark once, on entry. Following the pointer from there is
        // what makes the tooltip read as belonging to the cursor rather than to a spot.
        sigma.on('moveBody', ({ event }) => {
          if (!hoveredEdge && !hoveredNodeRef.current) return
          setTip((current) =>
            current
              ? {
                  ...current,
                  ...tipPlacement(sigma.getDimensions(), event, current.lines.length),
                }
              : current,
          )
        })

        // A rebuild starts from sigma's default framing. When the node set is unchanged —
        // a theme flip, a re-mount — that would silently throw away a view someone had
        // deliberately framed, so it is restored instead.
        if (remembered?.camera) sigma.getCamera().setState(remembered.camera)

        // A rebuild starts with nothing hovered, so the focus is whatever the selection
        // asks for — otherwise a selected graph would come back unfocused after a restyle.
        focusRef.current = focusSets(neighbourLookup(graph), selectionRef.current)
        renderedRef.current = { graph, sigma, nodeIds, edges }
        applyStyle(renderedRef.current, styleRef.current, network.directed, isSelected)
        setLayingOut(false)

        /*
         * The force layout settles in a worker, against the graph that now exists.
         *
         * Started here rather than beside `computeLayout` because the supervisor respawns its
         * worker on every `nodeAdded`/`edgeAdded`, so starting it before the graph was built
         * would restart the layout once per node. It also stops on a timer: an unattended
         * layout that never stops keeps a worker and a render loop alive behind whatever the
         * user does next.
         */
        // Only a graph too big to settle synchronously gets a supervisor; below the
        // threshold `computeLayout` has already returned finished positions.
        /*
         * Only a graph too big to settle synchronously gets a supervisor — and never one whose
         * layout was restored, because re-settling a layout somebody worked for is exactly the
         * loss the memo exists to prevent. Re-layout (↻) is how you ask for it to move again.
         */
        // Given positions are somebody's arrangement, not a seed: settling them would undo
        // the very thing that was handed in.
        if (
          !stableGiven &&
          layout === 'forceatlas2' &&
          needsForceWorker(nodeIds.length) &&
          !remembered
        ) {
          const supervisor = await startForceLayout(graph, barnesHut, weightInfluence)
          if (cancelled || renderedRef.current?.graph !== graph) {
            supervisor.kill()
            return
          }
          renderedRef.current.supervisor = supervisor
          setSettling(true)
          settleTimer = setTimeout(() => {
            supervisor.stop()
            setSettling(false)
          }, settleDuration(iterations))
        } else {
          setSettling(undefined)
        }
      } catch (error) {
        if (cancelled) return
        setLayingOut(false)
        onErrorRef.current?.(errorMessage(error))
      }
    }

    void run()
    return () => {
      cancelled = true
      if (settleTimer) clearTimeout(settleTimer)
      const current = renderedRef.current
      if (current) {
        // Read positions off the graph rather than off whatever was computed: the supervisor
        // has been moving them ever since, and where it stopped is what is worth keeping.
        const positions = new Map<string, Positioned>()
        current.graph.forEachNode((id, attrs) => {
          positions.set(id, { x: Number(attrs.x), y: Number(attrs.y) })
        })
        rememberLayout(memoKey, {
          nodeIds: current.nodeIds,
          signature,
          positions,
          camera: current.sigma.getCamera().getState(),
        })
        // Killed, not stopped: a stopped supervisor keeps its worker alive.
        current.supervisor?.kill()
        current.sigma.kill()
      }
      renderedRef.current = null
      hoveredNodeRef.current = null
      focusRef.current = NO_FOCUS
      setTip(null)
    }
  }, [
    network,
    nodeIds,
    stableGiven,
    layout,
    iterations,
    xColumn,
    yColumn,
    orientation,
    layerColumn,
    groupColumn,
    seed,
    barnesHut,
    weightInfluence,
    memoKey,
    layoutNonce,
    tooBig,
    empty,
    describeEdge,
    describeNode,
    isSelected,
  ])

  // --- style: everything that must not rebuild the renderer -----------------
  useEffect(() => {
    const rendered = renderedRef.current
    if (!rendered) return
    applyStyle(rendered, style, network.directed, isSelected)
  }, [style, network.directed, isSelected])

  /*
   * Search reuses the focus machinery rather than adding a second highlight channel — but it
   * anchors on *only* the matches, with no neighbourhood. A hover asks "what does this touch?";
   * a search asks "where are these?", and pulling in neighbours would answer a question nobody
   * typed. Links touching a match still light, which is what makes a match readable in place.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return nodeIds.filter((id, row) => {
      if (id.toLowerCase().includes(needle)) return true
      const label = nodeLabels?.[row]
      return !!label && label.toLowerCase().includes(needle)
    })
  }, [query, nodeIds, nodeLabels])

  useEffect(() => {
    const rendered = renderedRef.current
    if (!rendered) return
    if (query.trim()) {
      const set = new Set(matches)
      focusRef.current = { anchors: set, focus: set }
    } else if (hoveredNodeRef.current === null) {
      focusRef.current = focusSets(neighbourLookup(rendered.graph), selectionRef.current)
    }
    rendered.sigma.refresh()
  }, [query, matches])

  const fitToView = useCallback(() => {
    void renderedRef.current?.sigma.getCamera().animatedReset({ duration: 180 })
  }, [])

  const toggleSettling = useCallback(() => {
    const supervisor = renderedRef.current?.supervisor
    if (!supervisor) return
    if (supervisor.isRunning()) {
      supervisor.stop()
      setSettling(false)
    } else {
      supervisor.start()
      setSettling(true)
    }
  }, [])

  /**
   * Stop watching and land on the settled layout.
   *
   * Runs the remaining iterations synchronously, which blocks the main thread — acceptable
   * only because it takes an explicit press. `skipToSettled` bounds it by wall clock, but at
   * ten seconds that is a backstop against an unbounded graph rather than a promise of
   * responsiveness.
   */
  const skipSettling = useCallback(() => {
    const rendered = renderedRef.current
    if (!rendered?.supervisor) return
    rendered.supervisor.stop()
    setSettling(false)
    void skipToSettled(
      rendered.graph,
      iterationsRef.current,
      barnesHutRef.current,
      weightInfluenceRef.current,
    ).then(() => {
      renderedRef.current?.sigma.refresh()
    })
  }, [])

  // A selection is read from a ref by the reducers, so it only needs a repaint — but the
  // focus it anchors has to be recomputed, unless a hover is currently overriding it.
  useEffect(() => {
    const rendered = renderedRef.current
    if (!rendered) return
    // A live search owns the focus; neither a hover nor a selection may take it back until
    // the box is cleared.
    if (hoveredNodeRef.current === null && !queryRef.current.trim()) {
      focusRef.current = focusSets(neighbourLookup(rendered.graph), selectionSet)
    }
    rendered.sigma.refresh()
  }, [selectionSet])

  if (empty) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Network has no nodes</div>
      </div>
    )
  }

  if (tooBig) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {network.nodes.length.toLocaleString()} nodes is more than this viewer will lay out.
          <br />
          Aggregate upstream — group connectivity by type before building the network.
        </div>
      </div>
    )
  }

  return (
    <div className="viewer">
      <div
        ref={containerRef}
        className="network-canvas nowheel"
        style={{ background: chartSurface(mode) }}
      />

      {!compact && (
        /*
         * Verbs, not settings. Fitting the view, re-running a layout and freezing one are
         * *actions* — they have no value to store, so they cannot live in the styling panel
         * beside the params. Finding a node is here for the same reason: it is a way of
         * looking, and it writes nothing until you press Enter.
         */
        <div className="network-strip nodrag">
          <button
            type="button"
            className="network-strip__btn"
            title="Fit the whole graph in view"
            aria-label="Fit to view"
            onClick={fitToView}
          >
            ⤢
          </button>
          <button
            type="button"
            className="network-strip__btn"
            title="Lay the graph out again"
            aria-label="Re-run layout"
            onClick={() => setLayoutNonce((n) => n + 1)}
          >
            ↻
          </button>
          {settling !== undefined && (
            <>
              <button
                type="button"
                className="network-strip__btn"
                title={
                  settling ? 'Freeze the layout where it is' : 'Let the layout keep settling'
                }
                aria-label={settling ? 'Freeze layout' : 'Resume layout'}
                aria-pressed={!settling}
                onClick={toggleSettling}
              >
                {settling ? '❙❙' : '▶'}
              </button>
              <button
                type="button"
                className="network-strip__btn"
                title="Skip the animation and land on the settled layout"
                aria-label="Skip to settled layout"
                onClick={skipSettling}
              >
                ⏭
              </button>
            </>
          )}
          <input
            className="network-strip__find"
            type="search"
            value={query}
            placeholder="Find…"
            aria-label="Find nodes"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter turns a search into a selection, which is the only thing here that
              // writes to the graph — and it is undoable like any other selection change.
              if (event.key === 'Enter' && matches.length > 0) onSelectionRef.current?.(matches)
              if (event.key === 'Escape') setQuery('')
            }}
          />
          {query.trim() && (
            <span className="network-strip__count">{matches.length.toLocaleString()}</span>
          )}
        </div>
      )}

      {layingOut && <div className="viewer__overlay-note">laying out…</div>}

      {tip && (
        <div
          className="network-tip"
          style={{
            left: tip.x,
            top: tip.y,
            // Anchored to the pointer with a fixed gap rather than a multiple of the box's
            // own height, which with six rows would fling it clean out of the viewer.
            transform: `translate(${tip.flip ? '-100%' : '0'}, ${
              tip.below ? `${TIP_GAP}px` : `calc(-100% - ${TIP_GAP}px)`
            })`,
          }}
        >
          <div className="network-tip__title">{tip.title}</div>
          {tip.lines.map((line) => (
            <div key={line} className="network-tip__row">
              {line}
            </div>
          ))}
        </div>
      )}

      <NetworkLegend
        colors={colors}
        edgeColors={edgeColors}
        nodeSize={{ spec: stableNodeSize, resolved: sizes }}
        edgeWidth={{ spec: stableEdgeSize, resolved: edgeWidths }}
        compact={compact}
      />

      <div className="viewer__caption">
        <span>
          {network.nodes.length.toLocaleString()} nodes ·{' '}
          {network.edges.length.toLocaleString()} links
          {stableSelection.length > 0 && ` · ${stableSelection.length} selected`}
        </span>
        {filteredNote && !compact && (
          <span
            className="viewer__note"
            title="Removed by the Filter tab — from this node's output as well as from the drawing."
          >
            {filteredNote} filtered
          </span>
        )}
        {thinned && !compact && (
          <span className="viewer__note" title="Too many labels to draw them all — zoom in.">
            labels thinned
          </span>
        )}
        {stableGiven && !compact && (
          <span
            className="viewer__note"
            title="Positions came in on the Layout input, so the Layout setting is not being used."
          >
            layout from input
          </span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'network')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

/**
 * Snapshot the live view as SVG.
 *
 * Reads sigma's *display* data rather than the graph's own attributes, so the export
 * inherits whatever the reducers did — a focused selection exports focused — and takes
 * positions through the camera, so it exports the framing on screen rather than a
 * canonical one the user never chose.
 */
function buildSvg(
  rendered: Rendered | null,
  style: NetworkStyle,
  network: NetworkValue,
): SVGSVGElement | null {
  if (!rendered) return null
  const { graph, sigma, nodeIds, edges } = rendered
  const { width, height } = sigma.getDimensions()
  if (!width || !height) return null

  const minThickness = Number(sigma.getSetting('minEdgeThickness')) || 1
  // Which labels sigma actually drew, not which ones exist. Exporting every label of a
  // graph whose labels are being culled would produce a wall of overlapping text that the
  // screen never showed.
  const shownNodeLabels = sigma.getNodeDisplayedLabels()
  const shownEdgeLabels = sigma.getEdgeDisplayedLabels()

  const slot = new Map<string, number>()
  const nodes: SvgNode[] = []
  nodeIds.forEach((id) => {
    const display = sigma.getNodeDisplayData(id)
    if (!display || display.hidden) return
    const attrs = graph.getNodeAttributes(id)
    const at = sigma.graphToViewport({ x: Number(attrs.x), y: Number(attrs.y) })
    slot.set(id, nodes.length)
    nodes.push({
      id,
      x: at.x,
      y: at.y,
      radius: Math.max(1, sigma.scaleSize(display.size)),
      color: display.color,
      borderWidth: style.borderWidth,
      label: shownNodeLabels.has(id) ? (display.label ?? '') : '',
    })
  })

  const svgEdges: SvgEdge[] = []
  for (const { key, row } of edges) {
    const display = sigma.getEdgeDisplayData(key)
    if (!display || display.hidden) continue
    const source = slot.get(graph.source(key))
    const target = slot.get(graph.target(key))
    if (source === undefined || target === undefined) continue
    svgEdges.push({
      source,
      target,
      width: Math.max(minThickness, sigma.scaleSize(display.size)),
      color: display.color,
      curvature: style.curvatures[row] ?? 0,
      label: shownEdgeLabels.has(key) ? (display.label ?? '') : '',
    })
  }

  const ink = CHART_INK[style.mode]
  return networkToSvg({
    width,
    height,
    nodes,
    edges: svgEdges,
    arrows: network.directed && style.arrows,
    background: chartSurface(style.mode),
    nodeLabelColor: ink.secondary,
    edgeLabelColor: ink.secondary,
    nodeBorderColor: chartSurface(style.mode),
    font: FONT,
    ...(style.colors.legend ? { legend: style.colors.legend } : {}),
    title: `Network — ${nodes.length} nodes, ${svgEdges.length} links`,
  })
}
