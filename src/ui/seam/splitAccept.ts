/**
 * Accept and Undo in the split gallery (`docs/split-gallery-plan.md`, phase 4). **The one module
 * that starts a split write** — `importGraph.test.ts` holds its importers to a list (the gallery's
 * overlay alone). Apart from `splitSession.ts` on purpose: the key and the viewer import the
 * session, and none of them may reach a write.
 *
 * One write at a time, for the whole app. While one is out the gallery is held on the press it
 * was made from (`holdSplit`): Close does nothing and the key says why, so the answer is drawn
 * over the tiles it was chosen from and never lost to a new press. The hold is bounded: every
 * read has `READ_TIMEOUT_MS` and the send `SEND_TIMEOUT_MS` (`editWaits.ts`).
 */

import { errorMessage } from '../../core/errors'
import { channel } from '../../data/channel'
import type { GrapheneSource } from '../../data/cave/graphene'
import {
  otherWriteOut,
  registerWriteOut,
  SEND_TIMEOUT_MS,
  within,
} from '../../data/cave/editWaits'
import type { SplitCandidate, SplitGalleryInput } from '../../packs/seam/splitGallery'
import type {
  SplitStep,
  SplitWriteResult,
  SplitWriteServices,
} from '../../packs/seam/splitWrite'
import { LIVE_SPLIT_WRITE, writeSplit } from '../../packs/seam/splitWrite'
import { refoldedEdits, replaceSegments } from '../../data/neuroglancer/selectionEdits'
import { useGraphStore } from '../../store/graphStore'
import type { SplitCard, SplitRequest } from './splitSession'
import { closeSplit, holdSplit } from './splitSession'

/** The last Accept: under way, or finished with its result (and what Undo did, once pressed). */
export type SplitAccept = {
  /** The press and the tile the write was made from. */
  readonly request: SplitRequest
  readonly index: number
} & (
  | { readonly step: SplitStep | 'undoing'; readonly result?: SplitWriteResult }
  | {
      readonly step?: undefined
      readonly result: SplitWriteResult
      /** A send Coda stopped waiting for, still out: the gallery stays held until it answers. */
      readonly out?: boolean
      readonly undo?: { readonly ok: boolean; readonly message: string }
    }
)

/** What Accept writes from: the press's box and chunkedgraph (`SplitSession`), and the tile. */
export interface AcceptFrom {
  readonly request: SplitRequest
  readonly graphene: GrapheneSource
  readonly input: SplitGalleryInput
  readonly index: number
  readonly candidate: SplitCandidate
}

/** What an undo answers (the writer's `EditOutcome`, named without naming the writer's module). */
type UndoOutcome = Awaited<ReturnType<SplitWriteServices['undo']>>

const HELD = 'A split is being written from the split gallery; wait for its answer.'
/**
 * How long a send still out after `SEND_TIMEOUT_MS` holds the gallery; past it, its answer is no
 * longer waited for. As long as the merge path holds Submit (`mergeSession.ts`' `STILL_OUT_MS`).
 */
const STILL_OUT_MS = 10 * 60_000

let services: SplitWriteServices = LIVE_SPLIT_WRITE
let state: SplitAccept | undefined
const changed = channel()
// A merge Submit waits while a split is out (`otherWriteOut`).
registerWriteOut('split', () => (state?.step || state?.out ? HELD : undefined))

/**
 * Put `come` in place of `gone` in the neurons of the card the key was pressed over (and take
 * `retired` out, `replaceSegments`): its `selectionEdits`, read **now** from the store, so picks
 * made while the split was out are kept, and written only while its document is on screen and
 * still holds that Neuroglancer card — node ids repeat across documents, and opening a workflow
 * makes a new one. Otherwise left as it is: the answer is on the status bar either way.
 *
 * Its own undo step: written through `setParamsMany`, whose history tag is not a pick's
 * (`param:<node>:selectionEdits`), so a pick made within the coalescing window is never taken back
 * with it. A fault here is caught: the write and its answer stand without the drawing.
 */
function showInCard(
  card: SplitCard | undefined,
  gone: readonly string[],
  come: readonly string[],
  retired: readonly string[] = [],
): void {
  try {
    const store = useGraphStore.getState()
    if (!card || store.activeTabId !== card.docId) return
    const node = store.graph.nodes.find((one) => one.id === card.nodeId)
    if (node?.type !== 'out.neuroglancer') return
    const next = refoldedEdits(node.params['selectionEdits'], (edits) =>
      replaceSegments(edits, gone, come, retired),
    )
    if (next) store.setParamsMany([{ nodeId: card.nodeId, values: { selectionEdits: next } }])
  } catch {
    // A drawing convenience: never what holds the gallery or misreports the write.
  }
}

function set(next: SplitAccept | undefined): void {
  state = next
  holdSplit(next?.step || next?.out ? HELD : undefined)
  changed.notify()
}

/** The edit the server said a result made, if it said one — what Undo takes back. */
export function wrote(result: SplitWriteResult | undefined) {
  return result && 'done' in result ? result.done : undefined
}

/**
 * Whether Accept is off for the press a result came from: anything that may have written — an
 * edit, or no answer that says — since the neuron may no longer be what was read. Only a check
 * that sent nothing, or the server's refusal, leaves it on.
 */
export function mayHaveWritten(result: SplitWriteResult | undefined): boolean {
  return result !== undefined && result.kind !== 'not-sent' && result.kind !== 'refused'
}

/**
 * Write `from`'s candidate. Does nothing while a write, or a send Coda stopped waiting for, is out;
 * says why on the status bar while a merge is (`otherWriteOut`).
 */
export function acceptSplit(from: AcceptFrom): void {
  if (state?.step || state?.out) return
  const other = otherWriteOut('split')
  if (other) {
    useGraphStore.getState().setNotice(other)
    return
  }
  const { request, index } = from
  let sending = false
  void (async () => {
    let result: SplitWriteResult
    try {
      result = await writeSplit(
        {
          graphene: from.graphene,
          root: request.root,
          input: from.input,
          candidate: from.candidate,
        },
        { deployment: request.deployment },
        (step) => {
          sending ||= step !== 'checking'
          set({ request, index, step })
        },
        services,
      )
    } catch (error) {
      // `writeSplit` answers every failure itself; a throw is a fault, and must not leave the
      // gallery held. After the send it may have written, so it is not known.
      const message = `The split stopped on a fault: ${errorMessage(error)}`
      result = sending
        ? {
            kind: 'unknown',
            message: `${message} It may have been made; it is not sent again.`,
          }
        : { kind: 'not-sent', message }
    }
    const late = result.kind === 'unknown' ? result.late : undefined
    set({ request, index, result, out: Boolean(late) })
    // In the card, the pieces — where the server made them and the read back bears it out (one
    // new root, too, is the neuron now). Not where every end was read under the old root still.
    if (result.kind === 'split' || result.kind === 'joined') {
      showInCard(request.card, [request.root], result.done.newRootIds)
    }
    // Made, and read back apart: nothing left to choose, so the gallery closes (user,
    // 2026-11-23). The answer stays on the status bar, the card shows the pieces. Anything
    // else — a refusal, one piece still, no answer — stays open, with Undo where there is one.
    if (result.kind === 'split') closeSplit()
    useGraphStore.getState().setNotice(sentenceOf(result))
    if (result.kind === 'unknown' && late) await settleLate(request, index, result, late)
  })()
}

/**
 * Wait for a send still out (up to `STILL_OUT_MS`), then let the gallery go — saying so either
 * way. Where it answered that it made an edit, that edit is kept for Undo, worded as an on-time
 * answer would be where it left the neuron one piece. Never resent.
 */
async function settleLate(
  request: SplitRequest,
  index: number,
  result: SplitWriteResult & { kind: 'unknown' },
  late: NonNullable<typeof result.late>,
): Promise<void> {
  const answer = await within(late, STILL_OUT_MS)
  if (state?.result !== result) return
  let settled: SplitWriteResult
  let said: string
  if (answer?.kind === 'done') {
    said =
      answer.newRootIds.length === 1
        ? `It answered later (operation ${answer.operationId}) with one new root, ${answer.newRootIds[0]}: the neuron is still one piece, with these edges gone. Undo restores them.`
        : `It answered later: operation ${answer.operationId}, roots ${answer.newRootIds.join(', ')}.`
    settled =
      answer.newRootIds.length === 1
        ? { kind: 'joined', done: answer, message: `${result.message} ${said}` }
        : { kind: 'unknown', done: answer, message: `${result.message} ${said}` }
  } else if (answer?.kind === 'refused') {
    said = `It answered later: refused (${answer.status}), so nothing was written.`
    settled = { kind: 'refused', message: `${result.message} ${said}` }
  } else {
    said = `No answer after ${Math.round(STILL_OUT_MS / 60_000)} minutes; Coda no longer waits for it, and it may still land.`
    settled = { kind: 'unknown', message: `${result.message} ${said}` }
  }
  set({ request, index, result: settled })
  // On the server's word: a late answer has no read back to bear it out or contradict it, and the
  // root the key was pressed on is gone either way.
  if (answer?.kind === 'done') showInCard(request.card, [request.root], answer.newRootIds)
  useGraphStore.getState().setNotice(said)
}

/** The edit the last Accept made, while it can still be undone here. */
export function undoable(accept: SplitAccept | undefined) {
  // Once only, whatever came of it: the writer forgets an edit as its undo is sent.
  return accept && !accept.step && !accept.out && !accept.undo
    ? wrote(accept.result)
    : undefined
}

/**
 * Undo what the last Accept wrote. Never resent: one press, one request. Bounded as a send is; an
 * undo still out after that holds the gallery, as a split still out does, until it answers or
 * `STILL_OUT_MS` passes — and where it then answers that it was made, the card is set right.
 */
export function undoAccepted(): void {
  const current = state
  const done = undoable(current)
  if (!current?.result || !done) return
  const { request, index, result } = current
  set({ request, index, result, step: 'undoing' })
  void (async () => {
    // In an async function, so a throw (an edit already undone, before any request) is a rejection.
    const sent = (async () => services.undo(done, { deployment: request.deployment }))().catch(
      (error: unknown): UndoOutcome => ({
        kind: 'refused',
        status: 0,
        message: errorMessage(error),
      }),
    )
    const waitMs = services.sendTimeoutMs ?? SEND_TIMEOUT_MS
    const answered = await within(sent, waitMs)
    if (answered) {
      finishUndo(request, index, result, done, answered)
      return
    }
    set({
      request,
      index,
      result,
      out: true,
      undo: {
        ok: false,
        message: `Undo's reply has not come after ${Math.round(waitMs / 1000)} s; waiting for it.`,
      },
    })
    const late = await within(sent, STILL_OUT_MS)
    finishUndo(
      request,
      index,
      result,
      done,
      late ?? {
        kind: 'unknown',
        message: `no answer after ${Math.round(STILL_OUT_MS / 60_000)} minutes; it may still land`,
      },
    )
  })()
}

/** An undo's answer: said, and where it was made, the card shows its root in place of the pieces. */
function finishUndo(
  request: SplitRequest,
  index: number,
  result: SplitWriteResult,
  done: NonNullable<ReturnType<typeof wrote>>,
  outcome: UndoOutcome,
): void {
  const undo =
    outcome.kind === 'done'
      ? {
          ok: true,
          message: `Undone (operation ${outcome.operationId}): the neuron is ${outcome.newRootIds.join(', ')}.`,
        }
      : outcome.kind === 'refused'
        ? { ok: false, message: `Undo was refused: ${outcome.message}` }
        : {
            ok: false,
            message: `Undo's reply was lost (${outcome.message}); whether it was undone is not known.`,
          }
  set({ request, index, result, undo })
  useGraphStore.getState().setNotice(undo.message)
  // The pressed root out where the card was never given the pieces; the pieces only un-added.
  if (outcome.kind === 'done') {
    showInCard(request.card, [request.root], outcome.newRootIds, done.newRootIds)
  }
}

/** A result as one sentence, for the status bar and the overlay. */
export function sentenceOf(result: SplitWriteResult): string {
  if (result.kind !== 'split') return result.message
  const parts = result.kept
    ? `kept ${result.kept}; taken off ${result.taken.join(', ')}`
    : `now ${result.taken.join(', ')}`
  return `Split (operation ${result.done.operationId}): ${parts}.${result.message ? ` ${result.message}` : ''}`
}

export function splitAccept(): SplitAccept | undefined {
  return state
}

export function onSplitAccept(listener: () => void): () => void {
  return changed.subscribe(listener)
}

/** Tests: swap the servers and forget the last Accept. */
export function resetSplitAcceptForTests(next: SplitWriteServices = LIVE_SPLIT_WRITE): void {
  services = next
  state = undefined
  holdSplit(undefined)
}
