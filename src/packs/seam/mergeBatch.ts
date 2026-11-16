/**
 * The batch behind Submit's Merge button (`docs/seam-merge-plan.md`, phase 5). **This writes to a
 * shared segmentation.** It is one of the modules `importGraph.test.ts` allows to import the
 * writer (`MAY_WRITE`), and its own importers are held to a list there too, so nothing reached
 * from an `evaluate`, the assistant or the MCP server can start a batch.
 *
 * One merge at a time, in the order the reader confirmed them, with no pause between and none
 * retried (user, 2026-11-15). Before each, the merge's two supervoxels are mapped to their roots
 * **at the server's now** — never a client instant, which could be behind the server's clock and
 * see the roots from before this batch's last merge:
 *
 *  - the neuron's must map to **the root this batch last produced** (the plan's to begin with).
 *    Anything else is somebody else's edit to the neuron mid-batch: **stop**.
 *  - the candidate's must map to **its reviewed root**. If it maps to the neuron's root, it is in
 *    the neuron already (an earlier merge brought it, or somebody else): recorded, nothing sent.
 *    Anything else is an edit to the piece since the plan: that one is not sent, the rest go on.
 *
 * After a merge the server says was made, the same read checks both supervoxels are under its new
 * root: a graph flagged read-only answers success without keeping anything (phase 2).
 *
 * **The first failure stops the batch** (user, 2026-11-15): a refusal, a read that fails, a reply
 * that was lost. A lost reply may still have merged, so the roots are read once more to say which,
 * and an answer that does not settle it is recorded as `unknown`. Nothing is sent after a failure
 * until the reader presses Submit again, which plans afresh.
 *
 * What the per-merge check does not close: the moment between it and the server taking its lock.
 * No client closes that; Spelunker's check is the same.
 */

import { errorMessage } from '../../core/errors'
import type { ConfirmedMerge, EditOutcome, WriteOptions } from '../../data/cave/edits'
import { confirmMerge, mergeSupervoxels, requestOptionsOf } from '../../data/cave/edits'
import type { GrapheneSource } from '../../data/cave/graphene'
import { supervoxelRoots } from '../../data/cave/rootIds'
import type { PlannedMerge, ReadyPlan } from './mergePlan'
import type { EntryOutcome, MergeProgress, MergeRecordEntry } from './mergeRecord'
import { sharedNewRoot } from './mergeRecord'

/** How a batch ended. */
export interface BatchResult {
  /** `done`: every merge was decided. `stopped`: the reader stopped it. `failed`: a failure did. */
  readonly state: 'done' | 'stopped' | 'failed'
  /** The neuron's root at the end. */
  readonly currentRoot: string
  /** What stopped it, where something did. */
  readonly message?: string | undefined
}

/** What the batch tells its caller as it goes. */
export interface BatchCallbacks {
  progress(candidateRoot: string, progress: MergeProgress): void
  /** One decision, to keep. Called before the next merge is checked. */
  record(entry: MergeRecordEntry): void
  /** Asked before each merge: true stops the batch there, before anything more is sent. */
  stopRequested(): boolean
}

/** What the batch asks of the servers, apart so the logic can be tested without one. */
export interface BatchServices {
  /** Each supervoxel's root at the server's now, in order. */
  roots(graphene: GrapheneSource, supervoxels: readonly string[]): Promise<string[]>
  send(merge: ConfirmedMerge): Promise<EditOutcome>
  /** How long a send may go unanswered (`SEND_TIMEOUT_MS`); tests make it short. */
  sendTimeoutMs?: number
}

/**
 * How long a root read may take before it is given up: a read changes nothing, so stopping one is
 * safe, and a check that never answers must not hold the card and the overlay for good.
 */
export const READ_TIMEOUT_MS = 60_000

/**
 * How long a merge may go unanswered before the batch stops waiting. **The request is not
 * cancelled** — that would only throw away the answer — and the merge is read as `unknown`: the
 * roots are asked, and it is never sent again. Long, since a merge with its remesh is slow.
 */
export const SEND_TIMEOUT_MS = 120_000

function liveServices(options: WriteOptions): BatchServices {
  // The reads go as the writes do — not quiet — with a time limit of their own (`READ_TIMEOUT_MS`).
  const readAs = requestOptionsOf(options)
  return {
    roots: (graphene, supervoxels) =>
      supervoxelRoots(graphene, supervoxels, 'server', {
        ...readAs,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }),
    send: (merge) => mergeSupervoxels(merge, options),
  }
}

/** A batch ready to run: its merges confirmed, nothing sent yet. */
export interface Batch {
  /**
   * Make the merges, one at a time, and say what became of each. Runs once. Every failure is a
   * `BatchResult` and a recorded entry; it rejects only where a callback throws.
   */
  run(on: BatchCallbacks): Promise<BatchResult>
}

/**
 * Confirm the reader's merges: the step the Merge button takes. **Synchronous, and the only
 * place a batch can be refused before it starts** — merges that are not this plan's, one listed
 * twice, anything `confirmMerge` refuses — so a throw here means nothing was sent, and nothing
 * after it can be mistaken for that.
 */
export function prepareMerges(
  plan: ReadyPlan,
  merges: readonly PlannedMerge[],
  options: WriteOptions,
  services: BatchServices = liveServices(options),
): Batch {
  const planned = new Set(plan.merges)
  const seen = new Set<string>()
  for (const merge of merges) {
    if (!planned.has(merge)) {
      throw new Error(`The merge of ${merge.candidateRoot} is not one this plan made.`)
    }
    if (seen.has(merge.candidateRoot)) {
      throw new Error(`${merge.candidateRoot} is listed twice.`)
    }
    seen.add(merge.candidateRoot)
  }
  /*
   * Everything the run reads, taken now: the confirmations are frozen copies, and the rest is
   * copied out of the plan, so a caller that changes its objects after Merge (a Re-check reusing
   * them) cannot make the check, the request and the record disagree.
   */
  const steps: Step[] = merges.map((merge) => ({
    candidateRoot: merge.candidateRoot,
    endUid: merge.used.endUid,
    sending: confirmMerge(plan.graphene, merge.neuron, merge.candidate),
  }))
  const { reviewedRoot, currentRoot } = plan
  let ran = false
  return {
    run: (on) => {
      if (ran) return Promise.reject(new Error('A batch runs once.'))
      ran = true
      return runMerges(reviewedRoot, currentRoot, steps, on, services)
    },
  }
}

/** One merge as the run reads it: nothing in it is the caller's. */
interface Step {
  readonly candidateRoot: string
  readonly endUid: number
  readonly sending: ConfirmedMerge
}

async function runMerges(
  reviewedRoot: string,
  currentRoot: string,
  steps: readonly Step[],
  on: BatchCallbacks,
  services: BatchServices,
): Promise<BatchResult> {
  for (const step of steps) on.progress(step.candidateRoot, { state: 'waiting' })

  let expected = currentRoot
  const endWith = (state: 'stopped' | 'failed', from: number, message: string): BatchResult => {
    for (const step of steps.slice(from)) {
      on.progress(step.candidateRoot, { state: 'not-sent', message })
    }
    return { state, currentRoot: expected, message }
  }

  for (const [i, { candidateRoot: id, endUid, sending }] of steps.entries()) {
    if (on.stopRequested()) return endWith('stopped', i, 'Stopped before this merge.')
    // Reads go to the table the write goes to: the confirmation's own, frozen.
    const graphene = sending.graphene
    const ends = [sending.neuron.supervoxel, sending.candidate.supervoxel]
    // The root this merge is checked against and made into; `expected` moves on once it is made.
    const neuronRoot = expected
    const keep = (decided: Decided) => {
      const entry: MergeRecordEntry = {
        reviewedRoot,
        candidateRoot: id,
        endUid,
        neuronRoot,
        neuron: sending.neuron,
        candidate: sending.candidate,
        at: new Date().toISOString(),
        ...decided,
      }
      on.record(entry)
      on.progress(id, { state: entry.outcome, message: entry.message })
    }
    const failWith = (decided: Decided & { message: string }) => {
      keep(decided)
      return endWith('failed', i + 1, `${id}: ${decided.message} Nothing more is sent.`)
    }

    on.progress(id, { state: 'sending', message: 'Checking the roots' })
    const before = await rootsOrError(services, graphene, ends)
    if (!Array.isArray(before)) {
      // Nothing was decided about this merge, so nothing is recorded.
      return endWith('failed', i, `The check before merging ${id} failed: ${before}`)
    }
    const [neuronNow, pieceNow] = before
    if (neuronNow !== neuronRoot) {
      return failWith({
        outcome: 'not-sent',
        message: `The neuron is now ${neuronNow}, not ${neuronRoot}: somebody else edited it.`,
      })
    }
    if (pieceNow === neuronRoot) {
      keep({ outcome: 'already-merged', message: 'Part of the neuron already; nothing sent.' })
      continue
    }
    if (pieceNow !== id) {
      keep({
        outcome: 'not-sent',
        message: `The piece is now ${pieceNow}: it was edited since the check. Not sent.`,
      })
      continue
    }

    on.progress(id, { state: 'sending', message: 'Merging' })
    const outcome = await sendOnce(services, sending, services.sendTimeoutMs ?? SEND_TIMEOUT_MS)

    if (outcome.kind === 'refused') {
      return failWith({
        outcome: 'failed',
        status: outcome.status,
        message: `Refused (${outcome.status}): ${outcome.message}`,
      })
    }

    const after = await rootsOrError(services, graphene, ends)

    if (outcome.kind === 'done') {
      const newRoot = outcome.newRootIds[0]!
      // Made on the server's word: the neuron's root is the new one, whatever the check finds.
      expected = newRoot
      const made = { outcome: 'merged', newRoot, operationId: outcome.operationId } as const
      if (Array.isArray(after) && after[0] === newRoot && after[1] === newRoot) {
        keep(made)
        continue
      }
      return failWith({
        ...made,
        message:
          `The server answered merged (operation ${outcome.operationId}, root ${newRoot}), ` +
          `but ${rootsSaid(after)}`,
      })
    }

    /*
     * No answer that says what happened: the roots say what they can. Both under one new root is
     * a merge. **Anything else stays `unknown`** — roots that have not moved included: a reply lost
     * to a proxy's timeout can come back while the server is still writing, and the merge lands
     * after this read. Only the server's own refusal is `failed`. The next plan settles it
     * (`mergePlan.ts`), asking the roots again.
     */
    const lost = `The reply was lost (${outcome.message})`
    const made = Array.isArray(after) ? sharedNewRoot(after, neuronRoot) : undefined
    if (made !== undefined) {
      expected = made
      return failWith({
        outcome: 'merged',
        newRoot: made,
        message: `${lost}; the roots show the merge was made.`,
      })
    }
    const unmoved = Array.isArray(after) && after[0] === neuronRoot && after[1] === id
    return failWith({
      outcome: 'unknown',
      message: unmoved
        ? `${lost}; the roots had not moved when read, but a merge can land after its reply is lost.`
        : `${lost}, and ${rootsSaid(after)}`,
    })
  }
  return { state: 'done', currentRoot: expected }
}

/** What a read after a send found, as the end of a sentence. */
function rootsSaid(after: string[] | string): string {
  return Array.isArray(after)
    ? `the supervoxels are under ${after.join(' and ')}.`
    : `the roots could not be read: ${after}`
}

/**
 * Send one merge. A throw is read as `unknown`, never as "not sent": the writer throws only before
 * sending, but a caller cannot tell that from outside, and the safe reading is the one that
 * re-reads the roots. So is no answer within `waitMs` (`SEND_TIMEOUT_MS`): the batch stops
 * waiting, and the request is left to finish or fail on its own.
 */
async function sendOnce(
  services: BatchServices,
  merge: ConfirmedMerge,
  waitMs: number,
): Promise<EditOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unanswered = new Promise<EditOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          kind: 'unknown',
          message: `no answer after ${Math.round(waitMs / 1000)} s; it may still be made`,
        }),
      waitMs,
    )
  })
  try {
    return await Promise.race([services.send(merge), unanswered])
  } catch (error) {
    return { kind: 'unknown', message: errorMessage(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** What the batch decides about one merge; `keep` adds the merge it was decided about. */
type Decided = EntryOutcome & { readonly message?: string | undefined }

/**
 * Both ends' roots, or why they could not be read — never a throw. **One root per supervoxel or it
 * is no answer**: `rootsAtInstant` holds the live read to that already, and it is asked again here
 * because a short list read as two `undefined`s would equal each other, and a lost reply would be
 * recorded as merged into no root at all.
 */
async function rootsOrError(
  services: BatchServices,
  graphene: GrapheneSource,
  ends: readonly string[],
): Promise<string[] | string> {
  try {
    const roots = await services.roots(graphene, ends)
    return roots.length === ends.length
      ? roots
      : `the root lookup answered ${roots.length} of ${ends.length} supervoxels.`
  } catch (error) {
    return errorMessage(error)
  }
}
