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
 */

import { useSyncExternalStore } from 'react'

import { errorMessage } from '../../core/errors'
import { channel } from '../../data/channel'
import { prepareMerges } from '../../packs/seam/mergeBatch'
import type { PlannedMerge, ReadyPlan } from '../../packs/seam/mergePlan'
import { planMerges } from '../../packs/seam/mergePlan'
import type { MergeProgress, MergeRecordEntry } from '../../packs/seam/mergeRecord'
import { appendEntry, decodeRecord, settledEntry } from '../../packs/seam/mergeRecord'
import type { QueueTip } from '../../packs/seam/reviewQueue'
import { decodeVerdicts } from '../../packs/seam/reviewQueue'
import type { WriteHold } from '../../store/graphStore'
import { useGraphStore } from '../../store/graphStore'
import { isTourActive } from '../tour/tourState'

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
/** The batch being sent: the store's hold, and whether Stop was pressed. */
let inFlight: { readonly hold: WriteHold; stop: boolean } | undefined
const changed = channel()

function publish(next: SubmitSession | undefined): void {
  session = next
  changed.notify()
}

export function currentSubmit(): SubmitSession | undefined {
  return session
}

/** The overlay's session, for `MergeSubmitHost`. */
export function useSubmitSession(): SubmitSession | undefined {
  return useSyncExternalStore(changed.subscribe, currentSubmit)
}

/** Where a card's Submit has got to, as the card's button reads it. */
export type SubmitState = 'none' | 'other' | 'planning' | 'open' | 'running'

export function submitStateOf(docId: string, nodeId: string): SubmitState {
  if (!session) return 'none'
  const { request } = session
  if (request.docId !== docId || request.nodeId !== nodeId) {
    // Another card's: an overlay up over everything, or a check nothing is drawn for yet.
    return session.phase === 'ready' ? 'other' : 'none'
  }
  if (session.phase === 'planning') return 'planning'
  return session.running ? 'running' : 'open'
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
  if (!onScreen(request)) return endWith(MOVED)
  const params = liveParams(request.nodeId)
  let made
  try {
    made = await planMerges(
      {
        datastack: request.datastack,
        queue: request.queue,
        reviewedRoot: request.reviewedRoot,
        // Live, as the record is: a verdict changed since the press is the reader's latest word.
        verdicts: decodeVerdicts(params['verdicts']),
        record: decodeRecord(params['merges']),
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
   * A lost reply the plan showed was this merge: recorded now, whether or not anything is merged
   * after it — the plan's root is already the new one, and the record must say so too, or the
   * next Submit would start from the old one. Through a hold, which refuses unless the card is
   * on screen in the document it was pressed in.
   */
  if (made.settled) {
    const { entry, newRoot } = made.settled
    try {
      const hold = useGraphStore.getState().holdForWrite(request.docId, request.nodeId)
      try {
        hold.update('merges', (now) =>
          appendEntry(now, settledEntry(entry, newRoot, new Date().toISOString())),
        )
      } finally {
        hold.release()
      }
    } catch (error) {
      return endWith(`Submit was not opened: ${errorMessage(error)}`)
    }
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
  const warn = (event: BeforeUnloadEvent) => {
    event.preventDefault()
    // Still what some browsers need before they ask.
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', warn)

  // This session as it moves on; nothing is published once it has been closed or replaced.
  let live: ReadySession = { ...session, running: true, progress: new Map() }
  const show = (change: Partial<ReadySession>) => {
    if (session !== live) return
    live = { ...live, ...change }
    publish(live)
  }
  publish(live)

  void batch
    .run({
      progress: (candidateRoot, state) =>
        show({ progress: new Map(live.progress).set(candidateRoot, state) }),
      record: (entry: MergeRecordEntry) => {
        hold.update('merges', (now) => appendEntry(now, entry))
        if (entry.outcome === 'merged') show({ neuronRoot: entry.newRoot })
      },
      stopRequested: () => sending.stop,
    })
    .then(
      (result) => result.message,
      (error: unknown) => `The batch stopped: ${errorMessage(error)}`,
    )
    .then((message) => {
      hold.release()
      if (inFlight === sending) inFlight = undefined
      window.removeEventListener('beforeunload', warn)
      show({ running: false })
      if (message) useGraphStore.getState().setNotice(message)
    })
}

/** Stop after the merge in flight. */
export function stopSubmit(): void {
  if (inFlight) inFlight.stop = true
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
  planning?.abort()
  planning = undefined
  publish(undefined)
}
