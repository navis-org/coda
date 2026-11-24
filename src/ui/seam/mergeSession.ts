/**
 * Submit, from the press to the last merge (`docs/seam-merge-plan.md`, phase 6). **The one module
 * that starts a merge batch** — `importGraph.test.ts`' `MAY_SUBMIT`, whose own importers are held
 * to a list there too — and the record's one writer.
 *
 * ## Why a session outside the card
 *
 * A batch outlives the surface it was started from. The review card is drawn on the canvas and
 * again expanded, and the dashboard unmounts the whole canvas. State held in the card would lose
 * the overlay — and the progress of merges still being sent — to either. So the session lives
 * here, one at a time for the whole app, and `MergeSubmitHost` (mounted once, in the shell) draws
 * its overlay; the card only reads which state it is in.
 *
 * ## The card is named by document and node
 *
 * Two documents opened from one file share node ids, so a session remembers the document it was
 * pressed in as well, and every write goes through the store's hold on that document
 * (`holdForWrite`), which refuses unless it is on screen and holds the card. The overlay covers
 * the app while it is up, so the document cannot change under it by pointer; the hold makes that
 * true of every other way too while merges are sent.
 *
 * ## The record, written one way
 *
 * Every entry is appended through the hold's `update`: the param read and replaced in one store
 * step, unrecorded — never a value read once at the start, never `setParams`.
 *
 * ## A merge still out holds every Submit
 *
 * A merge the batch stopped waiting for is recorded `unknown` and its request is still with the
 * server (`BatchCallbacks.stillOut`). Until it answers — or `STILL_OUT_MS` has passed — no Submit
 * opens, on any card: a plan made meanwhile finds the roots unmoved and would send the same pair
 * again (audit of 77c0625, 2026-11-16). The server would refuse the second ("Supervoxels must
 * belong to different objects"), but that is the server's guard, not ours. The answer, when it
 * comes, is appended to the record through a short hold, with its operation id; past the limit it
 * is dropped, since a later batch may have moved the neuron on and an old root appended after it
 * would move it back. The next plan settles it from the roots instead.
 */

import { useSyncExternalStore } from 'react'

import { errorMessage } from '../../core/errors'
import { otherWriteOut, registerWriteOut } from '../../data/cave/editWaits'
import { channel } from '../../data/channel'
import { flushVerdicts } from '../../data/verdictLog'
import { prepareMerges } from '../../packs/seam/mergeBatch'
import type { PlannedMerge, ReadyPlan } from '../../packs/seam/mergePlan'
import { planMerges } from '../../packs/seam/mergePlan'
import type { MergeProgress, MergeRecordEntry } from '../../packs/seam/mergeRecord'
import { appendRecorded, decodeRecord } from '../../packs/seam/mergeRecord'
import type { QueueTip } from '../../packs/seam/reviewQueue'
import { reviewStateOf } from '../../packs/seam/reviewQueue'
import { queueVerdict, verdictInput } from '../../packs/seam/verdictRecord'
import type { WriteHold } from '../../store/graphStore'
import { useGraphStore } from '../../store/graphStore'
import { isTourActive } from '../tour/tourState'

/** How long a merge still out holds Submit; after it, the answer is no longer recorded. */
export const STILL_OUT_MS = 10 * 60_000

/** Why Submit is held meanwhile: the status bar's and the card's button's one sentence. */
export const STILL_OUT_NOTICE =
  'A merge sent earlier has not answered yet. Submit waits for it, for up to ' +
  `${STILL_OUT_MS / 60_000} minutes.`

/** What Submit was pressed on: the card, its dataset and the queue it was showing. */
export interface SubmitRequest {
  /** The document the card is in (`activeTabId` at the press) and the card. */
  readonly docId: string
  readonly nodeId: string
  /** The CAVE deployment and datastack (`caveTarget`). */
  readonly deployment: string
  readonly datastack: string
  /** The wired Dataset, for the overlay's viewer. */
  readonly sourceId: string
  readonly datasetId: string
  readonly queue: readonly QueueTip[]
  readonly reviewedRoot: string
}

export type SubmitSession =
  | { readonly request: SubmitRequest; readonly phase: 'planning' }
  | {
      readonly request: SubmitRequest
      readonly phase: 'ready'
      readonly plan: ReadyPlan
      readonly plannedAt: number
      /** Per candidate root, from the moment Merge is pressed: `undefined` is not yet started. */
      readonly progress: ReadonlyMap<string, MergeProgress> | undefined
      readonly running: boolean
      /** The neuron's root as the batch has moved it on. */
      readonly neuronRoot: string
    }

type ReadySession = Extract<SubmitSession, { phase: 'ready' }>

let session: SubmitSession | undefined
let planning: AbortController | undefined
/**
 * How far the check under way has got (`PlanRequest.onProgress`): beside the session, never in
 * it, since a Re-check plans from the open overlay and a count must not move its phase.
 */
let checked: SubmitChecked | undefined
/** The batch being sent: the store's hold, and whether Stop was pressed. */
let inFlight: { readonly hold: WriteHold; stop: boolean } | undefined
// The split gallery's Accept waits while a batch is out, or a merge it stopped waiting for.
registerWriteOut('merge', () =>
  inFlight
    ? 'Merges are being sent from Submit; wait for them to finish.'
    : stillOut
      ? STILL_OUT_NOTICE
      : undefined,
)
/** A merge the batch stopped waiting for, still out (the header): its limit's timer. */
let stillOut: ReturnType<typeof setTimeout> | undefined
const changed = channel()

function publish(next: SubmitSession | undefined): void {
  session = next
  // A new phase is a new check, or none: the count of the last one is nobody's.
  checked = undefined
  changed.notify()
}

export function currentSubmit(): SubmitSession | undefined {
  return session
}

/** The overlay's session, for `MergeSubmitHost`. */
export function useSubmitSession(): SubmitSession | undefined {
  return useSyncExternalStore(changed.subscribe, currentSubmit)
}

/**
 * Where a card's Submit has got to, as the card's button reads it. `waiting`: a merge sent earlier
 * is still out, and no Submit opens until it answers.
 */
export type SubmitState = 'none' | 'other' | 'planning' | 'open' | 'running' | 'waiting'

export function submitStateOf(docId: string, nodeId: string): SubmitState {
  if (session) {
    const { request } = session
    if (request.docId === docId && request.nodeId === nodeId) {
      if (session.phase === 'planning') return 'planning'
      return session.running ? 'running' : 'open'
    }
    // Another card's: an overlay up over everything (a check nothing is drawn for yet is not).
    if (session.phase === 'ready') return 'other'
  }
  return stillOut ? 'waiting' : 'none'
}

/** How many pieces a check has decided, of how many (`PlanRequest.onProgress`). */
export type SubmitChecked = { readonly done: number; readonly total: number }

/**
 * How far this card's check has got, while the card's button is the check — the overlay is not
 * up — and once the check reaches the pieces. The held object, the same until the next count,
 * so the selector hands out nothing new between equal answers (invariant 7).
 */
export function submitCheckedOf(docId: string, nodeId: string): SubmitChecked | undefined {
  if (session?.phase !== 'planning') return undefined
  const { request } = session
  return request.docId === docId && request.nodeId === nodeId ? checked : undefined
}

export function useSubmitChecked(docId: string, nodeId: string): SubmitChecked | undefined {
  return useSyncExternalStore(changed.subscribe, () => submitCheckedOf(docId, nodeId))
}

/** A card's Submit state, as a primitive (invariant 7). */
export function useSubmitState(docId: string, nodeId: string): SubmitState {
  return useSyncExternalStore(changed.subscribe, () => submitStateOf(docId, nodeId))
}

/**
 * Press Submit: plan, then open the overlay. One session at a time; a press while one is open, or
 * during a tour (nothing opens a dialog during a tour), says so on the status bar instead.
 */
export function openSubmit(request: SubmitRequest): void {
  const store = useGraphStore.getState()
  if (isTourActive()) {
    store.setNotice('Finish the tour first — Submit opens a dialog the tour cannot follow.')
    return
  }
  if (session) {
    store.setNotice('A Submit is already open. Close it first.')
    return
  }
  if (stillOut) {
    store.setNotice(STILL_OUT_NOTICE)
    return
  }
  const other = otherWriteOut('merge')
  if (other) {
    store.setNotice(other)
    return
  }
  publish({ request, phase: 'planning' })
  void plan(request)
}

/** Ask the servers again, as the overlay's Re-check: the ticks it keeps are the overlay's. */
export function recheckSubmit(): void {
  if (session?.phase === 'ready' && session.progress === undefined) void plan(session.request)
}

/** The card's params, as the store holds them now. */
function liveParams(nodeId: string): Record<string, unknown> {
  return useGraphStore.getState().graph.nodes.find((node) => node.id === nodeId)?.params ?? {}
}

/** Whether the document the card was pressed in is the one on screen. */
const onScreen = (request: SubmitRequest) =>
  useGraphStore.getState().activeTabId === request.docId

async function plan(request: SubmitRequest): Promise<void> {
  planning?.abort()
  const controller = (planning = new AbortController())
  checked = undefined
  if (!onScreen(request)) return endWith(MOVED)
  const params = liveParams(request.nodeId)
  // Live, as the record is: a verdict changed since the press is the reader's latest word.
  // Auto-extend's accepts with them, as the card reads them (`reviewStateOf`).
  const { verdicts, unjudged } = reviewStateOf(params, request.queue)
  let made
  try {
    made = await planMerges(
      {
        datastack: request.datastack,
        queue: request.queue,
        reviewedRoot: request.reviewedRoot,
        verdicts,
        unjudged,
        record: decodeRecord(params['merges']),
        // Only while this check is the one under way: a closed or re-asked one says nothing.
        // Drawn only on the card's button, while the check is all there is: a Re-check counts
        // under the open overlay, and says nothing.
        onProgress: (done, total) => {
          if (planning !== controller || session?.phase !== 'planning') return
          checked = { done, total }
          changed.notify()
        },
      },
      { deployment: request.deployment, signal: controller.signal },
    )
  } catch (error) {
    // Only a cancel throws (`planMerges`); otherwise it is said like any refusal.
    made = { ok: false as const, message: errorMessage(error) }
  }
  // Closed, reset, re-asked or overtaken by Merge meanwhile: this answer is nobody's.
  if (planning !== controller) return
  planning = undefined
  if (!made.ok) return endWith(made.message)
  // Another document came on screen during the check: the plan was made from this one's card.
  if (!onScreen(request)) return endWith(MOVED)
  /*
   * Lost replies the plan showed were made: recorded now, whether or not anything is merged after
   * them — the plan's roots are already the new ones, and the record must say so too, or the
   * next Submit would start from the old ones. Through a hold, which refuses unless the card is
   * on screen in the document it was pressed in.
   */
  for (const entry of made.settled ?? []) {
    const refused = appendHeld(request, (now) => appendRecorded(now, entry))
    if (refused) return endWith(`Submit was not opened: ${refused}`)
  }
  publish({
    request,
    phase: 'ready',
    plan: made,
    plannedAt: Date.now(),
    progress: undefined,
    running: false,
    neuronRoot: made.currentRoot,
  })
}

const MOVED =
  'Submit was closed: the workflow it was pressed in is no longer on screen. Press it again there.'

/** A card, as its document and node: all a write to its record needs of a press. */
type Card = Pick<SubmitRequest, 'docId' | 'nodeId'>

/**
 * Append to the card's record through a short hold, which refuses unless the card is on screen in
 * the document it was pressed in and no batch is holding one: a merge's entry (`appendRecorded`),
 * or anything else the record takes, as a change to its text — a follow (`ReviewBody`). Why not,
 * or undefined.
 */
export function appendHeld(card: Card, change: (now: unknown) => string): string | undefined {
  try {
    const hold = useGraphStore.getState().holdForWrite(card.docId, card.nodeId)
    try {
      hold.update('merges', change)
    } finally {
      hold.release()
    }
    return undefined
  } catch (error) {
    return errorMessage(error)
  }
}

/** Let Submit go again; `timer` is the wait being ended, or any. */
function endWait(timer = stillOut): boolean {
  if (stillOut === undefined || stillOut !== timer) return false
  clearTimeout(stillOut)
  stillOut = undefined
  window.removeEventListener('beforeunload', warnLeaving)
  changed.notify()
  return true
}

/**
 * The browser's "leave this page?", while closing the tab would lose the record of a merge the
 * server made or may make: a batch running, or a merge still out.
 */
function warnLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault()
  // Still what some browsers need before they ask.
  event.returnValue = ''
}

/**
 * Hold every Submit until every one of `answers` settles, and record what each says (the header).
 * Only the card's two ids are kept for them, never the press with its queue: a request may never
 * answer.
 */
function waitFor(
  card: Card,
  answers: readonly StillOut[],
  /** Said of a merge that landed: what `autoSender` sends of it. */
  merged: (candidateRoot: string) => boolean,
): void {
  endWait()
  const timer = setTimeout(() => {
    if (!endWait(timer)) return
    useGraphStore
      .getState()
      .setNotice(
        `A merge sent earlier has not answered in ${STILL_OUT_MS / 60_000} minutes. Submit is ` +
          'open again; a later answer will not be recorded, and the next Submit reads the roots.',
      )
  }, STILL_OUT_MS)
  stillOut = timer
  window.addEventListener('beforeunload', warnLeaving)
  changed.notify()
  let left = answers.length
  for (const { answer, intoNeuron } of answers) {
    void answer.then((entry) => answered(entry, intoNeuron))
  }
  function answered(entry: MergeRecordEntry | undefined, intoNeuron: boolean): void {
    // Past the limit, or forgotten (`resetSubmit`): a later batch may have moved the neuron on.
    if (stillOut !== timer) return
    left -= 1
    if (left === 0) endWait(timer)
    if (!entry) return
    const refused = appendHeld(card, (now) => appendRecorded(now, entry))
    // A merge that landed is one whatever became of its record: SEAM hears of it.
    // Only one made into the neuron: one short of it may never get there.
    if (entry.outcome === 'merged' && intoNeuron && merged(entry.candidateRoot)) {
      void flushVerdicts()
    }
    useGraphStore
      .getState()
      .setNotice(
        refused
          ? `A merge sent earlier answered (${entry.outcome}), and could not be recorded: ${refused} ` +
              (entry.outcome === 'merged'
                ? 'The next Submit reads it off the roots.'
                : 'Nothing was merged; the next Submit may send it again.')
          : `A merge sent earlier answered: ${entry.outcome}. Recorded in Merges.`,
      )
  }
}

/** A merge the batch stopped waiting for, and whether it was made onto the neuron itself. */
interface StillOut {
  readonly answer: Promise<MergeRecordEntry | undefined>
  readonly intoNeuron: boolean
}

/** Close the session and say why on the status bar. */
function endWith(message: string): void {
  publish(undefined)
  useGraphStore.getState().setNotice(message)
}

/**
 * Merge, as the overlay's button: hold the card, confirm the merges and run them. **Throws before
 * anything is sent** for anything that stops the batch starting — the overlay says "Not started"
 * — and never after.
 */
export function confirmSubmit(merges: readonly PlannedMerge[]): void {
  if (session?.phase !== 'ready' || session.progress !== undefined) {
    throw new Error('This Submit has already been sent, or is not open.')
  }
  const { request, plan: confirmed } = session
  const hold = useGraphStore.getState().holdForWrite(request.docId, request.nodeId)
  // A Re-check still out must not land a fresh plan over the batch: its answer is dropped.
  planning?.abort()
  planning = undefined
  let batch
  try {
    batch = prepareMerges(confirmed, merges, { deployment: request.deployment })
  } catch (error) {
    hold.release()
    throw error
  }
  const sending = (inFlight = { hold, stop: false })
  // Closing the tab mid-batch would lose the record of merges the server has made.
  window.addEventListener('beforeunload', warnLeaving)

  // This session as it moves on; nothing is published once it has been closed or replaced.
  let live: ReadySession = { ...session, running: true, progress: new Map() }
  const show = (change: Partial<ReadySession>) => {
    if (session !== live) return
    live = { ...live, ...change }
    publish(live)
  }
  publish(live)

  /*
   * A merge handed on still out: waited for once the batch has let go of the card, never before —
   * its answer can land while the batch still holds it, and a second hold would be refused. No
   * Submit can open in between: the overlay is up until `running` goes false, after this.
   */
  const stillOutAnswers: StillOut[] = []
  /*
   * **A piece Auto-extend accepted, merged unjudged, goes to SEAM as `auto-accepted`** (user,
   * 2026-11-18) — once it is in the neuron, so it is what the reader let through, and never as
   * `accept`. A piece merged onto pieces short of the neuron goes when its group does: the batch
   * stopping first, it may never. Queued only where the reader shares verdicts ("Help improve";
   * `enqueueVerdict` asks).
   */
  let autoSent = false
  const sendAutoAccepted = autoSender(merges, {
    deployment: request.deployment,
    datastack: request.datastack,
  })
  void batch
    .run({
      progress: (candidateRoot, state) =>
        show({ progress: new Map(live.progress).set(candidateRoot, state) }),
      record: (entry, neuronRoot, intoNeuron) => {
        hold.update('merges', (now) => appendRecorded(now, entry))
        // The batch says where the neuron is: a merge onto pieces short of it moves those.
        if (neuronRoot !== live.neuronRoot) show({ neuronRoot })
        for (const id of intoNeuron) autoSent = sendAutoAccepted(id) || autoSent
      },
      stopRequested: () => sending.stop,
      stillOut: (answer, intoNeuron) => stillOutAnswers.push({ answer, intoNeuron }),
    })
    .then(
      (result) => result.message,
      (error: unknown) => `The batch stopped: ${errorMessage(error)}`,
    )
    .then((message) => {
      hold.release()
      // Every Auto-extend piece merged, in one post, where the reader shares verdicts.
      if (autoSent) void flushVerdicts()
      if (inFlight === sending) inFlight = undefined
      // Before the wait adds the same listener back, which a later removal would take with it.
      window.removeEventListener('beforeunload', warnLeaving)
      if (stillOutAnswers.length > 0)
        waitFor(
          { docId: request.docId, nodeId: request.nodeId },
          stillOutAnswers,
          sendAutoAccepted,
        )
      show({ running: false })
      if (message) useGraphStore.getState().setNotice(message)
    })
}

/**
 * What sends an Auto-extend piece's `auto-accepted` once its merge lands — by the batch, or by an
 * answer that comes after it (`waitFor`). The records are made here, from the ticked merges, so
 * what a late answer keeps alive is these few small records and never the press with its queue.
 * Answers whether one was queued; each is sent at most once.
 */
function autoSender(
  merges: readonly PlannedMerge[],
  target: { deployment: string; datastack: string },
): (candidateRoot: string) => boolean {
  const records = new Map(
    merges
      .filter((merge) => merge.auto)
      .map((merge) => [
        merge.candidateRoot,
        verdictInput(merge.used.tip, merge.used.candidate, 'auto-accepted', __APP_VERSION__),
      ]),
  )
  return (candidateRoot) => {
    const record = records.get(candidateRoot)
    records.delete(candidateRoot)
    return record !== undefined && queueVerdict(target, record) === undefined
  }
}

/** Stop after the merge in flight. */
export function stopSubmit(): void {
  if (!inFlight || inFlight.stop) return
  inFlight.stop = true
  changed.notify()
}

/** Whether Stop was pressed on the batch being sent: the overlay's button says so until it ends. */
export function submitStopping(): boolean {
  return inFlight?.stop ?? false
}

export function useStopping(): boolean {
  return useSyncExternalStore(changed.subscribe, submitStopping)
}

/** Close the overlay, or cancel the check before it. Refused while merges are being sent. */
export function closeSubmit(): void {
  if (session?.phase === 'ready' && session.running) return
  planning?.abort()
  planning = undefined
  publish(undefined)
}

/** Test-only: forget the session, and let go of the card if a batch was left running. */
export function resetSubmit(): void {
  inFlight?.hold.release()
  inFlight = undefined
  endWait()
  planning?.abort()
  planning = undefined
  publish(undefined)
}
