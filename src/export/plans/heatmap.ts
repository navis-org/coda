/**
 * What a Heatmap export does, before either language says it.
 *
 * The heatmap emitter was the largest pair of copies in the two exporters: six sections — the
 * Labels tab, the Filter tab, the Order tab, the two Selected ports and the colour — each walking
 * the same params in the same order to the same decisions, and differing only in how a mask, a
 * permutation or a scale is written. Which axes a filter touches, when the missing-key note
 * replaces a sort, which axis follows which, which arrival names ride along: none of it has a
 * language in it, and two spellings of it is how a fix lands in the notebook and not in the R
 * document. So it is decided here once, and `python/emitters/viewers.ts` and
 * `r/emitters/viewers.ts` each render it — syntax, variable names, libraries and helpers, and the
 * notes whose wording really does differ between them.
 *
 * **Notes belong to sections and steps, not to one list**, because where a note lands in the
 * document is part of what it says: the invalid-pattern note sits between the two axes' masks,
 * the missing-key note inside the order lines where the sort would have been, the limits note
 * among the colour lines. A flat list would have made every renderer re-derive the positions it
 * was meant to stop deriving. The notes carried here are the ones whose text is the same in both
 * documents, so they ride as text; the palette, cluster and log notes differ past their opening
 * and stay with their renderer, gated on data the plan carries anyway (`substitute`, `by`, `log`).
 *
 * The plan refuses in one case only, and it is the one where the card fails at Run too: a
 * cluster order asked of a method fastcore does not know (`clusterMethodRefusal`), which raises
 * and leaves the node with no output — so a TODO, which binds nothing downstream, is the faithful
 * translation rather than a note beside a matrix the canvas never produced. The R document adds
 * one of its own, for the two methods `hclust` cannot reproduce (`hclustRefusal`, Linkage's too).
 * Everything else degrades to nothing, or to a note, and the pass-through is bound.
 */

import { decodeMatrixSelection, matrixSelectionOrder } from '../../nodes/lib/chartSelection'
import type { ColorLimits, HeatmapPalette } from '../../nodes/lib/heatmapParams'
import {
  heatmapLogColor,
  heatmapPaletteOf,
  readColorLimits,
} from '../../nodes/lib/heatmapParams'
import type {
  MatrixAxis,
  MatrixLabelOptions,
  MatrixOrderOptions,
  MatrixSortBy,
} from '../../nodes/lib/matrixShape'
import {
  axesOf,
  labelledAxes,
  missingKeyProblem,
  orderPlan,
  parseLabelFilter,
  readFilterOptions,
  readLabelOptions,
  readOrderOptions,
} from '../../nodes/lib/matrixShape'
import type { NeutralContext, Refusable } from '../neutral'
import { clusterMethodRefusal } from './analysis'

/** What the heatmap plan reads: its params, the Annotations wire and the two label pickers. */
type HeatmapContext = Pick<NeutralContext, 'params' | 'input' | 'column'>

/** Both axes, in the order every section walks them — rows first, as the node does. */
const AXES: readonly MatrixAxis[] = ['rows', 'columns']

/** The Labels tab: which annotation columns rename which axes. */
export interface HeatmapLabelPlan {
  /** The upstream variable on the Annotations port. */
  annotations: string
  match: string
  label: string
  /** The axes renamed, in `Apply to`'s order. */
  axes: MatrixAxis[]
}

/**
 * One axis of the Filter tab: either a note saying why it is left whole, or the filter to apply.
 *
 * An axis with nothing typed has no step at all, which is the node's own reading — so a step is
 * either something the reader has to be told or something the document has to do.
 */
export type HeatmapFilterStep =
  | { axis: MatrixAxis; note: string }
  | {
      axis: MatrixAxis
      note?: undefined
      /** `LabelFilter`'s own fields, parsed once, which is the reason it carries them. */
      pattern: string
      regex: boolean
      negate: boolean
    }

/**
 * One lead axis of the Order tab: a note where the sort cannot be written, or the sort — which
 * carries the plan's `by` so a renderer's switch on it narrows the step too.
 */
export type HeatmapOrderStep =
  | { axis: MatrixAxis; note: string }
  | { axis: MatrixAxis; note?: undefined; by: Exclude<MatrixSortBy, 'none' | 'value'> }
  | {
      axis: MatrixAxis
      note?: undefined
      by: 'value'
      /**
       * What the card says when no line of the other axis is called the key, which only the
       * data can tell. Each document checks at run time, prints this, and leaves the axis — and
       * its follower — as they arrived, which is what the canvas does.
       */
      keyMissing: string
    }

/** The Order tab, when it orders anything. */
export interface HeatmapOrderPlan extends Omit<MatrixOrderOptions, 'by' | 'axis' | 'follow'> {
  by: Exclude<MatrixSortBy, 'none'>
  steps: HeatmapOrderStep[]
  /**
   * The axis that takes its order from the leader's labels. Absent when there is no follower, and
   * also when the leader was not sorted — a follower copying an order that was never computed
   * would be copying the arrival order, which is the canvas's answer only by accident.
   */
  follower?: { axis: MatrixAxis; leader: MatrixAxis }
  /** The axes that end with a permutation — the sorted leads and the follower — rows first. */
  ordered: MatrixAxis[]
}

/** One of the two Selected ports. */
export interface HeatmapSelectionStep {
  axis: MatrixAxis
  /**
   * Ascending — `matrixSelectionOrder`, so two gestures selecting the same lines emit the same
   * text. Empty is still a step: both ports are bound whatever the selection is, because an
   * emitter cannot ask who is downstream and an unbound name there is an error, not an empty table.
   */
  positions: number[]
}

/** The colour: what to draw with, and the ends. The *spelling* of each is the renderer's. */
export interface HeatmapColourPlan {
  palette: HeatmapPalette
  diverging: boolean
  /**
   * Whether the palette is Coda's own, which neither matplotlib nor ggplot names, so the nearest
   * published ramp stands in. Which one, and how the note says so, is per language.
   */
  substitute: boolean
  limits: ColorLimits
  /** Whether either end was typed — the ends then stop being the data's. */
  manual: boolean
  log: boolean
  showValues: boolean
  /** Why the typed limits are ignored, as the note both documents write. */
  limitsNote?: string
}

export type HeatmapExportPlan = Refusable<HeatmapSections>

export interface HeatmapSections {
  /**
   * The axes whose arrival names ride through the reshaping: captured before the Labels tab
   * renames them, put through the filter's mask, permuted with the order, and handed to the
   * selection helper — every section asks this one set rather than carrying its own flag.
   *
   * Only an axis the Labels tab renames *and* somebody selected on. `labelledAxes` is the shared
   * half; the `size > 0` gate is local, because the canvas tracks unconditionally where an index
   * list costs nothing, and here every tracked axis is lines in somebody's document.
   */
  tracked: ReadonlySet<MatrixAxis>
  labels?: HeatmapLabelPlan
  filter: HeatmapFilterStep[]
  order?: HeatmapOrderPlan
  selection: HeatmapSelectionStep[]
  colour: HeatmapColourPlan
}

/** A Heatmap node's export, section by section, in the order the document writes them. */
export function heatmapExportPlan(ctx: HeatmapContext): HeatmapExportPlan {
  const ordering = readOrderOptions(ctx.params)
  const refusal = ordering.by === 'cluster' ? clusterMethodRefusal(ordering.method) : undefined
  if (refusal) return { refusal }
  const picked = decodeMatrixSelection(ctx.params.selection)
  const annotations = ctx.input('annotations')
  const labelOptions = readLabelOptions(ctx)
  const named = labelledAxes(labelOptions, Boolean(annotations))
  return {
    tracked: new Set(named.filter((axis) => picked[axis].size > 0)),
    labels: labelPlan(annotations, labelOptions),
    filter: filterSteps(ctx),
    order: orderSection(ctx),
    selection: AXES.map((axis) => ({ axis, positions: matrixSelectionOrder(picked[axis]) })),
    colour: colourPlan(ctx),
  }
}

/**
 * The Labels tab, or nothing. The gate is `labelledAxes`' — a wire and both pickers — spelled
 * here rather than asked of it because the renderer needs the two column names narrowed.
 */
function labelPlan(
  annotations: string | undefined,
  options: MatrixLabelOptions,
): HeatmapLabelPlan | undefined {
  if (!annotations || !options.match || !options.label) return undefined
  return {
    annotations,
    match: options.match,
    label: options.label,
    axes: axesOf(options.axis),
  }
}

/**
 * The Filter tab. Parsed through the node's own `parseLabelFilter`, so a pattern the canvas
 * refused is refused here with the axis left whole — which is what the note says the card did.
 */
function filterSteps(ctx: HeatmapContext): HeatmapFilterStep[] {
  const filters = readFilterOptions(ctx.params)
  const steps: HeatmapFilterStep[] = []
  for (const axis of AXES) {
    const query = axis === 'rows' ? filters.rows : filters.columns
    const { filter, error } = parseLabelFilter(query)
    if (error) {
      steps.push({
        axis,
        note:
          `The ${axis} filter "${query}" is not a valid regular expression, so Coda kept every ` +
          `${axis === 'rows' ? 'row' : 'column'} and so does this.`,
      })
      continue
    }
    if (!filter) continue
    steps.push({ axis, pattern: filter.pattern, regex: filter.regex, negate: filter.negate })
  }
  return steps
}

/**
 * The Order tab, or nothing when it orders nothing. The lead and the follower are the node's own
 * `orderPlan`; what is added is which leads actually get sorted — a `value` sort with no key is
 * left as it arrived, as on the card — and so whether the follower has anything to follow.
 */
function orderSection(ctx: HeatmapContext): HeatmapOrderPlan | undefined {
  const options = readOrderOptions(ctx.params)
  const by = options.by
  if (by === 'none') return undefined
  const plan = orderPlan(options)

  const sorted = new Set<MatrixAxis>()
  const steps = plan.lead.map((axis): HeatmapOrderStep => {
    if (by === 'value' && !options.key) {
      return {
        axis,
        note:
          `The ${axis} are to be ordered by one ${axis === 'rows' ? 'column' : 'row'} but ` +
          `none is named, so they are left as they arrived.`,
      }
    }
    sorted.add(axis)
    return by === 'value'
      ? { axis, by, keyMissing: missingKeyProblem(axis, options.key) }
      : { axis, by }
  })

  const leader = plan.lead[0]
  const follower =
    plan.follower && leader && sorted.has(leader) ? { axis: plan.follower, leader } : undefined
  if (follower) sorted.add(follower.axis)

  return {
    by,
    reverse: options.reverse,
    key: options.key,
    method: options.method,
    metric: options.metric,
    steps,
    follower,
    ordered: AXES.filter((axis) => sorted.has(axis)),
  }
}

/** The colour, through the three readers the viewer itself uses. */
function colourPlan(ctx: HeatmapContext): HeatmapColourPlan {
  const palette = heatmapPaletteOf(ctx.params)
  const limits = readColorLimits(ctx.params)
  return {
    palette,
    diverging: ctx.params.scale === 'diverging',
    substitute: palette === 'coda',
    limits,
    manual: limits.min !== undefined || limits.max !== undefined,
    log: heatmapLogColor(ctx.params),
    showValues: ctx.params.showValues === true,
    limitsNote: limits.problem
      ? `Coda is ignoring the colour limits because ${limits.problem}, so neither this nor ` +
        `the card is using them.`
      : undefined,
  }
}
