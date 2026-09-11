/**
 * What the viewers' exports decide, before either language says it: whether a chart has anything
 * to draw, and whether a Selected port holds anything.
 *
 * Neither is a refusal. A viewer is a tap — it binds its pass-through whatever else happens — so
 * an unset picker or a gesture nobody made becomes a note where the drawing or the selection
 * would have been. Each note is one rule stated once: `nothingDrawn` for a picker left unset,
 * `nothingSelected` for a selection left empty, with the gesture's own words (`NOTHING_SELECTED`)
 * the one fact that varies by node. The test behind each — which pickers a drawing needs, which
 * column a selection is matched against — is each chart's plan, so a renderer reads a note or the
 * values and never asks the question itself.
 */

import type { ParamValues } from '../../core/node'
import type { FieldTerm } from '../../data/terms'
import type { ValueRange } from '../../nodes/lib/chartSelection'
import {
  MISSING_LABEL,
  decodeIndices,
  decodeLabels,
  decodeRanges,
} from '../../nodes/lib/chartSelection'
import { decodeClauses, resolveFilters } from '../../nodes/lib/tableFilter'
import type { NeutralContext, Noted, Refusable } from '../neutral'
import { selectionIds } from '../selection'

/** What the chart plans read: params and the column pickers. */
type ChartContext = Pick<NeutralContext, 'params' | 'column'>

/** The nodes whose selection note is planned here. */
type SelectingNode =
  | 'out.histogram'
  | 'out.pie'
  | 'out.distribution'
  | 'out.scatter'
  | 'out.viewer3d'
  | 'out.dendrogram'
  | 'out.profile'
  | 'neuron.explore'

/** How each node's selection is made, and the port it fills. */
const NOTHING_SELECTED: Record<SelectingNode, { gesture: string; port: string }> = {
  'out.histogram': { gesture: 'No bars are selected on the canvas', port: 'Selected' },
  'out.pie': { gesture: 'No slices are selected on the canvas', port: 'Selected' },
  'out.distribution': { gesture: 'No boxes are selected on the canvas', port: 'Selected' },
  'out.scatter': { gesture: 'Nothing is lassoed on the canvas', port: 'Selected' },
  'out.viewer3d': { gesture: 'Nothing is picked in the viewer', port: 'Selected' },
  'out.dendrogram': { gesture: 'No branch is selected on the canvas', port: 'Selected' },
  'out.profile': { gesture: 'No neuron is pinned on the canvas', port: 'Current' },
  'neuron.explore': { gesture: 'Nothing is ticked on the canvas', port: 'Selected' },
}

function nothingSelected(type: SelectingNode): string {
  const { gesture, port } = NOTHING_SELECTED[type]
  return `${gesture}, so ${port} is empty.`
}

/** `missing` names the pickers, as `'value'` or `'x or y'`. */
function nothingDrawn(missing: string): string {
  return `No ${missing} column is picked, so nothing is drawn.`
}

/**
 * A viewer's stored id selection — `selectionIds`, exact decimal text — or the note saying it is
 * empty. For the viewers whose selection is ids and nothing else.
 */
export function pickedIds(
  ctx: Pick<NeutralContext, 'params'>,
  type: 'out.viewer3d' | 'out.profile' | 'neuron.explore',
): Noted<{ ids: string[] }> {
  const ids = selectionIds(ctx)
  return ids.length > 0 ? { ids } : { note: nothingSelected(type) }
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface TableViewerPlan {
  /** The header filters that resolve against the input, which the document applies. */
  terms: FieldTerm[]
  /**
   * One note per clause the canvas is ignoring. A clause the card leaves out is one the document
   * must leave out too — and say so, or the two quietly report different row counts.
   */
  ignored: string[]
}

export function tableViewerPlan(
  ctx: Pick<NeutralContext, 'params' | 'schema'>,
): TableViewerPlan {
  const { terms, problems } = resolveFilters(
    ctx.schema('in'),
    decodeClauses(ctx.params.filters),
  )
  return { terms, ignored: problems.map((problem) => `${problem.message} — not applied.`) }
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type BarChartPlan = Noted<{ category: string; value: string; series?: string }>

export function barChartPlan(ctx: ChartContext): BarChartPlan {
  const category = ctx.column('category')
  const value = ctx.column('value')
  if (!category || !value) return { note: nothingDrawn('category or value') }
  const series = ctx.params.useSeries === true ? ctx.column('series') : undefined
  return { category, value, series }
}

export interface HistogramPlan {
  /**
   * The value ranges the bars cover — the same decode the node runs, so the document and the
   * canvas cut the table at the same numbers.
   */
  selected: Noted<{ column: string; ranges: ValueRange[] }>
  drawn: Noted<{ value: string; series?: string }>
}

export function histogramPlan(ctx: ChartContext): HistogramPlan {
  const value = ctx.column('value')
  const series = ctx.column('series')
  const ranges = decodeRanges(ctx.params.selection)
  return {
    selected:
      ranges.length > 0 && value
        ? { column: value, ranges }
        : { note: nothingSelected('out.histogram') },
    drawn: value ? { value, series } : { note: nothingDrawn('value') },
  }
}

/** The marks picked by label — the slices or boxes — and the column they name values of. */
export interface PickedLabels {
  column: string
  /** Verbatim, as the canvas compares them — `decodeLabels`. */
  labels: string[]
  /**
   * Whether one of them is `markLabel`'s name for a null, so the document matches a missing
   * value too. The label stays in `labels`: a cell really holding that string is picked as well.
   */
  missing: boolean
}

/** A selection of marks by label, or the note saying it is empty. */
export type LabelSelection = Noted<PickedLabels>

function pickedLabels(
  ctx: ChartContext,
  column: string | undefined,
  type: 'out.pie' | 'out.distribution',
): LabelSelection {
  const labels = decodeLabels(ctx.params.selection)
  return labels.length > 0 && column
    ? { column, labels, missing: labels.includes(MISSING_LABEL) }
    : { note: nothingSelected(type) }
}

export interface PiePlan {
  /** What the slices are. Present whenever `drawn` is not a note. */
  category?: string
  selected: LabelSelection
  drawn: Noted<{ value?: string }>
}

export function piePlan(ctx: ChartContext): PiePlan {
  const category = ctx.column('category')
  return {
    category,
    selected: pickedLabels(ctx, category, 'out.pie'),
    drawn: category ? { value: ctx.column('value') } : { note: nothingDrawn('category') },
  }
}

export interface DistributionPlan {
  /** The grouping, which the boxes are drawn and selected by. */
  group?: string
  selected: LabelSelection
  drawn: Noted<{ value: string }>
}

export function distributionPlan(ctx: ChartContext): DistributionPlan {
  const value = ctx.column('value')
  const group = ctx.column('group')
  return {
    group,
    selected: pickedLabels(ctx, group, 'out.distribution'),
    drawn: value ? { value } : { note: nothingDrawn('value') },
  }
}

export interface ScatterPlan {
  /** The lassoed ids and the column they are matched against. */
  selected: Noted<{ column: string; ids: string[] }>
  drawn: Noted<{ x: string; y: string }>
}

export function scatterPlan(ctx: ChartContext): ScatterPlan {
  const x = ctx.column('x')
  const y = ctx.column('y')
  const ids = selectionIds(ctx)
  const idColumn = ctx.column('idColumn')
  return {
    selected:
      ids.length > 0 && idColumn
        ? { column: idColumn, ids }
        : { note: nothingSelected('out.scatter') },
    drawn: x && y ? { x, y } : { note: nothingDrawn('x or y') },
  }
}

// ---------------------------------------------------------------------------
// 3D Viewer, Neuroglancer, Dendrogram
// ---------------------------------------------------------------------------

export type Viewer3dPlan = Refusable<{
  /** The upstream variables on the Skeletons, Meshes and Points sockets that are wired. */
  geometry: string[]
  /** The Volumes socket, which carries a list of shells where the other three carry one object. */
  volumes?: string
  selected: Noted<{ ids: string[] }>
}>

/**
 * Four optional geometry sockets rather than one input, and the node is *not* a tap: its only
 * output is the neurons picked in the viewer. Assuming the pass-through shape every other viewer
 * has is what once made it emit "nothing is wired" for a node plainly wired up.
 */
export function viewer3dPlan(ctx: Pick<NeutralContext, 'params' | 'input'>): Viewer3dPlan {
  const geometry = ['skeletons', 'meshes', 'points']
    .map((port) => ctx.input(port))
    .filter((v): v is string => !!v)
  const volumes = ctx.input('volumes')
  if (geometry.length === 0 && !volumes) {
    return { refusal: 'No geometry is wired to this 3D Viewer.' }
  }
  return { geometry, volumes, selected: pickedIds(ctx, 'out.viewer3d') }
}

/**
 * Why a Neuroglancer node exports nothing, whatever it is set to. Its output is a **URL**, not a
 * table, so there is nothing to pass through — binding the incoming neurons to it would hand a
 * frame to anything reading a link — and building the URL needs the scene JSON the dataset
 * publishes, which is a fetch no translation makes. Downstream reports being blocked.
 */
export const NEUROGLANCER_REFUSAL =
  'This node builds a neuroglancer URL by editing the scene its dataset publishes. That ' +
  'scene is a fetch this translation does not make, so no link is built here.'

/**
 * The selected leaves, as *positions* rather than names: a label column can call two leaves the
 * same thing, so the canvas holds the observation index. `decodeIndices` is the node's own reader,
 * so the canvas and both documents cannot disagree about what the param holds.
 */
export function dendrogramSelection(params: ParamValues): Noted<{ positions: number[] }> {
  const positions = decodeIndices(params.selection)
  return positions.length > 0 ? { positions } : { note: nothingSelected('out.dendrogram') }
}
