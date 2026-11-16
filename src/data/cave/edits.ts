/**
 * The only module in Coda that writes to a chunkedgraph (`docs/seam-merge-plan.md`, phase 2).
 *
 * Everything else under `src/data/cave` reads. This module sends a merge, and an undo of a merge
 * it sent itself (for the sandbox probe), and nothing else. Three guards stand in front of it,
 * each against a different way of reaching it by accident:
 *
 *  1. **The import graph.** `src/test/importGraph.test.ts` names the modules allowed a value import
 *     of this file; any other importer fails the suite. An `evaluate`, the assistant or the MCP
 *     server cannot reach a write without a reviewed change to that list.
 *  2. **`ConfirmedMerge`.** `mergeSupervoxels` takes no bare pair. `confirmMerge` makes one, and is
 *     called only where the reader has confirmed the listed merges. The result is frozen and
 *     registered here, so a cast or a copy is refused at run time, not only by the compiler, and
 *     it is **spent** by sending: the same confirmation cannot be sent twice. Undo is held the same
 *     way: it takes only a `done` outcome this module returned, once.
 *  3. **The test-wide write guard** (`src/test/writeGuard.ts`) fails any test whose request
 *     reaches a chunkedgraph edit endpoint without a stubbed `fetch`.
 *
 * **Never retried, and never cancelled once sent.** A merge whose reply did not arrive may have
 * happened, so the outcome is `unknown` and the caller re-reads the roots to find out. Spelunker
 * retries a failed merge three times; Coda does not. There is no `signal`: aborting a sent POST
 * does not stop the server, it only throws away the answer that says what the server did.
 *
 * Which failures left the graph as it was is read off pychunkedgraph v2.20.0, not assumed, and is
 * a short list (`REFUSED`): the merge handler's own refusals (supervoxel lookup, the three-chunk
 * guard) and every `PreconditionError` — "Supervoxels must belong to different objects." among
 * them, raised in `_apply` before `_write` persists anything — are 400; the auth layer's are 401
 * and 403, before the handler runs; an unknown table is 404. Every other status is `unknown`: a
 * 500 is a locking failure, an unhandled exception or "Could not merge", some of them after the
 * write, and a 408, 409 or 429 can come from a proxy that had already passed the request on.
 * A redirect is not followed (`cavePostWrite`), so a write never lands on a host nobody named.
 */

import { errorMessage } from '../../core/errors'
import { idText, isSegmentId } from '../../core/ids'
import type { Triple } from '../precomputed/volume'
import type { CaveRequestOptions } from './client'
import { CaveError, cavePostWrite } from './client'
import type { GrapheneSource } from './graphene'
import { tableUrl } from './graphene'
import { isNodeId } from './graphLayout'
import type { MergeEnd } from './merge'
import { isPositionNm } from './merge'

/**
 * Who a write is sent as: the deployment (which decides the token) and, from a script, the token.
 * Deliberately not `CaveRequestOptions`, which also carries a `signal` (see above) and `quiet` —
 * a refused write is never something to keep off the auth channel.
 */
export interface WriteOptions {
  readonly deployment: string
  readonly token?: string | undefined
}

declare const CONFIRMED: unique symbol

/** A merge the reader has confirmed. Only `confirmMerge` makes one. */
export interface ConfirmedMerge {
  readonly graphene: GrapheneSource
  /** The reviewed neuron's side, sent first. */
  readonly neuron: MergeEnd
  readonly candidate: MergeEnd
  readonly [CONFIRMED]: true
}

/** Confirmations not yet sent. A WeakSet, so one that is dropped unsent is not kept alive here. */
const unsent = new WeakSet<ConfirmedMerge>()

/**
 * Confirm one merge: the step a reader takes by pressing the button that listed it.
 *
 * Throws for a merge that could not be meant — an id that is no chunkedgraph id, a position that
 * is not three finite numbers, one supervoxel on both sides, a chunkedgraph not on `https`, which
 * would carry the reader's token and the write in the clear. Those are faults in the code that
 * built the merge, never a refusal to show somebody, and the server would answer some of them
 * with a 500 that reads as "may have happened".
 */
export function confirmMerge(
  graphene: GrapheneSource,
  neuron: MergeEnd,
  candidate: MergeEnd,
): ConfirmedMerge {
  for (const end of [neuron, candidate]) {
    if (!isNodeId(end.supervoxel)) {
      throw new Error(`Not a chunkedgraph id: ${JSON.stringify(end.supervoxel)}.`)
    }
    if (!isPositionNm(end.positionNm)) {
      throw new Error(`Not a position in nanometres: ${JSON.stringify(end.positionNm)}.`)
    }
  }
  if (!graphene.server.startsWith('https://')) {
    throw new Error(`Not an https chunkedgraph: ${graphene.server}.`)
  }
  if (neuron.supervoxel === candidate.supervoxel) {
    throw new Error(`Both sides of the merge are supervoxel ${neuron.supervoxel}.`)
  }
  // Copied, then frozen: what is sent is what was confirmed, whatever the caller's objects do next.
  const merge = Object.freeze({
    graphene: Object.freeze({ ...graphene }),
    neuron: frozenEnd(neuron),
    candidate: frozenEnd(candidate),
  }) as ConfirmedMerge
  unsent.add(merge)
  return merge
}

function frozenEnd(end: MergeEnd): MergeEnd {
  return Object.freeze({
    supervoxel: end.supervoxel,
    positionNm: Object.freeze([...end.positionNm]) as Triple,
  })
}

/** The server made the edit. `newRootIds[0]` is the merged neuron. */
export interface DoneEdit {
  readonly kind: 'done'
  readonly operationId: string
  readonly newRootIds: readonly string[]
}

/** What became of one write. */
export type EditOutcome =
  | DoneEdit
  /** The server refused (`REFUSED`): nothing was written. `message` is the server's own sentence. */
  | { readonly kind: 'refused'; readonly status: number; readonly message: string }
  /**
   * No answer that says what happened: the host was unreachable, it redirected, it answered a
   * status not in `REFUSED`, or it answered success in a shape this cannot read. The edit **may have happened**; re-read the
   * roots before doing anything else.
   */
  | { readonly kind: 'unknown'; readonly message: string }

/**
 * Merge two supervoxels: `POST …/table/{table}/merge`, the request Spelunker sends.
 *
 * The body is `[[sv, x, y, z], [sv, x, y, z]]` with each supervoxel as a JSON **string**, as
 * Spelunker writes it (`String(segmentId)`): the server reads both through
 * `np.array(…, dtype=np.uint64)`, which takes decimal text exactly, and an id is never a
 * JavaScript number on the way (invariant 8). `priority=True` is spelled out, where Spelunker
 * leaves it to the server's default, so the request does not change if the default does.
 *
 * Throws only for a merge that was never confirmed here or was already sent — a fault in the
 * caller, before any request.
 */
export async function mergeSupervoxels(
  merge: ConfirmedMerge,
  options: WriteOptions,
): Promise<EditOutcome> {
  if (!unsent.has(merge)) {
    throw new Error(
      'This merge was not confirmed by confirmMerge, or has already been sent. A merge is sent ' +
        'once per confirmation.',
    )
  }
  const { graphene, neuron, candidate } = merge
  const url = tableUrl(graphene, 'merge?int64_as_str=1&priority=True')
  const body = JSON.stringify(
    [neuron, candidate].map((end) => [end.supervoxel, ...end.positionNm]),
  )
  // Spent before the request, and after everything that could throw, so a caller that catches
  // and loops cannot send it twice, and a confirmation is never spent on a request never made.
  unsent.delete(merge)
  const outcome = await edit(url, body, options)
  if (outcome.kind === 'done') undoable.set(outcome, graphene)
  return outcome
}

/** Merges this module made and has not undone, with the table each was made on. */
const undoable = new WeakMap<DoneEdit, GrapheneSource>()

/**
 * Undo a merge this module made: `POST …/table/{table}/undo` with `{"operation_id": n}`, as
 * caveclient's `undo_operation` sends it, on the table the merge was made on. **For the sandbox
 * probe**, which undoes its own merge; Coda has no Undo button. It takes the `done` outcome itself,
 * not an operation id, so nothing can undo somebody else's edit or undo the same merge twice.
 *
 * Throws only for an outcome `mergeSupervoxels` did not return, or one already undone.
 */
export async function undoMerge(merged: DoneEdit, options: WriteOptions): Promise<EditOutcome> {
  const graphene = undoable.get(merged)
  if (!graphene) {
    throw new Error(
      'Only a merge this session made can be undone, and only once: this one was not made by ' +
        'mergeSupervoxels, or has already been undone.',
    )
  }
  undoable.delete(merged)
  // The id is spliced in as digits, as caveclient sends an integer; `replyId` checked them.
  return edit(
    tableUrl(graphene, 'undo?int64_as_str=1'),
    `{"operation_id":${merged.operationId}}`,
    options,
  )
}

/**
 * The request options a write — and the reads that check it — go with: the deployment and the
 * token, field by field, so a `signal` or `quiet` on the caller's object never rides along.
 */
export function requestOptionsOf(options: WriteOptions): CaveRequestOptions {
  return {
    deployment: options.deployment,
    ...(options.token ? { token: options.token } : {}),
  }
}

/**
 * The statuses that mean the server refused before writing — see the header for where each comes
 * from. A status outside this list is not evidence that nothing happened.
 */
const REFUSED: ReadonlySet<number> = new Set([400, 401, 403, 404])

/**
 * Send one write and say what became of it. Never throws: every failure is an outcome.
 *
 * Takes the URL and body ready-made, so building them cannot fail after a confirmation is spent.
 * The transport can still fail before sending (a token no header can carry), which comes out as
 * `unknown` — wrong, but in the safe direction. The options are rebuilt (`requestOptionsOf`).
 */
async function edit(url: string, body: string, options: WriteOptions): Promise<EditOutcome> {
  let reply: unknown
  try {
    reply = await cavePostWrite<unknown>(url, body, requestOptionsOf(options))
  } catch (error) {
    // `CaveError` is the transport's own. A missing token is a 401 that was never sent.
    if (error instanceof CaveError && REFUSED.has(error.status)) {
      return { kind: 'refused', status: error.status, message: error.message }
    }
    // Status 0 is a request with no answer — and a refused redirect fails exactly like a host
    // that cannot be reached, so the message has to say it could be either.
    const redirect =
      error instanceof CaveError && error.status === 0
        ? ' A redirect is not followed for a write, and fails the same way.'
        : ''
    return { kind: 'unknown', message: errorMessage(error) + redirect }
  }
  return (
    doneFrom(reply) ?? {
      kind: 'unknown',
      message:
        'The chunkedgraph answered success without an operation id and new root ids, so ' +
        `whether the edit happened is not known: ${JSON.stringify(reply)?.slice(0, 200)}`,
    }
  )
}

/**
 * `{operation_id, new_root_ids}` from a reply, or undefined where it is not that. Frozen, since
 * the object itself is what `undoMerge` takes.
 */
function doneFrom(reply: unknown): DoneEdit | undefined {
  if (typeof reply !== 'object' || reply === null) return undefined
  const { operation_id, new_root_ids } = reply as Record<string, unknown>
  const operationId = replyId(operation_id, isOperationId)
  if (operationId === undefined) return undefined
  if (!Array.isArray(new_root_ids) || new_root_ids.length === 0) return undefined
  const newRootIds = new_root_ids.map((id) => replyId(id, isNodeId))
  if (!newRootIds.every((id) => id !== undefined)) return undefined
  return Object.freeze({ kind: 'done', operationId, newRootIds: Object.freeze(newRootIds) })
}

/** An operation id: a uint64 counter, not a node, so not held to whatever `isNodeId` may grow. */
function isOperationId(text: string): boolean {
  return text !== '0' && isSegmentId(text)
}

/**
 * One id from a reply: text under `int64_as_str`, a safe integer if a server ignores it
 * (`parseCaveJson` quotes any wider one), undefined for anything else.
 */
function replyId(value: unknown, valid: (text: string) => boolean): string | undefined {
  const text = typeof value === 'string' || typeof value === 'number' ? idText(value) : null
  return text !== null && valid(text) ? text : undefined
}
