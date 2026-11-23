/**
 * The only module in Coda that writes to a chunkedgraph (`docs/seam-merge-plan.md`, phase 2).
 *
 * Everything else under `src/data/cave` reads. This module sends a merge, a split
 * (`docs/split-gallery-plan.md`, phase 4), and an undo of an edit it sent itself, and nothing else.
 * Three guards stand in front of it, each against a different way of reaching it by accident:
 *
 *  1. **The import graph.** `src/test/importGraph.test.ts` names the modules allowed a value import
 *     of this file; any other importer fails the suite. An `evaluate`, the assistant or the MCP
 *     server cannot reach a write without a reviewed change to that list.
 *  2. **`ConfirmedMerge` / `ConfirmedSplit`.** `mergeSupervoxels` takes no bare pair, nor
 *     `splitSupervoxels` bare edges. `confirmMerge` / `confirmSplit` make them, and are called only
 *     where the reader has confirmed the edit. The result is frozen and registered here, so a cast
 *     or a copy is refused at run time, not only by the compiler, and it is **spent** by sending:
 *     the same confirmation cannot be sent twice. Undo is held the same way: it takes only a `done`
 *     outcome this module returned, once.
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
 * them, raised in `_apply` before `_write` persists anything, and a split's "Supervoxels must
 * belong to the same object." and self-loop refusal the same way — are 400; the auth layer's are 401
 * and 403, before the handler runs; an unknown table is 404. Every other status is `unknown`: a
 * 500 is a locking failure, an unhandled exception or "Could not merge", some of them after the
 * write, and a 408, 409 or 429 can come from a proxy that had already passed the request on.
 * A redirect is not followed (`cavePostWrite`), so a write never lands on a host nobody named.
 */

import { errorMessage } from '../../core/errors'
import { isSegmentId } from '../../core/ids'
import type { Triple } from '../precomputed/volume'
import type { CaveRequestOptions } from './client'
import { CaveError, cavePostWrite } from './client'
import type { GrapheneSource } from './graphene'
import { tableUrl } from './graphene'
import { isNodeId, replyId } from './graphLayout'
import type { MergeEnd } from './merge'
import { isPositionNm, splitBody, wireEnd } from './merge'

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
const unsent = new WeakSet<ConfirmedMerge | ConfirmedSplit>()

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
  checkEdit(graphene, [neuron, candidate])
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

/** The two ends of one edge a split removes: `source` on the side named first, `sink` the other. */
export interface SplitEdge {
  readonly source: MergeEnd
  readonly sink: MergeEnd
}

/**
 * How a split is asked of the server: **exactly one edge** (`mincut=false`; the server removes it
 * and nothing else), or **its own min-cut** between two sets of seeds (`mincut=true`, in a box
 * around their positions). The exact form takes one edge because pychunkedgraph takes no more: two
 * or more fail with a 500 before anything is written (its edge list is not C-contiguous where
 * `in2d` views it as pairs; `split-gallery-plan.md`, phase 4's live test). A longer cut is sent as a
 * min-cut its preview agreed with.
 */
export type SplitAsked =
  | { readonly edge: SplitEdge }
  | {
      readonly mincut: {
        readonly sources: readonly MergeEnd[]
        readonly sinks: readonly MergeEnd[]
      }
    }

/** A split the reader has confirmed. Only `confirmSplit` makes one. */
export interface ConfirmedSplit {
  readonly graphene: GrapheneSource
  readonly mincut: boolean
  /** The edge's two ends where `mincut` is false; the two seed sets where it is true. */
  readonly sources: readonly MergeEnd[]
  readonly sinks: readonly MergeEnd[]
  readonly [CONFIRMED]: true
}

/**
 * Confirm one split, the step a reader takes by pressing Accept on it.
 *
 * Throws, as `confirmMerge` does, for a split that could not be meant: an empty seed set, an id that is no chunkedgraph id, a position that is not three finite numbers, an edge from
 * a supervoxel to itself or a seed on both sides (the server's own refusals, asked here first), a
 * chunkedgraph not on `https`. **Whether the split separates anything is not asked here** — the
 * server does not ask it either, and writes one new root where it does not
 * (`split-gallery-plan.md`, phase 0); the caller's checks are `splitWrite.ts`'.
 */
export function confirmSplit(graphene: GrapheneSource, asked: SplitAsked): ConfirmedSplit {
  const mincut = 'mincut' in asked
  const sources = mincut ? asked.mincut.sources : [asked.edge.source]
  const sinks = mincut ? asked.mincut.sinks : [asked.edge.sink]
  if (sources.length === 0 || sinks.length === 0) {
    throw new Error('A min-cut needs seeds on both sides.')
  }
  checkEdit(graphene, [...sources, ...sinks])
  // An edge from a supervoxel to itself, or a seed on both sides: the server's own refusals.
  const seeded = new Set(sources.map((end) => end.supervoxel))
  const both = sinks.find((end) => seeded.has(end.supervoxel))
  if (both) {
    throw new Error(
      mincut
        ? `Supervoxel ${both.supervoxel} seeds both sides of the min-cut.`
        : `An edge from supervoxel ${both.supervoxel} to itself.`,
    )
  }
  const split = Object.freeze({
    graphene: Object.freeze({ ...graphene }),
    mincut,
    sources: Object.freeze(sources.map(frozenEnd)),
    sinks: Object.freeze(sinks.map(frozenEnd)),
  }) as ConfirmedSplit
  unsent.add(split)
  return split
}

/**
 * The checks every edit's confirmation makes, one rule for merges and splits: each end a
 * chunkedgraph id at a position of three finite numbers, and the chunkedgraph on `https`.
 */
function checkEdit(graphene: GrapheneSource, ends: readonly MergeEnd[]): void {
  for (const end of ends) {
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
}

/**
 * Spend a confirmation: throws for one never made here or already sent, a fault in the caller.
 * Called after everything else that could throw, just before the request, so a caller that
 * catches and loops cannot send it twice, and a confirmation is never spent on a request never made.
 */
function spend(confirmation: ConfirmedMerge | ConfirmedSplit, what: 'merge' | 'split'): void {
  if (!unsent.has(confirmation)) {
    const maker = what === 'merge' ? 'confirmMerge' : 'confirmSplit'
    throw new Error(
      `This ${what} was not confirmed by ${maker}, or has already been sent. A ${what} is sent ` +
        'once per confirmation.',
    )
  }
  unsent.delete(confirmation)
}

function frozenEnd(end: MergeEnd): MergeEnd {
  return Object.freeze({
    supervoxel: end.supervoxel,
    positionNm: Object.freeze([...end.positionNm]) as Triple,
  })
}

/** The server made the edit. After a merge, `newRootIds[0]` is the merged neuron. */
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
  const { graphene, neuron, candidate } = merge
  const url = tableUrl(graphene, 'merge?int64_as_str=1&priority=True')
  const body = JSON.stringify([neuron, candidate].map(wireEnd))
  spend(merge, 'merge')
  return sendEdit(graphene, url, body, options)
}

/**
 * Split as confirmed: `POST …/table/{table}/split` with `mincut` spelled out either way, and
 * `{"sources": [[sv, x, y, z], …], "sinks": [[sv, x, y, z], …]}` — the body pychunkedgraph's
 * `handle_split` reads (`c75ace9`) — ids as JSON strings as in a merge. A supervoxel id skips the
 * server's point lookup (`get_atomic_ids_from_coords` returns a layer-1 id as it is); the
 * positions, in nanometres, are logged and, for a min-cut, bound the box it is made in.
 * `priority=True` spelled out, as for a merge.
 *
 * Throws only for a split that was never confirmed here or was already sent.
 */
export async function splitSupervoxels(
  split: ConfirmedSplit,
  options: WriteOptions,
): Promise<EditOutcome> {
  const { graphene, mincut, sources, sinks } = split
  const url = tableUrl(graphene, `split?int64_as_str=1&mincut=${mincut}&priority=True`)
  const body = JSON.stringify(splitBody(sources, sinks))
  spend(split, 'split')
  return sendEdit(graphene, url, body, options)
}

/** Send a merge or a split, and keep a `done` one undoable on its own table. */
async function sendEdit(
  graphene: GrapheneSource,
  url: string,
  body: string,
  options: WriteOptions,
): Promise<EditOutcome> {
  const outcome = await edit(url, body, options)
  if (outcome.kind === 'done') undoable.set(outcome, graphene)
  return outcome
}

/** Edits this module made and has not undone, with the table each was made on. */
const undoable = new WeakMap<DoneEdit, GrapheneSource>()

/**
 * Undo a merge or split this module made: `POST …/table/{table}/undo` with
 * `{"operation_id": n}`, as caveclient's `undo_operation` sends it, on the table the edit was made
 * on. For the sandbox probes, which undo their own merges, and the split gallery's Undo. It takes
 * the `done` outcome itself, not an operation id, so nothing can undo somebody else's edit or undo
 * the same edit twice.
 *
 * Throws only for an outcome `mergeSupervoxels` or `splitSupervoxels` did not return, or one
 * already undone.
 */
export async function undoEdit(made: DoneEdit, options: WriteOptions): Promise<EditOutcome> {
  const graphene = undoable.get(made)
  if (!graphene) {
    throw new Error(
      'Only an edit this session made can be undone, and only once: this one was not made by ' +
        'mergeSupervoxels or splitSupervoxels, or has already been undone.',
    )
  }
  undoable.delete(made)
  // The id is spliced in as digits, as caveclient sends an integer; `replyId` checked them.
  return edit(
    tableUrl(graphene, 'undo?int64_as_str=1'),
    `{"operation_id":${made.operationId}}`,
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
 * the object itself is what `undoEdit` takes.
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
