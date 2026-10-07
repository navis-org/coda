/**
 * The Neuron Dendrogram card: one neuron's arbour flat, its synapses on it, and what lies distal
 * to a clicked point.
 *
 * Neuron Topology's sibling, and deliberately built from its parts: the same per-neuron fetch
 * (`useNeuronTopology`, one cache for both cards), the same partner list and lighting
 * (`usePartnerHighlight`, `PartnerList`), the same identity bar and rail. What is new is the stage —
 * a canvas over a layout from `nodes/lib/arborLayout.ts` — and the Distal tab.
 *
 * Everything that is arithmetic lives outside this file, where a test can reach it: the arbour
 * model in `nodes/lib/arborOps.ts`, the layouts beside it, the heal in `useHealedSkeleton`, the
 * screen geometry in `arborPlot.ts` and the marks themselves in `arborScene.ts` (one list for the
 * canvas, the SVG export and the hover). What stays is the state and the controls.
 *
 * Almost every control here writes a presentational param. The exceptions are the clicked point
 * and the root, which decide what the Points port carries and so mark the graph stale. The zoom
 * is not even a param, a window into the drawing being nobody's state but the reader's.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { idText } from '../../core/ids'
import type { EnumOption, ParamValue } from '../../core/node'
import { lowerBound, quantileSorted } from '../../core/stats'
import { column, findColumn, tableSchema } from '../../core/types'
import type { CellValue, DatasetAnnotations, DatasetEdges, TableValue } from '../../core/values'
import { getColumn, getRow, makeTable } from '../../core/values'
import { NM_PER_UM } from '../../data/units'
import type { ArborLayoutKind, ArborOrder, ArborShape } from '../../nodes/lib/arborLayout'
import { SUBWAY_DEFAULTS } from '../../nodes/lib/arborLayout'
import type { Arbor, ArborPoint, DistalRow, KeyTree } from '../../nodes/lib/arborOps'
import {
  buildArbor,
  distalSynapses,
  distanceAt,
  focusOn,
  electrotonicDistances,
  inSubtree,
  keyTree,
  landmarkDistances,
  orientPlacement,
  projectSynapses,
  pruneTwigs,
  resolveRoot,
  rootChoiceOf,
  stampedRadius,
  summariseDistal,
  synapseFlow,
  writeFocus,
} from '../../nodes/lib/arborOps'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { isSequentialPalette } from '../../nodes/lib/heatmapParams'
import type { PartnerGrouping } from '../../nodes/lib/profileStats'
import { polarityColumn, sitesFrom, strahlerOrders } from '../../nodes/lib/topologyOps'
import { BRANCH_PALETTE_OPTIONS } from '../../nodes/output/neuronDendrogram'
import {
  CHART_INK,
  chartSurface,
  currentMode,
  heatmapSequentialColor,
  seriesColor,
  sequentialColor,
} from '../colors'
import { LEGEND_KEYS, resolveColor } from '../encoding'
import { exportBaseName } from '../export'
import { formatCompact, formatMeasure, formatNumber, niceTicks, plural } from '../format'
import { mediaMatches } from '../mediaQuery'
import { REDUCED_MOTION } from '../useThemeMode'
import type { ArborView, PieceGeometry, PlotTransform, SubSegments } from './arborPlot'
import {
  arborPointAt,
  fitTransform,
  panBy,
  pickPiece,
  pieceGeometry,
  placeOnPiece,
  subSegments,
  synapseMarks,
  zoomAbout,
} from './arborPlot'
import type { BranchGroup, TickGroup } from './arborScene'
import { blendPieces, buildScene, nearestTick, paintScene, sceneToSvg } from './arborScene'
import { prepareCanvas, uiFontFamily } from './canvas2d'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import {
  HIGHLIGHT_COLUMN,
  HIGHLIGHT_OTHER,
  partnerLabel,
  partnerLabelColumn,
  partnerLabelsForIds,
  partnerTypesById,
} from './synapseHighlight'
import { useArborLayout } from './useArborLayout'
import { useElementSize } from './useElementSize'
import { useHealedSkeleton } from './useHealedSkeleton'
import { useNeuronTopology } from './useNeuronTopology'
import { usePanGesture } from './usePanGesture'
import type { PartnerNaming } from './usePartnerHighlight'
import { usePartnerHighlight } from './usePartnerHighlight'
import { tooltipPoint } from './tooltipPoint'
import { useStable } from './useStable'
import { useWheelZoom } from './useWheelZoom'
import { PartnerPanel, RailTabs, TopoBar } from './topoChrome'
import { ViewerEmpty } from './ViewerEmpty'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'

/** Every setting the card reads, as the params store them. */
export interface ArborSettings {
  layout: ArborLayoutKind
  metric: 'geodesic' | 'electrotonic'
  rm: number
  ri: number
  root: 'soma' | 'source' | 'picked'
  rootNode: number
  order: ArborOrder
  /** µm of geodesic cable. */
  minTwig: number
  angleChange: number
  angleDecrease: number
  daylight: number
  colorBy: string
  branchColor: BranchColor
  /** `red`, or one of the Heatmap's sequential palettes. */
  branchPalette: string
  widthBy: 'uniform' | 'radius'
  lineWidth: number
  synapseSize: number
  unlitOpacity: number
  /** Whether anybody has toggled a partner yet; until then the Partners port seeds the lit set. */
  partnersChosen: boolean
  grouping: PartnerGrouping
  direction: string
  partnerQuery: string
  focus: string
  tab: string
  railOpen: boolean
}

export interface NeuronDendrogramViewerProps {
  neurons: TableValue | undefined
  /** The Partners port's neurons, which seed the lit set while the card's own is empty. */
  partnerIds?: readonly string[]
  sourceId: string | undefined
  datasetId: string | undefined
  annotations?: DatasetAnnotations
  edges?: DatasetEdges
  page: number
  onPage: (page: number) => void
  pinned: readonly string[]
  onPin: (ids: string[]) => void
  partners: readonly string[]
  settings: ArborSettings
  /** `Colour synapses by`'s options, resolved from the param — the inspector's list exactly. */
  colorOptions: readonly EnumOption[]
  /** Writes one param; every setting above is a param of the same name. */
  onSetting: (id: keyof ArborSettings | 'partners', value: ParamValue) => void
  compact?: boolean
  /** The download's file name, the expand button and the error channel — `ValuePreview`'s. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

const TABS = [
  { id: 'partners', label: 'Partners' },
  { id: 'distal', label: 'Distal' },
  { id: 'settings', label: 'Settings' },
] as const

const LAYOUTS: Array<{ value: ArborLayoutKind; label: string }> = [
  { value: 'rectangular', label: 'Dendrogram' },
  { value: 'radial', label: 'Radial' },
  { value: 'subway', label: 'Subway' },
  { value: 'equalAngle', label: 'Unrooted' },
]

export type BranchColor = 'flat' | 'strahler' | 'flow' | 'distance'

const BRANCH_COLORS: Array<{ value: BranchColor; label: string }> = [
  { value: 'flat', label: 'Branches: one colour' },
  { value: 'strahler', label: 'Branches: Strahler order' },
  { value: 'flow', label: 'Branches: flow centrality' },
  { value: 'distance', label: 'Branches: distance to root' },
]

/** How long a change of layout takes to settle, in ms. Long enough to follow a branch, no more. */
const MORPH_MS = 450

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

/** Whether to animate at all: not where there is no frame clock, nor for a reader who asked not. */
function animates(): boolean {
  return typeof requestAnimationFrame === 'function' && !mediaMatches(REDUCED_MOTION)
}

/** A distance as the card prints it: µm from nanometres, or λ. */
function showDistance(value: number, inLambda: boolean): string {
  return inLambda ? `${value.toFixed(3)} λ` : formatMeasure(value / NM_PER_UM, 'µm')
}

/** A bar about a fifth of the plot wide, at a round length. */
function scaleBarFor(t: PlotTransform, inLambda: boolean): { px: number; label: string } {
  const visible = (t.width * 0.22) / t.sx
  const length = niceTicks(visible, 1)[1] ?? visible
  return {
    px: length * t.sx,
    label: inLambda ? `${length} λ` : formatMeasure(length / NM_PER_UM, 'µm'),
  }
}

/** The number of colour steps a branch value is drawn in — one stroke each, so few. */
const COLOR_STEPS = 24

/**
 * Where on the sequential ramp a branch value lands. The bottom quarter is skipped: the ramp is
 * built for heatmap cells, where low values receding into the surface is the point, and a branch
 * that recedes into the surface is a branch that has disappeared on the dark theme. Why red is
 * the default is `BRANCH_PALETTE_OPTIONS`' note.
 */
function branchRampColor(
  step: number,
  mode: ReturnType<typeof currentMode>,
  palette: string,
): string {
  const t = step / (COLOR_STEPS - 1)
  if (palette === 'red') return sequentialColor(0.25 + 0.75 * t, mode, 'red')
  if (palette === 'coda' || !isSequentialPalette(palette)) {
    return sequentialColor(0.25 + 0.75 * t, mode)
  }
  // The transcribed ramps run dark to light whatever the theme, so a tenth comes off each end:
  // the darkest step vanishes on the dark surface and the lightest (magma's near-white) on the
  // light one.
  return heatmapSequentialColor(0.1 + 0.8 * t, mode, palette)
}

interface BranchStyle {
  readonly sub: SubSegments
  readonly groups: BranchGroup[]
  /** Each drawn branch point's colour, for the connectors. */
  readonly landmarkColor?: string[]
  readonly legend?: { lo: number; hi: number }
}

/**
 * Every skeleton edge's colour and width, grouped into strokes.
 *
 * Colour comes from a value per node — Strahler order, flow centrality, distance — on the edge's
 * child end. Width comes from the radius, the mean of the edge's two ends, scaled so the 95th
 * percentile radius is twice the line width: the 3D viewer's rule (`flexLineMaterial.ts`), since
 * a single wide soma node would otherwise set the scale and thin every neurite to a hair.
 */
function branchStyle(o: {
  arbor: Arbor
  tree: KeyTree
  landmarkD: Float64Array
  nodeD: Float64Array
  radii: Float32Array | undefined
  values: Float64Array | undefined
  sqrt: boolean
  lineWidth: number
  flat: string
  mode: ReturnType<typeof currentMode>
  palette: string
}): BranchStyle {
  const sub = subSegments(o.arbor, o.tree, o.landmarkD, o.nodeD)
  let lo = Infinity
  let hi = -Infinity
  if (o.values) {
    // Over every reached node, the root included: a distance key starts at zero.
    for (const v of o.arbor.order) {
      const x = o.values[v]!
      if (!Number.isFinite(x)) continue
      if (x < lo) lo = x
      if (x > hi) hi = x
    }
  }
  const span = hi - lo
  const colorOf = (v: number): string => {
    if (!o.values || !(span >= 0)) return o.flat
    let t = span > 0 ? (o.values[v]! - lo) / span : 0
    if (o.sqrt) t = Math.sqrt(Math.max(0, t))
    return branchRampColor(Math.round(t * (COLOR_STEPS - 1)), o.mode, o.palette)
  }
  let p95 = 0
  if (o.radii) {
    const positive = Float64Array.from(o.arbor.order, (v) => o.radii![v]!)
      .filter((r) => r > 0)
      .sort()
    p95 = quantileSorted(positive, 0.95)
  }

  const groups = new Map<string, { color: string; width: number; sub: number[] }>()
  for (let i = 0; i < sub.node.length; i++) {
    const v = sub.node[i]!
    const color = colorOf(v)
    let width = o.lineWidth
    if (o.radii && p95 > 0) {
      const r = (o.radii[v]! + o.radii[o.arbor.parent[v]!]!) / 2
      // Quarter-pixel steps: enough to read, few enough strokes to paint every frame.
      width =
        Math.round(Math.min(o.lineWidth * 6, Math.max(0.5, (2 * o.lineWidth * r) / p95)) * 4) /
        4
    }
    const key = `${color}|${width}`
    const group = groups.get(key)
    if (group) group.sub.push(i)
    else groups.set(key, { color, width, sub: [i] })
  }
  return {
    sub,
    groups: [...groups.values()].map((g) => ({ ...g, sub: Int32Array.from(g.sub) })),
    ...(o.values ? { landmarkColor: Array.from(o.tree.nodes, colorOf) } : {}),
    ...(o.values && span >= 0 ? { legend: { lo, hi } } : {}),
  }
}

/** The branch colouring's key: what it measures, and its two ends in the measure's own units. */
function legendFor(
  kind: BranchColor,
  range: { lo: number; hi: number },
  show: (value: number) => string,
  palette: string,
): { title: string; stops: string[]; lo?: string; hi: string } {
  const mode = currentMode()
  const stops = Array.from({ length: 6 }, (_, i) =>
    branchRampColor((i * (COLOR_STEPS - 1)) / 5, mode, palette),
  )
  const [title, format]: [string, (value: number) => string] =
    kind === 'strahler'
      ? ['Strahler order', String]
      : kind === 'flow'
        ? ['Flow centrality (√ scale)', formatCompact]
        : ['Distance to root', show]
  // One value everywhere is said as one value: a ramp from 0 to 0 claims a range there is not.
  if (range.hi === range.lo) return { title, stops, hi: format(range.hi) }
  return { title, stops, lo: format(range.lo), hi: format(range.hi) }
}

/** The column `Partner type` colouring writes for `resolveColor`; `coda…` so the tooltip skips it. */
const PARTNER_TYPE_KEY = 'codaPartnerType'

/** Columns the tooltip states in its own words, so it does not list them twice. */
const NAMED_COLUMNS = new Set(['neuronId', 'partnerId', 'partnerType', 'polarity', 'type'])

/** The tooltip's heading where no partner can be read off the row yet. */
const NAMING_HEADER = {
  fetchable: 'Finding partner…',
  unnamed: 'Partner not named by this dataset',
} as const

/** What a hovered synapse is: its partner, its side, and how far out it sits. */
function SynapseTooltip({
  at,
  partners,
  synapse,
  attributes,
  typeById,
  side,
  fromRoot,
  fromFocus,
  show,
}: {
  at: { x: number; y: number }
  partners: PartnerNaming
  synapse: number
  attributes: TableValue
  typeById: Map<string, CellValue> | undefined
  side: string
  fromRoot: number
  fromFocus: number | undefined
  show: (value: number) => string
}) {
  const cell = (name: string): CellValue =>
    findColumn(attributes.schema, name) ? (getColumn(attributes, name)[synapse] ?? null) : null
  const partnerId = idText(cell('partnerId'))
  const typed = cell('partnerType') ?? (partnerId ? typeById?.get(partnerId) : null) ?? null
  const extra = attributes.schema.columns
    .filter((c) => !NAMED_COLUMNS.has(c.name) && !c.name.startsWith('coda'))
    .slice(0, 4)
  return (
    <ChartTooltip at={at}>
      <strong>
        {partners === 'named' ? String(typed ?? 'Untyped partner') : NAMING_HEADER[partners]}
      </strong>
      {partnerId && <TooltipRow>partner {partnerId}</TooltipRow>}
      <TooltipRow>
        {side === 'pre' ? 'Output (presynaptic)' : 'Input (postsynaptic)'}
      </TooltipRow>
      <TooltipRow>{show(fromRoot)} from the root</TooltipRow>
      {fromFocus !== undefined && (
        <TooltipRow>{show(fromFocus)} beyond the clicked point</TooltipRow>
      )}
      {extra.map((c) => {
        const value = cell(c.name)
        return value === null ? null : (
          <TooltipRow key={c.name}>
            {c.name}: {typeof value === 'number' ? formatNumber(value) : String(value)}
          </TooltipRow>
        )
      })}
    </ChartTooltip>
  )
}

export function NeuronDendrogramViewer(props: NeuronDendrogramViewerProps) {
  const {
    neurons,
    sourceId,
    datasetId,
    annotations,
    edges,
    page,
    onPage,
    pinned,
    onPin,
    settings,
    onSetting,
  } = props
  const { layout, metric, root, minTwig, grouping, direction, focus, tab, railOpen } = settings
  const partners = useStable(props.partners)
  const partnerIds = useStable(props.partnerIds ?? [])
  const mode = currentMode()

  const total = neurons?.length ?? 0
  // Clamped on read, never corrected in the store — Profile's pager rule.
  const index = total > 0 ? Math.min(Math.max(0, Math.floor(page)), total - 1) : 0
  const row = useMemo(
    () => (neurons && total > 0 ? getRow(neurons, index) : undefined),
    [neurons, index, total],
  )
  // Through `idText`, never `Number` — invariant 8, and this is the fetch key.
  const neuronId = row ? idText(row['neuronId']) : null
  const neuronName = String(row?.['type'] ?? row?.['instance'] ?? neuronId ?? '—')

  const loaded = useNeuronTopology(
    sourceId,
    datasetId,
    neuronId ?? undefined,
    annotations,
    edges,
  )
  const data = loaded.status === 'ready' ? loaded.data : undefined
  const raw = data?.skeletons?.items[0]
  const heal = useHealedSkeleton(data?.skeletons)
  // While a forest is being joined, the largest piece is drawn — `resolveRoot`'s choice.
  const healed = heal.status === 'ready' ? heal.data : undefined
  const skeleton = healed?.skeleton ?? raw

  /*
   * The Partners port seeds the lit set while the card's own is empty. Its ids are read in the
   * card's grouping — `partnerKey`, the same rule the list keys rows by — so a wired set of
   * neurons lights their types under the default grouping. The first toggle in the list writes
   * the param and `partnersChosen`, after which the card's own choice stands — an empty list
   * included, or unlighting the last seeded partner would light it straight back.
   */
  const seeded = useMemo(
    () =>
      settings.partnersChosen || partners.length > 0 || partnerIds.length === 0 || !data
        ? partners
        : partnerLabelsForIds(partnerIds, [data.inputs, data.outputs], grouping),
    [settings.partnersChosen, partners, partnerIds, data, grouping],
  )

  const distalTab = railOpen && tab === 'distal'
  // The Distal tab with a point clicked: the one state in which it reads every synapse's partner.
  const distalOpen = distalTab && focus !== ''
  /*
   * The neuron whose synapses have been hovered at least once. It asks the partner hook for every
   * synapse's partner — on neuPrint the link cloud, seconds on a big cell, which is why it waits
   * for a hover — and builds the tooltip's type lookup once rather than per tick entered. Kept as
   * the neuron's id rather than a flag, so paging lands on `false` in the same render.
   */
  const [hoveredOn, setHoveredOn] = useState<string | null>(null)
  const hoveredHere = neuronId !== null && hoveredOn === neuronId
  // Stable, so the hook's `togglePartner` is too rather than new on every pointer move.
  const partnersChosen = settings.partnersChosen
  const onPartners = useCallback(
    (next: string[]) => {
      onSetting('partners', next)
      if (!partnersChosen) onSetting('partnersChosen', true)
    },
    [onSetting, partnersChosen],
  )
  const highlight = usePartnerHighlight({
    data,
    sourceId,
    datasetId,
    neuronId: neuronId ?? undefined,
    annotations,
    partners: seeded,
    onPartners,
    grouping,
    direction,
    partnerQuery: settings.partnerQuery,
    listing: railOpen && tab === 'partners',
    /*
     * The Distal tab rolls synapses up by partner type, and colouring the ticks by partner type
     * reads the same, so both need every synapse to name its partner whether or not anything is
     * lit — which on neuPrint is the second query. Without this the summary fell back to "all
     * synapses" until somebody lit a partner.
     */
    needsPartners: distalOpen || hoveredHere || settings.colorBy === 'partnerType',
    mode,
  })
  /*
   * `cloud` carries the positions every measurement here is built on. Lighting a partner mints a
   * highlighted copy of it (`highlight.highlighted`); keying the 146 ms projection on that would
   * re-run it for a colour change, so only the colours read the copy.
   */
  const cloud = highlight.cloud
  // The link cloud repeats a presynaptic site once per partner it drives, so outputs read from it
  // are connections rather than release sites — the Distal tab says so.
  const perConnection = highlight.links.status === 'ready'

  /* --- the arbour --------------------------------------------------------------------- */

  const rooted = useMemo(
    () => (skeleton ? resolveRoot(skeleton, rootChoiceOf(root, settings.rootNode)) : undefined),
    [skeleton, root, settings.rootNode],
  )
  // Keyed on the node, not the resolved object: Soma and As delivered resolve to the same node on
  // a skeleton with no soma labelled, and that toggle should not rebuild the arbour.
  const rootAt = rooted?.node
  const bridges = healed?.bridges
  const arbor = useMemo(
    () =>
      skeleton && rootAt !== undefined ? buildArbor(skeleton, rootAt, bridges) : undefined,
    [skeleton, rootAt, bridges],
  )
  const electrotonic = useMemo(
    () =>
      metric === 'electrotonic' && skeleton && arbor && data?.skeletons
        ? electrotonicDistances(skeleton, arbor, data.skeletons, {
            rm: settings.rm,
            ri: settings.ri,
          })
        : undefined,
    [metric, skeleton, arbor, data, settings.rm, settings.ri],
  )
  // Electrotonic where it can be answered; geodesic, with the reason said, where it cannot.
  const inLambda = electrotonic?.ok === true
  const nodeD = electrotonic?.ok ? electrotonic.distance : arbor?.geodesic
  const stamped = useMemo(
    () => (inLambda && skeleton && arbor ? stampedRadius(skeleton, arbor) : undefined),
    [inLambda, skeleton, arbor],
  )
  const full = useMemo(() => (arbor ? keyTree(arbor) : undefined), [arbor])
  const pruned = useMemo(
    () =>
      full && arbor
        ? pruneTwigs(full, landmarkDistances(full, arbor.geodesic), minTwig * NM_PER_UM)
        : undefined,
    [full, arbor, minTwig],
  )
  const landmarkD = useMemo(
    () => (pruned && nodeD ? landmarkDistances(pruned.tree, nodeD) : undefined),
    [pruned, nodeD],
  )
  const { shape, refining } = useArborLayout(layout, pruned?.tree, landmarkD, {
    order: settings.order,
    subway: {
      angleChange: settings.angleChange,
      angleDecrease: settings.angleDecrease,
      switchShare: SUBWAY_DEFAULTS.switchShare,
    },
    daylight: settings.daylight,
  })
  // Which drawn pieces carry a healed bridge: per skeleton node, so once per arbour, not per frame.
  const dashed = useMemo(() => {
    if (!arbor?.bridge || !pruned) return undefined
    const out = new Uint8Array(pruned.tree.nodes.length)
    for (const v of arbor.order) {
      if (!arbor.bridge[v]) continue
      const k = pruned.tree.segmentOf[v]!
      if (k >= 0) out[k] = 1
    }
    return out
  }, [arbor, pruned])

  /* --- the synapses ------------------------------------------------------------------- */

  // The expensive half, once per skeleton and cloud; re-rooting only re-reads it.
  const projection = useMemo(
    () => (skeleton && cloud ? projectSynapses(skeleton, sitesFrom(cloud)) : undefined),
    [skeleton, cloud],
  )
  const placement = useMemo(
    () => (arbor && projection ? orientPlacement(arbor, projection) : undefined),
    [arbor, projection],
  )
  const polarity = useMemo(() => (cloud ? polarityColumn(cloud) : undefined), [cloud])
  const sideOf = useCallback((s: number) => String(polarity?.[s] ?? ''), [polarity])
  const marks = useMemo(
    () =>
      pruned && landmarkD && arbor && nodeD && placement
        ? synapseMarks(pruned.tree, landmarkD, arbor, nodeD, placement, sideOf)
        : undefined,
    [pruned, landmarkD, arbor, nodeD, placement, sideOf],
  )

  /*
   * `Partner type` is resolved here rather than read off a column: the rows name a partner's type
   * on some sources, only its id on CAVE, and neither on neuPrint until the link cloud lands — so
   * the label is `partnerLabelColumn`'s, the same join and the same `—` for an untyped partner the
   * partner list uses.
   */
  const byPartnerType = settings.colorBy === 'partnerType' && !highlight.partnerOverrides
  const distalByType = distalOpen && grouping === 'type'
  // One join for both readers of a partner's type: the tick colours and the Distal tab.
  const typeLabels = useMemo(
    () =>
      (byPartnerType || distalByType) && cloud
        ? partnerLabelColumn(cloud.attributes, [data?.inputs, data?.outputs], 'type')
        : undefined,
    [byPartnerType, distalByType, cloud, data],
  )
  const colorTable = useMemo(() => {
    if (highlight.highlighted) return highlight.highlighted.points.attributes
    if (!cloud || !byPartnerType) return cloud?.attributes
    const values = Array.from({ length: cloud.attributes.length }, (_, i) =>
      typeLabels ? partnerLabel(typeLabels[i] ?? null) : '—',
    )
    return makeTable(
      tableSchema(...cloud.attributes.schema.columns, column(PARTNER_TYPE_KEY, 'str')),
      { ...cloud.attributes.data, [PARTNER_TYPE_KEY]: values },
    )
  }, [highlight.highlighted, byPartnerType, cloud, typeLabels])
  /*
   * Lit partners win over `Colour by`, Topology's rule: what somebody picked in the list is what the
   * picture shows. Otherwise the chosen column, categorical — a synapse keeps its own mark, so the
   * cycle is right and the fold is not (CLAUDE.md's chart-colour rule).
   */
  const colorSpec: ColorSpec = useMemo(
    () =>
      highlight.partnerOverrides
        ? {
            mode: 'categorical',
            column: HIGHLIGHT_COLUMN,
            constant: CHART_INK[mode].muted,
            overrides: highlight.partnerOverrides,
          }
        : {
            mode: 'categorical',
            column: byPartnerType ? PARTNER_TYPE_KEY : settings.colorBy,
            constant: seriesColor(2, mode),
          },
    [highlight.partnerOverrides, byPartnerType, settings.colorBy, mode],
  )
  const colors = useMemo(
    () => (colorTable ? resolveColor(colorTable, colorSpec, mode) : undefined),
    [colorTable, colorSpec, mode],
  )
  /*
   * The ticks' key, for a colouring by a column. Not while partners are lit — the Partners list is
   * that key, swatches and all.
   */
  const synapseKey = useMemo(() => {
    const legend = colors?.legend
    if (highlight.partnerOverrides || !legend || legend.kind !== 'categorical') return undefined
    const named = (label: string) =>
      settings.colorBy === 'polarity'
        ? label === 'pre'
          ? 'output'
          : label === 'post'
            ? 'input'
            : label
        : label
    const entries = legend.entries
      .slice(0, LEGEND_KEYS)
      .map((e) => ({ ...e, label: named(e.label) }))
    return { entries, more: legend.entries.length - entries.length + (legend.unlisted ?? 0) }
  }, [colors, highlight.partnerOverrides, settings.colorBy])
  const litValues = highlight.highlighted?.values
  /*
   * The ticks grouped by colour, one stroke each, with the unlit ones dimmed. Built once per
   * colouring rather than per frame: a pan redraws every frame and the grouping does not move.
   */
  const ticks = useMemo((): TickGroup[] => {
    if (!marks || !colors) return []
    const byColor = new Map<string, number[]>()
    for (let s = 0; s < marks.piece.length; s++) {
      if (marks.piece[s]! < 0) continue
      const key = colors.at(s)
      const list = byColor.get(key)
      if (list) list.push(s)
      else byColor.set(key, [s])
    }
    return [...byColor].map(([color, rows]) => ({
      color,
      alpha: litValues && litValues[rows[0]!] === HIGHLIGHT_OTHER ? settings.unlitOpacity : 1,
      rows: Int32Array.from(rows),
    }))
  }, [marks, colors, litValues, settings.unlitOpacity])

  /* --- the branches' colour and width ------------------------------------------------- */

  const byRadius = settings.widthBy === 'radius'
  const hasRadii = useMemo(
    () => (skeleton ? skeleton.radii.some((r) => r > 0) : false),
    [skeleton],
  )
  const branchColor = settings.branchColor
  // Per skeleton node, on the tree as rooted here: Strahler order and flow both move with the root.
  const nodeValue = useMemo(() => {
    if (!skeleton || !arbor) return undefined
    if (branchColor === 'strahler') {
      return Float64Array.from(strahlerOrders({ ...skeleton, parents: arbor.parent }))
    }
    if (branchColor === 'flow')
      return placement ? synapseFlow(arbor, placement, sideOf) : undefined
    if (branchColor === 'distance') return nodeD
    return undefined
  }, [branchColor, skeleton, arbor, placement, sideOf, nodeD])
  const branches = useMemo(() => {
    const widthed = byRadius && hasRadii
    if ((!nodeValue && !widthed) || !arbor || !pruned || !landmarkD || !nodeD || !skeleton) {
      return undefined
    }
    return branchStyle({
      arbor,
      tree: pruned.tree,
      landmarkD,
      nodeD,
      radii: widthed ? skeleton.radii : undefined,
      values: nodeValue,
      // A heavy-tailed measure on a linear ramp is one bright branch and a dark tree.
      sqrt: branchColor === 'flow',
      lineWidth: settings.lineWidth,
      flat: CHART_INK[mode].secondary,
      mode,
      palette: settings.branchPalette,
    })
  }, [
    nodeValue,
    byRadius,
    hasRadii,
    arbor,
    pruned,
    landmarkD,
    nodeD,
    skeleton,
    branchColor,
    settings.lineWidth,
    settings.branchPalette,
    mode,
  ])

  /* --- the clicked point -------------------------------------------------------------- */

  const focusPoint = useMemo(
    () => (arbor ? focusOn(focus, neuronId, arbor) : undefined),
    [focus, neuronId, arbor],
  )
  const focusAt = useMemo(
    () =>
      focusPoint && pruned && landmarkD && arbor && nodeD
        ? placeOnPiece(pruned.tree, landmarkD, arbor, nodeD, focusPoint)
        : undefined,
    [focusPoint, pruned, landmarkD, arbor, nodeD],
  )
  const distalPieces = useMemo(() => {
    if (!focusPoint || !focusAt || !pruned || !arbor) return undefined
    const tree = pruned.tree
    const out = new Uint8Array(tree.nodes.length)
    for (let k = 1; k < out.length; k++) {
      if (k !== focusAt.piece && inSubtree(arbor, focusPoint.node, tree.nodes[k]!)) out[k] = 1
    }
    return out
  }, [focusPoint, focusAt, pruned, arbor])
  const distal = useMemo(
    () =>
      focusPoint && arbor && placement && nodeD
        ? distalSynapses(arbor, placement, nodeD, focusPoint)
        : undefined,
    [focusPoint, arbor, placement, nodeD],
  )
  // The partner each synapse names, in the list's vocabulary: built once per cloud and grouping
  // while the Distal tab is open, not once per click.
  const partnerOf = useMemo(
    () =>
      grouping === 'type'
        ? typeLabels
        : distalOpen && cloud
          ? partnerLabelColumn(cloud.attributes, [data?.inputs, data?.outputs], grouping)
          : undefined,
    [grouping, typeLabels, distalOpen, cloud, data],
  )
  const distalRows = useMemo((): DistalRow[] => {
    if (!distal || !distalOpen) return []
    return summariseDistal(
      distal,
      (s) => (partnerOf ? partnerLabel(partnerOf[s] ?? null) : 'all synapses'),
      sideOf,
    )
  }, [distal, distalOpen, partnerOf, sideOf])

  /* --- the stage ---------------------------------------------------------------------- */

  const [stageRef, size] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<ArborView | undefined>()
  // A new neuron or a new layout starts fitted: a window into the last one means nothing here.
  useEffect(() => setView(undefined), [neuronId, layout, root, metric])

  const transform = useMemo(
    () =>
      shape && size.width > 0 && size.height > 0
        ? fitTransform(shape, size.width, size.height, view)
        : undefined,
    [shape, size.width, size.height, view],
  )
  const target = useMemo(
    () => (shape && transform ? pieceGeometry(shape, transform) : undefined),
    [shape, transform],
  )

  useWheelZoom(stageRef, transform !== undefined, (factor, x, y) => {
    if (!transform) return
    const next = zoomAbout(transform, factor, x, y)
    setView(next.zoom <= 1 ? undefined : next)
  })
  const { panning, handlers } = usePanGesture(view !== undefined, (dx, dy) => {
    if (transform) setView(panBy(transform, dx, dy))
  })

  /*
   * The animation. When the drawing changes shape — another layout, root, distance or twig
   * setting — the pieces slide from where they were painted to where they now belong, matched by
   * the skeleton node each ends at. Only a change of *shape* animates: a pan or a zoom is a gesture
   * and has to follow the pointer, and a new neuron has nothing to match against.
   */
  const painted = useRef<
    | { pieces: PieceGeometry; nodes: Int32Array; shape: ArborShape; neuron: string | null }
    | undefined
  >(undefined)
  const [blend, setBlend] = useState<
    { from: { pieces: PieceGeometry; nodes: Int32Array }; t: number } | undefined
  >(undefined)
  useLayoutEffect(() => {
    const before = painted.current
    if (!shape || !before || before.shape === shape || before.neuron !== neuronId) return
    if (!animates()) return
    const from = { pieces: before.pieces, nodes: before.nodes }
    setBlend({ from, t: 0 })
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / MORPH_MS)
      setBlend(t < 1 ? { from, t: easeInOut(t) } : undefined)
      if (t < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [shape, neuronId])

  const pieces = useMemo(
    () =>
      target && pruned
        ? blend
          ? blendPieces(blend.from, { pieces: target, tree: pruned.tree }, blend.t)
          : target
        : undefined,
    [target, pruned, blend],
  )

  const scene = useMemo(() => {
    if (!shape || !transform || !pruned || !pieces) return undefined
    const ink = CHART_INK[mode]
    return buildScene({
      width: transform.width,
      height: transform.height,
      background: chartSurface(mode),
      title: `${neuronName}, ${LAYOUTS.find((l) => l.value === layout)?.label ?? layout}`,
      ink: { line: ink.secondary, text: ink.primary, accent: seriesColor(0, mode) },
      shape,
      transform,
      pieces,
      settled: !blend,
      tree: pruned.tree,
      lineWidth: settings.lineWidth,
      ...(branches ? { branches } : {}),
      ...(dashed ? { dashed } : {}),
      ...(distalPieces && focusAt ? { distal: { pieces: distalPieces, focus: focusAt } } : {}),
      ...(marks ? { marks } : {}),
      ticks,
      synapseSize: settings.synapseSize,
      ...(synapseKey ? { key: synapseKey } : {}),
      scaleBar: scaleBarFor(transform, inLambda),
      ...(branches?.legend
        ? {
            legend: legendFor(
              branchColor,
              branches.legend,
              (v) => showDistance(v, inLambda),
              settings.branchPalette,
            ),
          }
        : {}),
    })
  }, [
    shape,
    transform,
    pruned,
    pieces,
    blend,
    mode,
    inLambda,
    neuronName,
    layout,
    settings.lineWidth,
    settings.synapseSize,
    branches,
    dashed,
    distalPieces,
    focusAt,
    marks,
    ticks,
    synapseKey,
    branchColor,
    settings.branchPalette,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !scene || !pieces || !pruned || !shape) return
    const ctx = prepareCanvas(canvas, scene.width, scene.height)
    if (!ctx) return
    paintScene(ctx, scene)
    painted.current = { pieces, nodes: pruned.tree.nodes, shape, neuron: neuronId }
  }, [scene, pieces, pruned, shape, neuronId])

  /* --- pointing ------------------------------------------------------------------------ */

  const [hover, setHover] = useState<{ synapse: number; x: number; y: number } | undefined>()
  // Partner types by id, for rows naming a partner's id and not its type (CAVE's) — the only rows
  // the tooltip reads it for.
  const typeById = useMemo(() => {
    const schema = cloud?.attributes.schema
    return hoveredHere &&
      data &&
      schema &&
      findColumn(schema, 'partnerId') &&
      !findColumn(schema, 'partnerType')
      ? partnerTypesById([data.inputs, data.outputs])
      : undefined
  }, [hoveredHere, data, cloud])
  /*
   * The hovered synapse's distance beyond the clicked point, as the Distal tab measured it.
   * `distalSynapses` lists synapses in order, so the lookup is a binary search at hover time
   * rather than a map rebuilt on every click.
   */
  const beyondFocus = (synapse: number): number | undefined => {
    if (!distal) return undefined
    const k = lowerBound(distal.indices, synapse)
    return distal.indices[k] === synapse ? distal.distances[k] : undefined
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    handlers.onPointerMove(event)
    if (panning || !scene) return
    const at = tooltipPoint(event, event.currentTarget)
    const synapse = nearestTick(scene, at.x, at.y)
    setHover(synapse === undefined ? undefined : { synapse, x: at.x, y: at.y })
    if (synapse !== undefined && !hoveredHere) setHoveredOn(neuronId)
  }
  /*
   * A new scene can renumber the ticks — the link cloud arriving swaps one row per site for one
   * per connection — so a tooltip left open is re-pointed at whatever is under the pointer now,
   * rather than naming a row of the cloud before.
   */
  useEffect(() => {
    if (!scene) return
    setHover((current) => {
      if (!current) return current
      const synapse = nearestTick(scene, current.x, current.y)
      // The same object when nothing changed: the scene moves on every pan and morph frame.
      if (synapse === current.synapse) return current
      return synapse === undefined ? undefined : { ...current, synapse }
    })
  }, [scene])

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!pieces || !pruned || !arbor || !landmarkD || !nodeD) return
    // In the plot's own pixels: on the canvas React Flow scales the card, and a raw client offset
    // would carry that zoom into a transform measured without it — every click a miss.
    const at = tooltipPoint(event, event.currentTarget)
    const picked = pickPiece(pieces, at.x, at.y)
    if (!picked) {
      onSetting('focus', '')
      return
    }
    const point = arborPointAt(arbor, pruned.tree, landmarkD, nodeD, picked.piece, picked.along)
    if (neuronId) onSetting('focus', writeFocus({ neuronId, point }))
    if (!distalTab) {
      onSetting('tab', 'distal')
      onSetting('railOpen', true)
    }
  }

  const exportSource: ExportSource = {
    svg: () => (scene ? sceneToSvg(scene, uiFontFamily()) : null),
  }

  /* --- what the card says ------------------------------------------------------------- */

  const show = (nm: number): string => showDistance(nm, inLambda)

  const notes: Array<{ text: string; warn?: boolean }> = []
  if (heal.status === 'healing') notes.push({ text: `joining ${heal.pieces} pieces…` })
  if (heal.status === 'error') {
    notes.push({
      text: `could not join ${heal.pieces} pieces (${heal.message}); drawing the largest`,
      warn: true,
    })
  }
  if (healed?.bridges) notes.push({ text: `${healed.pieces} pieces joined, joins dashed` })
  if (rooted?.fellBack) {
    notes.push({
      text:
        root === 'soma'
          ? 'no soma labelled, measured from the delivered root'
          : 'picked root gone, measured from the delivered root',
    })
  }
  if (electrotonic && !electrotonic.ok) notes.push({ text: electrotonic.reason, warn: true })
  if (stamped) {
    notes.push({
      text:
        `${Math.round(stamped.share * 100)}% of radii are ${formatNumber(stamped.radius)} nm, ` +
        'so electrotonic distance is close to geodesic here',
    })
  }
  if (byRadius && skeleton && !hasRadii) {
    notes.push({ text: 'no radii on this skeleton, drawn at one width' })
  }
  if (pruned && pruned.hidden > 0) {
    notes.push({
      text:
        `${plural(pruned.hidden, 'twig')} hidden` +
        (marks && marks.onHiddenTwigs > 0
          ? `, ${plural(marks.onHiddenTwigs, 'synapse')} on them not drawn`
          : ''),
    })
  }
  if (placement && placement.unplaced > 0) {
    notes.push({ text: `${plural(placement.unplaced, 'synapse')} off the drawn arbour` })
  }
  if (refining) notes.push({ text: 'evening out branches…' })

  if (!neurons) return <ViewerEmpty>Connect a table of neurons to draw them.</ViewerEmpty>
  if (total === 0) return <ViewerEmpty>No neurons in the incoming table.</ViewerEmpty>

  const distalInputs = distalRows.filter((r) => r.polarity === 'post')
  const distalOutputs = distalRows.filter((r) => r.polarity === 'pre')
  const countOf = (rows: DistalRow[]) => rows.reduce((a, r) => a + r.count, 0)

  return (
    <div className="viewer topo arbor nodrag" data-rail={railOpen ? 'open' : 'closed'}>
      <TopoBar
        index={index}
        total={total}
        onPage={onPage}
        name={neuronName}
        neuronId={neuronId}
        pinned={pinned}
        onPin={onPin}
        railOpen={railOpen}
        onRailOpen={(open) => onSetting('railOpen', open)}
      />

      <div className="topo__stage">
        <div className="topo__tools">
          <select
            className="topo__select"
            aria-label="Layout"
            value={layout}
            onChange={(e) => onSetting('layout', e.target.value)}
          >
            {LAYOUTS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <select
            className="topo__select"
            aria-label="Distance"
            value={metric}
            onChange={(e) => onSetting('metric', e.target.value)}
          >
            <option value="geodesic">Geodesic (µm)</option>
            <option value="electrotonic">Electrotonic (λ)</option>
          </select>
          <select
            className="topo__select"
            aria-label="Colour branches by"
            value={branchColor}
            onChange={(e) => onSetting('branchColor', e.target.value)}
          >
            {BRANCH_COLORS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {view && (
            <button type="button" className="topo__pin" onClick={() => setView(undefined)}>
              Fit
            </button>
          )}
          <span className="topo__spacer" />
          <ViewerActions
            baseName={props.baseName ?? exportBaseName(undefined, 'neuron-dendrogram')}
            source={exportSource}
            compact={props.compact ?? false}
            {...(props.onExpand ? { onExpand: props.onExpand } : {})}
            {...(props.onError ? { onError: props.onError } : {})}
          />
          {notes.map((note) => (
            <span
              key={note.text}
              className={note.warn ? 'topo__note topo__note--warn' : 'topo__note'}
            >
              {note.text}
            </span>
          ))}
        </div>

        <div
          ref={stageRef}
          className="arbor__plot"
          data-panning={panning || undefined}
          data-zoomed={view !== undefined || undefined}
          {...handlers}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(undefined)}
          onClick={onClick}
          onDoubleClick={() => setView(undefined)}
        >
          {shape ? (
            <canvas
              ref={canvasRef}
              className="arbor__canvas"
              aria-label={`${neuronName} arbour`}
            />
          ) : (
            <div className="viewer__empty">
              {loaded.status === 'loading'
                ? 'Loading geometry…'
                : loaded.status === 'error'
                  ? loaded.message
                  : 'No skeleton for this neuron.'}
            </div>
          )}
          {hover && cloud && arbor && nodeD && placement && (
            <SynapseTooltip
              at={hover}
              partners={highlight.partnerNaming}
              synapse={hover.synapse}
              attributes={cloud.attributes}
              typeById={typeById}
              side={sideOf(hover.synapse)}
              fromRoot={distanceAt(arbor, nodeD, {
                node: placement.node[hover.synapse]!,
                t: placement.t[hover.synapse]!,
              })}
              fromFocus={beyondFocus(hover.synapse)}
              show={show}
            />
          )}
        </div>

        {railOpen && (
          <aside className="topo__rail">
            <RailTabs
              tabs={TABS}
              tab={tab}
              onTab={(id) => onSetting('tab', id)}
              onClose={() => onSetting('railOpen', false)}
            />

            {tab === 'partners' && (
              <PartnerPanel
                direction={direction}
                onDirection={(next) => onSetting('direction', next)}
                query={settings.partnerQuery}
                onQuery={(next) => onSetting('partnerQuery', next)}
                grouping={grouping}
                onGrouping={(next) => onSetting('grouping', next)}
                list={{
                  rows: highlight.shownPartners.rows,
                  note: {
                    canHighlight: highlight.canHighlight,
                    linksState: highlight.links.status,
                    selected: seeded,
                    lit: highlight.highlighted?.lit,
                    filtered: Boolean(highlight.partnerFilter.filter),
                    matched: highlight.shownPartners.matched,
                    total: highlight.partnerRows.length,
                    neuronCount: highlight.partnerNeuronCount,
                  },
                  onToggle: highlight.togglePartner,
                  colorFor: highlight.colorForPartner,
                  loading: loaded.status === 'loading',
                  ...(highlight.partnerFilter.error
                    ? { filterError: highlight.partnerFilter.error }
                    : {}),
                }}
              />
            )}

            {tab === 'distal' && (
              <div className="topo__panel">
                {!focusPoint || !arbor || !nodeD ? (
                  <p className="topo__pending">
                    Click a branch on the drawing to list the synapses beyond it.
                  </p>
                ) : (
                  <>
                    <p className="topo__note topo__note--block">
                      {show(distanceAt(arbor, nodeD, focusPoint))} from the root.{' '}
                      {plural(countOf(distalInputs), 'input')} and{' '}
                      {plural(countOf(distalOutputs), 'output')} lie beyond it; distances below
                      are from this point, in {inLambda ? 'λ' : 'µm'}.
                      {perConnection &&
                        ' Outputs are counted per connection: a release site driving three ' +
                          'partners counts three times, once under each.'}
                    </p>
                    <div className="topo__seg">
                      <button
                        type="button"
                        className="topo__pin"
                        onClick={() => {
                          onSetting('root', 'picked')
                          onSetting('rootNode', rootNodeFor(focusPoint, arbor.parent))
                          onSetting('focus', '')
                        }}
                      >
                        Make root
                      </button>
                      <button
                        type="button"
                        className="topo__pin"
                        onClick={() => onSetting('focus', '')}
                      >
                        Clear
                      </button>
                    </div>
                    <DistalTable title="Inputs" rows={distalInputs} show={show} />
                    <DistalTable title="Outputs" rows={distalOutputs} show={show} />
                  </>
                )}
              </div>
            )}

            {tab === 'settings' && (
              <div className="topo__panel arbor__settings">
                <SettingsPanel
                  settings={settings}
                  onSetting={onSetting}
                  colorOptions={props.colorOptions}
                />
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

/** The node a "Make root" on a clicked point means: whichever end of its edge it is nearer. */
function rootNodeFor(point: ArborPoint, parent: Int32Array): number {
  const p = parent[point.node]!
  return point.t >= 0.5 || p < 0 ? point.node : p
}

function DistalTable({
  title,
  rows,
  show,
}: {
  title: string
  rows: DistalRow[]
  show: (value: number) => string
}) {
  if (rows.length === 0) return null
  return (
    <table className="arbor__table">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Partner</th>
          <th scope="col">n</th>
          <th scope="col">nearest</th>
          <th scope="col">median</th>
          <th scope="col">farthest</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" title={row.label}>
              {row.label}
            </th>
            <td>{formatNumber(row.count)}</td>
            <td>{show(row.min)}</td>
            <td>{show(row.median)}</td>
            <td>{show(row.max)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SettingsPanel({
  settings,
  onSetting,
  colorOptions,
}: {
  settings: ArborSettings
  onSetting: NeuronDendrogramViewerProps['onSetting']
  colorOptions: readonly EnumOption[]
}) {
  const number = (
    id:
      | 'rm'
      | 'ri'
      | 'minTwig'
      | 'angleChange'
      | 'angleDecrease'
      | 'daylight'
      | 'lineWidth'
      | 'synapseSize'
      | 'unlitOpacity',
    label: string,
    step: number,
  ) => (
    <label className="arbor__field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={settings[id]}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (Number.isFinite(next)) onSetting(id, next)
        }}
      />
    </label>
  )
  return (
    <>
      <label className="arbor__field">
        <span>Root</span>
        <select value={settings.root} onChange={(e) => onSetting('root', e.target.value)}>
          <option value="soma">Soma</option>
          <option value="source">As delivered</option>
          <option value="picked" disabled={settings.rootNode < 0}>
            Picked point
          </option>
        </select>
      </label>
      <label className="arbor__field">
        <span>Colour synapses by</span>
        <select value={settings.colorBy} onChange={(e) => onSetting('colorBy', e.target.value)}>
          {colorOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {settings.branchColor !== 'flat' && (
        <label className="arbor__field">
          <span>Branch palette</span>
          <select
            value={settings.branchPalette}
            onChange={(e) => onSetting('branchPalette', e.target.value)}
          >
            {BRANCH_PALETTE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="arbor__field">
        <span>Branch width</span>
        <select value={settings.widthBy} onChange={(e) => onSetting('widthBy', e.target.value)}>
          <option value="uniform">Uniform</option>
          <option value="radius">By radius</option>
        </select>
      </label>
      {number('lineWidth', 'Line width (px)', 0.25)}
      {number('synapseSize', 'Synapse size (px)', 1)}
      {number('unlitOpacity', 'Unlit synapses (0–1)', 0.05)}
      {number('minTwig', 'Hide twigs under (µm)', 0.5)}
      {(settings.layout === 'rectangular' || settings.layout === 'radial') && (
        <label className="arbor__field">
          <span>Branch order</span>
          <select value={settings.order} onChange={(e) => onSetting('order', e.target.value)}>
            <option value="balanced">Balanced</option>
            <option value="ladder">Longest first</option>
          </select>
        </label>
      )}
      {settings.layout === 'subway' && (
        <>
          {number('angleChange', 'Branch angle (°)', 5)}
          {number('angleDecrease', 'Angle decrease (°)', 1)}
        </>
      )}
      {settings.layout === 'equalAngle' && number('daylight', 'Daylight passes', 1)}
      {settings.metric === 'electrotonic' && (
        <>
          {number('rm', 'Membrane resistance (Ω·cm²)', 100)}
          {number('ri', 'Axial resistivity (Ω·cm)', 1)}
        </>
      )}
      <p className="topo__note topo__note--block">
        Root decides what counts as beyond a clicked point, so changing it marks the Points
        output stale until Run; nothing else here does. Hidden twigs leave the drawing only:
        distances and the Distal tab still count every branch.
      </p>
    </>
  )
}
