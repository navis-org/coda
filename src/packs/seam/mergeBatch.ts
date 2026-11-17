/**
 * The batch behind Submit's Merge button (`docs/seam-merge-plan.md`, phase 5). **This writes to a
 * shared segmentation.** It is one of the modules `importGraph.test.ts` allows to import the
 * writer (`MAY_WRITE`), and its own importers are held to a list there too, so nothing reached
 * from an `evaluate`, the assistant or the MCP server can start a batch.
 *
 * One merge at a time, in the plan's order — from the neuron outwards; `prepareMerges` refuses a
 * list that puts a piece before the one it is made onto — with no pause between and none
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
 * **A merge made onto a piece that is not in the neuron yet** (a neuron grown piece by piece:
 * `PlannedMerge.needs`, the piece its neuron end is on, and `parent`, the piece it was accepted
 * as a continuation of) is sent only once those pieces' own merges have landed in this batch. It was confirmed after it, so by then the end *is* under the root the batch last made
 * and the check above holds as it stands. Where that piece did not land — it had been edited, say
 * — the merge is `not-sent` in those words and the batch goes on: it is not "somebody else edited
 * the neuron", which is what the unmoved end would otherwise read as.
 *
 * After a merge the server says was made, the same read checks both supervoxels are under its new
 * root: a graph flagged read-only answers success without keeping anything (phase 2).
 *
 * **The first failure stops the batch** (user, 2026-11-15): a refusal, a read that fails, a reply
 * that was lost. A lost reply may still have merged; it is recorded as `unknown`, whatever the
 * roots read straight after show, and the next plan settles it (`mergePlan.ts`' `settle`) — one
 * rule in one place, which also tells this merge from somebody else's edit landing in the same
 * seconds (audit of 77c0625, 2026-11-16). A send that is merely slow is handed to the caller
 * still out (`BatchCallbacks.stillOut`): its answer, when it comes, is recorded, and Submit waits
 * for it. Nothing is sent after a failure until the reader presses Submit again, which plans
 * afresh.
 *
 * What the per-merge check does not close: the moment between it and the server taking its lock.
 * No client closes that; Spelunker's check is the same.
 */

import { errorMessage } from '../../core/errors'
import type { ConfirmedMerge, EditOutcome, WriteOptions } from '../../data/cave/edits'
import { confirmMerge, mergeSupervoxels, requestOptionsOf } from '../../data/cave/edits'
import type { GrapheneSource } from '../../data/cave/graphene'
import { isNodeId, layerOf } from '../../data/cave/graphLayout'
import { supervoxelRoots } from '../../data/cave/rootIds'
import type { PlannedMerge, ReadyPlan } from './mergePlan'
import { waitsFor } from './mergePlan'
import type {
  EntryBase,
  EntryOutcome,
  MergeProgress,
  MergeRecordEntry,
  RecordScope,
} from './mergeRecord'

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
  /**
   * A merge the batch stopped waiting for (`SEND_TIMEOUT_MS`), recorded `unknown` already, whose
   * request is still out. `answer` is the entry to append once the server answers — `merged` or
   * `failed` — or undefined where the answer says nothing either. Called once, as soon as the
   * send is given up on, before anything that could throw: Submit must be held even where the
   * batch then fails.
   */
  stillOut(answer: Promise<MergeRecordEntry | undefined>): void
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
 * cancelled** — that would only throw away the answer — and the merge is read as `unknown`; the
 * caller is handed the request (`stillOut`) and holds Submit until it answers, so the same pair is
 * not planned and sent again meanwhile. Long, since a merge with its remesh is slow.
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
 * twice, an end that is not a supervoxel, anything `confirmMerge` refuses — so a throw here means
 * nothing was sent, and nothing after it can be mistaken for that.
 *
 * **Every end must be a supervoxel** (layer 1 of the plan's `layout`), checked here, beside the
 * writer, rather than trusted to the anchors two modules away. The per-merge check — "this
 * supervoxel is under this root now" — only means something for one: the server maps an id
 * already at the root layer to itself, retired or not, and looks a higher layer's supervoxel up
 * at that id's creation time (pychunkedgraph 2.20.0), which merges an outdated root silently.
 */
export function prepareMerges(
  plan: ReadyPlan,
  merges: readonly PlannedMerge[],
  options: WriteOptions,
  services: BatchServices = liveServices(options),
): Batch {
  const planned = new Set(plan.merges)
  const seen = new Set<string>()
  const { layout } = plan
  if (merges.length > 0 && !layout) {
    throw new Error(
      'The plan carries no id layout, so its ends cannot be checked as supervoxels.',
    )
  }
  for (const merge of merges) {
    for (const { supervoxel } of [merge.neuron, merge.candidate]) {
      const layer = isNodeId(supervoxel) ? layerOf(layout!, BigInt(supervoxel)) : undefined
      if (layer !== 1) {
        throw new Error(
          `${supervoxel} is not a supervoxel${layer === undefined ? '' : ` (layer ${layer})`}.`,
        )
      }
    }
    if (!planned.has(merge)) {
      throw new Error(`The merge of ${merge.candidateRoot} is not one this plan made.`)
    }
    if (seen.has(merge.candidateRoot)) {
      throw new Error(`${merge.candidateRoot} is listed twice.`)
    }
    // What it waits for has to be merged first, so it has to be here, and earlier.
    for (const first of waitsFor(merge)) {
      if (seen.has(first)) continue
      throw new Error(
        `The merge of ${merge.candidateRoot} is made onto ${first}, which is not merged before it.`,
      )
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
    waitsFor: waitsFor(merge),
    parentRoot: merge.used.neuronId === plan.reviewedRoot ? undefined : merge.used.neuronId,
    sending: confirmMerge(plan.graphene, merge.neuron, merge.candidate),
  }))
  const about: About = {
    deployment: options.deployment,
    datastack: plan.datastack,
    reviewedRoot: plan.reviewedRoot,
  }
  const { currentRoot } = plan
  let ran = false
  return {
    run: (on) => {
      if (ran) return Promise.reject(new Error('A batch runs once.'))
      ran = true
      return runMerges(about, currentRoot, steps, on, services)
    },
  }
}

/** What every entry of one batch says alike: where it was made, and about which neuron. */
type About = RecordScope & { readonly reviewedRoot: string }

/** One merge as the run reads it: nothing in it is the caller's. */
interface Step {
  readonly candidateRoot: string
  readonly endUid: number
  /** The pieces of this batch that have to be in the neuron first (`waitsFor`). */
  readonly waitsFor: readonly string[]
  /** The piece it was accepted on, for the record; absent where that is the neuron itself. */
  readonly parentRoot: string | undefined
  readonly sending: ConfirmedMerge
}

async function runMerges(
  about: About,
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

  /** The pieces this batch has put in the neuron, or found there already. */
  const landed = new Set<string>()
  for (const [
    i,
    { candidateRoot: id, endUid, waitsFor: firsts, parentRoot, sending },
  ] of steps.entries()) {
    if (on.stopRequested()) return endWith('stopped', i, 'Stopped before this merge.')
    // Reads go to the table the write goes to: the confirmation's own, frozen.
    const graphene = sending.graphene
    const ends = [sending.neuron.supervoxel, sending.candidate.supervoxel]
    // The root this merge is checked against and made into; `expected` moves on once it is made.
    const neuronRoot = expected
    const base: Base = {
      ...about,
      candidateRoot: id,
      endUid,
      ...(parentRoot === undefined ? {} : { parentRoot }),
      neuronRoot,
      neuron: sending.neuron,
      candidate: sending.candidate,
    }
    const keep = (decided: Decided) => {
      const entry = entryAt(base, decided)
      on.record(entry)
      on.progress(id, { state: entry.outcome, message: entry.message })
    }
    const failWith = (decided: Decided & { message: string }) => {
      keep(decided)
      return endWith('failed', i + 1, `${id}: ${decided.message} Nothing more is sent.`)
    }

    /*
     * A piece it waits for did not make it into the neuron: nothing to merge it onto, or no
     * reason left to. Said as that, before any read — where its end is on that piece, the end
     * is still under the piece's own root, and the check below would call it somebody else's
     * edit to the neuron and stop the batch.
     */
    const missing = firsts.find((first) => !landed.has(first))
    if (missing !== undefined) {
      keep({
        outcome: 'not-sent',
        message: `${missing}, the piece this one is merged onto, was not merged. Not sent.`,
      })
      continue
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
      landed.add(id)
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
    const { outcome, late } = await sendOnce(
      services,
      sending,
      services.sendTimeoutMs ?? SEND_TIMEOUT_MS,
    )
    if (late) on.stillOut(lateEntry(base, late))

    if (outcome.kind === 'refused') {
      return failWith({
        outcome: 'failed',
        status: outcome.status,
        message: `Refused (${outcome.status}): ${outcome.message}`,
      })
    }

    const after = await rootsOrError(services, graphene, ends)

    const unmoved = Array.isArray(after) && after[0] === neuronRoot && after[1] === id

    if (outcome.kind === 'done') {
      const newRoot = outcome.newRootIds[0]!
      const said = `The server answered merged (operation ${outcome.operationId}, root ${newRoot})`
      if (Array.isArray(after) && after[0] === newRoot && after[1] === newRoot) {
        expected = newRoot
        keep({ outcome: 'merged', newRoot, operationId: outcome.operationId })
        landed.add(id)
        continue
      }
      /*
       * Both ends read fine and still under their old roots: what a graph flagged read-only does
       * (it answers success and keeps nothing), so the server's word is not taken — `unknown`,
       * for the next plan to settle from the roots.
       */
      if (unmoved) {
        return failWith({
          outcome: 'unknown',
          operationId: outcome.operationId,
          message: `${said}, but both supervoxels are still under their old roots.`,
        })
      }
      // Otherwise made on the server's word: the neuron's root is the new one.
      expected = newRoot
      return failWith({
        outcome: 'merged',
        newRoot,
        operationId: outcome.operationId,
        message: `${said}, but ${rootsSaid(after)}`,
      })
    }

    /*
     * No answer that says what happened. **Always `unknown`**, whatever the roots show: both ends
     * under one new root may be this merge, or somebody else's edit landing in the same seconds,
     * and only the next plan's `settle` tells the two apart (`mergePlan.ts`). Roots that have not
     * moved say nothing either: a reply lost to a proxy's timeout can come back while the server
     * is still writing. Only the server's own refusal is `failed`.
     */
    const lost = `The reply was lost (${outcome.message})`
    return failWith({
      outcome: 'unknown',
      message: unmoved
        ? `${lost}; the roots had not moved when read, but a merge can land after its reply is lost.`
        : `${lost}, and ${rootsSaid(after)} The next Submit checks whether that was this merge.`,
    })
  }
  return { state: 'done', currentRoot: expected }
}

/** An entry's merge, apart from when it was decided and what became of it. */
type Base = Omit<EntryBase, 'at' | 'message'>

function entryAt(base: Base, decided: Decided): MergeRecordEntry {
  return { ...base, at: new Date().toISOString(), ...decided }
}

/**
 * The entry a late answer makes — `merged` with its operation id, `failed` with its status — or
 * undefined for one that says nothing either way. Out here, so what waits on the request keeps
 * `base` alone alive, never the batch's scope: the request may never answer.
 */
function lateEntry(
  base: Base,
  late: Promise<EditOutcome>,
): Promise<MergeRecordEntry | undefined> {
  const after = ' — answered after the batch had stopped waiting.'
  return late.then((answer) => {
    if (answer.kind === 'done') {
      return entryAt(base, {
        outcome: 'merged',
        newRoot: answer.newRootIds[0]!,
        operationId: answer.operationId,
        message: `Merged${after}`,
      })
    }
    if (answer.kind === 'refused') {
      return entryAt(base, {
        outcome: 'failed',
        status: answer.status,
        message: `Refused (${answer.status}): ${answer.message}${after}`,
      })
    }
    return undefined
  })
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
 * waiting, and the request — left to finish or fail on its own — comes back as `late`.
 */
async function sendOnce(
  services: BatchServices,
  merge: ConfirmedMerge,
  waitMs: number,
): Promise<{ outcome: EditOutcome; late?: Promise<EditOutcome> }> {
  // In an async function, so a send that throws before returning is a rejection like any other.
  const sent = (async () => services.send(merge))().catch((error: unknown): EditOutcome => ({
    kind: 'unknown',
    message: errorMessage(error),
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const unanswered = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs)
  })
  try {
    const outcome = await Promise.race([sent, unanswered])
    if (outcome) return { outcome }
    return {
      outcome: {
        kind: 'unknown',
        message: `no answer after ${Math.round(waitMs / 1000)} s; it may still be made`,
      },
      late: sent,
    }
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
