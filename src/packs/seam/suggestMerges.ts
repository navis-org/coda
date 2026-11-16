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
 * **What it costs on top of the search is a quarter of an end, and that is browser-dependent.**
 * A measured run of 25 ends in Chrome took 6.2 s each with the network at 25% — 27 ms a patch,
 * the figure a bare probe gets on the same GPU. The same run in Firefox took 11.0 s an end with
 * the network at half of it, because a WebGPU dispatch costs that browser far more to submit and
 * synchronise; `SECONDS_PER_PATCH` has the measurement and `SLOW_WEBGPU` is what says so on the
 * card. The checkpoint is a 133 MB download. The network is Coda's own WGSL implementation
 * rather than ONNX Runtime — 27 ms a patch against 136 — so most of an assessed end is the two
 * boxes it reads.
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

import type { NodeHint } from '../../core/graph'
import { NO_HINTS } from '../../core/graph'
import type { EvalContext, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { warnOverWait } from '../../core/limits'
import type { TableValue } from '../../core/values'
import { isTableValue } from '../../core/values'
import { slowGpuDispatch } from '../../ml/support'
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
import { patchBoxFor, patchScaleFrom, widestPatchReach } from './patchBox'
import { afterShare } from './progress'
import { openTreeRanker } from './rankerConfig'
import type { RankerConfig } from './rankerConfig'
import { contactsOf, publishedEnd, reportOnRun } from './scoreEnds'
import type { EndToSearch } from './searchRun'
import { oneAhead, searchEnds } from './searchRun'
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
import { boxFits, endToSearch, openSearchVolume } from './searchVolume'
import { forgetRoots, labelledBox } from './rootedBox'
import type { SearchVolume } from './searchVolume'
import { runClock } from './runClock'
import type { RunClock } from './runClock'
import type { GraphRunner, RunRequest } from '../../ml/session'
import type { Triple, VolumeScale } from '../../data/precomputed/volume'
import type { CaveRequestOptions } from '../../data/cave/client'
import { formatBytes } from '../../core/limits'
import { DEFAULT_CHUNK_BUDGET } from '../../data/precomputed/chunkCache'

/** How much of the progress bar the ranker gets before the search starts. It is 1.3 MB. */
const MODEL_SHARE = 0.02

/**
 * The `Chunk cache` param's default, in the megabytes a reader sets it in.
 *
 * Derived from `DEFAULT_CHUNK_BUDGET` rather than typed out beside it: the measurement and the
 * reasoning behind the number live in `chunkCache.ts`, and a second literal here is how a
 * default comes to disagree with the documentation of itself.
 */
const DEFAULT_CHUNK_MB = DEFAULT_CHUNK_BUDGET / (1024 * 1024)

/**
 * Where `Chunk cache` stops being an ordinary number and starts being a decision about a
 * machine, in the megabytes the param is set in.
 *
 * Twice the default, and the threshold is a round number rather than a measured one on purpose:
 * what it guards is how much memory *this* computer has free, which nothing here can read. The
 * measurement that does exist says the other side — a neuron's whole working set was 2.8 GB, and
 * a cache that holds it reads a tenth of what no cache does — so the warning is written to be
 * acted on in either direction.
 */
const BIG_CHUNK_CACHE_MB = 1024

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
 * What one open end costs before any patch, in seconds, measured on Aedes.
 *
 * The search box, the pool measured from it, and the chunk counts of every root in that pool —
 * everything an end pays whether or not an assessor is picked. From a 25-end run in Chrome, a
 * cold session: **1.27 s of search box, 0.64 s of pool, 0.83 s of counts**, which is 2.74 and is
 * rounded down to 2.7 rather than up, the patch figures below being measured on the same run.
 *
 * **The counts used to be left out of this entirely**, on the reasoning that they are shared
 * between neighbouring ends and so ride on top. They are shared, and they were still a third of
 * an end: `l2ChunkCounts` memoises by root, but a pool is about 500 roots and a walk along a
 * neuron keeps meeting new ones, so what is shared is a fraction and not the cost. Pricing it at
 * zero made this model under-state a wait by about a fifth, which is the one direction
 * `docs/limits.md` says a guard rail must not fail in.
 *
 * **It is the cold figure, and the warm one is lower.** The memo lasts the session, so a second
 * run over ends near the first pays far less — two Firefox runs put the same stage at 16% and
 * then under 5%. The conservative one is the one to price with, for the same reason.
 *
 * `pnpm probe:seam-tip-boxes` holds the reading half up on real ends: 1.3 s of voxels for a
 * search box that has to fetch its chunks, 0.6 s of root lookups beside it, and 89 ms where
 * `Chunk cache` already holds them — so the box figure is right for an end moving into new
 * segmentation, which on a walk along a neuron is most of them.
 *
 * **A rate, not a limit.** `WAIT_WARN_SECONDS` decides when the number is worth saying; this only
 * turns a count of ends into it, which is `docs/limits.md`' rule about stating a limit in the
 * units of what it protects.
 */
export const SECONDS_PER_END = 2.7

/**
 * What one assessed candidate costs, in seconds: a 129³ patch cut and run.
 *
 * **27 ms, measured in a run rather than in a probe.** 25 open ends of an Aedes neuron through
 * Coda's own WGSL implementation, best 26 and median 26 — the same figure
 * `pnpm probe:gpu-assessor` gets on a bare page (`docs/seam-assessor-speed.md` §14), so the loop
 * around the network costs nothing worth a constant. The cut is about 40 ms a group of four and
 * is prefetched one group deep, so it hides behind the GPU that group costs and does not appear
 * here.
 *
 * **It is a rate for one browser, and the spread between browsers is larger than anything else
 * on this page.** The same 25 ends on the same laptop and the same GPU measured **98 ms a
 * patch** in Firefox against 27 in Chrome — 11.0 s an end against 6.2 — because the cost is in
 * how a browser's WebGPU submits and synchronises a dispatch, not in the arithmetic. A ladder
 * of nine controlled rungs (`pnpm probe:assessor-gap`) cleared everything else: the loop, the
 * Pyodide cut beside it, `Chunk cache`'s bytes, a blocked main thread, a repainting page and
 * Chrome's own GPU flags are all worth under 7 ms between them.
 *
 * **This is the fast figure and there is a second constant for the other**, rather than an
 * average of the two, which would be a number no reader experiences. `secondsPerEnd` asks
 * `slowGpuDispatch` which of them applies; `SLOW_SECONDS_PER_PATCH` carries the Firefox
 * measurement and the reason.
 *
 * The consequence is not only a number in a warning. At 27 ms the scoring is a quarter of an end
 * and `Assess top` is a weak lever; at 98 it is half the run and the cap is the biggest one
 * there is. Which is why the node reports the rate, and the fastest call beside it, after a run
 * rather than this file claiming to know (`runClock.ts`).
 *
 * **The ONNX Runtime path was 136 ms** for the same network and the same answer — its WebGPU
 * backend runs 3D `Conv` through a per-element shader — so this is 5.1x cheaper. That is not
 * only a faster run: it moves where an end's time *goes*, which is why `Assess top` no longer
 * promises much. `secondsPerEnd` is the sum.
 *
 * (A draft of this constant said 0.17, which was a review chain's *budget* for 133 ms of GPU
 * plus some of the cut, never a measurement of anything. A later one said 0.091, which was the
 * Firefox figure taken for a defect in this loop before anybody asked which browser it came
 * from. Both are recorded because prose contrasting against either was comparing a measurement
 * with something that was not one.)
 */
const SECONDS_PER_PATCH = 0.027

/**
 * What a patch costs where the browser's WebGPU dispatch is the slow kind — `slowGpuDispatch`.
 *
 * **98 ms, the measured figure, not a safety margin.** The same 25 ends on one laptop and one
 * GPU: 27 ms a patch in Chrome and 98 in Firefox, 6.2 s an end against 11.0. Pricing every
 * reader at the fast rate left `warnOverWait` under-stating a 500-end Firefox run as about
 * thirty-five minutes where the measurement says ninety — and under-stating is the one direction
 * `docs/limits.md` says a guard rail must not fail in. `SECONDS_PER_END` records being caught by
 * exactly that once already.
 *
 * It costs nothing to ask: the browser fact is already on hand for the card's hint, and
 * `slowGpuDispatch` answers `false` where there is no `navigator` at all (the MCP server, a
 * build-time render), which is the Chrome figure and the right default for a machine nobody is
 * waiting at.
 */
const SLOW_SECONDS_PER_PATCH = 0.098

/**
 * What a reader on a browser with a costly WebGPU dispatch should know before a long run.
 *
 * Derived from the browser rather than written into the document (`NodeDefinition.readerHints`),
 * which is the whole reason it can be stated at all: it is false for most readers, and a
 * sentence saved by a Firefox user would ride a share link to a Chrome one.
 *
 * **Two sentences, with the measurement left out.** A draft quoted the figures — 98 ms a patch
 * against 27 — and named `Assess top` as the fallback. Both belong somewhere, and a hint box on
 * a card is not it: `docs/help.md` has the rule, and a reader who wants the number gets it from
 * the node's own report after a run. What a hint owes them is the one thing they cannot work out
 * for themselves, which is that the browser is the cause.
 */
const SLOW_WEBGPU: readonly NodeHint[] = [
  {
    text:
      'This assessor runs significantly slower in Firefox than in Chrome. If speed is a ' +
      'problem, try running it in Chrome.',
  },
]

/**
 * The patch box an end's whole list shares: a little over 8 µm of segmentation, read once.
 *
 * **Measured now, where this was a range taken at its top.** `pnpm probe:seam-tip-boxes` reads
 * real consecutive ends of one Aedes neuron, and the thing it found is that this box is mostly
 * the chunks the search box in front of it has just fetched — a chunk here is 8.2 x 8.2 x 2.9 µm
 * and 3.0 MB, wider than either box. So with `Chunk cache` holding them, a box read drops from
 * ~1300 ms to **89 ms**: cold, the wire is everything. (Warm, what is left *is* the decode —
 * `chunkCache.ts` weighs that trade.)
 *
 * 0.4 s is that, plus the part of this box which genuinely lies outside the search box — it
 * reaches 8.5 µm against the search's 6 — averaged over a walk. At the default budget a tip
 * reads 13 MB against the 72 MB it read before the cache, and the two boxes together come to
 * about 1.3 s rather than 3.
 *
 * **It is a rate for the default configuration**, and the two things that move it are the
 * reader's: a smaller `Chunk cache`, and a `Sort` above this node scattering ends that lie
 * beside each other. `reportOnReads` is what says so after a run where it went badly, since no
 * constant here can know either.
 */
const SECONDS_PER_PATCH_BOX = 0.4

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
  // The reader's own browser, because that is the largest single factor in this sum and the
  // node already knows it — see `SLOW_SECONDS_PER_PATCH`.
  const perPatch = slowGpuDispatch() ? SLOW_SECONDS_PER_PATCH : SECONDS_PER_PATCH
  return SECONDS_PER_END + SECONDS_PER_PATCH_BOX + patches * perPatch
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
      help: 'How many of each end’s ranked candidates to put through the assessor, counting from the forest’s first. 0 is all of them, which is what SEAM does. **What it saves depends on your browser, by a lot**: the same 25 ends on the same laptop and the same GPU measured 27 ms a patch in Chrome, where the network was a quarter of the run, and 98 ms in Firefox, where it was half — 6.2 s an end against 11.0. On the Firefox run, capping at 10 took an end from 11.0 s to 4.5. Run once uncapped and read the `ms a patch` in the timing the node reports: under about 30 ms the cap buys little and a Filter Table above this node is the better lever, and well above it the cap is the biggest lever there is. What it costs is answers, and not only lost ones: flooring the rest of the list concentrates the first candidate’s share and so raises `q`, so a cap invents a few suggestions as well as losing a few. Against SEAM’s own 2,708 tips a cap of 25 changes the verdict on 5, and a cap of 10 on 21.',
    },
    {
      id: 'chunkCacheMb',
      kind: 'int',
      label: 'Chunk cache (MB)',
      default: DEFAULT_CHUNK_MB,
      min: 0,
      step: 128,
      advanced: true,
      absentMeans: DEFAULT_CHUNK_MB,
      /*
       * **Presentational, and that is not a slip.** Invariant 4's rule is that a param is
       * presentational only where it cannot change what `evaluate` returns, and this one cannot:
       * the same chunks are read either way, and a cache decides whether they arrive over the
       * wire or out of a map. Keyed, every change to it would invalidate a run that would come
       * back byte-for-byte identical, which on a node of this cost is the expensive kind of
       * wrong.
       */
      presentational: true,
      help: 'How much memory to spend holding segmentation this run has already fetched. A chunk of the Aedes segmentation is 8.2 × 8.2 × 2.9 µm and 3 MB — wider than either box an end reads — so an end’s patch box is largely the chunks its own search box just pulled, and so is its neighbour’s: one neuron’s 505 ends fetched 25.4 GB for 2.8 GB of distinct chunks. On that neuron a tip read 72 MB with no cache, 13 MB at this default, and 7 MB at 1.5 GB. Raising it pays most where a Sort above this node has scattered the ends, since a cache the size of the neuron’s working set does not care what order they arrive in. It is held until the run ends, outside the JavaScript heap where nothing refuses it — so a budget past what the machine has loses the run rather than slowing it. 0 holds nothing.',
    },
    caveDatastackParam(
      'Which datastack’s segmentation to search, as `datastack:materialization`. Wire a Dataset instead and this follows it. The materialization decides *when* the supervoxels are read as belonging to a neuron, so it should be the one the open ends were found in.',
    ),
  ],

  // Only where an assessor is picked: with none, nothing runs on the GPU and the sentence is
  // about a cost this run does not pay.
  readerHints: (params) =>
    params.assessor !== NO_ASSESSOR && slowGpuDispatch() ? SLOW_WEBGPU : NO_HINTS,

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
    /*
     * **A guard rail warns; it does not refuse** (`docs/limits.md`), and it says its number in
     * the units of the thing it protects. A chunk cache is held outside the JavaScript heap,
     * where neither `CRASH_FLOOR_BYTES` nor the browser itself refuses it, so the first sign of
     * a budget past what the machine has is the tab going down and taking several hundred ends
     * of work with it. Which number is too large is a fact about a machine this node cannot
     * read, so the sentence says what it costs rather than naming a ceiling.
     */
    if (Number(ctx.params.chunkCacheMb) > BIG_CHUNK_CACHE_MB) {
      issues.push(
        `\`Chunk cache\` is ${formatBytes(Number(ctx.params.chunkCacheMb) * 1024 * 1024)}, ` +
          'held for the whole run and outside the memory the browser will refuse. It is worth ' +
          'it on a machine with the room to spare — a cache the size of a neuron’s working ' +
          'set makes the search read about a tenth of what it otherwise would — but a tab that ' +
          'runs out of memory loses the run rather than slowing it.',
      )
    }
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
           * `ModelSession`, so nothing below this line knows the difference — but it is 27 ms
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
        volume: await openSearchVolume(target.datastack, plan.xyNm, when, options, {
          // Megabytes at the param, bytes inside: a reader thinks in the first and a budget is
          // spent in the second.
          chunkBytes: Math.max(0, Number(ctx.params.chunkCacheMb)) * 1024 * 1024,
        }),
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

  /*
   * **Timed at the seam the sequences already have.** Every expensive step is injected — which
   * is what makes `searchRun.ts` and `assessEnds.ts` drivable without a token or a GPU — so
   * wrapping each one here charges the stage it belongs to and nothing inside those files knows
   * a clock exists. `runClock.ts` says why a run of this cost has to be able to answer "where
   * did the time go" on the reader's machine rather than on the one the headers were measured
   * on.
   */
  const clock = runClock()
  const steps = {
    measure: clock.around('measuring the pool', (request: CandidatePoolRequest) =>
      runCandidatePool(request, { signal: ctx.signal }),
    ),
    sizes: clock.around('pool sizes', (request: PoolSizesRequest) =>
      runPoolSizes(request, { signal: ctx.signal }),
    ),
    counts: clock.around('chunk counts', (roots: readonly string[]) =>
      l2ChunkCounts(volume.graphene, roots, options),
    ),
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
   * **Asked once, before the loop**, which is what makes a dataset with no 32 nm scale one
   * sentence rather than a refusal on every end of every neuron — and only where an assessor
   * runs, since a geometry-only search reads no patch box and must not be refused for the want
   * of a scale it never reads. Why the two steps are built per run rather than per end is on
   * `patchSteps` itself.
   */
  const patchScale = assessor && patchScaleFrom(volume.info)
  /*
   * **One record, not an `assess` and an `assessSteps` beside it.** Built apart they were two
   * optionals that are always both set or both unset, which the type system cannot know — so
   * the construction needed `assessor!` and the call site `assessSteps!`, two assertions
   * standing in for one condition.
   *
   * `patchSteps` is handed the clock and charges its own stages from inside; `box` is the one
   * it cannot, being the caller's to name.
   */
  const assess =
    assessor && patchScale
      ? {
          scale: patchScale,
          floor: assessor.config.missingPatchScore,
          fits: assessor.config.fits,
          steps: ((made) => ({
            ...made,
            box: clock.around('reading the patch box', made.box),
          }))(patchSteps(assessor, patchScale, volume, options, ctx.signal, clock)),
        }
      : undefined

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
    /*
     * `tip` indexes every one of this neuron's tips, which is what the own-tip rule compares
     * against; only the ones with a readable box become an end to search.
     *
     * **One pass, because two would put the plan's order in a comment.** This used to `filter`
     * for the plan and `flatMap` for the ends, running the same `fits.has` twice — and the plan
     * is built in the order the ends are searched, so if the two predicates ever drifted the
     * cache would evict confidently against the wrong future. Nothing but prose stopped it.
     * Derived from one list, the ordering holds structurally.
     */
    const toSearch: EndToSearch[] = []
    for (const [i, tip] of mine.entries()) {
      if (!fits.has(tip)) continue
      const end = endToSearch(volume, tip, i, halfWidthNm, options)
      toSearch.push({ ...end, box: clock.around('reading the search box', end.box) })
    }
    if (toSearch.length === 0) continue
    /*
     * **What this neuron is about to read, before it reads any of it.** Both of an end's boxes
     * are functions of its tip position, so the whole sequence is knowable — and with it the
     * cache evicts what is wanted furthest away rather than what was read longest ago, which on
     * one neuron at the default budget is 9.3 MB a tip against 13.7. `chunkPlan.ts` holds the
     * measurement and why the patch box is bounded rather than predicted.
     *
     * In `toSearch`'s order, which is the order `searchEnds` yields in — the positions come
     * from the same list, so the two cannot disagree.
     */
    volume.planEnds(
      toSearch.map((end) => [...mine[end.tip]!.nm] as Triple),
      {
        halfWidthNm,
        // No assessor, no patch box — so the plan is the search boxes alone.
        ...(assess
          ? {
              patchScale: assess.scale,
              patchReachNm: widestPatchReach(plan.ownUm),
            }
          : {}),
      },
    )
    /*
     * **The next end is searched while this one is scored.** `oneAhead` is the whole of it, and
     * `searchRun.ts` holds the reasoning and the one thing it does not buy: both halves call
     * Pyodide, and there is one worker for the tab, so that part queues rather than overlapping.
     * What genuinely runs alongside the network is the GPU. The two things it rests on are settled elsewhere rather than here — a yielded end
     * is final (`searchRun.ts`), and two box reads in flight share one supervoxel lookup
     * (`SearchVolume.asking`).
     *
     * **The eviction plan is still sound, with one caveat that is this file's to record.**
     * `chunkPlanFor` gives both boxes of one end *one* position and `endSearched` runs below,
     * after the assessor — so with two ends in flight the plan sits at *p* while the reads
     * belong to *p* (the patch box) and *p+1* (the search box). Neither scores `Infinity`, so
     * neither is ever dropped ahead of a chunk nothing wants again, which is the property that
     * matters: nothing is evicted while it is still being read in preference to dead bytes.
     *
     * What is **not** true, and an earlier draft of this comment claimed, is that neither can be
     * the furthest *finite* next use. `nextUse` answers the nearest end at or after the cursor,
     * so a chunk only end *p+1* wants scores `p+1` — the largest finite score there is, unless
     * something held is wanted further ahead still. At a budget too small to hold both ends'
     * working sets the cache can therefore evict what the read in flight has just fetched, and
     * the patch box then re-reads what the search box had in hand. It is wasted bytes rather
     * than a wrong box, and at the default budget the two ends are about 28 chunks against 170
     * held — but a reader who sets `Chunk cache` low enough is in that régime, which is one
     * more reason `reportOnReads` exists.
     *
     * What it costs is a second box alive: end *i+1*'s search box is read while end *i*'s patch
     * box is still being cut from. At a 6 µm and an 8 µm box that is tens of megabytes, against
     * a chunk cache measured in hundreds.
     */
    for await (const searched of oneAhead(
      searchEnds(
        tipPositions(mine),
        toSearch,
        { ranker, topK: plan.topK, ownUm: plan.ownUm },
        steps,
        { signal: ctx.signal },
      ),
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
      // One end off the plan, so the chunks only it wanted stop being worth keeping.
      volume.endSearched()
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
      /*
       * Charged directly rather than through a wrapper: it is the one expensive thing the run
       * does that is not behind an injected step, and it grows with the run — every publish
       * rebuilds both tables from every end so far.
       */
      const builtAt = performance.now()
      answer = published(table, ends, rows, assessing, attempting)
      clock.spend('rebuilding the published tables', performance.now() - builtAt)
      ctx.publish(answer)
    }
  }

  reportOnRun(ctx, ends, volume.chunks)
  /*
   * Patches actually put through the network — `''` in `filled` is a candidate that really was
   * scored, which is the same vocabulary the run's tally counts. The rate it buys is the one
   * number in the report that compares against another machine.
   */
  let patches = 0
  for (const end of ends)
    for (const why of end.scores?.filled ?? []) if (why === '') patches += 1
  const timing = clock.report({ ends: ends.length, patches })
  if (timing) ctx.warn(timing)
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
  /**
   * The scale a patch is cut at, resolved by the caller.
   *
   * **Handed over rather than asked for here**, because the run needs the same answer one step
   * earlier: it tells the chunk cache which boxes are coming, and a patch box is at this scale.
   * Two `patchScaleFrom` calls would be two chances for a run to plan one scale and read
   * another, which is the quiet kind of wrong — the plan would simply never match a key.
   */
  scale: VolumeScale,
  volume: SearchVolume,
  options: CaveRequestOptions,
  signal: AbortSignal | undefined,
  clock: RunClock,
): AssessSteps {
  /*
   * The session with its one expensive call timed. A wrapper rather than a timer inside
   * `scoreCandidates`, which takes a `GraphRunner` precisely so it can be driven by something
   * that is not a GPU — `assessorRun.test.ts` hands it a fake, and a clock in there would be a
   * second thing that fake has to satisfy.
   */
  const timed: GraphRunner = {
    loaded: assessor.session.loaded,
    run: clock.around('running the network', (request: RunRequest) =>
      assessor.session.run(request),
    ),
  }
  return {
    box: async (cut) => {
      const box = patchBoxFor(scale, cut.centresNm)
      const read = await labelledBox(volume, scale, box, options)
      return {
        ...read,
        queryRoot: cut.queryRoot,
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
     *
     * **Timed as three stages**, because that is how many different things it is and how many
     * different controls they answer to — see `STAGES`. The open is the time before the
     * callback's first line, since that is what `useAssessorBox` does in between; the network
     * is a wrapper on `session.run`; and the cutting is what is left of the loop once the
     * network's share is taken out of it, which is why the clock can be read as well as
     * written.
     */
    score: async (request) => {
      const askedAt = performance.now()
      return useAssessorBox(
        request,
        async (open) => {
          clock.spend('handing the patch box to Python', performance.now() - askedAt)
          const ranBefore = clock.spent('running the network')
          const loopAt = performance.now()
          const answer = await scoreCandidates(timed, assessor.config, open, { signal })
          const ran = clock.spent('running the network') - ranBefore
          clock.spend('cutting patches', performance.now() - loopAt - ran)
          return answer
        },
        { signal },
      )
    },
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
