/**
 * One searched end scored: a patch per candidate, a logit each back, in the end's own order.
 *
 * Stage 6, as a run sees it. `assessorPatches.ts` cuts the 129³ windows and `assessorRun.ts`
 * feeds them to the checkpoint; what is here is the part between the search and those two — which
 * candidates get a patch, where the box around them is, and what happens to the ones that do not.
 *
 * **This is the mask-patch route's stage 6**, not stage 6 in general: a patch per candidate, cut
 * from segmentation. SEAM's arm B answers the same question from one 256³ EM window per tip, so
 * it is a sibling of this file rather than a generalisation of it — what the two share is what
 * they hand back (`AssessedEnd`), which is declared with the columns it is published into.
 *
 * Headless and pure, `searchRun.ts`' arrangement and for its reason: the sequence is where the
 * failures live, and every one of them is a number rather than an error. It takes its two
 * expensive steps as functions, so a test drives the sequence rather than a second copy of it.
 *
 * ## A candidate with no patch is scored at the floor, never dropped
 *
 * Three things leave a candidate unscored: the cap below, a root with no voxel in the box
 * (`AssessorBox.absent`), and a window that would reach past the box's edge
 * (`AssessorPatches.outside`). All three take the checkpoint's own `missingPatchScore` — SEAM's
 * `filled`, its lowest score on the calibration list — because the logits go on to a **softmax
 * within the tip's list**, so a missing row changes every other row's share, and a candidate
 * absent from the answer is not "ranked last", it is a merge nobody was offered.
 *
 * ## The cap is the reader's, and it is not free
 *
 * `top` scores only the first `top` of the list, which is the forest's own order, and floors the
 * rest. Measured against SEAM's own 2,708-tip single-seed fixture — the whole pipeline
 * recomputed, capped and uncapped:
 *
 * | cap | patches cut | of 144 shown tips, unchanged | no longer shown | newly shown |
 * |---|---|---|---|---|
 * | 10 | 25% | 132 | 12 | 9 |
 * | 20 | 47% | 139 | 3 | 4 |
 * | 25 | 57% | 141 | 1 | 4 |
 *
 * The first column is what it buys and the last is the part worth reading twice: a cap does not
 * only lose suggestions, it **invents** them. Flooring the tail concentrates the softmax on the
 * first candidate, which raises `p_top` and so `q`, and a few tips cross the cutoff that would
 * not have. The ranking of the ones that remain is barely touched — the assessor's term dominates
 * ref's design, so a floored candidate sits some nineteen logits down and contributes nothing —
 * which is why the middle column holds up so much better than the raw count of tips whose first
 * candidate moves (959 of 2,708 at a cap of 10, almost all of them far below the cutoff).
 *
 * So the default is no cap, and a run that caps says so.
 */

import { errorMessage } from '../../core/errors'
import { throwIfAborted } from '../../core/slice'
import type { Triple } from '../../data/precomputed/volume'
import type { AssessorBoxRequest } from '../../pyodide/assessorPatches'
import type { AssessorScores } from './assessorRun'
import type { AssessedEnd, WhyFilled } from './searchTips'

/** One end's ranked list, as the assessor needs it. */
export interface EndToAssess {
  /** The neuron the patch's label `1` is. */
  readonly queryRoot: bigint
  /** The candidates in the forest's order — `RankedPool.candRoot`. */
  readonly candRoot: BigUint64Array
  /**
   * Where each comes nearest the query, in nanometres, in the same order.
   *
   * Triples rather than one interleaved array, because that is the form the only two consumers
   * want: `patchBoxFor` sizes the box from `readonly Triple[]`, and the bridge takes a flat
   * `Float64Array` built once where the request is. It used to be interleaved here, taken apart
   * into triples in this file, and put back together in the node — three shapes for one fact.
   */
  readonly contactsNm: readonly Triple[]
  /**
   * An accepted piece's path, read as the query's in the patch box — `labelledBox`' `alias`.
   * Stated on every end, `undefined` for a neuron's own: it has to match what the search read.
   */
  readonly alias: ReadonlyMap<bigint, bigint> | undefined
}

/** Which patches to cut, and for which candidates: one end's capped list, ready for the bridge. */
export interface PatchCut {
  /** The contacts to centre patches on — the capped prefix of the end's list. */
  readonly centresNm: readonly Triple[]
  /**
   * The candidate roots those belong to, **copied**, in the same order.
   *
   * A copy and not a subarray: `callPython` transfers every view in a request, so handing over
   * a window on the end's own `candRoot` would detach the whole buffer — and the table writer
   * reads the rest of it afterwards to publish the floored tail.
   */
  readonly candRoots: BigUint64Array
  readonly queryRoot: bigint
  /** Passed through from the end: the box is read with these roots written as the query's. */
  readonly alias: ReadonlyMap<bigint, bigint> | undefined
}

/**
 * The two expensive steps, as functions.
 *
 * `box` reads and labels; `score` cuts and runs the graph. Injected rather than imported because
 * one needs a volume and a credential and the other a GPU session, and neither is a thing a test
 * — or `pnpm probe:*` — can hand over. The same argument `SearchSteps` makes one file along.
 */
export interface AssessSteps {
  /**
   * The labelled box holding every patch of the cut, ready for the bridge.
   *
   * It throws where no box can be read — a list whose contacts clamp to nothing at the edge of
   * the volume. `assessEnd` turns that into a refusal rather than letting it end the run.
   *
   * It takes the **whole cut**, candidate roots and all, which is what lets a run build these
   * two closures once rather than per end: everything else either of them reads — the volume,
   * the session, the scale — is constant for the run.
   */
  box(cut: PatchCut): Promise<AssessorBoxRequest>
  score(request: AssessorBoxRequest): Promise<AssessorScores>
}

export interface AssessOptions {
  readonly signal?: AbortSignal
  /**
   * How many of the list to score, counting from the forest's first. `0` or absent is all of it.
   *
   * Capping is a decision about cost with a measured price in answers — see the header — so it
   * arrives here as a number somebody chose, never a default this file picks.
   */
  readonly top?: number
}

/** How many of the list to score: `options.top` within the list, or all of it. */
function topOf(all: number, options: AssessOptions): number {
  return options.top && options.top > 0 ? Math.min(options.top, all) : all
}

/**
 * Start reading one end's patch box, **ahead of scoring it** — `undefined` for an end with no
 * candidates, which reads none.
 *
 * Its own step because it need not wait for the GPU: the box depends only on the end's contacts,
 * which the search has long since found, so a run reads the next end's box while the GPU scores
 * this one. Serial, the GPU stood idle for every box read — ~0.6 s an end once the search ran
 * ahead (`docs/seam-suggestions-plan.md`, 2026-11-19). Hand the promise to `assessEnd`.
 *
 * The rejection is handled here, where the promise is made (`oneAhead`'s rule): it may be waiting
 * unread while another end is scored, and `assessEnd` turns it into the end's refusal.
 */
export function startPatchBox(
  end: EndToAssess,
  steps: Pick<AssessSteps, 'box'>,
  options: AssessOptions = {},
): Promise<AssessorBoxRequest> | undefined {
  const all = end.candRoot.length
  if (all === 0) return undefined
  const top = topOf(all, options)
  /*
   * **The capped candidates are left out of the box as well as the scoring**, which is the cap's
   * second saving and the larger one on a tip whose tail straggles: the box is sized by the
   * points in it, so a candidate 4 µm away that nobody is going to score should not be widening
   * the read.
   */
  const box = Promise.resolve().then(() =>
    steps.box({
      centresNm: end.contactsNm.slice(0, top),
      candRoots: BigUint64Array.from(end.candRoot.subarray(0, top)),
      queryRoot: end.queryRoot,
      alias: end.alias,
    }),
  )
  void box.catch(() => {})
  return box
}

/**
 * Score one end's candidates.
 *
 * `floor` is the checkpoint's `missingPatchScore`, passed rather than read from a config so this
 * file needs no opinion about where a config comes from. An empty list is an answer — a tip whose
 * every candidate belonged to a nearer tip of the same neuron has none — and costs no box.
 */
export async function assessEnd(
  end: EndToAssess,
  floor: number,
  steps: AssessSteps,
  options: AssessOptions = {},
  /**
   * The end's patch box, already being read (`startPatchBox`) — with the **same** `options.top`.
   * Absent, it is read here, which is the serial order.
   */
  box?: Promise<AssessorBoxRequest>,
): Promise<AssessedEnd> {
  const all = end.candRoot.length
  const score = new Float64Array(all).fill(floor)
  const filled: WhyFilled[] = new Array<WhyFilled>(all).fill('no patch')
  if (all === 0) return { score, filled }

  const top = topOf(all, options)
  for (let i = top; i < all; i++) filled[i] = 'capped'
  throwIfAborted(options.signal)

  let request: AssessorBoxRequest
  try {
    request = await (box ?? startPatchBox(end, steps, options)!)
  } catch (error) {
    // A Cancel is not a box that could not be read: it would publish this end as refused.
    throwIfAborted(options.signal)
    /*
     * **Every candidate is "no patch" here, including the ones past the cap.** `filled` says why
     * a candidate carries the floor, and on this end the reason is the same for all of them: no
     * box could be read, so no patch was attempted for anyone. Leaving the tail marked `capped`
     * made the run's tally report "N past `Assess top`" about an end where the cap changed
     * nothing — a number blaming a control the reader set for a failure of the volume.
     */
    return {
      score,
      filled: filled.map(() => 'no patch' as const),
      refusal: errorMessage(error),
    }
  }
  throwIfAborted(options.signal)

  const answer = await steps.score(request)
  /*
   * **Length checked, not assumed.** `scoreCandidates` answers for every candidate the box was
   * given, and a short answer written into the list by position would leave the tail at the floor
   * — a believable ranking of a list whose last rows were never looked at. It costs one
   * comparison against a run of whole seconds.
   */
  if (answer.logits.length !== top) {
    throw new Error(
      `seam assessor: ${top} candidates were sent and ${answer.logits.length} came back. ` +
        'Written in by position, the difference would be a tail silently left at its floor.',
    )
  }
  score.set(answer.logits, 0)
  filled.fill('', 0, top)
  /*
   * The ones the box could not cut: marked with *why*, which is what the node counts, and
   * written back at the floor in full precision. `scoreCandidates` has already put
   * `missingPatchScore` there — but through a `Float32Array`, so it arrives a few parts per
   * million off, where a capped candidate beside it carries the exact number. The difference
   * vanishes into ref's `score_clip` and changes nothing; one value from one source is still
   * worth more than a column that holds two versions of "the floor".
   */
  for (const at of answer.missing) {
    filled[at] = 'no patch'
    score[at] = floor
  }
  return { score, filled }
}
