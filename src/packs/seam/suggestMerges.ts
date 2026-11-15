/**
 * Suggest Merges: run SEAM's search over a neuron's open ends and publish the ranked candidates.
 *
 * ## It computes a set; it does not read one
 *
 * `seam:suggestions` reads the lists SEAM's pipeline produced on a cluster. This does stages 4
 * and 5 — the 6 µm box, the eleven geometric features, the forest, the cut, the own-tip rule —
 * in the browser, for the ends on the wire — and stages 6 to 9 too, where an `Assessor` is
 * picked. Everything it publishes was measured here, from the
 * segmentation as the chosen materialization saw it.
 *
 * **The pipeline is Coda's, not a published run's.** The box size, the pool radius, the cut, the
 * own-tip radius and the forest's feature order are one decision — every number was fixed when
 * the forest was fitted — so they ride in the model manifest beside the weights and are picked
 * together by `Ranker` (`rankerConfig.ts`). The node used to read them out of whichever
 * suggestion set it was pointed at, which made Coda's pipeline a property of somebody else's run.
 *
 * ## It streams, because a reader starts before the run ends
 *
 * Each end is measured, ranked, ruled and **published** on its own, so the review card fills as
 * the search sweeps the arbour rather than after it. What makes that honest is that a published
 * end is final: the own-tip rule reads the tip *positions*, which are known before any box is
 * read, so a later end cannot change an earlier one. `searchRun.ts` yields them one at a time and
 * says what that cost.
 *
 * ## Two answers, and `Assessor` is which one
 *
 * With **no assessor**, the search says where a candidate is and how the forest ranks it:
 * `geo_rank`, `rank`, `vol_um3`, `min_dist_um` and the contact point. It says nothing about how
 * *likely* the merge is to be right, and the columns that would — `p_cand`, `conf`, `q`, `shown`
 * — are **absent rather than null** (`searchTips.ts` says why). A queue fed from there is
 * ordered by geometry with no cutoff applied: a real answer, since the forest is fitted to rank
 * and its first candidate is the piece most likely to be the continuation, but not a probability.
 *
 * With one **picked**, each candidate's 4 µm patch of segmentation goes through the checkpoint
 * and the stages after it run from the fits the checkpoint's own manifest carries — so the list
 * comes back in SEAM's order (`rank` by `logit`, `geo_rank` still the forest's), every candidate
 * carries `p_cand` and `conf`, and the tip carries `p_tip`, `q`, `r` and shown-or-withheld
 * against the cutoff this configuration was fitted with. `singleSeed.test.ts` holds all of it to
 * SEAM's own published numbers.
 *
 * **It costs about two seconds an end on top of the search**, and the checkpoint is a 133 MB
 * download. The network is Coda's own WGSL implementation rather than ONNX Runtime — 26.5 ms a
 * patch against 136 — so most of an assessed end is now the two boxes it reads.
 *
 * `Assess top` caps the patches per end; what the cap costs in answers is measured on SEAM's own
 * set, in `assessEnds.ts`' header, and the part worth knowing is that it does not only lose
 * suggestions, it invents a few. Since the runtime changed it also buys much less than it used
 * to — see `CANDIDATES_PER_END`.
 *
 * ## It does not cut the **ends**, and that is the lesson from `seam:findMerges`
 *
 * A whole neuron is hundreds of open ends and each is a ~19 MB cutout, so something has to
 * narrow them. It is not this node. `seam:findMerges` shipped a `Score cutoff` inside an
 * expensive node, and the cost was that every nudge re-ran the whole thing and a discarded
 * answer looked like a verdict the model had given. Narrowing here is a `Filter Table` on `e_tip`
 * above this node, where the cut is a thing somebody did. What this node has instead is a guard
 * rail: it prices the wait and warns, and runs anyway (`docs/limits.md`).
 *
 * **Narrowing the ends also narrows the own-tip rule, and that is not a bug to fix here.** The
 * rule drops a candidate whose contact is nearer some *other* tip of the neuron, and the only
 * tips it can measure against are the rows it was given. Filter to twenty ends and a candidate
 * that belonged to one of the other four hundred is now kept, and published as one of the twenty's
 * first. Ends this node drops itself — a box outside the volume — stay competitors for exactly
 * this reason; rows a `Filter Table` removed are not here to keep. So a filtered run is a
 * slightly more generous answer than SEAM's, never a different ranking of the same list, and a
 * reader comparing against a published set should search the whole neuron.
 *
 * ## Read-only
 *
 * Boxes out of a public bucket, roots and chunk counts out of the chunkedgraph, and nothing
 * written anywhere. The merge is the proofreader's own, in their own viewer, with their own
 * token — SEAM's invariant 7, which holds in every phase of this pack.
 */

import type { EvalContext, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { warnOverWait } from '../../core/limits'
import type { TableValue } from '../../core/values'
import { isTableValue } from '../../core/values'
import { agree, plural } from '../../style/format'
import {
  CAVE_DATASET_INPUT,
  caveDatastackIssues,
  caveDatastackParam,
  caveTargetOfValue,
} from '../../nodes/lib/caveParams'
import { NM_PER_UM } from '../../data/units'
import type { CandidatePoolRequest, PoolSizesRequest } from '../../pyodide/cutoutSummary'
import { runCandidatePool, runPoolSizes } from '../../pyodide/cutoutSummary'
import { l2ChunkCounts } from '../../data/cave/rootIds'

import { useAssessorBox } from '../../pyodide/assessorPatches'
import type { TreeRanker } from './treeRanker'

import { assessEnd } from './assessEnds'
import type { AssessSteps } from './assessEnds'
import { ASSESSOR_RUNTIME, parseAssessorConfig } from './assessorModel'
import type { AssessorConfig } from './assessorModel'
import { scoreCandidates } from './assessorRun'
import type { AffinityModel } from './models'
import {
  MERGE_ASSESSOR_MODELS,
  MERGE_ASSESSOR_TASK,
  MERGE_RANKER_MODELS,
  NO_ASSESSOR,
  mergeAssessorModel,
  mergeRankerModel,
} from './models'
import { openSeamModel } from './openWindowModel'
import type { OpenedSeamModel } from './openWindowModel'
import { patchBoxFor, patchScaleFrom } from './patchBox'
import { afterShare } from './progress'
import { openTreeRanker } from './rankerConfig'
import type { RankerConfig } from './rankerConfig'
import { contactsOf, publishedEnd, reportOnRun } from './scoreEnds'
import { searchEnds } from './searchRun'
import type { SearchedEnd } from './searchRun'
import type { PublishedEnd, TipRow } from './searchTips'
import {
  candidateFields,
  candidatesTable,
  searchOnly,
  tipPositions,
  tipsByNeuron,
  tipsFromTable,
  tipsSchema,
  tipsWithFirsts,
} from './searchTips'
import { schemaOf } from './suggestionTables'
import {
  boxFits,
  endToSearch,
  forgetRoots,
  labelledBox,
  openSearchVolume,
} from './searchVolume'
import type { SearchVolume } from './searchVolume'
import type { CaveRequestOptions } from '../../data/cave/client'

/** How much of the progress bar the ranker gets before the search starts. It is 1.3 MB. */
const MODEL_SHARE = 0.02

/**
 * And the assessor's share, where one is picked. It is 133 MB.
 *
 * Bigger than the ranker's by a lot more than the ratio of the two downloads, and deliberately:
 * the forest is text off a lab host and this is 133 MB that has to be fetched and verified,
 * which on a cold cache is the longest single wait in the run — roughly ten seconds on a
 * 100 Mbit link, against 4 s for the end that follows it. **Opening** it is not the wait:
 * 330–440 ms, shorter than one end. Once the weights are in the browser's cache the bar crosses
 * this in a blink, which is the right way round — a reader watching a stalled bar wants to know
 * it is the download.
 */
const ASSESSOR_SHARE = 0.1

/**
 * What one open end costs, in seconds, measured on Aedes.
 *
 * The box is ~19 MB over the network and the pool is 560 ms of Pyodide warm; the chunkedgraph
 * calls ride on top and are shared between neighbouring ends, so they are not in the figure.
 * Two seconds is the whole-end number the probe reports on a warm worker with the box cached,
 * rounded up — a cold first end is some four seconds more and is not worth modelling.
 *
 * **A rate, not a limit.** `WAIT_WARN_SECONDS` decides when the number is worth saying; this only
 * turns a count of ends into it, which is `docs/limits.md`' rule about stating a limit in the
 * units of what it protects.
 */
export const SECONDS_PER_END = 2

/**
 * What one assessed candidate costs, in seconds: a 129³ patch cut and run.
 *
 * **26.5 ms**, measured on real patches through Coda's own WGSL implementation of the network
 * (`docs/seam-assessor-speed.md` §14, M3 Max / Chrome 157). The cut is about 40 ms a group of
 * four and is prefetched one group deep, so it hides behind the ~106 ms of GPU that group costs
 * and does not appear here.
 *
 * **The ONNX Runtime path was 136 ms** for the same network and the same answer — its WebGPU
 * backend runs 3D `Conv` through a per-element shader — so this is 5.1x cheaper. That is not
 * only a faster run: it moves where an end's time *goes*, which is why `Assess top` no longer
 * promises much. `secondsPerEnd` is the sum.
 *
 * (A draft of this constant said 0.17, which was a review chain's *budget* for 133 ms of GPU
 * plus some of the cut, never a measurement of anything. It never shipped, and prose contrasting
 * against it was comparing a measurement with an estimate. The two real numbers are 136 and
 * 26.5, both from §14 on the same patches.)
 */
const SECONDS_PER_PATCH = 0.0265

/**
 * The patch box an end's whole list shares: a little over 8 µm of segmentation, read once.
 *
 * **The top of a measured range, deliberately.** It was put at 0.5–1 s per end by the review
 * that found this box re-reads chunks the search box fetched seconds earlier
 * (`docs/seam-suggestions-plan.md`), and that measurement was explicitly flagged as wanting a
 * browser to confirm it — the sharded path uses Range requests, which browsers cache unreliably.
 * A guard rail that under-states a wait is the one that fails, so this takes the high end until
 * somebody measures it properly. At 0.5 s the headline "two seconds on top" would be 1.6.
 */
const SECONDS_PER_PATCH_BOX = 1

/**
 * How many candidates an end's list holds once the own-tip rule has run, for pricing a wait.
 *
 * SEAM's own rv2 sets: 40 on average over 2,708 tips, 1 to 94. **An average, not a cap** — the
 * list is already cut at the ranker's `top_k` and thinned by the own-tip rule, so there is no
 * number to read off a manifest. It prices a run of hundreds of ends, where an average is what
 * a total is made of.
 */
const CANDIDATES_PER_END = 40

/**
 * Which assessor a run is to use, from the param — the **one** derivation of it.
 *
 * `undefined` for none, and a sentence for an id this build does not carry; a saved graph keeps
 * a param it no longer has a row for (`core/persistence`), so falling back to the first row
 * would score with a different checkpoint under a different set of fits and say nothing. The
 * three readers — `inferOutputs`, `validate` and `evaluate` — ask this rather than each
 * re-deriving it, which is also where the arm B row will arrive.
 *
 * It reads `params.assessor` **plainly**, with no `?? NO_ASSESSOR`: `withDefaults` has already
 * put the declared default in, and invariant 4 names that exact spelling as the one that drifts
 * from the declaration it is copying.
 */
function chosenAssessor(params: ParamValues): { model?: AffinityModel; issue?: string } {
  const id = String(params.assessor)
  if (id === NO_ASSESSOR) return {}
  const model = mergeAssessorModel(id)
  return model ? { model } : { issue: unknownModel('an assessor', id, 'Assessor') }
}

/**
 * The same question about the forest, and it has the same readers.
 *
 * It was written out twice before this — once in `validate`, once in `evaluate` — and the two
 * sentences had already drifted: only one of them said which control to fix. That is exactly
 * the drift `chosenAssessor` above exists to prevent, so the node's other model param gets it
 * too rather than the helper being applied to one of the two.
 */
function chosenRanker(params: ParamValues): { model?: AffinityModel; issue?: string } {
  const id = String(params.model)
  const model = mergeRankerModel(id)
  return model ? { model } : { issue: unknownModel('a ranker', id, 'Ranker') }
}

/**
 * One sentence for "a saved graph names a model this build no longer carries".
 *
 * An ordinary thing rather than an error — a graph keeps the param it was saved with
 * (`core/persistence`) — and the only useful answer names **which** model and **which** control.
 * The alternative a node could take is to fall back to the first row of its list and rank, or
 * score, with a different pipeline under the same heading.
 */
function unknownModel(what: string, id: string, param: string): string {
  return `This build does not have ${what} called \`${id}\`. Pick one in \`${param}\`.`
}

/**
 * What one end costs with the assessor a reader picked, and the cap they set.
 *
 * Exported for the test rather than its three constants, so a change to how an assessed end is
 * priced cannot pass a test that recomputes the old formula from the parts.
 */
export function secondsPerEnd(assessed: boolean, top: number): number {
  if (!assessed) return SECONDS_PER_END
  const patches = top > 0 ? Math.min(top, CANDIDATES_PER_END) : CANDIDATES_PER_END
  return SECONDS_PER_END + SECONDS_PER_PATCH_BOX + patches * SECONDS_PER_PATCH
}

export const suggestMergesNode = packNode({
  type: 'seam:suggestMerges',
  label: 'Suggest Merges',
  category: 'analysis',
  description:
    'Searches around each open end for the piece of segmentation most likely to be its continuation, and ranks them with SEAM’s forest.',
  guide:
    'Takes a table of open ends and, for each, reads a 6 µm box of segmentation around it, ' +
    'measures every object that comes near the neuron there, and ranks them with the forest ' +
    'picked in Ranker. Each end is published as it finishes, so Review Suggestions fills while ' +
    'the rest of the neuron is still being measured — the `searched` column says which tips ' +
    'it has reached, and false where it never will, the end lying outside the volume. ' +
    'Without an Assessor the ranking is ' +
    'geometric — no probability and no cutoff, and those columns are absent rather than empty. ' +
    'Pick one and every candidate also goes through SEAM’s own network, which gives the list a ' +
    'calibrated probability and each tip a shown-or-withheld verdict, for about two seconds ' +
    'an end more and a 133 MB download. It searches every row it is given either way, so narrow ' +
    'the ends with a Filter Table above it rather than looking for a cutoff here — though ' +
    'filtering also narrows what the own-tip rule can compare against, so a filtered run keeps ' +
    'a few candidates a whole-neuron run would drop.',
  cost: 'expensive',

  inputs: [{ id: 'tips', label: 'Tips', type: T.table() }, CAVE_DATASET_INPUT],
  outputs: [
    { id: 'tips', label: 'Tips', type: T.table() },
    { id: 'candidates', label: 'Candidates', type: T.table() },
  ],
  params: [
    {
      id: 'model',
      kind: 'enum',
      label: 'Ranker',
      default: MERGE_RANKER_MODELS[0]!.id,
      options: MERGE_RANKER_MODELS.map((model) => ({ value: model.id, label: model.label })),
      help: 'Which forest to order each open end’s candidates with. The model carries the pipeline it was fitted with — the box size, the pool radius, the cut and the feature order — so picking a ranker picks all of them together.',
    },
    {
      id: 'assessor',
      kind: 'enum',
      label: 'Assessor',
      default: NO_ASSESSOR,
      options: [
        { value: NO_ASSESSOR, label: 'None — rank by geometry' },
        ...MERGE_ASSESSOR_MODELS.map((model) => ({ value: model.id, label: model.label })),
      ],
      help: 'Which checkpoint judges whether each candidate really continues the neuron. Without one the answer is the forest’s ranking and nothing else — no probability and no cutoff. With one, each candidate gets a 4 µm patch of segmentation through the network, and the tip gets SEAM’s own `q`, `r` and shown/withheld. It costs about two seconds an end on top of the search, and the model is a 133 MB download kept in this browser.',
    },
    {
      id: 'download',
      kind: 'boolean',
      label: 'Download the model',
      default: false,
      visibleIf: (params) => params.assessor !== NO_ASSESSOR,
      help: 'The assessor’s weights are 133 MB, fetched once and kept in this browser. Off by default so a graph that opens on its own does not reach for them. The ranker is 1.3 MB and is never asked about.',
    },
    {
      id: 'assessTop',
      kind: 'number',
      label: 'Assess top',
      default: 0,
      min: 0,
      step: 5,
      absentMeans: 0,
      visibleIf: (params) => params.assessor !== NO_ASSESSOR,
      help: 'How many of each end’s ranked candidates to put through the assessor, counting from the forest’s first. 0 is all of them, which is what SEAM does. Since the assessor runs at 26.5 ms a patch, most of an assessed end is now the two boxes it reads rather than the scoring — so a cap of 25 cuts the patches by 43% but the run by only about a tenth, and it does not only lose suggestions, it invents a few: flooring the rest of the list concentrates the first candidate’s share and so raises `q`. It changes the verdict on 5 tips of SEAM’s own 2,708. Narrowing the ends with a Filter Table above this node is the better lever.',
    },
    caveDatastackParam(
      'Which datastack’s segmentation to search, as `datastack:materialization`. Wire a Dataset instead and this follows it. The materialization decides *when* the supervoxels are read as belonging to a neuron, so it should be the one the open ends were found in.',
    ),
  ],

  /*
   * The full published shape, before anything runs — invariant 2's reason. A column picker on a
   * downstream Filter Table is the first thing a reader reaches for, and it cannot wait for a
   * neuron's worth of boxes. The tips half keeps the incoming table's own columns beside the
   * published ones, because a tip carries whatever Find Open Ends gave it.
   */
  inferOutputs: (ctx) => {
    // Read from the param, not from a run: `Assessor` decides eleven columns, and a picker on a
    // Filter Table below has to be offered them before anything has been measured. It is one
    // string comparison — invariant 2's bar is "never throws, never fetches", not "is trivial".
    const assessed = String(ctx.params.assessor) !== NO_ASSESSOR
    return {
      tips: T.table(tipsSchema(ctx.schema('tips'), assessed)),
      candidates: T.table(schemaOf(candidateFields(assessed))),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    for (const chosen of [chosenRanker(ctx.params), chosenAssessor(ctx.params)]) {
      if (chosen.issue) issues.push(chosen.issue)
    }
    issues.push(...caveDatastackIssues(ctx.inputs.dataset, ctx.params))
    return issues
  },

  evaluate: async (ctx) => {
    const table = ctx.input('tips')
    if (!isTableValue(table)) throw new Error('Tips input is missing')
    const target = caveTargetOfValue(ctx.input('dataset'), ctx.params)
    if (!target) {
      throw new Error(
        'No datastack. Wire a Dataset, or type one as `datastack:materialization` in `Datastack`.',
      )
    }

    /*
     * **The assessor is chosen before the table is read, and the table before a byte is
     * fetched.** Choosing costs nothing — `chosenAssessor` is a lookup in a list — and it
     * decides which columns the run needs, so `tipsFromTable` can refuse by name for the whole
     * run rather than the node remembering a second check afterwards.
     *
     * The order matters because the thing a reader is most likely to have done is wire this to
     * the wrong node, and paying three round trips and 133 MB before saying "wire this to Find
     * Open Ends" is the one wait that buys nothing.
     */
    const { model: assessorModel, issue } = chosenAssessor(ctx.params)
    if (issue) throw new Error(issue)
    const assessing = assessorModel !== undefined

    const { rows, dropped } = tipsFromTable(table, assessing)
    if (dropped > 0) {
      ctx.warn(
        `${plural(dropped, 'row')} of the Tips table could not be searched — no position, no ` +
          '`end_uid`, or a neuron that is not a chunkedgraph id. ' +
          `${agree(dropped, 'It is', 'They are')} passed through unsearched.`,
      )
    }
    const top = assessing ? Math.max(0, Math.floor(Number(ctx.params.assessTop) || 0)) : 0

    /*
     * Through `tipsWithFirsts` rather than handing back `table`, so the empty answer is the shape
     * `inferOutputs` promised: one schema function, one value writer, and no path that publishes
     * a table a column picker below has not been offered.
     */
    if (rows.length === 0) {
      return {
        // Nothing attempted, so every row of the incoming table is a row this run will not
        // search — which is what the warning just above says in prose.
        tips: tipsWithFirsts(table, [], [], assessing, new Set<number>()),
        candidates: candidatesTable([], [], assessing),
      }
    }
    warnOverWait(ctx, {
      seconds: rows.length * secondsPerEnd(assessing, top),
      what: assessing
        ? `Searching and assessing ${plural(rows.length, 'open end')}`
        : `Searching ${plural(rows.length, 'open end')}`,
      lever: assessing
        ? 'Each end is a 6 µm box of segmentation at about 19 MB, a second box for the patches, ' +
          'and a patch through the network per candidate. Narrow the ends with a Filter Table ' +
          'on `e_tip` above this node, or cap the candidates with `Assess top`.'
        : 'Each end is a 6 µm box of segmentation, about 19 MB. Narrow them with a Filter Table ' +
          'on `e_tip` above this node.',
    })

    const { model, issue: rankerIssue } = chosenRanker(ctx.params)
    if (!model) throw new Error(rankerIssue)
    /*
     * **One instant for the whole run.** Every box is turned into roots at the same moment, so
     * the supervoxels two neighbouring ends share are asked about once — which is what
     * `SearchVolume.roots` then makes free. The materialization is the dataset's, not the
     * clock's, which also makes the answer the same on a re-run.
     */
    const when = { version: target.version } as const
    const options = { deployment: target.deployment, signal: ctx.signal }

    /*
     * **Opened in turn, not together, and the order is the whole of the reason.**
     *
     * This comment used to claim the forest and the volume were fetched concurrently. They never
     * were, and they should not be: every refusal worth having happens before the next step's
     * first request. The ranker first, because a manifest this build cannot read or a config
     * missing a number costs one small file. Then the assessor, because `openSeamModel` answers
     * "no usable GPU", "no runnable build" and "nobody ticked Download" before it fetches a
     * byte — and all three would otherwise come after three CAVE round trips. The volume last,
     * and only then does a request go to a shared server.
     *
     * It costs a second or so of serialisation on a warm cache. Overlapping them would buy that
     * back and give up the property above, which is the wrong trade on a node whose next step
     * is a 19 MB read per end.
     */
    const { ranker, config: plan } = await openTreeRanker(model, {
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(fraction * MODEL_SHARE, note),
    })

    /*
     * **The assessor is opened before the volume**, and the order is the cheap-refusal rule
     * again: a browser with no usable GPU, a config this build cannot read, a 133 MB download
     * nobody ticked — all three are answered by `openSeamModel` before it fetches a byte, and
     * all three would otherwise come after three CAVE round trips.
     *
     * **The session is open from here**, so everything that can throw is inside the `finally`
     * below. A session left open holds a worker and a GPU device.
     */
    const assessor = assessorModel
      ? await openSeamModel({
          model: assessorModel,
          task: MERGE_ASSESSOR_TASK,
          parse: parseAssessorConfig,
          download: ctx.params.download === true,
          downloadShare: ASSESSOR_SHARE,
          signal: ctx.signal,
          progress: (fraction, note) => ctx.progress(MODEL_SHARE + fraction, note),
          /*
           * **Coda's own WGSL, not ONNX Runtime.** `ASSESSOR_RUNTIME` hands back the same
           * `ModelSession`, so nothing below this line knows the difference — but it is 26.5 ms
           * a patch against 136, because ORT's WebGPU backend runs 3D `Conv` through a
           * per-element shader (`docs/seam-assessor-speed.md` §14).
           */
          runtime: ASSESSOR_RUNTIME,
        })
      : undefined
    const head = MODEL_SHARE + (assessor ? ASSESSOR_SHARE : 0)
    try {
      ctx.progress(head, 'opening the segmentation')
      return await searchAndScore(ctx, {
        table,
        rows,
        head,
        ranker,
        plan,
        assessor,
        top,
        volume: await openSearchVolume(target.datastack, plan.xyNm, when, options),
        options,
      })
    } finally {
      // Without the signal and swallowing its own failure, `useAssessorBox`' reasoning: the
      // commonest way to get here is a Cancel, and a close that refuses leaves the worker and
      // its GPU device held for the rest of the session.
      await assessor?.session.close().catch(() => undefined)
    }
  },
})

/** Everything one run was opened with, so the loop below takes one argument rather than ten. */
interface RunPlan {
  readonly table: TableValue
  readonly rows: readonly TipRow[]
  /** How much of the progress bar the models took before the first end. */
  readonly head: number
  readonly ranker: TreeRanker
  /** The pipeline the forest was fitted with — the box, the pool, the cut, the own-tip radius. */
  readonly plan: RankerConfig
  readonly assessor: OpenedSeamModel<AssessorConfig> | undefined
  readonly top: number
  readonly volume: SearchVolume
  readonly options: CaveRequestOptions
}

/**
 * The run: every neuron's ends searched, scored where an assessor was opened, published as they
 * land.
 *
 * Lifted out of `evaluate` when the assessor arrived, because the session has to be closed
 * however this ends and a `try/finally` wrapped around two hundred lines hides which of them is
 * the one that must not throw. What is here is the loop; what is above it is what the loop needs.
 */
async function searchAndScore(ctx: EvalContext, run: RunPlan) {
  const { table, rows, head, ranker, plan, assessor, top, volume, options } = run
  const assessing = assessor !== undefined

  const steps = {
    measure: (request: CandidatePoolRequest) =>
      runCandidatePool(request, { signal: ctx.signal }),
    sizes: (request: PoolSizesRequest) => runPoolSizes(request, { signal: ctx.signal }),
    counts: (roots: readonly string[]) => l2ChunkCounts(volume.graphene, roots, options),
  }
  const halfWidthNm = plan.halfWidthUm * NM_PER_UM

  /*
   * **Which ends can be searched, not which tips exist.** A box that clamps to nothing throws,
   * and one such end would abort a run of several hundred after the expensive ones had been
   * paid for — so it is answered here, once, and counted.
   *
   * The distinction matters below: an end that cannot be searched is still a **tip**, and the
   * own-tip rule measures a candidate against every one of its neuron's tips. Dropping it from
   * that set would keep a candidate that is nearer the unsearchable end and publish it as
   * another end's first — which is a plausible suggestion in the wrong place.
   */
  const fits = new Set(rows.filter((tip) => boxFits(volume, tip, halfWidthNm)))
  if (fits.size < rows.length) {
    const outside = rows.length - fits.size
    ctx.warn(
      `${plural(outside, 'open end')} ${agree(outside, 'lies', 'lie')} outside the ` +
        'segmentation volume, so no box could be read there. The rest were searched.',
    )
  }

  /*
   * **Published as they land, because a reader starts before the run does.** `ReviewBody`
   * draws its queue from `inputValues`, so every end that arrives here reaches the review card
   * with nothing downstream re-running (`core/node.ts`, `publish`). An end is yielded only
   * once the own-tip rule has run over it, so a row a reader is looking at never changes.
   *
   * **No throttle, and that is a measurement rather than an oversight.** `publish`'s rule is
   * to throttle because each call repaints every card; an end costs ~560 ms warm and a 19 MB
   * box before that, so the gap between two publishes is already far above the
   * `PUBLISH_INTERVAL_MS` a geometry channel needs. A throttle here would only ever delay the
   * last end of a neuron.
   */
  /*
   * **Before the loop**, which is what makes a dataset with no 32 nm scale one sentence rather
   * than a refusal on every end of every neuron: `patchSteps` asks `patchScaleFrom` once, here.
   * Why the two steps are built per run rather than per end is on `patchSteps` itself.
   */
  const assess = assessor && {
    steps: patchSteps(assessor, volume, options, ctx.signal),
    floor: assessor.config.missingPatchScore,
    fits: assessor.config.fits,
  }

  const ends: PublishedEnd[] = []
  /*
   * The rows this run will attempt, by their index in the incoming table — built once here
   * rather than per publish, since `fits` cannot change inside the loop. It is what the
   * published `searched` column reads: every row outside it is one of the two the node has
   * already warned about, and `seam:review` counts the rows still waiting from the difference.
   */
  const attempting = new Set([...fits].map((tip) => tip.row))
  // The last thing published *is* the answer, so the final return does not build it again.
  let answer = published(table, ends, rows, assessing, attempting)
  let done = 0
  for (const [neuron, at] of tipsByNeuron(rows)) {
    const mine = at.map((i) => rows[i]!)
    // One neuron's ends overlap; two neurons' do not. See `forgetRoots`.
    forgetRoots(volume)
    // `tip` indexes every one of this neuron's tips, which is what the own-tip rule compares
    // against; only the ones with a readable box become an end to search.
    const toSearch = mine.flatMap((tip, i) =>
      fits.has(tip) ? [endToSearch(volume, tip, i, halfWidthNm, options)] : [],
    )
    if (toSearch.length === 0) continue
    for await (const searched of searchEnds(
      tipPositions(mine),
      toSearch,
      { ranker, topK: plan.topK, ownUm: plan.ownUm },
      steps,
      { signal: ctx.signal },
    )) {
      // Back to the whole table's numbering: `searchEnds` indexes this neuron's tips alone.
      const end: SearchedEnd = { ...searched, tip: at[searched.tip]! }
      const tip = rows[end.tip]!
      if (assess) {
        const scored = await assessEnd(
          {
            queryRoot: BigInt(tip.neuronId),
            candRoot: end.candRoot,
            contactsNm: contactsOf(end),
          },
          assess.floor,
          assess.steps,
          { signal: ctx.signal, top },
        )
        ends.push(publishedEnd(end, scored, tip.eTip, assess.fits))
      } else {
        ends.push(searchOnly(end))
      }
      done += 1
      /*
       * **Published only once the end is wholly finished**, assessor and all, which is what
       * keeps the streaming honest now that there is a second stage: a reader must never see a
       * row ranked by geometry that the assessor is about to reorder underneath them. The cost
       * is that an assessed end takes about two seconds longer to appear, which is the right
       * trade — a draft that moves is worse than a wait.
       */
      ctx.progress(
        afterShare(head, done / fits.size),
        `${assessing ? 'scoring' : 'searching'} ${neuron}`,
      )
      answer = published(table, ends, rows, assessing, attempting)
      ctx.publish(answer)
    }
  }

  reportOnRun(ctx, ends)
  return answer
}

/**
 * The assessor's two expensive steps, bound to one run.
 *
 * A module-level factory, so the two closures hold the four things they read and not whatever
 * scope the loop happened to be in — CLAUDE.md's rule for a closure kept past its build, and the
 * same arrangement `endToSearch` makes one file along for the same reason.
 *
 * They are handed to `assessEnd` rather than reached for inside it, which is `searchRun.ts`'
 * arrangement: one needs a volume and a credential, the other a GPU session, and neither is a
 * thing a test — or a probe — can give.
 */
function patchSteps(
  assessor: OpenedSeamModel<AssessorConfig>,
  volume: SearchVolume,
  options: CaveRequestOptions,
  signal: AbortSignal | undefined,
): AssessSteps {
  const scale = patchScaleFrom(volume.info)
  return {
    box: async (cut) => {
      const box = patchBoxFor(scale, cut.centresNm)
      const read = await labelledBox(volume, scale, box, cut.queryRoot, options)
      return {
        ...read,
        candRoots: cut.candRoots,
        // Flat and freshly built, because `callPython` transfers whatever it is given.
        centresNm: Float64Array.from(cut.centresNm.flat()),
      }
    },
    /*
     * `useAssessorBox` rather than the three calls: the bridge holds **one** labelled box, and
     * an end that throws or is cancelled with its box still open leaves 11 MB held in a heap
     * that never shrinks — and the next end's `open` would replace its labels, so a late close
     * would drop the wrong tip's.
     */
    score: (request) =>
      useAssessorBox(
        request,
        (open) => scoreCandidates(assessor.session, assessor.config, open, { signal }),
        { signal },
      ),
  }
}

/**
 * The two tables, from the ends finished so far.
 *
 * One builder for the partial answer and the final one, because `publish`'s whole promise is
 * that what a reader sees mid-run is what they will have at the end — two code paths would be
 * two shapes, and the review card reads them by column name and would say nothing about the
 * difference.
 */
function published(
  table: TableValue,
  ends: readonly PublishedEnd[],
  tips: readonly TipRow[],
  assessed: boolean,
  attempting: ReadonlySet<number>,
) {
  return {
    tips: tipsWithFirsts(table, ends, tips, assessed, attempting),
    candidates: candidatesTable(ends, tips, assessed),
  }
}
