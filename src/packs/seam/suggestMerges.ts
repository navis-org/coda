/**
 * Suggest Merges: run SEAM's search over a neuron's open ends and publish the ranked candidates.
 *
 * ## It computes a set; it does not read one
 *
 * `seam:suggestions` reads the lists SEAM's pipeline produced on a cluster. This does stages 4
 * and 5 — the 6 µm box, the eleven geometric features, the forest, the cut, the own-tip rule —
 * in the browser, for the ends on the wire — and stages 6 to 9 too, where an `Assessor` is
 * picked. Everything it publishes was measured here, from the
 * segmentation as it stood at each neuron's moment in `Searched at` (`momentsOf`).
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
 * **What it costs on top of the search is a share of an end, and that is browser-dependent.**
 * 60 ends measured through the node on one laptop (2026-11-21): 13 to 16 ms a patch in Chrome
 * and 19 in Firefox, 1.2-1.3 s an end against 1.4-1.5 — the search sets the pace in both now.
 * Firefox was 98 ms a patch and 6.2 s an end until the patches were kept in flight — every wait
 * for the GPU costs it ~100 ms, and the network had waited once a patch — and 30 ms over the same 60
 * ends until stage 0 skipped its background and the kernels took the forms Firefox is quick with;
 * `SLOW_SECONDS_PER_PATCH` has the story. The card once told Firefox
 * readers to try Chrome; at 1.2x an end that would overstate it, so it no longer does. The
 * checkpoint is a 133 MB download. The network is Coda's own WGSL implementation rather than
 * ONNX Runtime — 14 ms a patch against 134 — so most of an assessed end is the two boxes it
 * reads.
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
import { errorMessage } from '../../core/errors'
import { LruMap } from '../../core/lruMap'
import type { TableValue } from '../../core/values'
import { isTableValue } from '../../core/values'
import { slowGpuDispatch } from '../../ml/support'
import { agree, plural } from '../../style/format'
import type { CaveTarget } from '../../nodes/lib/caveParams'
import {
  CAVE_DATASET_INPUT,
  caveDatastackIssues,
  caveDatastackParam,
  caveTargetOfValue,
} from '../../nodes/lib/caveParams'
import { NM_PER_UM } from '../../data/units'
import type { CandidatePoolRequest, PoolSizesRequest } from '../../pyodide/cutoutSummary'
import { runCandidatePool, runPoolSizes } from '../../pyodide/cutoutSummary'
import { grapheneFor, instantOf, l2ChunkCounts, rootLives } from '../../data/cave/rootIds'
import { distinctStrings } from '../../core/collections'
import { namedFew } from '../../core/prose'
import {
  noLongerCurrent,
  momentsFrom,
  notRoots,
  readSearchedAt,
  writeSearchedAt,
} from './rootMoment'

import { readyAssessorPatches, useAssessorBox } from '../../pyodide/assessorPatches'
import type { TreeRanker } from './treeRanker'

import { assessEnd, startPatchBox } from './assessEnds'
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
import { loadSeamManifest, openSeamModel } from './openWindowModel'
import type { OpenedSeamModel } from './openWindowModel'
import { patchBoxFor, patchScaleFrom, widestPatchReach } from './patchBox'
import { afterShare } from './progress'
import type { RunIdentity } from './endMemory'
import type { RecalledEnd, Remembered } from './endMemory'
import { endKey, forgetStale, heldEnds, neuronKey, recalled, sessionEnds } from './endMemory'
import { PUBLISH_INTERVAL_MS } from '../../data/geometryCache'
import { throwIfAborted, yieldToBrowser } from '../../core/slice'
import type { Piece } from './pieces'
import { runBook } from './runBook'
import type { Assembled } from './runBook'
import type { ExtendPlan } from './pieces'
import {
  aliasOf,
  autoTakes,
  EXTENDED_PORT,
  extendPlanOf,
  growAuto,
  junctionOf,
  pathKey,
  piecesOf,
} from './pieces'
import { openTreeRanker, readRankerManifest } from './rankerConfig'
import type { RankerConfig } from './rankerConfig'
import { contactsOf, publishedEnd, reportOnRun } from './scoreEnds'
import type { EndToSearch, SearchedEnd } from './searchRun'
import { oneAhead, searchEnds } from './searchRun'
import type { PublishedEnd, TipRow } from './searchTips'
import {
  candidateFields,
  candidatesTable,
  modelVersion,
  runSource,
  searchCell,
  searchOnly,
  tipPositions,
  tipsByNeuron,
  tipsFromTable,
  tipsSchema,
  tipsWithFirsts,
} from './searchTips'
import { schemaOf } from './suggestionTables'
import { boxFits, endToSearch, openSearchVolume, unlistedMaterialization } from './searchVolume'
import { openEndsNode } from './openEnds'
import { forgetRoots, labelledBox } from './rootedBox'
import type { SearchVolume } from './searchVolume'
import { runClock } from './runClock'
import type { RunClock } from './runClock'
import type { GraphRunner, RunRequest } from '../../ml/session'
import type { Triple, VolumeScale } from '../../data/precomputed/volume'
import type { CaveRequestOptions } from '../../data/cave/client'
import { formatBytes } from '../../core/limits'
import { DEFAULT_CHUNK_BUDGET } from '../../data/precomputed/chunkCache'

/**
 * How far behind this browser's clock a new neuron's moment is taken. A browser clock ahead of
 * the chunkedgraph's would otherwise name a moment a current root has not reached, and the run
 * would be capped at the server's now while the record said otherwise. A clock kept by NTP is
 * well within a second of a server's; five is a margin, not a measurement.
 */
const FILL_BEHIND_MS = 5_000

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
 * How many ends are searched at once (`SearchOptions.depth`), ahead of the one being scored.
 *
 * The search was the run's pace — box, pool and counts in a row, ~3.1 s an end against ~1.8 s
 * of scoring, the GPU idle ~1.5 s an end (`pnpm probe:suggest-merges`, 2026-11-19). Replaying
 * that run's own step times through a search this deep put an end at ~2.0 s at 3 and ~1.9 at
 * 4, against a floor of 1.79 for scoring alone, so 3 holds one box less for a tenth of a
 * second. It rests on the chunkedgraph keeping up, which was measured: three or four ends'
 * lookups and counts at once took 0.4-0.7 s of its time an end against 1.0-1.7 one at a time,
 * inside the tab's budget at that server (`rootIds.ts`' `CHUNKEDGRAPH_BUDGET`).
 *
 * That was before the network got quicker. At ~13 ms a patch Chrome's GPU waited on the search
 * again, and 60 ends run live took 91 s at 3 and 69 s at 4, twice each, with no more at 5 or 6;
 * Firefox, at ~18 ms a patch, took 92-105 s at every depth (2026-11-21). The answer was the
 * same at all of them.
 *
 * The cost is memory: each end under way holds its box (~19 MB) until it is measured.
 */
const SEARCH_DEPTH = 4

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
 * **The organelle measure adds a quarter of a second** (2026-11-17): SEAM's `enclosure` on the
 * same box, in the same Pyodide call as the pool. One rv2 end's warm pool step, five calls each
 * way in Chrome: a median of 836 ms with it, 577 ms without — 260 ms. So the 2.74 s above is
 * 3.0 s, and that is the rate.
 *
 * **A rate, not a limit.** `WAIT_WARN_SECONDS` decides when the number is worth saying; this only
 * turns a count of ends into it, which is `docs/limits.md`' rule about stating a limit in the
 * units of what it protects.
 */
export const SECONDS_PER_END = 3.0

/**
 * What one assessed candidate costs, in seconds: a 129³ patch cut and run.
 *
 * **16 ms, the larger of what the node and a probe measured** (2026-11-21, Chrome, patches kept in
 * flight, `docs/seam-assessor-speed.md` §17): 13 and 16 ms a patch over 60 real ends through the
 * node in two runs, 13.5 median in `pnpm probe:gpu-browsers` at `GPU_ASSESSOR_IN_FLIGHT`. It was
 * 20 before stage 0 skipped its background (§16), 22 one at a time (§15), 27 before the stem read
 * the patch itself (§14). **It depends on the patch**: one whose objects fill more of the window
 * has less background to skip — the patches of SEAM's short lists measured 15.9 against the
 * 13.5 of its long ones. The cut is about 40 ms a group of four and is prefetched one group deep,
 * so it hides behind the GPU that group costs and does not appear here.
 *
 * **It is a rate for one browser.** Firefox computes the same patch in ~19 ms, and until the
 * patches were kept in flight it paid 98, because there every wait for the GPU costs ~100 ms;
 * `SLOW_SECONDS_PER_PATCH` has it.
 *
 * **This is the fast figure and there is a second constant for the other**, rather than an
 * average of the two, which would be a number no reader experiences. `secondsPerEnd` asks
 * `slowGpuDispatch` which of them applies; `SLOW_SECONDS_PER_PATCH` carries the Firefox
 * measurement and the reason.
 *
 * The consequence is not only a number in a warning. The scoring is about as long as the search
 * now, and `Assess top` the one lever on it that changes answers. Which is why the node
 * reports the rate, and the fastest call beside it, after a run rather than this file claiming to
 * know (`runClock.ts`).
 *
 * **The ONNX Runtime path was 136 ms** for the same network and the same answer — its WebGPU
 * backend runs 3D `Conv` through a per-element shader — so this is about 7x cheaper. That is not
 * only a faster run: it moves where an end's time *goes*, which is why `Assess top` no longer
 * promises much. `secondsPerEnd` is the sum.
 *
 * (A draft of this constant said 0.17, which was a review chain's *budget* for 133 ms of GPU
 * plus some of the cut, never a measurement of anything. A later one said 0.091, which was the
 * Firefox figure taken for a defect in this loop before anybody asked which browser it came
 * from. Both are recorded because prose contrasting against either was comparing a measurement
 * with something that was not one.)
 */
const SECONDS_PER_PATCH = 0.016

/**
 * What a patch costs where the browser's WebGPU dispatch is the slow kind — `slowGpuDispatch`.
 *
 * **26 ms, the largest of the measurements** (2026-11-21, Firefox 160,
 * `docs/seam-assessor-speed.md` §18). On a Mac, where Firefox builds the kernel forms its shader
 * translator is quick with (`frugalShaders`): 19 ms a patch over 60 real ends through the node,
 * twice (`pnpm probe:suggest-merges --browser firefox`), and in `pnpm probe:gpu-browsers` at
 * `GPU_ASSESSOR_IN_FLIGHT` 16.9 on the patches of SEAM's long lists and 20.0 on its short ones,
 * whose objects fill more of the window and leave less background to skip. In the plain forms,
 * which Firefox runs anywhere else, the same two sets measured 21.6 and 25.7. The largest is
 * taken because under-stating is the one direction `docs/limits.md` says a guard rail must not
 * fail in; `SECONDS_PER_END` records being caught by exactly that once already.
 *
 * Before stage 0 skipped its background the same 60 ends measured 30 ms a patch that day — 29
 * over 40 ends on 2026-11-19 — and this constant was 0.033, a probe's figure that was a batch's
 * rounding.
 *
 * **It was 98, and the reason is the thing worth knowing.** Firefox answers every wait for the
 * GPU in ~100 ms whatever the work — an empty submit included — so a network that waited once a
 * patch paid ~100 ms for ~30 of computing, 6.2 s an end against Chrome's 1.8. The ladder of
 * `pnpm probe:assessor-gap` could not see it: it drives Chrome only. Keeping patches in flight
 * shares the wait (`GPU_ASSESSOR_IN_FLIGHT`), and what is left is Firefox's own arithmetic.
 *
 * It costs nothing to ask, and `slowGpuDispatch` answers `false` where there is no `navigator`
 * at all (the MCP server, a build-time render), which is the Chrome figure and the right default
 * for a machine nobody is waiting at.
 */
const SLOW_SECONDS_PER_PATCH = 0.026

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
    'Takes a table of open ends and, around each, finds and ranks the pieces of segmentation ' +
    'that could continue the neuron. Usually wired from Find Open Ends into Review Suggestions, ' +
    'which fills while the search runs. Pick an Assessor for calibrated probabilities, and wire ' +
    'the review card’s `Extended` output back into `Review` to search accepted pieces too.',
  cost: 'expensive',
  /*
   * The node's own memory of finished ends (`endMemory.ts`). Clear Cache forgets the ends of
   * this run before any is measured (`ctx.refresh`), and the card's age is that of the oldest
   * end behind the answer — the contract every `dataCache` node keeps.
   */
  dataCache: true,
  /*
   * For extending a neuron piece by piece (`pieces.ts`, `docs/seam-extend-plan.md`): an accepted
   * piece's open ends come from running the chain above `Tips` again for that piece alone.
   */
  rerunsInputs: true,

  inputs: [
    { id: 'tips', label: 'Tips', type: T.table() },
    CAVE_DATASET_INPUT,
    /*
     * **A reference, drawn backwards**: Review Suggestions sits below this node and says which
     * accepted pieces to extend. It is read from that card's params alone
     * (`NodeDefinition.asReference`), so this node waits for nothing below it, and re-runs when
     * that list moves and at no other click on the card.
     */
    {
      id: 'review',
      label: 'Review',
      type: T.table(),
      required: false,
      reference: true,
      producedBy: { type: 'seam:review', port: EXTENDED_PORT },
    },
  ],
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
        ...MERGE_ASSESSOR_MODELS.map((model) => ({
          value: model.id,
          label: model.label,
          ...(model.retired === undefined ? {} : { retired: model.retired }),
        })),
      ],
      help: 'Which checkpoint judges whether each candidate really continues the neuron. Without one the answer is the forest’s ranking and nothing else — no probability and no cutoff. With one, each candidate gets a 4 µm patch of segmentation through the network, and the tip gets SEAM’s own `q`, `r` and shown/withheld. An assessed end took 1.2 to 1.5 s on one laptop, 13 to 19 ms of it on the GPU for each candidate, and the model is a 133 MB download kept in this browser.',
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
      help: 'How many of each end’s ranked candidates to put through the assessor, counting from the forest’s first. 0 is all of them, which is what SEAM does. **It usually saves little**: 60 ends on one laptop measured 13 to 16 ms a patch in Chrome and 19 in Firefox, 1.2 to 1.5 s an end, with the search setting the pace in both. Run once uncapped and read the `ms a patch` in the timing the node reports: around these rates a Filter Table above this node is the better lever, and only well above them is the cap worth what it costs. What it costs is answers, and not only lost ones: flooring the rest of the list concentrates the first candidate’s share and so raises `q`, so a cap invents a few suggestions as well as losing a few. Against SEAM’s own 2,708 tips a cap of 25 changes the verdict on 5, and a cap of 10 on 21.',
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
      help: 'How much memory to spend holding segmentation this run has already fetched. A chunk of the Aedes segmentation is 8.2 × 8.2 × 2.9 µm and 3 MB — wider than either box an end reads — so an end’s patch box is largely the chunks its own search box just pulled, and so is its neighbour’s: one neuron’s 505 ends fetched 25.4 GB for 2.8 GB of distinct chunks. On that neuron a tip read 72 MB with no cache, 13 MB at this default, and 7 MB at 1.5 GB. Raising it pays most where a Sort above this node has scattered the ends, since a cache the size of the neuron’s working set does not care what order they arrive in. It is held until the run ends, outside the JavaScript heap where nothing refuses it — so a budget past what the machine has loses the run rather than slowing it. 0 holds nothing. It changes no answer, so changing it re-runs nothing, and an end already searched is remembered and reads no segmentation at all: to see what a new budget does, use Clear Cache and run again.',
    },
    caveDatastackParam(
      'Which datastack’s segmentation to search, as `datastack:materialization`. Wire a Dataset instead and this follows it. Only the datastack is read: the moment the search reads the segmentation at is `Searched at`, moved into each neuron’s own life, never the materialization.',
    ),
    {
      id: 'at',
      kind: 'string',
      label: 'Searched at',
      placeholder: 'kept by the node as it runs',
      default: '',
      absentMeans: '',
      /*
       * **A record the run keeps, not a setting** (`ParamBase.runRecord`): the moment each
       * neuron was first searched at, as `root=moment` entries (`readSearchedAt`). The search
       * reads the live segmentation and the review card below saves verdicts naming what it
       * found; searched again at a new "now" after a reload, those could name nothing. A neuron
       * is only known once the run is under way, so the run writes the record (`ctx.record`),
       * and it is out of the key so that writing it re-runs nothing — the same key means the
       * same neurons, and an entry is what the run that wrote it used. Internal, so the card does
       * not offer it for editing; unrecorded, so undo does not take it back
       * (`docs/seam-live-plan.md`).
       */
      runRecord: true,
      presentational: true,
      unrecorded: true,
      internal: true,
      help: 'The moment each neuron was searched at, as `root=moment` entries (ISO 8601, UTC). Kept by the node: the first run that meets a neuron searches it at the present and writes it here, so the same suggestions come back for it after a reload and when you return to it from another neuron. The card’s ⟳ empties it, and the run after searches every neuron at the present. Where a root was edited before its moment, it is searched as it last stood; the card says so.',
    },
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

    const parsed = tipsFromTable(table, assessing)
    if (parsed.dropped > 0) {
      ctx.warn(
        `${plural(parsed.dropped, 'row')} of the Tips table could not be searched — no ` +
          'position, no `end_uid`, or a neuron that is not a chunkedgraph id. ' +
          `${agree(parsed.dropped, 'It is', 'They are')} passed through unsearched.`,
      )
    }
    const top = assessing ? Math.max(0, Math.floor(Number(ctx.params.assessTop) || 0)) : 0

    /*
     * Through `tipsWithFirsts` rather than handing back `table`, so the empty answer is the shape
     * `inferOutputs` promised: one schema function, one value writer, and no path that publishes
     * a table a column picker below has not been offered. Nothing attempted, so every row of the
     * incoming table is a row this run will not search — which the warnings say in prose.
     */
    const nothing = () => ({
      tips: tipsWithFirsts(table, [], [], assessing, new Set<number>()),
      candidates: candidatesTable([], [], assessing),
    })
    if (parsed.rows.length === 0) return nothing()
    const { model, issue: rankerIssue } = chosenRanker(ctx.params)
    if (!model) throw new Error(rankerIssue)
    const options = { deployment: target.deployment, signal: ctx.signal }

    /*
     * **Both manifests, read once and first** — two files of a few kilobytes. First, because a
     * manifest this build cannot read is the cheapest refusal there is. Once, because the version
     * read is the version everything is named by: the memory of finished ends is keyed on it
     * (`identityOf` below), `source` says it on every searched tip, and both models are opened
     * from this same read rather than a second one that could find a republished file.
     */
    ctx.progress(0, 'reading the models')
    const rankerManifest = await readRankerManifest(model, ctx.signal)
    const assessorManifest =
      assessorModel &&
      (await loadSeamManifest({
        model: assessorModel,
        task: MERGE_ASSESSOR_TASK,
        parse: parseAssessorConfig,
        signal: ctx.signal,
      }))

    /*
     * **When each neuron is read** — its own moment, not the Dataset's materialization
     * (`momentsOf`, `docs/seam-live-plan.md`). Asked before anything is priced, since the moment
     * is in every end's key. A neuron the chunkedgraph never made is passed through unsearched,
     * as a row with no position is.
     */
    const moments = await momentsOf(ctx, target, parsed.rows, options)
    const rows = parsed.rows.filter((tip) => moments.has(tip.neuronId))
    if (rows.length === 0) return nothing()
    /*
     * **What this run is, for the memory of finished ends** — everything an end's answer depends
     * on that every end of a neuron shares (`endMemory.ts`), the moment included, so one per
     * neuron. Built before anything is opened, because it also prices the wait: an end already
     * answered costs nothing, and a warning that counted it would announce twenty minutes for a
     * run that takes one.
     */
    const identityOf = (neuron: string): RunIdentity => ({
      ranker: modelVersion(rankerManifest.loaded),
      assessor: assessorManifest ? modelVersion(assessorManifest.loaded) : NO_ASSESSOR,
      top,
      deployment: target.deployment,
      datastack: target.datastack,
      moment: moments.get(neuron)!,
    })
    const neurons = neuronsOf(rows, identityOf)
    const keys = neurons.flatMap((neuron) => neuron.keys)
    const held = heldFor(ctx, keys)
    /*
     * **And the pieces, as far as they can be seen from here** (`foreseePieces`): the ones whose
     * tips an earlier run found have ends that are remembered or not, and the rest have a chain
     * to run before anything about them is known. Before anything is opened, for the two things
     * decided here — and because a Clear Cache has to reach every piece now, while its flag is
     * still in hand, not as the loop comes to each.
     */
    const extendPlan = extendPlanOf(ctx.input('review'))
    // The pieces extended by hand. What Auto-extend takes is not known before their ends are.
    const pieces = piecesOf(
      extendPlan.pairs,
      neurons.map((one) => one.neuron),
    )
    const foreseen = foreseePieces(ctx, identityOf, neurons, pieces, assessing)
    /*
     * A count of **tips**, where the run searches only those whose box fits the volume; a tip
     * outside it is never remembered, so it is counted and never searched. That errs towards
     * the longer wait, which is the direction `docs/limits.md` allows a guard rail to be wrong
     * in — and towards opening an assessor a run of remembered ends did not need.
     */
    const toMeasure = keys.length - held.size + foreseen.unremembered
    const perEnd = secondsPerEnd(assessing, top)
    const openEnds = plural(toMeasure, 'open end')
    warnOverWait(ctx, {
      seconds:
        toMeasure * perEnd +
        foreseen.unknown * (SECONDS_PER_PIECE_CHAIN + ENDS_PER_UNSEEN_PIECE * perEnd),
      what:
        (assessing ? `Searching and assessing ${openEnds}` : `Searching ${openEnds}`) +
        (foreseen.unknown > 0
          ? `, and finding the open ends of ${plural(foreseen.unknown, 'piece')}`
          : ''),
      lever: assessing
        ? 'Each end is a 6 µm box of segmentation at about 19 MB, a second box for the patches, ' +
          'and a patch through the network per candidate. Narrow the ends with a Filter Table ' +
          'on `e_tip` above this node, or cap the candidates with `Assess top`.'
        : 'Each end is a 6 µm box of segmentation, about 19 MB. Narrow them with a Filter Table ' +
          'on `e_tip` above this node.',
    })

    /*
     * **One moment per neuron.** Every box of a neuron is turned into roots at the same moment,
     * so the supervoxels two neighbouring ends share are asked about once — which is what
     * `SearchVolume.roots` then makes free — and the reader is moved to each neuron's moment
     * where it forgets the last one's roots (`forgetRoots`), before its first box. So the moment
     * it is opened at only has to be one CAVE can resolve; any neuron's will do. The moment is
     * in the document (`Searched at`), which also makes the answer the same on a re-run.
     */
    const openedAt = moments.get(rows[0]!.neuronId)!

    /*
     * **Opened in turn, not together, and the order is the whole of the reason.**
     *
     * This comment used to claim the forest and the volume were fetched concurrently. They never
     * were, and they should not be: every refusal worth having happens before the next step's
     * first request. The ranker first, because a manifest this build cannot read or a config
     * missing a number costs one small file. Then the assessor, where this run can already see
     * an end to score (below). The volume last. (The neurons' moments came before all three —
     * three small chunkedgraph requests — because the moment is in every key the wait above was
     * priced on.)
     *
     * It costs a second or so of serialisation on a warm cache. Overlapping them would buy that
     * back and give up the property above, which is the wrong trade on a node whose next step
     * is a 19 MB read per end.
     */
    const plan = rankerManifest.config
    const ranker = await openTreeRanker(model, rankerManifest, {
      signal: ctx.signal,
      progress: (fraction, note) => ctx.progress(fraction * MODEL_SHARE, note),
    })

    /*
     * **The assessor is opened before the volume**, and the order is the cheap-refusal rule
     * again: a browser with no usable GPU, a config this build cannot read, a 133 MB download
     * nobody ticked — all three are answered by `openSeamModel` before it fetches a byte, and
     * all three would otherwise come after three CAVE round trips.
     *
     * **But only where this run can see something to measure.** The session is a GPU worker and,
     * the first time, a 133 MB download behind a tick box; a run answered from memory needs none
     * of it, and would otherwise fail on "no usable GPU" with every answer already in hand. So it
     * is opened here where a neuron's own end is unremembered, and otherwise on the first end
     * that needs it — which, with pieces to extend, cannot be known until each piece's tips are.
     *
     * **The session is open from the first call**, so everything that can throw is inside the
     * `finally` below. A session left open holds a worker and a GPU device.
     */
    let session: OpenedSeamModel<AssessorConfig> | undefined
    let upFront = true
    const openAssessor =
      assessorModel &&
      (async (says?: (note?: string) => void) =>
        (session ??= await openSeamModel({
          model: assessorModel,
          task: MERGE_ASSESSOR_TASK,
          parse: parseAssessorConfig,
          ...(assessorManifest ? { manifest: assessorManifest } : {}),
          download: ctx.params.download === true,
          downloadShare: ASSESSOR_SHARE,
          signal: ctx.signal,
          // Opened later, the bar is already past where a download would put it: the caller
          // says what is happening and leaves the bar where it is.
          progress: (fraction, note) => {
            if (upFront) ctx.progress(MODEL_SHARE + fraction, note)
            else says?.(note)
          },
          /*
           * **Coda's own WGSL, not ONNX Runtime.** `ASSESSOR_RUNTIME` hands back the same
           * `ModelSession`, so nothing below this line knows the difference — but it is 27 ms
           * a patch against 136, because ORT's WebGPU backend runs 3D `Conv` through a
           * per-element shader (`docs/seam-assessor-speed.md` §14).
           */
          runtime: ASSESSOR_RUNTIME,
        })))
    try {
      // A piece nothing is known of yet has ends to score too, as far as anyone can tell.
      if (openAssessor && toMeasure + foreseen.unknown > 0) {
        /*
         * The cutter's worker boots under the model's download rather than before the first
         * end's patches. Not awaited: a failure here is met again, and said, at the first cut.
         *
         * **Never aborted**: an abort tears down the whole lane, and the lane is the tab's — one
         * run's declined model would take another run's held box with it. So it is asked only
         * where the download is allowed, which is where a model is meant to open; a model that
         * then fails leaves a booted worker the memory readout can stop.
         */
        if (ctx.params.download === true) void readyAssessorPatches().catch(() => {})
        await openAssessor()
      }
      upFront = false
      const head = MODEL_SHARE + (session ? ASSESSOR_SHARE : 0)
      ctx.progress(head, 'opening the segmentation')
      return await searchAndScore(ctx, {
        table,
        rows,
        neurons,
        held,
        identityOf,
        pieces,
        extendPlan,
        foreseen: foreseen.held,
        head,
        ranker,
        plan,
        assessor: openAssessor,
        source: runSource(rankerManifest.loaded, assessorManifest?.loaded),
        top,
        volume: await openSearchVolume(target.datastack, plan.xyNm, openedAt, options, {
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
      await session?.session.close().catch(() => undefined)
    }
  },
})

/** Everything one run was opened with, so the loop below takes one argument rather than ten. */
interface RunPlan {
  /** The incoming tips; the run adds each extended piece's beneath them as it reaches it. */
  readonly table: TableValue
  readonly rows: readonly TipRow[]
  /** The run's neurons, each with its key in the memory of finished ends. */
  readonly neurons: readonly RunNeuron[]
  /** The finished ends the memory held when the run started (`heldEnds`). */
  readonly held: ReadonlyMap<string, Remembered>
  /**
   * What every end of a neuron shares, for the keys of its pieces' ends — made as each is
   * reached. Its `moment` is also what the reader moves to for that neuron (`forgetRoots`).
   */
  readonly identityOf: (neuron: string) => RunIdentity
  /** The accepted pieces to extend, in the order the run takes them (`piecesOf`). */
  readonly pieces: readonly Piece[]
  /** What Review asked for, Auto-extend's presses and refusals among it. */
  readonly extendPlan: ExtendPlan
  /** What the memory held of each piece whose tips were known when the run started. */
  readonly foreseen: ReadonlyMap<string, ReadonlyMap<string, Remembered>>
  /** How much of the progress bar the models took before the first end. */
  readonly head: number
  readonly ranker: TreeRanker
  /** The pipeline the forest was fitted with — the box, the pool, the cut, the own-tip radius. */
  readonly plan: RankerConfig
  /**
   * The assessor's session, **opened by the call** if it is not already — or `undefined` where
   * none is picked, which is also what decides the tables' columns.
   */
  readonly assessor:
    ((says?: (note?: string) => void) => Promise<OpenedSeamModel<AssessorConfig>>) | undefined
  readonly top: number
  readonly volume: SearchVolume
  readonly options: CaveRequestOptions
  /** What this run's numbers come from, for the tips it searches (`runSource`). */
  readonly source: string
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
  const { rows, neurons, held, identityOf, pieces, head, ranker, plan, top, volume, options } =
    run
  const assessing = run.assessor !== undefined
  const { foreseen, extendPlan } = run

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
    measure: clock.around(
      'measuring the pool',
      (request: CandidatePoolRequest, onPool?: (candRoot: BigUint64Array) => void) =>
        runCandidatePool(request, { signal: ctx.signal, onPool }),
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
   * **Asked once**, which is what makes a dataset with no 32 nm scale one sentence rather than
   * a refusal on every end of every neuron — and only where an assessor runs, since a
   * geometry-only search reads no patch box and must not be refused for the want of a scale it
   * never reads. Why the two steps are built per run rather than per end is on
   * `patchSteps` itself.
   */
  type Assess = {
    scale: VolumeScale
    floor: number
    fits: AssessorConfig['fits']
    steps: AssessSteps
  }
  let assess: Assess | undefined
  /**
   * What scoring an end needs, made on the first end that is to be scored and kept.
   *
   * **One record, not an `assess` and an `assessSteps` beside it.** Built apart they were two
   * optionals that are always both set or both unset, which the type system cannot know.
   * `patchSteps` is handed the clock and charges its own stages from inside; `box` is the one
   * it cannot, being the caller's to name.
   *
   * On first need rather than before the loop, because a run answered from memory scores
   * nothing and must not open a GPU session to find that out (`evaluate` says when it is
   * already open). The patch scale is still asked once, and before that end reads a box.
   */
  const assessFor = async (): Promise<Assess | undefined> => {
    if (!run.assessor || assess) return assess
    try {
      const assessor = await run.assessor((says) => ctx.progress(afterShare(head, shown), says))
      const scale = patchScaleFrom(volume.info)
      const made = patchSteps(assessor, scale, volume, options, ctx.signal, clock)
      assess = {
        scale,
        floor: assessor.config.missingPatchScore,
        fits: assessor.config.fits,
        steps: { ...made, box: clock.around('reading the patch box', made.box) },
      }
    } catch (error) {
      unscorable = error
      throw error
    }
    return assess
  }
  /**
   * Why nothing can be scored in this run, once that is known: no usable GPU, a download nobody
   * ticked, a volume with no scale to cut a patch at.
   *
   * A refusal about the **run**, however late it is found. Met on the first end of a piece, it
   * would otherwise be that piece's failure — said, passed over, and met again at the next,
   * fifty times, under a node that ends green. The piece loop reads this and stops.
   */
  let unscorable: unknown

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
  /*
   * The rows this run will attempt, by their index in the published table. It is what the
   * `searched` column reads — every row outside it is one the run has warned about, or the end
   * a piece joins by — and `seam:review` counts the rows still waiting from the difference. A
   * neuron's own are known here; a piece's are its record's, added when its tips are found
   * (`runBook.ts`). Together they are the progress bar's whole.
   */
  const seedAttempting = new Set(
    rows.filter((tip) => boxFits(volume, tip, halfWidthNm)).map((tip) => tip.row),
  )
  if (seedAttempting.size < rows.length) {
    const outside = rows.length - seedAttempting.size
    ctx.warn(
      `${plural(outside, 'open end')} ${agree(outside, 'lies', 'lie')} outside the ` +
        'segmentation volume, so no box could be read there. The rest were searched.',
    )
  }
  /**
   * What the run has found so far, a record per root, from which the tables are put together in
   * the order a plain run takes everything — whatever order the work is done in (`runBook.ts`).
   */
  const book = runBook({
    table: run.table,
    rows,
    neurons: neurons.map((one) => ({ id: one.neuron, at: one.at })),
    attempting: seedAttempting,
    order: pieces,
  })
  /** The bar only ever moves forward, though its whole grows as pieces' tips are added. */
  let shown = 0
  /*
   * The tables, and the bar from the very same reading: a bar that moved ahead of what is
   * listed, or stayed behind it, describes another moment.
   */
  /** The ends behind the last tables built, for the report at the end. */
  let listed: readonly PublishedEnd[] = []
  const publish = () => {
    const now = book.assemble()
    listed = now.ends
    shown = Math.max(shown, now.attempting.size > 0 ? now.ends.length / now.attempting.size : 0)
    return published(now, assessing, run.source)
  }
  // The last thing published *is* the answer, so the final return does not build it again.
  let answer = publish()
  /** Each root's tips as the run searched them: what the own-tip rule measures a piece against. */
  const tipsOf = new Map<string, readonly TipRow[]>()
  /** Ends this run measured itself, and the patches it put through the network for them. */
  let measured = 0
  let patches = 0
  /** Set where something changed without the tables being built again — see `showSoon`. */
  let behind = false
  /**
   * Set while the run takes what the memory answers, before anything else (the order of work,
   * below): nothing is measured (`searchRoot`, `settle`) and so nothing is published
   * (`showSoon`); the owed tables are built once, when it ends.
   */
  let fromMemory = false
  let builtAt = performance.now()
  /** When the browser was last let in by this loop's own yields (`showSoon`, `letIn`). */
  let letInAt = performance.now()
  /** What the bar says of what was last added — shown whenever the tables are. */
  let note = ''
  /*
   * **Published as they land, because a reader starts before the run does.** `ReviewBody`
   * draws its queue from `inputValues`, so every end that arrives here reaches the review card
   * with nothing downstream re-running (`core/node.ts`, `publish`). An end is yielded only
   * once the own-tip rule has run over it, so a row a reader is looking at never changes.
   *
   * **A measured end is published with no throttle, and that is a measurement rather than an
   * oversight.** `publish`'s rule is to throttle because each call repaints every card; an end
   * costs ~560 ms warm and a 19 MB box before that, so the gap between two publishes is already
   * far above the `PUBLISH_INTERVAL_MS` a geometry channel needs. A throttle there would only
   * ever delay the last end of a neuron. **An end answered from memory is the other case** — it
   * costs nothing, so several hundred can arrive in one tick — and is throttled, below.
   */
  const build = () => {
    /*
     * Charged directly rather than through a wrapper: it is the one expensive thing the run
     * does that is not behind an injected step, and it grows with the run — every publish
     * rebuilds both tables from every end so far.
     */
    const at = performance.now()
    answer = publish()
    builtAt = performance.now()
    clock.spend('rebuilding the published tables', builtAt - at)
    behind = false
    // With the tables, never apart from them (`publish` moves the bar): one that stayed on
    // "scoring" through a stretch answered from memory describes another moment.
    ctx.progress(afterShare(head, shown), note)
    ctx.publish(answer)
  }
  /**
   * Show what changed **without anything having been measured**: at most a few times a second,
   * and then let the browser in.
   *
   * Every publish rebuilds both tables from every end so far — 20–40 ms at a neuron's 505 ends
   * — which hides behind the seconds a measured end takes and behind nothing when several
   * hundred ends, or two hundred pieces, are answered from memory in one tick. And nothing in
   * such a stretch awaits anything real, so without the yield it is one task: no repaint of what
   * was just published, and no Cancel.
   *
   * **By hand, where the rule is `sliced`** (`core/slice.ts`): that loop's body is synchronous
   * and its count known, and this is an async stream whose next item may take a tick or eleven
   * seconds. What is shared with it is the part that matters — the browser is let in on a
   * clock, and Cancel is read each time round.
   *
   * While the run takes what the memory answers (`fromMemory`) nothing is shown, `now` or not;
   * the browser is still let in on the clock.
   */
  const showSoon = async (now = false) => {
    throwIfAborted(ctx.signal)
    if (fromMemory) {
      behind = true
      await letIn()
      return
    }
    if (!now && performance.now() - builtAt < PUBLISH_INTERVAL_MS) {
      behind = true
      return
    }
    build()
    await yieldToBrowser()
    letInAt = performance.now()
  }

  /**
   * One neuron's ends that the memory does not hold, searched and scored — each yielded once it
   * is wholly finished, in the order given, which is `recalled`'s contract.
   *
   * **One list, because two would put the plan's order in a comment.** The chunk plan and the
   * search are both built from `missing`, so the cache cannot evict confidently against a
   * future the search is not going to have. Remembered ends are in neither: they read nothing.
   *
   * An end leaves here numbered within its root, as `searchEnds` numbers it, and is kept under
   * that number; where it sits in the published table is the run book's to say.
   *
   * `competing` is every tip the own-tip rule measures against, the ends to search first: a
   * neuron's own tips, or an accepted piece's followed by those of its path (`pieces.ts`).
   */
  const measure = async function* (
    competing: readonly TipRow[],
    missing: readonly EndToSearch[],
    alias: ReadonlyMap<bigint, bigint> | undefined,
    signal: AbortSignal,
  ) {
    const assess = await assessFor()
    /*
     * **What this neuron is about to read, before it reads any of it.** Both of an end's boxes
     * are functions of its tip position, so the whole sequence is knowable — and with it the
     * cache evicts what is wanted furthest away rather than what was read longest ago, which
     * on one neuron at the default budget is 9.3 MB a tip against 13.7. `chunkPlan.ts` holds
     * the measurement and why the patch box is bounded rather than predicted.
     */
    volume.planEnds(
      missing.map((end) => [...competing[end.tip]!.nm] as Triple),
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
     * **Several ends are under way while this one is scored**: `searchEnds` keeps
     * `SEARCH_DEPTH` searching, `oneAhead` asks for the next before the body scores this one, and
     * `arriving` starts that next end's patch box as it comes. `searchRun.ts` holds the reasoning;
     * what it rests on is settled there and in `rootedBox.ts` — a yielded end is final, and boxes
     * read together share their supervoxel lookups (`shareInFlight`).
     *
     * **The eviction plan stays sound, with one caveat that is this file's to record.**
     * `chunkPlanFor` gives both boxes of one end *one* position and `endSearched` runs below,
     * after the assessor — so the plan sits at *p* while the reads belong to *p* (this end's
     * scoring), *p+1* (the patch box read ahead) and up to *p+3* (the searches). None scores
     * `Infinity`, so nothing still being read is dropped in preference to dead bytes. But
     * `nextUse` answers the nearest end at or after the cursor, so a chunk only the furthest
     * end wants scores highest of the finite ones: at a budget too small for every end in
     * flight, the cache can evict what a read has just fetched, and it is fetched again —
     * wasted bytes, never a wrong box. At the default budget the ends in flight want ~70 chunks
     * against 170 held; a reader who sets `Chunk cache` low meets it sooner, which is one more
     * reason `reportOnReads` exists.
     *
     * What it costs is boxes alive: up to three search boxes and two patch boxes at once — not
     * yet measured as a peak.
     */
    /*
     * **Each end's patch box starts as the end arrives from the search**, and `oneAhead` asks for
     * the next end before the body scores this one — so the next box is read while the GPU
     * scores, rather than between two scorings with the GPU idle. Only the read runs ahead: the
     * cutter still holds one box at a time (`useAssessorBox`), and each end is scored, finished
     * and yielded in order.
     */
    /*
     * **The search's own stop, aborted the moment this loop ends** — scoring failed, or the
     * consumer stopped. Closing the generators is not enough: `oneAhead`'s `return()` waits
     * behind the `next()` it has pending, so the ends `searchEnds` has under way would go on to
     * measure, and `arriving` read one more patch box, before the close arrived.
     */
    const stop = new AbortController()
    const searching = AbortSignal.any([signal, stop.signal])
    const arriving = async function* (stream: AsyncGenerator<SearchedEnd>) {
      for await (const end of stream) {
        // Thrown, not returned: a stream that just ended would read as one that came up short.
        throwIfAborted(searching)
        const tip = competing[end.tip]!
        // A piece's ends are asked about as the neuron's: its path is read as one with it.
        const toAssess = assess && {
          queryRoot: BigInt(tip.seed ?? tip.neuronId),
          candRoot: end.candRoot,
          contactsNm: contactsOf(end),
          alias,
        }
        const box = assess && toAssess && startPatchBox(toAssess, assess.steps, { signal, top })
        yield { end, tip, toAssess, box }
      }
    }
    try {
      for await (const { end, tip, toAssess, box } of oneAhead(
        arriving(
          searchEnds(
            tipPositions(competing),
            missing,
            { ranker, topK: plan.topK, ownUm: plan.ownUm },
            steps,
            { signal: searching, depth: SEARCH_DEPTH },
          ),
        ),
      )) {
        let finished: PublishedEnd
        if (assess && toAssess) {
          const scored = await assessEnd(
            toAssess,
            assess.floor,
            assess.steps,
            { signal, top },
            box,
          )
          finished = publishedEnd(end, scored, tip.eTip, assess.fits)
        } else {
          finished = searchOnly(end)
        }
        // One end off the plan, so the chunks only it wanted stop being worth keeping.
        volume.endSearched()
        yield finished
      }
    } finally {
      stop.abort()
    }
  }

  /**
   * Take one root's ends as they come — remembered or measured — into the run's answer.
   *
   * One body for a neuron's ends and an accepted piece's, because what happens to a finished end
   * is the same for both; what differs is what was searched, which is the stream's.
   */
  const take = async (
    stream: AsyncIterable<RecalledEnd>,
    says: string,
    put: (end: PublishedEnd) => void,
  ) => {
    for await (const got of stream) {
      put(got.end)
      // The oldest wins, so the card says how long ago the stalest end behind it was measured.
      ctx.reportFetched(got.at)
      if (!got.fresh) {
        note = `${says}: already searched`
        // An owed publish is made before an end that has to be measured, not after its seconds.
        await showSoon(got.thenWaits)
        continue
      }
      note = `${assessing ? 'scoring' : 'searching'} ${says}`
      measured += 1
      /*
       * `''` in `filled` is a candidate that really was scored — the vocabulary the run's own
       * tally counts in. Counted for measured ends only, since the rate it becomes is this
       * run's: a remembered end's patches were another run's work.
       */
      for (const why of got.end.scores?.filled ?? []) if (why === '') patches += 1
      /*
       * **Published only once the end is wholly finished**, assessor and all, which is what
       * keeps the streaming honest now that there is a second stage: a reader must never see
       * a row ranked by geometry that the assessor is about to reorder underneath them. The
       * cost is that an assessed end takes about two seconds longer to appear, which is the
       * right trade — a draft that moves is worse than a wait.
       */
      build()
    }
  }

  /** One root whose open ends are to be searched: a neuron, or a piece it is being extended by. */
  interface Root {
    /** The neuron it is, or is part of — the boxes of two of these do not overlap. */
    readonly seed: string
    /** The neuron's id, or the piece's: its name in the run's book, and what the bar calls it. */
    readonly id: string
    /** Its own tips; an end is numbered by its tip's place here. */
    readonly mine: readonly TipRow[]
    /** Every tip the own-tip rule measures against, `mine` first. */
    readonly competing: readonly TipRow[]
    /** Each of `mine`'s key in the memory of finished ends, and what the memory answers of them. */
    readonly keys: readonly string[]
    readonly held: ReadonlyMap<string, Remembered>
    /** A piece's path, read as the seed's in every box; `undefined` for a neuron's own ends. */
    readonly alias: ReadonlyMap<bigint, bigint> | undefined
    /** Stops this root's search alone — a piece's, so that one failing does not end the run. */
    readonly signal: AbortSignal
  }
  let lastSeed: string | undefined
  /**
   * Search one root's ends: the ones the run attempts, remembered or measured, in their order.
   *
   * The same for a neuron and for a piece. A neuron is the plain case — it competes with its own
   * tips only, and nothing is read as it but itself.
   *
   * Only what is still wanted: a root can be searched more than once, and an end it already has
   * is not asked for again. While the run takes what the memory answers (`fromMemory`), just the
   * ends the memory holds — so nothing is measured, and `take` never builds the tables.
   */
  const searchRoot = async (root: Root) => {
    const toSearch: EndToSearch[] = []
    // A tip outside the volume, or the end a piece joins by, is a competitor and never an end —
    // and an end the book already has is not asked for again.
    for (const i of book.wanted(root.id)) {
      const tip = root.mine[i]!
      if (fromMemory && !root.held.has(root.keys[i]!)) continue
      const end = endToSearch(
        volume,
        tip,
        i,
        halfWidthNm,
        { ...options, signal: root.signal },
        root.alias,
      )
      toSearch.push({ ...end, box: clock.around('reading the search box', end.box) })
    }
    if (toSearch.length === 0) return
    // One neuron's ends overlap, and so do its pieces'; two neurons' do not, and may be read at
    // different moments. See `forgetRoots`, which moves the reader to this neuron's.
    if (lastSeed !== root.seed) forgetRoots(volume, identityOf(root.seed).moment)
    lastSeed = root.seed
    // `thenWaits` looks ahead within a root; this is the same look across the boundary.
    if (behind && !root.held.has(root.keys[toSearch[0]!.tip]!)) build()
    await take(
      recalled(toSearch, {
        memory: sessionEnds,
        held: root.held,
        keyOf: (end) => root.keys[end.tip]!,
        // Numbered within the root, as `searchEnds` numbers them and the book keeps them.
        rowOf: (end) => end.tip,
        measure: (missing) => measure(root.competing, missing, root.alias, root.signal),
      }),
      root.id,
      (end) => book.put(root.id, end),
    )
  }

  let said = ''
  /**
   * Let the browser in, on a clock, where a stretch of work awaits nothing real — so a repaint
   * and a Cancel are not held up by it. `showSoon`'s yield, without anything to show.
   */
  const letIn = async () => {
    if (performance.now() - letInAt < PUBLISH_INTERVAL_MS) return
    await yieldToBrowser()
    letInAt = performance.now()
    throwIfAborted(ctx.signal)
  }
  /**
   * Pieces whose chain could not be run, said once. Not tried again in this run: the memo would
   * answer with the same failure in other words, and one failure would read as two.
   */
  const gaveUp = new Set<string>()
  /** Whether a neuron has an end to try that the memory does not answer. */
  const seedWaits = (neuron: string, keys: readonly string[]) =>
    book.wanted(neuron).some((tip) => !held.has(keys[tip]!))
  /**
   * Take one piece the reader asked to have extended: find its open ends, tell the joining one
   * from the rest, search what is still to be searched.
   *
   * **It can be called more than once for a piece, and the second time does only what
   * changed.** The piece's record (`runBook.ts`) holds its tips and the ends found so far; this
   * works out the joining end again from what its parent's ends say *now*, and searches the
   * ends the record does not have. That is what lets a piece go ahead of the ends its neuron
   * still has left — joined by what there is so far — and be put right once they are all in.
   *
   * **A piece that cannot be extended is said and passed over**, never the end of the run: its
   * mesh may not load, its chain may not be one that can be run again, and the ends already on
   * the table are worth having either way (`docs/limits.md`). It is said as a warning on this
   * card and nowhere else: a table of what became of each piece was built and taken out again
   * (user, 2026-11-16) — few pieces are expected to fail, and it was a third wire into the
   * review card. A Cancel is the one thing that does stop here.
   *
   * `ahead` is a piece offered a turn before its neuron's remaining ends. It takes it only
   * where an end already found lists it; otherwise its turn comes with the rest. While the run
   * takes what the memory answers (`fromMemory`), a piece whose tips no earlier run kept is
   * left for later too: finding them means running its chain.
   */
  const settle = async (piece: Piece, ahead = false) => {
    throwIfAborted(ctx.signal)
    // A piece with nothing to do awaits nothing real, and there can be hundreds in a row.
    await letIn()
    // Where it joins what it was accepted on, and so which of its ends is not an open one.
    const contact = book.contactOf(piece)
    if ((ahead && !contact) || gaveUp.has(piece.id)) return
    let record = book.piece(piece.id)
    const first = record === undefined
    let ran = false
    if (!record) {
      try {
        const got = await pieceTips(
          ctx,
          piece,
          (says) => {
            // The inner chain reports on every state change, mostly the same words.
            if (says === said) return
            said = says
            ctx.progress(afterShare(head, shown), says)
          },
          fromMemory,
        )
        // Taking what the memory answers, and its tips are not kept: its chain runs later.
        if (!got) return
        ran = got.ran
        // Numbered within the piece: where its rows sit in the table is the book's to say.
        const mine = ownTips(got.tips, piece, assessing)
        /*
         * Rows, and none of them this piece's tip: the chain answered about another id, or with
         * rows that have no position. Said, because the state it leaves — nothing to search —
         * is the one a piece with no open ends has, and a reader would take the piece for
         * finished.
         */
        if (got.tips.length > 0 && mine.length === 0) {
          ctx.warn(
            `${piece.id}: the chain above Tips answered with ${plural(got.tips.length, 'row')}, ` +
              'none of them an open end of this piece that can be searched.',
          )
        }
        record = book.addPiece(
          piece,
          got.tips,
          mine,
          mine.map((tip) => boxFits(volume, tip, halfWidthNm)),
        )
        tipsOf.set(piece.id, mine)
      } catch (error) {
        throwIfAborted(ctx.signal)
        gaveUp.add(piece.id)
        ctx.warn(`${piece.id} could not be extended. ${errorMessage(error)}`)
        return
      }
    }
    const { mine } = record
    if (!contact && mine.length > 0) {
      ctx.warn(
        `${piece.id} is not among the candidates found for ${piece.parent}, so the end it ` +
          'joins by could not be told from an open one and was searched with the rest.',
      )
    }
    // Which end is the join, by what the parent's ends say now. An end found earlier at a tip
    // that turns out to be the join is dropped by the book; one that is no longer it is wanted.
    const moved = book.join(piece.id, junctionOf(mine, contact, plan.ownUm))
    // Its search failed earlier in this run: joined where it belongs, said once, tried no more.
    // (Asked again: a record is a reading, and the join has just been said.)
    if (book.piece(piece.id)?.failed) {
      behind ||= moved
      return
    }
    const wanted = book.wanted(piece.id)
    // Taken before, and nothing about it has changed.
    if (!first && !moved && wanted.length === 0) return

    const { competing, keys } = pieceKeys(identityOf(piece.seed), piece, mine, tipsOf)
    /*
     * What the memory held of this piece when the run started, where its tips were known then —
     * the reading the wait was priced on and the assessor decided on (`foreseePieces`). A piece
     * whose chain has only just run is read now: nothing could have been foreseen of it. Taken
     * again, it is asked of the ends now wanted alone — an old joining tip, never measured in
     * this run — so Clear Cache and the card's lifetime reach those too, and nothing this run
     * has just measured is forgotten.
     */
    const heldHere = first
      ? ((ran ? undefined : foreseen.get(piece.id)) ?? heldFor(ctx, keys))
      : heldFor(
          ctx,
          wanted.map((tip) => keys[tip]!),
        )

    note = `${piece.id}: ${plural(wanted.length, 'open end')} to search`
    /*
     * Shown before any of it is searched, so a reader sees the piece's tips, waiting — at once
     * where that is news (its chain just ran, its join moved, or an end is about to take
     * seconds), and on the clock where the whole piece is remembered, which on a neuron with two
     * hundred pieces already extended is every piece but the one just asked for.
     */
    const waits = wanted.some((tip) => !heldHere.has(keys[tip]!))
    await showSoon(ran || waits || (moved && !first))
    if (wanted.length === 0) return

    // Its own, so that a failure stops what this piece still has in flight and nothing else.
    const own = new AbortController()
    try {
      await searchRoot({
        seed: piece.seed,
        id: piece.id,
        mine,
        competing,
        keys,
        held: heldHere,
        alias: aliasOf(piece),
        signal: AbortSignal.any([ctx.signal, own.signal]),
      })
    } catch (error) {
      throwIfAborted(ctx.signal)
      // Not this piece's failure but the run's: nothing after it could be scored either.
      if (unscorable !== undefined) throw unscorable
      /*
       * The same promise as for its tips: this piece is said and passed over, and the rest go
       * on. What it had read ahead is stopped, and the ends it never reached are taken off what
       * the run attempts (`fail`) — left there they would read "not yet" on a finished run, and
       * the review card would go on counting them as waiting.
       */
      own.abort()
      book.fail(piece.id)
      ctx.warn(`${piece.id} could not be searched. ${errorMessage(error)}`)
    }
    behind = true
  }

  /*
   * **First, everything the memory answers, published once** (user, 2026-11-18): every neuron's
   * remembered ends, then every piece whose tips an earlier run kept, with the ends of it the
   * memory holds (`fromMemory`). Extend moves this node's key, so each press starts the run from
   * an empty book, and a reader is left the answer they had only until the first publish — which
   * now holds every row the memory could answer, so a press adds rows and takes none away
   * (`docs/seam-extend-plan.md` has what it did before). It costs nothing: none of it reads the
   * network, and the book's order is not the work's.
   *
   * **Then, where the run still has ends to measure, a neuron's pieces before those** (user,
   * 2026-11-16). A reader extends a piece while the search is still running; the press restarts
   * this run, and left in the plain order the piece would wait behind every end the run has
   * left, a minute or more for a search of seconds. So, a neuron at a time: every piece that can
   * be joined by what its ends so far found, breadth first, so a piece of such a piece goes too;
   * then the rest of the neuron's ends. **Asked of the run, not of the neuron**: a reader extends
   * a piece of the first neuron, which is finished, while the second is still being searched,
   * and that piece must not wait for the second neuron's ends either.
   *
   * **What goes early is a draft, and is put right afterwards.** Taken early, a piece is joined
   * by the ends its parent has *so far*; an end not yet measured may list it at a smaller gap,
   * and then another of its ends is the one it joins by. So once every neuron's ends are in,
   * every piece is taken again, in order (`settle`): for nearly all of them nothing has changed
   * and nothing is done. The tables a run ends on do not depend on when Extend was pressed —
   * they are put together from the records in the plain order every time (`runBook.ts`).
   */
  const runWaits = neurons.some((one) => seedWaits(one.neuron, one.keys))
  const seeds = neurons.map((one) => one.neuron)
  const roots: Root[] = []
  for (const { neuron, mine, keys } of neurons) {
    tipsOf.set(neuron, mine)
    roots.push({
      seed: neuron,
      id: neuron,
      mine,
      competing: mine,
      keys,
      held,
      alias: undefined,
      signal: ctx.signal,
    })
  }

  /**
   * The first candidates Auto-extend takes at a piece's ends — `autoTakes` over the ends the book
   * has, as the card applies it to the published rows (`autoFirsts`), so both grow one tree.
   */
  const firstsOf = (piece: Piece) =>
    book.endsOf(piece.id).flatMap(({ end, order, scores }) => {
      const at = order[0]
      if (at === undefined) return []
      const id = String(end.candRoot[at])
      // The first candidate's cells as the tables publish them (`searchCell`).
      const organelle = searchCell(end.columns, 'organelle', at)
      const l2Chunks = searchCell(end.columns, 'n_l2', at)
      const takes = autoTakes(
        {
          shown: scores?.tip.shown,
          q: scores?.tip.q,
          organelle: typeof organelle === 'boolean' ? organelle : null,
          l2Chunks: typeof l2Chunks === 'number' ? l2Chunks : null,
          id,
        },
        // The reader's floor, as the card applies it (`autoFirsts`): one tree on both sides.
        extendPlan.autoMinQ,
      )
      return takes ? [id] : []
    })
  /** The pieces the run takes, in the plain order — the book's too. */
  let order = pieces
  /**
   * Take the pieces — one neuron's, or every one — and, where an Auto-extend was pressed, the
   * pieces it takes from their ends, round after round until it takes no more
   * (`docs/seam-auto-extend-plan.md`). Without one, a single pass in `piecesOf`'s order.
   *
   * **The tree is grown afresh from the book every round** (`growAuto`), never added to: taken
   * early, a piece's ends are a draft, and what Auto-extend took from them may not stand once
   * they are all in. So the last call, made once every end is, grows the tree a plain run grows.
   */
  const grow = async (ahead: boolean, seed?: string) => {
    const settleAll = async () => {
      for (const piece of order) {
        if (seed === undefined || piece.seed === seed) await settle(piece, ahead)
      }
    }
    if (extendPlan.roots.size === 0) return settleAll()
    for (let round = 0; round < MAX_GROW_ROUNDS; round++) {
      const next = growAuto(extendPlan, seeds, firstsOf).searched
      const same =
        next.length === order.length &&
        next.every((piece, at) => pathKey(piece) === pathKey(order[at]!))
      if (same && round > 0) return
      if (!same) {
        book.reorder(next)
        order = next
      }
      await settleAll()
    }
    ctx.warn(
      `Auto-extend was stopped after ${MAX_GROW_ROUNDS} rounds without settling on a tree. ` +
        'The pieces it had taken are listed.',
    )
  }

  fromMemory = true
  for (const root of roots) {
    await searchRoot(root)
    await grow(true, root.seed)
  }
  fromMemory = false
  // Shown before anything that takes seconds — a piece's chain, an end to measure. The bar's
  // words are the pass's, not those the last piece taken in it left behind.
  if (behind) {
    note = 'already searched'
    await showSoon(true)
  }
  for (const root of roots) {
    if (runWaits) await grow(true, root.seed)
    await searchRoot(root)
  }

  // Every neuron's ends are in now. Where a piece joins is asked of the book again, which knows
  // whether its parent's ends have moved since. A neuron's pieces together, in `piecesOf`'s
  // order within it: each change of neuron moves the reader to another moment and starts its
  // supervoxel memo afresh (`forgetRoots`). The tables are the book's order whatever this is.
  await grow(false)

  const piecesOutside = book.piecesOutside()
  if (piecesOutside > 0) {
    ctx.warn(
      `${plural(piecesOutside, 'open end')} of the extended pieces ` +
        `${agree(piecesOutside, 'lies', 'lie')} ` +
        'outside the segmentation volume, so no box could be read there.',
    )
  }

  // The answer has to hold the last ends recalled, shown yet or not.
  if (behind) build()

  reportOnRun(ctx, listed, volume.chunks)
  // The rate is the one number in the report that compares against another machine — and both
  // halves of it are this run's own work, so a run answered from memory says nothing about time.
  const timing = clock.report({ ends: measured, patches })
  if (timing) {
    ctx.warn(timing.said)
    // The whole split, for a reader comparing machines or browsers (`TimingReport`).
    // eslint-disable-next-line no-console
    console.info(`Suggest Merges: ${timing.detail}`)
  }
  return answer
}

/**
 * An accepted piece's tips, by the chain that made them and the piece — for the session.
 *
 * The chain above `Tips` is a mesh fetched, cleaned and scanned: a second and a half for a small
 * fragment, twenty for a piece of five hundred level-2 chunks (phase 0). The node's key moves on
 * every Extend, so every piece already extended would otherwise be run through it again each
 * time. Keyed on `ctx.inputKey('tips')`, which is the provenance of that chain: change a setting
 * in it and these are asked for afresh, as the neuron's own tips are.
 */
/** A piece's tips as the chain answered, what it warned about, and when — epoch ms. */
interface KeptTips {
  readonly tips: TableValue
  readonly warnings: readonly string[]
  readonly at: number
}

type Kept =
  | KeptTips
  /** The chain failed for this piece, and when — so it is not run again on every Extend. */
  | { readonly failed: string; readonly at: number }

const pieceTipsMemo = new LruMap<string, Kept>(512)

/**
 * How many rounds Auto-extend may take before it is stopped. Each round is a layer or less, and
 * `AUTO_DEPTH` layers is ten; a nested press adds its own. Far above any tree that settles, so
 * reaching it means one that does not — said, never silent.
 */
const MAX_GROW_ROUNDS = 100

/**
 * How long a piece whose chain failed is left alone.
 *
 * Every Extend moves the node's key and runs it again, and a piece that failed was found out by
 * running its chain — up to twenty seconds for a mesh that will not load. Unremembered, each
 * failing piece is paid for again on every press, on a run the memory otherwise answers in a
 * fraction of a second. Remembered for good, a moment's network trouble would be the piece's
 * answer for the session. Five minutes is neither; Clear Cache tries at once.
 */
const FAILED_FOR_MS = 5 * 60 * 1000

/**
 * What one piece's chain costs before any of its ends is searched, in seconds, and how many
 * ends a piece nothing is known of is priced at — for the wait warning alone.
 *
 * Phase 0's measurement over 33 pieces (`docs/seam-extend-plan.md`): the chain took a median
 * 1.5 s, and a median piece had two tips with one to search; a quarter were larger, at eleven.
 * Two is between, and a rate rather than a limit: `WAIT_WARN_SECONDS` decides when to speak.
 */
const SECONDS_PER_PIECE_CHAIN = 1.5
const ENDS_PER_UNSEEN_PIECE = 2

/** The node `rerunInput` puts where the neuron came in: the piece's id, and nothing wired. */
const PIECE_SOURCE = 'neuron.inputIds'

/**
 * What a piece's chain runs with that the neuron's did not: **the nucleus lookup only for a piece
 * that could hold a nucleus**, by its mesh surface — under the smallest nucleus measured, with a
 * margin (`docs/seam-extend-plan.md`, "Phase 0 — results").
 */
const PIECE_SETTINGS = { [openEndsNode.type]: { nucleusMinAreaUm2: 75 } } as const

/**
 * Where a piece's tips are kept — or `undefined` where the chain above `Tips` has no key, and
 * then nothing is kept at all: a key without the chain in it would hand one chain's tips to
 * another's.
 */
function pieceTipsKey(ctx: EvalContext, piece: Piece): string | undefined {
  const chain = ctx.inputKey('tips')
  return chain === undefined ? undefined : `${chain}|${piece.id}`
}

/**
 * What is kept of a piece that this run may answer from: nothing where a Clear Cache asked for
 * none, nothing older than a lifetime chosen on the card, and a failure only while it is recent.
 *
 * The `dataCache` contract, kept for this memory as for the ends': the node offers Clear Cache
 * and a lifetime, and both mean the tips as well as what was searched from them.
 */
function keptOf(ctx: EvalContext, piece: Piece): Kept | undefined {
  const key = pieceTipsKey(ctx, piece)
  const kept = key === undefined ? undefined : pieceTipsMemo.get(key)
  if (!kept || key === undefined) return undefined
  const age = Date.now() - kept.at
  const stale =
    ctx.refresh ||
    ('failed' in kept ? age >= FAILED_FOR_MS : ctx.maxAgeMs !== undefined && age > ctx.maxAgeMs)
  if (stale) pieceTipsMemo.delete(key)
  return stale ? undefined : kept
}

/**
 * One accepted piece's open ends: the chain above `Tips`, run again for the piece alone.
 *
 * Throws where the chain cannot be run again or a node in it fails; the caller says so and goes
 * on to the next piece.
 */
async function pieceTips(
  ctx: EvalContext,
  piece: Piece,
  report: (says: string) => void,
  /**
   * Answer from the memo or not at all: `undefined` where the chain would have to run, or a
   * failure is kept. One reading of the memo decides, so a lifetime crossed between asking and
   * running cannot start seconds of chain in a stretch that publishes nothing (`fromMemory`).
   */
  keptOnly: boolean,
): Promise<{ tips: TableValue; ran: boolean } | undefined> {
  const key = pieceTipsKey(ctx, piece)
  let kept = keptOf(ctx, piece)
  if (keptOnly && (!kept || 'failed' in kept)) return undefined
  if (kept && 'failed' in kept) {
    throw new Error(`${kept.failed} Not tried again for a few minutes; Clear Cache tries now.`)
  }
  const ran = !kept
  if (!kept) {
    if (!ctx.rerunInput) {
      throw new Error('This run cannot run the chain above `Tips` again for another neuron.')
    }
    report(`${piece.id}: finding its open ends`)
    try {
      const { value, warnings } = await ctx.rerunInput(
        'tips',
        { type: PIECE_SOURCE, params: { ids: piece.id }, output: 'neurons' },
        { report: (says) => report(`${piece.id}: ${says}`), settings: PIECE_SETTINGS },
      )
      if (!isTableValue(value)) {
        throw new Error('The chain above `Tips` did not answer with a table of open ends.')
      }
      kept = { tips: value, warnings, at: Date.now() }
    } catch (error) {
      // A Cancel is not the piece's failure, and must not be remembered as one.
      throwIfAborted(ctx.signal)
      if (key !== undefined)
        pieceTipsMemo.set(key, { failed: errorMessage(error), at: Date.now() })
      throw error
    }
    if (key !== undefined) pieceTipsMemo.set(key, kept)
  }
  // The age of the tips counts towards the card's, as each end's does.
  ctx.reportFetched(kept.at)
  /*
   * Said again on every run, kept or not — a caveat that held for the tips holds for an answer
   * built on them, and names the piece. Find Open Ends' two about the nucleus lookup — no row in
   * the table, a root no longer current — are said only for a piece large enough to be asked
   * (`PIECE_SETTINGS`), where a missing soma mask is worth knowing about.
   */
  for (const said of kept.warnings)
    ctx.warn(`Finding the open ends of piece ${piece.id}: ${said}`)
  return { tips: kept.tips, ran }
}

/**
 * A piece's own tips out of its chain's table: on its root, numbered as that table's rows —
 * where they sit in the published table is the run book's to say — and in the neuron the piece
 * is being extended into.
 */
function ownTips(tips: TableValue, piece: Piece, assessing: boolean): TipRow[] {
  return tipsFromTable(tips, assessing)
    .rows.filter((tip) => tip.neuronId === piece.id)
    .map((tip) => ({ ...tip, seed: piece.seed }))
}

/**
 * A piece's ends in the memory of finished ends: every tip the own-tip rule measures them
 * against — the piece's own, then its path's — and each of its tips' key.
 *
 * **One derivation, read twice**, for `neuronsOf`'s reason: by `foreseePieces`, which prices the
 * run and takes a Clear Cache to every piece before anything is measured, and by the loop. A
 * key those two spelled apart would be a Clear Cache that forgot nothing, or a wait priced on
 * ends the run never asks for.
 */
function pieceKeys(
  identity: RunIdentity,
  piece: Piece,
  mine: readonly TipRow[],
  tipsOf: ReadonlyMap<string, readonly TipRow[]>,
): { competing: TipRow[]; keys: string[] } {
  const competing = [...mine, ...piece.path.slice(0, -1).flatMap((id) => tipsOf.get(id) ?? [])]
  const inNeuron = neuronKey(identity, piece.id, competing, piece.path)
  return { competing, keys: mine.map((tip) => endKey(inNeuron, tip)) }
}

/**
 * What can be said of the pieces before the run reaches any of them — and, on a Clear Cache,
 * everything about them forgotten here.
 *
 * A piece whose tips an earlier run found has ends whose keys can be worked out now. What the
 * memory holds of them is **taken here, once**, and handed to the loop (`held`): the wait is
 * priced and the assessor opened, or not, on the very reading the run then answers from —
 * `heldEnds`' reason, which a second look as the loop reached each piece would undo. A piece
 * nothing is kept of has a chain to run first.
 *
 * **Clear Cache is taken to every piece here**, tips and ends both. Its flag is spent when the
 * run starts, so forgotten as the loop reached each piece, a run cancelled at the third would
 * leave the fourth to the fiftieth answering from before it on the next run — `forgetStale`'s
 * own header, one level out.
 */
function foreseePieces(
  ctx: EvalContext,
  identityOf: (neuron: string) => RunIdentity,
  neurons: readonly RunNeuron[],
  pieces: readonly Piece[],
  assessing: boolean,
): { unremembered: number; unknown: number; held: Map<string, Map<string, Remembered>> } {
  const tipsOf = new Map<string, readonly TipRow[]>(
    neurons.map((one) => [one.neuron, one.mine]),
  )
  const held = new Map<string, Map<string, Remembered>>()
  let unremembered = 0
  let unknown = 0
  for (const piece of pieces) {
    const key = pieceTipsKey(ctx, piece)
    // Read past `keptOf`: a Clear Cache has to find the ends of tips it is about to forget.
    const any = key === undefined ? undefined : pieceTipsMemo.get(key)
    const kept = keptOf(ctx, piece)
    let mine: TipRow[] | undefined
    if (any && 'tips' in any) {
      try {
        mine = ownTips(any.tips, piece, assessing)
      } catch {
        // A table this run cannot read (an `e_tip` it now needs): the loop will say so.
      }
    }
    if (!mine) {
      unknown += 1
      continue
    }
    tipsOf.set(piece.id, mine)
    const { keys } = pieceKeys(identityOf(piece.seed), piece, mine, tipsOf)
    // Forgets what a Clear Cache or a lifetime rules out, then takes what is left.
    const snapshot = heldFor(ctx, keys)
    if (!kept) {
      // The tips themselves are to be found again, so nothing about its ends is known yet.
      unknown += 1
      continue
    }
    held.set(piece.id, snapshot)
    /*
     * Less one: the end a piece joins by is never searched, so it is never remembered, and
     * counted it would have every piece already extended look as though it had an end to
     * measure — a wait announced for a run that has none, and an assessor opened for it. Which
     * end that is cannot be told here (the own-tip radius is the ranker's, not yet opened), so
     * it is taken off the count; a piece with no such end and exactly one to measure is priced
     * one end short, and its assessor opened on that end instead.
     */
    unremembered += Math.max(0, keys.length - snapshot.size - 1)
  }
  return { unremembered, unknown, held }
}

/**
 * The moment each neuron of the run is read at, by its root id — or no entry for a root the
 * chunkedgraph never made, which is said and not searched.
 *
 * **Each neuron's own moment, kept in `Searched at`** (`ParamBase.runRecord`): the moment the
 * first run that met it searched it at. A neuron with no entry is searched at the present —
 * `FILL_BEHIND_MS` behind this browser's clock — and its moment is written back at once, before
 * anything is measured, so a run cancelled half way and run again searches it at the same moment
 * and the memory of finished ends answers what was done. A run outside the store writes nothing
 * (`EvalContext.record`), and meets the neuron as new each time.
 *
 * **The moment moved into the root's life** (`momentWithin`): where the root was edited before
 * its moment, as it last stood; where the record names a moment before the root was made (only
 * by hand), from when it was made. Both are said, and so is a root edited *after* its moment:
 * the answer is the recorded one, but the neuron has moved on since.
 *
 * **The record is enough without the chunkedgraph.** An entry the node wrote is already inside
 * the root's life, and stays there: a root's life only grows until it is replaced, and an entry
 * is written at or before the moment it was asked. So where the chunkedgraph cannot be asked and
 * every neuron has an entry — a run the memory may answer whole, after a reload too — the run
 * goes on at the record's moments, and says so. A neuron with no entry has no moment to go on at.
 *
 * Without a chunkedgraph root ids never move, and the materialization's moment is as good as any.
 */
export async function momentsOf(
  ctx: EvalContext,
  target: CaveTarget,
  rows: readonly TipRow[],
  options: CaveRequestOptions,
): Promise<Map<string, number>> {
  // Plainly: `withDefaults` has put `absentMeans` in (invariant 4).
  const { moments: record, unread } = readSearchedAt(String(ctx.params.at))
  if (unread.length > 0) {
    ctx.warn(
      `\`Searched at\` held ${namedFew(unread.map((entry) => `“${entry}”`))}, which ` +
        `${agree(unread.length, 'is not a', 'are not')} \`root=moment\` ` +
        `${agree(unread.length, 'entry', 'entries')}, so ${agree(unread.length, 'it was', 'they were')} ` +
        'set aside. The node keeps this field itself, and writes it again without them.',
    )
  }
  // On the paths that write nothing else, so a set-aside entry is not said again every run.
  const healed = () => {
    if (unread.length > 0) ctx.record?.('at', writeSearchedAt(record))
  }
  const neurons = distinctStrings(rows.map((tip) => tip.neuronId))
  const graphene = await grapheneFor(target.datastack, options)
  if (!graphene) {
    const frozen = await instantOf(target.datastack, { version: target.version }, options)
    if (frozen === undefined) {
      throw new Error(unlistedMaterialization(target.datastack, target.version))
    }
    healed()
    return new Map(neurons.map((neuron) => [neuron, frozen]))
  }

  const now = Date.now() - FILL_BEHIND_MS
  const wantedOf = (root: string) => record.get(root) ?? now
  let asked: Awaited<ReturnType<typeof rootLives>>
  try {
    asked = await rootLives(graphene, neurons, options)
  } catch (error) {
    throwIfAborted(ctx.signal)
    if (neurons.some((root) => !record.has(root))) throw error
    ctx.warn(
      `Whether ${agree(neurons.length, 'this neuron has', 'these neurons have')} been edited ` +
        `since could not be asked (${errorMessage(error)}), so the moments in \`Searched at\` ` +
        'were used.',
    )
    healed()
    return new Map(neurons.map((root) => [root, record.get(root)!]))
  }
  const { lives, unknown } = asked
  if (unknown.length > 0) {
    ctx.warn(
      `${notRoots(unknown, target.datastack)}, so ${agree(unknown.length, 'its', 'their')} ` +
        'ends were passed through unsearched.',
    )
  }
  const { moments, edited, later } = momentsFrom(lives, wantedOf)
  /*
   * The moment each neuron is searched at, kept — written before anything is measured. Written
   * back where an entry is new, or names a moment outside its root's life (typed by hand: the
   * node writes only moments inside one), so the record always holds the moment used and the
   * run that cannot ask the chunkedgraph goes on at the same one. Or where one was set aside.
   */
  const fresh = [...moments].filter(([root, moment]) => record.get(root) !== moment)
  if (fresh.length > 0 || unread.length > 0) {
    ctx.record?.('at', writeSearchedAt(new Map([...record, ...fresh])))
  }

  /*
   * **One sentence, and Update Root IDs its only remedy** (user, 2026-11-18). Whether the root was
   * replaced before its moment or after it, the suggestions predate the neuron as it is now. The
   * ⟳ is not a remedy: a replaced root is read at its last moment at best, the same answer again.
   */
  if (edited.size > 0) {
    ctx.warn(
      `${noLongerCurrent(edited, {
        one: 'its suggestions are from before that edit',
        many: 'their suggestions are from before those edits',
      })} To search the neuron as it is now, run Update Root IDs above \`Tips\`.`,
    )
  }
  /*
   * Only a neuron the record held a moment for. A new one's moment is the present a few seconds
   * back (`FILL_BEHIND_MS`), and a root made in those seconds — the neuron just merged and its
   * new root brought in by Update Root IDs — is not one to tell about, and the ⟳ the warning
   * names would answer the same.
   */
  const madeLater = later.filter((root) => record.has(root))
  if (madeLater.length > 0) {
    ctx.warn(
      `${namedFew(madeLater)} ${agree(madeLater.length, 'was', 'were')} made after ` +
        `${agree(madeLater.length, 'its', 'their')} moment in \`Searched at\`, so ` +
        `${agree(madeLater.length, 'it was', 'each was')} searched from the moment it was made. ` +
        'The card’s ⟳ searches at the present.',
    )
  }
  return moments
}

/**
 * What the memory holds of these ends, once what the run may not answer from is forgotten.
 *
 * `forgetStale` then `heldEnds`, in that order and always together: for a neuron's own ends
 * before anything is opened, and for a piece's where its tips are first known.
 */
function heldFor(ctx: EvalContext, keys: readonly string[]): Map<string, Remembered> {
  // Clear Cache, and a lifetime chosen on the card.
  forgetStale(sessionEnds, keys, { refresh: ctx.refresh, maxAgeMs: ctx.maxAgeMs })
  // Then what is left, taken once — the run prices on this and answers from this.
  return heldEnds(sessionEnds, keys)
}

/** One neuron of a run: its tips, where they sit in the table, and its part of an end's key. */
interface RunNeuron {
  readonly neuron: string
  /** Each tip's index in the run's `rows`. */
  readonly at: readonly number[]
  readonly mine: readonly TipRow[]
  /** Each tip's key in the memory of finished ends, beside `mine`. Made once and carried. */
  readonly keys: readonly string[]
}

/**
 * The run's neurons, each with its key in the memory of finished ends.
 *
 * **One derivation, read three times** — by what a Clear Cache forgets, by what the run takes
 * from the memory before anything is opened, and by the loop. Derived apart, nothing would hold the key a wait was priced on equal to the key the run
 * then asks for, and a drift between them is a warning that miscounts and says nothing else.
 */
function neuronsOf(
  rows: readonly TipRow[],
  identityOf: (neuron: string) => RunIdentity,
): RunNeuron[] {
  return [...tipsByNeuron(rows)].map(([neuron, at]) => {
    const mine = at.map((i) => rows[i]!)
    const inNeuron = neuronKey(identityOf(neuron), neuron, mine)
    return { neuron, at, mine, keys: mine.map((tip) => endKey(inNeuron, tip)) }
  })
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
    run: clock.aroundQueue('running the network', (request: RunRequest) =>
      assessor.session.run(request),
    ),
  }
  return {
    box: async (cut) => {
      const box = patchBoxFor(scale, cut.centresNm)
      const read = await labelledBox(volume, scale, box, options, cut.alias)
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
     * is a queue-timed wrapper on `session.run`; and the cutting is a wrapper on the box's
     * `cut`, each call the Pyodide work for one group.
     */
    score: async (request) => {
      const askedAt = performance.now()
      return useAssessorBox(
        request,
        async (open) => {
          clock.spend('handing the patch box to Python', performance.now() - askedAt)
          // The cut timed as its own calls: with runs in flight the network's queue is busy
          // while the loop waits for a cut, so "the loop minus the network" would hide it.
          const timedOpen = { ...open, cut: clock.around('cutting patches', open.cut) }
          return scoreCandidates(timed, assessor.config, timedOpen, {
            signal,
            inFlight: assessor.inFlight,
          })
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
function published(now: Assembled, assessed: boolean, source: string) {
  const { table, ends, tips, attempting, lineage } = now
  return {
    tips: tipsWithFirsts(table, ends, tips, assessed, attempting, lineage, source),
    candidates: candidatesTable(ends, tips, assessed),
  }
}
