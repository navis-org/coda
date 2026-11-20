/**
 * The batch behind Submit's Merge button (`docs/seam-merge-plan.md`, phase 5). **This writes to a
 * shared segmentation.** It is one of the modules `importGraph.test.ts` allows to import the
 * writer (`MAY_WRITE`), and its own importers are held to a list there too, so nothing reached
 * from an `evaluate`, the assistant or the MCP server can start a batch.
 *
 * **From the tips in, up to `MERGES_IN_FLIGHT` at once** (user, 2026-11-20; it was one at a time
 * from the neuron outwards before), none retried (user, 2026-11-15). A neuron grown piece by piece
 * is a tree of merges, and a merge onto a piece that is not in the neuron yet joins the two short
 * of it: different branches go side by side, and only the merges onto the neuron itself, each
 * moving its root, wait for each other. **No root is in two merges at once** — the server locks a
 * root while it edits, and a merge sent onto a root already being edited is refused — so the run
 * keeps which root each piece is under (the record's `Groups`) and which are out. The farthest
 * from the neuron go first, which brings the batch of 244 measured on 2026-11-20 from 244 rounds
 * to 66.
 *
 * Before each merge, its two supervoxels are mapped to their roots **at the server's now** —
 * never a client instant, which could be behind the server's clock and see the roots from before
 * this batch's last merge:
 *
 *  - the neuron end's must map to **the root this batch has that side under**: the neuron's (the
 *    plan's to begin with, then the last merge's into it), or that of the pieces it was joined to
 *    short of it. Anything else is somebody else's edit: to the neuron, **stop**; to those
 *    pieces, that merge is not sent and the rest go on.
 *  - the candidate's must map to **its piece's root** (its own, or that of the pieces merged onto
 *    it before, `PlannedMerge.pieceRoot`). If it maps to the other side's root, it is part of it
 *    already: recorded, nothing sent. Anything else is an edit to the piece since the plan: that
 *    one is not sent, the rest go on.
 *
 * **A merge whose end lies on a piece further in than the one it continues** (`PlannedMerge.needs`
 * beside `parent`) waits until that one has joined what its end is on, or the piece would be in
 * without the piece the reader accepted it as continuing. Where that never happens — the piece
 * was edited, say — the merge is `not-sent` in those words and the batch goes on.
 *
 * A stopped or failed batch can leave pieces joined to each other and not to the neuron. Each
 * merge is recorded with the two roots it was checked against (`neuronRoot`, `candidateRootAt`),
 * so the record says so (`MergedSoFar.joined`), and the next plan merges each group whole.
 *
 * After a merge the server says was made, the same read checks both supervoxels are under its new
 * root: a graph flagged read-only answers success without keeping anything (phase 2).
 *
 * **The first failure stops the batch** (user, 2026-11-15): a refusal, a read that fails, a reply
 * that was lost. Nothing more is started; the merges already out are waited for and recorded. A lost reply may still have merged; it is recorded as `unknown`, whatever the
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
import { Groups } from './mergeRecord'

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
  /**
   * One decision, to keep, as soon as it is made — merges out at once land in any order — with
   * the neuron's root after it (a merge onto pieces short of the neuron does not move it) and the
   * pieces this decision took into the neuron: its own, and any joined to it before.
   */
  record(entry: MergeRecordEntry, neuronRoot: string, intoNeuron: readonly string[]): void
  /**
   * Asked before each merge is started: true stops the batch there. Nothing more is sent, and the
   * merges already out are waited for.
   */
  stopRequested(): boolean
  /**
   * A merge the batch stopped waiting for (`SEND_TIMEOUT_MS`), recorded `unknown` already, whose
   * request is still out. `answer` is the entry to append once the server answers — `merged` or
   * `failed` — or undefined where the answer says nothing either. Called once, as soon as the
   * send is given up on, before anything that could throw: Submit must be held even where the
   * batch then fails.
   */
  stillOut(answer: Promise<MergeRecordEntry | undefined>, intoNeuron: boolean): void
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
   * Make the merges, several at once, and say what became of each. Runs once. Every failure is a
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
    parentRoot: merge.used.neuronId === plan.reviewedRoot ? undefined : merge.used.neuronId,
    onto: merge.needs,
    parent: merge.parent,
    pieceRoot: merge.pieceRoot ?? merge.candidateRoot,
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
  /** The piece it was accepted on, for the record; absent where that is the neuron itself. */
  readonly parentRoot: string | undefined
  /** The merge of this batch whose piece its neuron end is on (`PlannedMerge.needs`); else the neuron. */
  readonly onto: string | undefined
  /** The merge of this batch whose piece it continues (`PlannedMerge.parent`); else the neuron. */
  readonly parent: string | undefined
  /** Its piece's root when planned: its own, or that of pieces merged onto it already. */
  readonly pieceRoot: string
  readonly sending: ConfirmedMerge
}

/**
 * How many merges are out at once, at most (user, 2026-11-20): a batch of 244 merges in a tree 11
 * deep, 41 of them onto the neuron itself, replayed takes 66 rounds at eight against 244 one at a
 * time, and 41 with no cap (`docs/seam-merge-plan.md`). Eight is under Spelunker's twenty, every
 * merge going to the shared fast remesh queue.
 */
export const MERGES_IN_FLIGHT = 8

async function runMerges(
  about: About,
  currentRoot: string,
  steps: readonly Step[],
  on: BatchCallbacks,
  services: BatchServices,
): Promise<BatchResult> {
  for (const step of steps) on.progress(step.candidateRoot, { state: 'waiting' })

  /*
   * Which root each piece is under, by the record this run writes (`Groups`, replaying each entry
   * as it is kept), and which roots a merge is out on. The neuron's group is keyed by the reviewed
   * root: a piece is never the neuron.
   */
  const neuronKey = about.reviewedRoot
  const groups = new Groups()
  groups.seed(neuronKey, currentRoot)
  for (const step of steps) groups.seed(step.candidateRoot, step.pieceRoot)
  const busy = new Set<string>()
  const neuronRoot = () => groups.find(neuronKey)
  /** The pieces merged onto pieces not in the neuron yet: `merged` once their group is. */
  const joinedShort = new Set<string>()

  const keep = (step: Step, entry: MergeRecordEntry) => {
    groups.replay(entry)
    const id = step.candidateRoot
    const landed = entry.outcome === 'merged' || entry.outcome === 'already-merged'
    const inNeuron = landed && groups.find(id) === neuronRoot()
    // A group that reached the neuron takes every piece joined in it there too.
    const along =
      inNeuron && joinedShort.size > 0
        ? groups.members(neuronKey).filter((member) => joinedShort.delete(member))
        : []
    on.record(entry, neuronRoot(), inNeuron ? [id, ...along] : [])
    if (!landed || inNeuron) {
      on.progress(id, { state: entry.outcome, message: entry.message })
    } else {
      joinedShort.add(id)
      on.progress(id, {
        state: 'joined',
        message: `Merged onto ${step.onto}; it goes into the neuron with it.`,
      })
    }
    for (const member of along) {
      on.progress(member, {
        state: 'merged',
        message: 'In the neuron with the piece it joined.',
      })
    }
  }

  /*
   * **From the tips in**: the farthest from the neuron first, then in the plan's order. A merge
   * onto a piece not in the neuron yet joins the two short of it, so different branches go side
   * by side, and only the neuron's own merges, each moving its root, have to wait for each other.
   * `prepareMerges` has every piece after the one it continues, so one pass gives the depths.
   */
  const depth = new Map<string, number>()
  for (const step of steps) {
    depth.set(step.candidateRoot, step.parent === undefined ? 0 : depth.get(step.parent)! + 1)
  }
  const pending = steps
    .map((step, at) => ({ step, at }))
    .sort(
      (a, b) =>
        depth.get(b.step.candidateRoot)! - depth.get(a.step.candidateRoot)! || a.at - b.at,
    )
    .map(({ step }) => step)

  let ended: { state: 'stopped' | 'failed'; message: string } | undefined
  /** A callback's throw: the batch rejects with it once nothing is out. */
  let thrown: { error: unknown } | undefined
  /** A send failed: nothing more is started, though its decision is still to come. */
  let halted = false
  const out = new Set<Promise<void>>()
  /*
   * A merge goes when both roots it is made on are free, and **the piece it continues is part of
   * what its end is on**: where its end lies on a piece further in than that one, that one goes
   * first, or the piece would be in without the piece the reader accepted it as continuing.
   */
  const startIfReady = (step: Step): boolean => {
    const onto = groups.find(step.onto ?? neuronKey)
    const piece = groups.find(step.candidateRoot)
    if (busy.has(onto) || busy.has(piece)) return false
    if (groups.find(step.parent ?? neuronKey) !== onto) return false
    busy.add(onto).add(piece)
    const merge = {
      step,
      ontoRoot: onto,
      pieceRoot: piece,
      intoNeuron: onto === neuronRoot(),
      // A send that did not plainly land stops any more being started, before its check after.
      halt: () => (halted = true),
    }
    const done = mergeOne(about, merge, (entry) => keep(step, entry), on, services).then(
      (failed) => {
        busy.delete(onto)
        busy.delete(piece)
        // A failure is said over a stop: the reader has to hear of a merge refused or lost.
        if (failed !== undefined && ended?.state !== 'failed') {
          ended = { state: 'failed', message: failed }
        }
      },
    )
    /*
     * A callback that throws (the record's hold, say) ends the batch, **once the merges still out
     * have answered**: rejected at once, the caller would let go of the card while they land, and
     * their entries, and any still out, would be lost.
     */
    const held = done
      .catch((error: unknown) => {
        busy.delete(onto)
        busy.delete(piece)
        thrown ??= { error }
      })
      .finally(() => out.delete(held))
    out.add(held)
    return true
  }

  for (;;) {
    // Asked once a pass, so a stop while every merge left is waiting is still a stop.
    try {
      if (!ended && !thrown && pending.length > 0 && on.stopRequested()) {
        ended = { state: 'stopped', message: 'Stopped before this merge.' }
      }
    } catch (error) {
      thrown ??= { error }
    }
    for (
      let at = 0;
      !ended && !thrown && !halted && at < pending.length && out.size < MERGES_IN_FLIGHT;
    ) {
      if (startIfReady(pending[at]!)) pending.splice(at, 1)
      else at += 1
    }
    if (out.size === 0) break
    await Promise.race(out)
  }
  if (thrown) throw thrown.error

  if (ended) {
    const message =
      ended.state === 'stopped' ? ended.message : `${ended.message} Nothing more is sent.`
    for (const step of pending) on.progress(step.candidateRoot, { state: 'not-sent', message })
    return { state: ended.state, currentRoot: neuronRoot(), message: ended.message }
  }
  /*
   * What is left waits for a piece that never joined what its end is on: nothing to merge it onto,
   * or no reason left to. Said as that — where its end is on that piece, the end is still under
   * the piece's own root, and the check would call it somebody else's edit.
   */
  for (const step of pending) {
    // At the roots its ends are under now: pieces further out may have joined this one.
    const onto = groups.find(step.onto ?? neuronKey)
    const base = baseOf(about, step, onto, groups.find(step.candidateRoot))
    keep(
      step,
      entryAt(base, {
        outcome: 'not-sent',
        message: `${step.parent ?? step.onto}, the piece this one is merged onto, was not merged. Not sent.`,
      }),
    )
  }
  return { state: 'done', currentRoot: neuronRoot() }
}

/** The entry `base` a merge is recorded with, its ends checked against these two roots. */
function baseOf(about: About, step: Step, ontoRoot: string, pieceRoot: string): Base {
  const { candidateRoot: id, endUid, parentRoot, sending } = step
  return {
    ...about,
    candidateRoot: id,
    endUid,
    ...(parentRoot === undefined ? {} : { parentRoot }),
    neuronRoot: ontoRoot,
    ...(pieceRoot === id ? {} : { candidateRootAt: pieceRoot }),
    neuron: sending.neuron,
    candidate: sending.candidate,
  }
}

/** A merge as the run hands it out: the roots its two ends are under, held for it. */
interface Started {
  readonly step: Step
  readonly ontoRoot: string
  readonly pieceRoot: string
  /** `ontoRoot` is the neuron's: somebody else's edit to it stops the batch. */
  readonly intoNeuron: boolean
  /** Starts nothing more, at once: a send that did not plainly land. */
  readonly halt: () => void
}

/**
 * One merge, from its check to the check after it (the header): each decision handed to `keep`.
 * Undefined where the batch may go on, else why it stops.
 */
async function mergeOne(
  about: About,
  { step, ontoRoot, pieceRoot, intoNeuron, halt }: Started,
  keep: (entry: MergeRecordEntry) => void,
  on: BatchCallbacks,
  services: BatchServices,
): Promise<string | undefined> {
  const { candidateRoot: id, sending } = step
  // Reads go to the table the write goes to: the confirmation's own, frozen.
  const graphene = sending.graphene
  const ends = [sending.neuron.supervoxel, sending.candidate.supervoxel]
  const base = baseOf(about, step, ontoRoot, pieceRoot)
  const decide = (decided: Decided) => keep(entryAt(base, decided))
  const stopWith = (decided: Decided & { message: string }): string => {
    decide(decided)
    return `${id}: ${decided.message}`
  }

  on.progress(id, { state: 'sending', message: 'Checking the roots' })
  const before = await rootsOrError(services, graphene, ends)
  if (!Array.isArray(before)) {
    // Nothing was decided about this merge, so nothing is recorded.
    const message = `The check before merging ${id} failed: ${before}`
    on.progress(id, { state: 'not-sent', message })
    return message
  }
  const [ontoNow, pieceNow] = before
  if (ontoNow !== ontoRoot) {
    if (intoNeuron) {
      return stopWith({
        outcome: 'not-sent',
        message: `The neuron is now ${ontoNow}, not ${ontoRoot}: somebody else edited it.`,
      })
    }
    decide({
      outcome: 'not-sent',
      message: `The pieces it is merged onto are now ${ontoNow}, not ${ontoRoot}: somebody else edited them. Not sent.`,
    })
    return undefined
  }
  if (pieceNow === ontoRoot) {
    decide({ outcome: 'already-merged', message: 'Part of it already; nothing sent.' })
    return undefined
  }
  if (pieceNow !== pieceRoot) {
    decide({
      outcome: 'not-sent',
      message: `The piece is now ${pieceNow}: it was edited since the check. Not sent.`,
    })
    return undefined
  }

  on.progress(id, { state: 'sending', message: 'Merging' })
  const { outcome, late } = await sendOnce(
    services,
    sending,
    services.sendTimeoutMs ?? SEND_TIMEOUT_MS,
  )
  if (late) on.stillOut(lateEntry(base, late), intoNeuron)
  if (outcome.kind !== 'done') halt()

  if (outcome.kind === 'refused') {
    return stopWith({
      outcome: 'failed',
      status: outcome.status,
      message: `Refused (${outcome.status}): ${outcome.message}`,
    })
  }

  const after = await rootsOrError(services, graphene, ends)

  const unmoved = Array.isArray(after) && after[0] === ontoRoot && after[1] === pieceRoot

  if (outcome.kind === 'done') {
    const newRoot = outcome.newRootIds[0]!
    const said = `The server answered merged (operation ${outcome.operationId}, root ${newRoot})`
    if (Array.isArray(after) && after[0] === newRoot && after[1] === newRoot) {
      decide({ outcome: 'merged', newRoot, operationId: outcome.operationId })
      return undefined
    }
    /*
     * Both ends read fine and still under their old roots: what a graph flagged read-only does
     * (it answers success and keeps nothing), so the server's word is not taken — `unknown`,
     * for the next plan to settle from the roots.
     */
    if (unmoved) {
      return stopWith({
        outcome: 'unknown',
        operationId: outcome.operationId,
        message: `${said}, but both supervoxels are still under their old roots.`,
      })
    }
    // Otherwise made on the server's word, and recorded so — its root is the new one — and
    // nothing more is sent.
    return stopWith({
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
  return stopWith({
    outcome: 'unknown',
    message: unmoved
      ? `${lost}; the roots had not moved when read, but a merge can land after its reply is lost.`
      : `${lost}, and ${rootsSaid(after)} The next Submit checks whether that was this merge.`,
  })
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
