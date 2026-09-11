/**
 * What the Similarity Matrix, Embedding, Linkage and Cut Tree exports do, before either language
 * says it.
 *
 * Each of these emitters was a pair walking the same params in the same order to the same
 * decisions — which layout is live and which columns it needs, which Embedding route is wired and
 * whether its columns are picked, how a Linkage makes a matrix symmetric and whether it inverts
 * it, whether a Cut Tree cuts by height or by count — and differing only in how the call is
 * written. `heatmap.ts` is the precedent, and its reason: two spellings of a decision with no
 * language in it is how a fix lands in the notebook and not in the R document. So each is decided
 * here once, and `python/emitters/analysis.ts` and `r/emitters/analysis.ts` each render it —
 * syntax, variable names, libraries and helpers, and the notes whose wording differs between them.
 *
 * Refusals and notes follow `neutral.ts`' note rule. Where a note is always written (the
 * implementation notes on Embedding and Linkage, Cut Tree's renumbering) there is no decision to
 * share, and it stays with its renderer entirely.
 *
 * Both documents meet every refusal here before they ask for a library, so a refused Embedding or
 * Linkage imports nothing. The notebook's Embedding used to request `umap` ahead of its column
 * checks; that was a difference in the documents and not a decision, and it is gone.
 *
 * The rest of the file is the smaller analysis nodes whose emitters live beside these — Filter
 * Network, Landmark Transform, NBLAST Matches, Partner Vectors and Compare Connectivity — where
 * what was written twice is a refusal over unset pickers, or the gate on a note.
 */

import type { ParamValues } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { resolveDatasetNames } from '../../nodes/analysis/compareConnectivity'
import type { CompareParams } from '../../nodes/lib/edgeComparison'
import { compareParamsFrom } from '../../nodes/lib/edgeComparison'
import type { EmbedRoute } from '../../nodes/lib/embedOps'
import { embedRoute } from '../../nodes/lib/embedOps'
import { transformFor } from '../../nodes/lib/linkageOps'
import type { MatchParams } from '../../nodes/lib/matchOps'
import { matchParamsFrom } from '../../nodes/lib/matchOps'
import { repeatParamId } from '../../nodes/lib/repeatParams'
import type { LANDMARK_SIDES } from '../../nodes/transform/landmarkTransform'
import { LANDMARK_AXES, landmarkParamId } from '../../nodes/transform/landmarkTransform'
import type { SimilarityMetric, SimilarityOutput } from '../../nodes/lib/similarityOps'
import { effectiveOutput, isLongLayout } from '../../nodes/lib/similarityOps'
import { FILTER_NETWORK_DEFAULT_OP } from '../../nodes/lib/tableOps'
import { findColumn } from '../../core/types'
import { paramValueLabel } from '../../help/paramText'
import type { NeutralContext, Refusable } from '../neutral'
import type { FilterComparison } from './table'
import { filterComparison } from './table'

/** What the Similarity and Embedding plans read: params, optional wires and column pickers. */
type AnalysisContext = Pick<NeutralContext, 'params' | 'input' | 'column' | 'columns'>

/**
 * Whether a score matrix becomes `1 - score` before it is read as distances — the nodes' own
 * `transformFor`, asked without a measure, since neither a DataFrame nor an R matrix carries one.
 * So `auto` inverts, as the node does for a similarity, and only `none` reads the values as
 * distances already.
 */
function inverts(distance: string): boolean {
  return transformFor(undefined, distance) === 'one_minus'
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** One `coda_similarity_wide|long(...)` call, in either layout. */
export type SimilarityCall = { metric: string; output: SimilarityOutput } & (
  | { layout: 'wide'; idColumn: string; columns: string[] }
  | { layout: 'long'; observations: string; features: string; value?: string }
)

export type SimilarityPlan = Refusable<{ call: SimilarityCall }>

/**
 * The similarity call, for the two nodes that reach it — `core.similarity`, and `core.embed`'s
 * Features port, which differ only in which param holds the long feature picker, what the
 * refusal calls the node, and the output.
 *
 * Through the nodes' own `isLongLayout`, so the export and the node's `visibleIf` cannot disagree
 * about which layout is live. The refusal is decided before anything is requested of the context:
 * a node that emits a TODO should not still pull two hundred lines of helper into the document,
 * which is why both renderers ask `ctx.helper` only once they have a call.
 */
function similarityCall(
  ctx: AnalysisContext,
  label: string,
  featureParam: string,
  output: SimilarityOutput,
): SimilarityPlan {
  const metric = String(ctx.params.metric)
  if (!isLongLayout(ctx.params)) {
    const idColumn = ctx.column('idColumn')
    const columns = ctx.columns('wideFeatures')
    return idColumn && columns.length > 0
      ? { call: { layout: 'wide', idColumn, columns, metric, output } }
      : { refusal: `This ${label} needs an Id column and at least one feature column.` }
  }
  const observations = ctx.column('observations')
  const features = ctx.column(featureParam)
  if (!observations || !features) {
    return { refusal: `This ${label} needs an Observations and a Features column.` }
  }
  const value = ctx.column('value')
  return {
    call: {
      layout: 'long',
      observations,
      features,
      value,
      metric,
      output,
    },
  }
}

/** A Similarity Matrix node's export. */
export function similarityPlan(ctx: AnalysisContext): SimilarityPlan {
  // Through `effectiveOutput`, not `params.output`: a metric with no similarity form hides that
  // param, so reading it raw would write `output = "similarity"` for a node whose run could only
  // produce distances — an argument the run it mirrors never used.
  const output = effectiveOutput(
    String(ctx.params.metric) as SimilarityMetric,
    String(ctx.params.output) as SimilarityOutput,
  )
  return similarityCall(ctx, 'Similarity Matrix', 'features', output)
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

/** The UMAP settings, as the card holds them. Which of them each library takes is the renderer's. */
export interface EmbedSettings {
  neighbours: number
  minDist: number
  spread: number
  /** Present only when set — 0 is "the library's default", written by leaving the argument out. */
  epochs?: number
  seed: number
}

/** A note an Embedding export may carry, after its UMAP call. The texts are each renderer's. */
export type EmbedNote =
  /** `auto` read the matrix as similarities and inverted it. */
  'autoDistance'

/** Whether a score matrix is turned into distances, and which notes say so. */
interface EmbedDistance {
  invert: boolean
  notes: EmbedNote[]
}

/** The wired route and what it reads, or the TODO its missing columns become. */
export type EmbedInput = { route: EmbedRoute } & Refusable<
  | {
      route: 'neighbours'
      src: string
      query: string
      target: string
      score?: string
      scoreIs: string
    }
  | ({ route: 'matrix'; src: string } & EmbedDistance)
  | ({ route: 'features'; src: string; call: SimilarityCall } & EmbedDistance)
>

export type EmbedPlan = Refusable<{
  settings: EmbedSettings
  input: EmbedInput
  /** The Annotations join, when the port is wired and a label column picked. */
  annotations?: { table: string; key: string; value: string }
}>

/**
 * An Embedding node's export.
 *
 * Two levels of refusal: the plan's is the route itself (none wired, or several), the input's a
 * route whose columns are not picked. Both documents write either before asking for any library.
 */
export function embedPlan(ctx: AnalysisContext): EmbedPlan {
  // The node's own decision, not a fourth copy of the port list: `embedRoute` is what `validate`
  // and `evaluate` ask too, so a fourth route cannot arrive without both documents noticing. Its
  // refusal becomes a TODO — emitting the first of two would put a picture in the document
  // computed from an input the canvas never used.
  const selected = embedRoute((port) => ctx.input(port) !== undefined)
  if (!selected.ok)
    return { refusal: `This Embedding cannot be translated: ${selected.refusal}` }

  const epochs = Number(ctx.params.epochs)
  const settings: EmbedSettings = {
    neighbours: Number(ctx.params.neighbors),
    minDist: Number(ctx.params.minDist),
    spread: Number(ctx.params.spread),
    epochs: epochs > 0 ? epochs : undefined,
    seed: Number(ctx.params.seed),
  }

  const annotations = ctx.input('annotations')
  const labelBy = ctx.column('labelBy')
  return {
    settings,
    input: embedInput(ctx, selected.route),
    annotations:
      annotations && labelBy
        ? { table: annotations, key: ctx.column('matchOn') ?? ID_COLUMN_NAME, value: labelBy }
        : undefined,
  }
}

function embedInput(ctx: AnalysisContext, route: EmbedRoute): EmbedInput {
  if (route === 'neighbours') {
    const query = ctx.column('queryColumn')
    const target = ctx.column('targetColumn')
    if (!query || !target) {
      return {
        route,
        refusal: 'This Embedding needs the two columns naming each neighbour pair.',
      }
    }
    const score = ctx.column('scoreColumn')
    return {
      route,
      src: ctx.input('neighbours')!,
      query,
      target,
      score,
      scoreIs: String(ctx.params.scoreIs),
    }
  }

  if (route === 'features') {
    /*
     * The same call the Similarity Matrix node emits, through the same function — so a graph that
     * does this in two cards and one that does it in one produce the same matrix, and a fix to the
     * guard reaches both documents. `distance` rather than the node's own control, which it does
     * not have: the Features route asks for distances, so there is nothing left to invert.
     */
    const plan = similarityCall(ctx, 'Embedding', 'featureColumn', 'distance')
    if (plan.refusal !== undefined) return { route, refusal: plan.refusal }
    return { route, src: ctx.input('features')!, call: plan.call, invert: false, notes: [] }
  }

  // Only a matrix inverted *because* of `auto` is noted: the note says a matrix of distances
  // would have been used as it stands.
  const distance = String(ctx.params.distance)
  const invert = inverts(distance)
  return {
    route,
    src: ctx.input('matrix')!,
    invert,
    notes: invert && distance === 'auto' ? ['autoDistance'] : [],
  }
}

// ---------------------------------------------------------------------------
// Linkage
// ---------------------------------------------------------------------------

/**
 * Every method name fastcore's `linkage` accepts — `Method::from_name` in fastcore-rs, which is
 * SciPy's list — and so every name the canvas can cluster with. Not `LINKAGE_METHODS`, which is
 * the five the card *offers*: a hand-edited file can hold `centroid`, and the canvas runs it.
 * Anything else makes fastcore raise, so the card fails at Run.
 */
const FASTCORE_METHODS = [
  'single',
  'complete',
  'average',
  'weighted',
  'ward',
  'centroid',
  'median',
] as const

/**
 * Why a clustering method cannot be translated, or undefined when it can — for Linkage and the
 * Heatmap's cluster order, which pass the same name to the same library.
 */
export function clusterMethodRefusal(method: string): string | undefined {
  if ((FASTCORE_METHODS as readonly string[]).includes(method)) return undefined
  return (
    `"${method}" is not a linkage method fastcore knows (${FASTCORE_METHODS.join(', ')}), ` +
    `so the canvas cannot cluster with it either.`
  )
}

/** A note a Linkage export may carry. The texts are each renderer's; *whether* is decided here. */
export type LinkageNote =
  /** Symmetry is off, so only one triangle is read — which one differs between the languages. */
  'symmetryOff'

const COMBINE = ['mean', 'min', 'max'] as const

export type LinkagePlan = Refusable<{
  /**
   * Coda's method name, one fastcore accepts. The notebook passes it to SciPy as is; R maps it
   * onto `hclust`'s, and refuses the two it cannot map.
   */
  method: string
  /**
   * How the matrix is made symmetric before it is read, or `undefined` to read it as it stands —
   * which is `none`, and also what an unrecognised stored value has always done.
   */
  combine?: (typeof COMBINE)[number]
  /** Whether the distance is `1 - score`. Only `none` says the values already are distances. */
  invert: boolean
  notes: LinkageNote[]
  /**
   * What `auto` becomes in a document, which cannot see the matrix's measure — the same text in
   * both. Present exactly when Distance is `auto`.
   */
  autoNote?: string
}>

export function linkagePlan(ctx: Pick<NeutralContext, 'params' | 'def'>): LinkagePlan {
  const { params } = ctx
  const method = String(params.method)
  const refusal = clusterMethodRefusal(method)
  if (refusal) return { refusal }
  const symmetry = String(params.symmetry)
  const distance = String(params.distance)
  const notes: LinkageNote[] = []
  if (symmetry === 'none') notes.push('symmetryOff')
  // Typed, not read off `LINKAGE_SYMMETRY_OPTIONS`: that list is untyped by value, so a new option
  // would reach each renderer's `SYMMETRISE` as a key it lacks and print `undefined`. Here it is
  // unrecognised, and read as it stands.
  const combine = COMBINE.find((value) => value === symmetry)
  const distanceParam = ctx.def.params?.find((p) => p.id === 'distance')
  const asIs = distanceParam ? paramValueLabel(distanceParam, 'none') : 'none'
  return {
    method,
    combine,
    invert: inverts(distance),
    notes,
    autoNote:
      distance === 'auto'
        ? 'Distance is on Auto, which the canvas decides from the matrix’s own measure: a ' +
          'similarity is turned into 1 − score, a distance is used as it stands. This document ' +
          'cannot see the measure, so it assumes similarities and uses 1 − score. If the matrix ' +
          `holds distances, set Distance to "${asIs}" on the card and export again.`
        : undefined,
  }
}

// ---------------------------------------------------------------------------
// Cut Tree
// ---------------------------------------------------------------------------

export type CutPlan = Refusable<{
  by: 'height' | 'count'
  at: number
  /** Said beside a height cut, in both documents: its group count is not the card's choice. */
  note?: string
}>

export function cutPlan(params: ParamValues): CutPlan {
  /*
   * The mixed-dataset mode has no counterpart in either language. `cut_tree`/`cutree` both cut
   * across the tree at one level; this mode descends to the deepest clusters drawing from every
   * dataset, which is a walk over the merge matrix rather than a cut. Emitting a count cut instead
   * — which is what falling through to the branch below did — produces a document that *runs*,
   * returns four clusters, and is a different analysis from the canvas, with `4` being a default
   * the user never saw because the control is hidden in this mode.
   *
   * `docs/export.md`'s policy: two things are refused, every other gap emits a TODO. Writing the
   * walk in both languages is the fix if somebody wants it; a silent wrong answer is not.
   */
  const mode = String(params.mode)
  if (mode === 'mixed') {
    return {
      refusal:
        'This Cut Tree groups by which datasets each cluster draws from, which has no ' +
        'single-call equivalent here.',
    }
  }
  return mode === 'height'
    ? {
        by: 'height',
        at: Number(params.height),
        note:
          'Cutting at a height gives however many groups fall out below it, which may be one ' +
          'if the height is above the top of the tree.',
      }
    : { by: 'count', at: Number(params.count) }
}

// ---------------------------------------------------------------------------
// Filter Network
// ---------------------------------------------------------------------------

export type FilterNetworkPlan = Refusable<{
  /** The condition on a node attribute, when a column is picked. */
  condition?: FilterComparison
  /** The wired seed table and its id column, when both are there. */
  seed?: { table: string; column: string }
}>

/**
 * Seeds from a condition, from a wired table, or both — unioned. Neither is a refusal.
 *
 * The condition is Filter Table's `filterComparison`, with the dtype read through
 * `ctx.attributes`: `schemaOf` has no branch for a network, and this is the accessor
 * `InferContext` carries for exactly that.
 */
export function filterNetworkPlan(
  ctx: Pick<NeutralContext, 'params' | 'input' | 'column' | 'attributes'>,
): FilterNetworkPlan {
  const column = ctx.column('column')
  const table = ctx.input('seed')
  const seedColumn = ctx.column('seedColumn')
  const seed = table && seedColumn ? { table, column: seedColumn } : undefined
  if (!column && !seed) return { refusal: 'Nothing selects any nodes on this Filter Network.' }
  const condition = column
    ? filterComparison(
        ctx.params,
        column,
        findColumn(ctx.attributes('in', 'nodes'), column)?.dtype,
        FILTER_NETWORK_DEFAULT_OP,
      )
    : undefined
  return { condition, seed }
}

// ---------------------------------------------------------------------------
// Landmark Transform
// ---------------------------------------------------------------------------

/** The source and target coordinate columns, x-y-z each. */
export type LandmarkPlan = Refusable<{ from: string[]; to: string[] }>

/**
 * Through the node's own id builder, so a renamed param breaks the build rather than quietly
 * emitting the "unset columns" TODO.
 */
export function landmarkPlan(ctx: Pick<NeutralContext, 'column'>): LandmarkPlan {
  const columns = (side: (typeof LANDMARK_SIDES)[number]) =>
    LANDMARK_AXES.map((axis) => ctx.column(landmarkParamId(side, axis)) ?? '')
  const from = columns('source')
  const to = columns('target')
  if ([...from, ...to].some((name) => !name)) {
    return { refusal: 'Landmark Transform has unset coordinate columns — pick all six.' }
  }
  return { from, to }
}

// ---------------------------------------------------------------------------
// NBLAST Matches
// ---------------------------------------------------------------------------

/** A note a Matches export may carry. The texts are each renderer's; *whether* is decided here. */
export type MatchesNote =
  /**
   * `Best means` is on "from the matrix". `auto` reads `MatrixValue.measure`, which lives on the
   * *value* and not on the type, so it is decided at run time and no export can see it — nor guess
   * it, since the same port carries an NBLAST similarity, a Pivot's counts and a normalised
   * distance matrix. So `auto` emits the majority answer, higher is better, and says so.
   */
  'autoDirection'

export interface MatchesPlan {
  /** The node's own decoder — `axis` stored as text and meant as a number, and the rest. */
  match: MatchParams
  notes: MatchesNote[]
}

export function matchesPlan(params: ParamValues): MatchesPlan {
  const match = matchParamsFrom(params)
  return { match, notes: match.direction === 'auto' ? ['autoDirection'] : [] }
}

// ---------------------------------------------------------------------------
// Partner Vectors
// ---------------------------------------------------------------------------

export function partnerVectorsPlan(
  ctx: Pick<NeutralContext, 'column'>,
): Refusable<{ weight: string }> {
  const weight = ctx.column('weight')
  return weight
    ? { weight }
    : { refusal: 'This Partner Vectors node has no weight column picked.' }
}

// ---------------------------------------------------------------------------
// Compare Connectivity
// ---------------------------------------------------------------------------

/**
 * The node's own reading of its repeated params — `resolveDatasetNames` for the names, which are
 * the output's column names and deduplicated, so a re-derivation would name a column the canvas
 * does not have. Refused at the first dataset missing an endpoint column.
 */
export function compareConnectivityPlan(
  ctx: Pick<NeutralContext, 'params' | 'column'>,
): Refusable<CompareParams> {
  const spec = compareParamsFrom(ctx, resolveDatasetNames(ctx), repeatParamId)
  const missing = spec.columns.findIndex((columns) => !columns.pre || !columns.post)
  if (missing >= 0) {
    return {
      refusal: `Dataset ${missing + 1} of this Compare Connectivity has no pre or post column.`,
    }
  }
  return spec
}
