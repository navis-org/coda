/**
 * The write behind the split gallery's Accept (`docs/split-gallery-plan.md`, phase 4). **This
 * writes to a shared segmentation.** It is one of the modules `importGraph.test.ts` allows to
 * import the writer, and its own importers are held to a list there too.
 *
 * One split, sent once, never retried — the merge path's rules (`mergeBatch.ts`), its time limits
 * included (`editWaits.ts`):
 *
 *  1. **Separation, checked again.** The server removes the edges it is sent and nothing else, and
 *     where they do not separate the neuron it writes **one new root** without them — a silent
 *     edit, not a refusal (phase 0). So the cut is checked against the box once more
 *     (`splitOf`), which also says which side each end is on. **No fresh read**: a root id names
 *     one fixed graph, the box was read for this root, and step 3 asks that the root is still the
 *     neuron — so the box read then is the graph now.
 *  2. **Permission**, read-only, so a reader who may not edit is told so rather than by a 403.
 *  3. **The root is current** (`is_latest_roots` at the server's now). The server does not ask:
 *     it splits whatever root the supervoxels are under when it takes its lock. Somebody else's
 *     edit in between would have the cut applied to a neuron the reader never saw.
 *  4. **Sent**, every edge oriented from the side `a` end to the side `b` end.
 *  5. **Read back**: every end's root at the server's now. One new root in the reply, or the two
 *     sides' ends under one root, is the silent edit of step 1 — reported as a failure with the
 *     edit itself, so the reader can undo it. Ends still under the old root is a graph that
 *     answers success and keeps nothing (`mergeBatch.ts`): not known.
 *
 * A reply that never came (`unknown`, or none within `SEND_TIMEOUT_MS`) is **never resent**: the
 * roots are read and reported, and the reader decides. What no client closes: the moment between
 * step 3 and the server's lock.
 */

import { errorMessage } from '../../core/errors'
import type { CaveRequestOptions } from '../../data/cave/client'
import type {
  ConfirmedSplit,
  DoneEdit,
  EditOutcome,
  SplitAsked,
  WriteOptions,
} from '../../data/cave/edits'
import {
  confirmSplit,
  requestOptionsOf,
  splitSupervoxels,
  undoEdit,
} from '../../data/cave/edits'
import { rootsOrError, SEND_TIMEOUT_MS, timedRead, within } from '../../data/cave/editWaits'
import type { GrapheneSource } from '../../data/cave/graphene'
import type { MergeEnd } from '../../data/cave/merge'
import type { EditPermission } from '../../data/cave/permissions'
import { editPermission, editRefusal } from '../../data/cave/permissions'
import { isLatestRoots, supervoxelRoots } from '../../data/cave/rootIds'
import type { SplitPreview } from '../../data/cave/splitPreview'
import { previewSplit } from '../../data/cave/splitPreview'
import type { SplitCandidate, SplitGalleryInput, SplitSide } from './splitGallery'
import { chunkOfMembers, splitOf } from './splitGallery'

/** What the write asks of the servers, apart so the logic can be tested without one. */
export interface SplitWriteServices {
  permission(graphene: GrapheneSource, options: CaveRequestOptions): Promise<EditPermission>
  /** Whether each root is current at the server's now. */
  latest(
    graphene: GrapheneSource,
    roots: readonly string[],
    options: CaveRequestOptions,
  ): Promise<boolean[]>
  /** Each supervoxel's root at the server's now, in order. */
  roots(
    graphene: GrapheneSource,
    supervoxels: readonly string[],
    options: CaveRequestOptions,
  ): Promise<string[]>
  /** The server's own min-cut between two seed sets, previewed (`previewSplit`): a read. */
  preview(
    graphene: GrapheneSource,
    sources: readonly MergeEnd[],
    sinks: readonly MergeEnd[],
    options: CaveRequestOptions,
  ): Promise<SplitPreview>
  send(split: ConfirmedSplit, options: WriteOptions): Promise<EditOutcome>
  /** Undo an Accept's edit. Throws only for one already undone. */
  undo(done: DoneEdit, options: WriteOptions): Promise<EditOutcome>
  /** How long a send may go unanswered (`SEND_TIMEOUT_MS`); tests make it short. */
  sendTimeoutMs?: number
}

export const LIVE_SPLIT_WRITE: SplitWriteServices = {
  permission: (graphene, options) => editPermission(graphene, timedRead(options)),
  latest: (graphene, roots, options) =>
    isLatestRoots(graphene, roots, 'server', timedRead(options)),
  roots: (graphene, supervoxels, options) =>
    supervoxelRoots(graphene, supervoxels, 'server', timedRead(options)),
  preview: (graphene, sources, sinks, options) =>
    previewSplit(graphene, sources, sinks, timedRead(options)),
  send: splitSupervoxels,
  undo: undoEdit,
}

/** The split to write: the neuron, the box its candidate was found in, and the candidate. */
export interface SplitToWrite {
  readonly graphene: GrapheneSource
  readonly root: string
  readonly input: SplitGalleryInput
  readonly candidate: SplitCandidate
}

/** Where a write is, for the overlay's line. */
export type SplitStep = 'checking' | 'splitting' | 'reading'

/** What became of one Accept. `done` is on every result that wrote, for Undo. */
export type SplitWriteResult =
  /** Split: `kept` is the root of the larger side (the tiles' "kept"), `taken` the rest. */
  | {
      readonly kind: 'split'
      readonly done: DoneEdit
      readonly kept: string | undefined
      readonly taken: readonly string[]
      /** Where the read back could not confirm the sides, why. */
      readonly message?: string | undefined
    }
  /** Written, and the neuron is still one piece: the edit to undo. */
  | { readonly kind: 'joined'; readonly done: DoneEdit; readonly message: string }
  /** Nothing was sent: a check before it said no, in a sentence. */
  | { readonly kind: 'not-sent'; readonly message: string }
  /** The server refused: nothing was written. */
  | { readonly kind: 'refused'; readonly message: string }
  /**
   * No answer that says what happened, or one the read back does not bear out. May have split;
   * never resent. `done` where the server did answer it made an edit (for Undo); `late` where the
   * request is still out after `SEND_TIMEOUT_MS` — its answer, when it comes.
   */
  | {
      readonly kind: 'unknown'
      readonly message: string
      readonly done?: DoneEdit | undefined
      readonly late?: Promise<EditOutcome> | undefined
    }

/**
 * Write `split` as `options`' reader, saying each step to `progress`. Never throws: every failure
 * is a result.
 */
export async function writeSplit(
  split: SplitToWrite,
  options: WriteOptions,
  progress: (step: SplitStep) => void,
  services: SplitWriteServices = LIVE_SPLIT_WRITE,
): Promise<SplitWriteResult> {
  const { graphene, root } = split
  const readAs = requestOptionsOf(options)
  progress('checking')
  const plan = planSplit(split)
  if (typeof plan === 'string') return { kind: 'not-sent', message: plan }

  try {
    // Permission first: a reader who may not edit is usually refused the reads after it too.
    const refusal = editRefusal(await services.permission(graphene, readAs))
    if (refusal) return { kind: 'not-sent', message: refusal }
    // A min-cut is sent only where the server's own, previewed, makes this split.
    if ('mincut' in plan.asked) {
      const disagrees = await previewDisagrees(services, graphene, plan, split, readAs)
      if (disagrees) return { kind: 'not-sent', message: disagrees }
    }
    // Last before the send, to keep the moment before the server's lock short. A root names one
    // fixed graph, so a preview taken before this, of a root still current, still holds.
    const [current] = await services.latest(graphene, [root], readAs)
    if (current !== true) {
      return {
        kind: 'not-sent',
        message: `${root} has been edited since it was read, so this split is not sent. Press K over the neuron again.`,
      }
    }
  } catch (error) {
    return {
      kind: 'not-sent',
      message: `The check before splitting failed: ${errorMessage(error)}`,
    }
  }
  let confirmed: ConfirmedSplit
  try {
    confirmed = confirmSplit(graphene, plan.asked)
  } catch (error) {
    // A fault in building the split, never the reader's: said, and nothing sent.
    return { kind: 'not-sent', message: errorMessage(error) }
  }

  progress('splitting')
  const waitMs = services.sendTimeoutMs ?? SEND_TIMEOUT_MS
  // In an async function, so a send that throws is a rejection — read as `unknown`, the safe way:
  // the writer throws only before sending, but that cannot be told from here.
  const sent = (async () => services.send(confirmed, options))().catch(
    (error: unknown): EditOutcome => ({ kind: 'unknown', message: errorMessage(error) }),
  )
  const answered = await within(sent, waitMs)
  // Still out: handed on, so nothing else is sent for this neuron until it answers.
  const late = answered ? undefined : sent
  const outcome: EditOutcome = answered ?? {
    kind: 'unknown',
    message: `no answer after ${Math.round(waitMs / 1000)} s; it may still be made`,
  }
  if (outcome.kind === 'refused') {
    return { kind: 'refused', message: `Refused (${outcome.status}): ${outcome.message}` }
  }
  const said =
    outcome.kind === 'done' ? `The server answered (operation ${outcome.operationId})` : ''
  if (outcome.kind === 'done' && outcome.newRootIds.length === 1) {
    return {
      kind: 'joined',
      done: outcome,
      message: `${said} with one new root, ${outcome.newRootIds[0]}: the neuron is still one piece, with these edges gone. Undo restores them.`,
    }
  }

  progress('reading')
  const after = await readBack(services, graphene, root, plan, readAs)
  if (outcome.kind === 'unknown') {
    const found =
      after.kind === 'unread'
        ? `, and its roots could not be read: ${after.message}`
        : after.kind === 'unchanged'
          ? `. Its ends were still under ${root} when read, but a split can land after its reply is lost.`
          : after.kind === 'joined'
            ? `. Its two sides' ends were found under one root, ${after.roots.join(', ')}: the neuron is whole, but an edit with these edges gone may have landed — check it before anything else.`
            : `. Its ends are now under ${after.roots.join(', ')}.`
    return {
      kind: 'unknown',
      message: `The reply was lost (${outcome.message}), so whether the neuron was split is not known${found} It is not sent again.`,
      late,
    }
  }

  const done = outcome
  switch (after.kind) {
    case 'unread':
      return {
        kind: 'split',
        done,
        kept: undefined,
        taken: done.newRootIds,
        message: `${said} with ${done.newRootIds.length} new roots, but they could not be read back: ${after.message}`,
      }
    case 'unchanged':
      return {
        kind: 'unknown',
        done,
        message: `${said} with new roots, but every end is still under ${root}: nothing seems kept. Not sent again.`,
      }
    case 'joined':
      return {
        kind: 'joined',
        done,
        message: `${said}, but the two sides' ends are still under one root: the neuron is still one piece where it was cut. Undo restores the edges.`,
      }
    case 'split':
      return {
        kind: 'split',
        done,
        kept: after.kept,
        taken: done.newRootIds.filter((id) => id !== after.kept),
        message:
          after.kept === undefined
            ? `${said}; the larger side's ends are under several roots.`
            : done.newRootIds.length > 2
              ? `${said} with ${done.newRootIds.length} new roots: the cut broke off more than one piece.`
              : undefined,
      }
  }
}

interface Plan {
  /**
   * What is asked of the server, decided here once: a one-edge cut as it is, a longer one as the
   * server's min-cut between its sides (`SplitAsked` says why).
   */
  readonly asked: SplitAsked
  /** The cut's ends on each side, each once: the read back's, and a min-cut's seeds. */
  readonly sources: readonly MergeEnd[]
  readonly sinks: readonly MergeEnd[]
  /** The larger side, as the tiles name it. */
  readonly kept: SplitSide
}

/**
 * The cut checked once more against the box, each edge oriented from its side `a` end — or why
 * not, in a sentence. An end's position is its level-2 chunk's point (logged with the edit, and a
 * min-cut's box is drawn around them), the press's point where its chunk has none.
 */
function planSplit({ input, candidate }: SplitToWrite): Plan | string {
  const sides = splitOf(input, candidate.cut)
  if (!sides)
    return 'This split does not separate the neuron when checked again, so it is not sent.'
  const chunkOf = chunkOfMembers(input.members)
  const endOf = (supervoxel: string): MergeEnd => ({
    supervoxel,
    positionNm: input.positions.get(chunkOf.get(supervoxel)!) ?? input.click,
  })
  const pairs = new Set<string>()
  const sources = new Map<string, MergeEnd>()
  const sinks = new Map<string, MergeEnd>()
  for (const { source, sink } of candidate.cut) {
    // Each end's own side, never its chunk's: an end on a third piece is on neither.
    const [one, other] = [sides.sideOf(source), sides.sideOf(sink)]
    if (one === undefined || other === undefined || one === other) {
      return `The cut's edge ${source}–${sink} does not run between the two sides, so the split is not sent.`
    }
    const [from, to] = one === 'a' ? [source, sink] : [sink, source]
    pairs.add(`${from}|${to}`)
    if (!sources.has(from)) sources.set(from, endOf(from))
    if (!sinks.has(to)) sinks.set(to, endOf(to))
  }
  const [a, b] = [[...sources.values()], [...sinks.values()]]
  return {
    asked:
      pairs.size === 1
        ? { edge: { source: a[0]!, sink: b[0]! } }
        : { mincut: { sources: a, sinks: b } },
    sources: a,
    sinks: b,
    kept: sides.sizes.a >= sides.sizes.b ? 'a' : 'b',
  }
}

/**
 * Why the server's own min-cut, seeded with the cut's two sides, would not make exactly this
 * split — or undefined where it would. Its preview must not be one the server refuses, must keep
 * every seed on its side, must hold no supervoxel outside the box Coda read (where nothing can be
 * checked), and **the edges it cuts must be the tile's cut, no more and no fewer**: an edge of the
 * box runs between two of its pieces only where the server cut it, so that set is the server's cut.
 */
async function previewDisagrees(
  services: SplitWriteServices,
  graphene: GrapheneSource,
  plan: Plan,
  { input, candidate }: SplitToWrite,
  options: CaveRequestOptions,
): Promise<string | undefined> {
  const preview = await services.preview(graphene, plan.sources, plan.sinks, options)
  const not =
    'so it is not sent. Splitting with two points in Neuroglancer lets you choose the cut there.'
  if (preview.illegal) {
    return `The server's own cut between this split's sides would be one it refuses to make, ${not}`
  }
  const pieceOf = new Map<string, number>()
  preview.pieces.forEach((piece, i) => {
    for (const sv of piece) pieceOf.set(sv, i)
  })
  if (
    !plan.sources.every((end) => pieceOf.get(end.supervoxel) === 0) ||
    !plan.sinks.every((end) => pieceOf.get(end.supervoxel) === 1)
  ) {
    return `The server's own cut would not keep this split's two sides apart where it was asked, ${not}`
  }
  const known = chunkOfMembers(input.members)
  if ([...pieceOf.keys()].some((sv) => !known.has(sv))) {
    return `The server's own cut would reach past the part of the neuron Coda read, where it cannot be checked, ${not}`
  }
  const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`)
  const tile = new Set(candidate.cut.map((edge) => key(edge.source, edge.sink)))
  const server = new Set<string>()
  const { a, b } = input.wide
  for (let i = 0; i < a.length; i++) {
    const [p, q] = [pieceOf.get(a[i]!), pieceOf.get(b[i]!)]
    if (p !== undefined && q !== undefined && p !== q) server.add(key(a[i]!, b[i]!))
  }
  const differ =
    [...server].filter((edge) => !tile.has(edge)).length +
    [...tile].filter((edge) => !server.has(edge)).length
  return differ === 0
    ? undefined
    : `The server's own cut would differ from this split's by ${differ} edge${differ === 1 ? '' : 's'}, ${not}`
}

/** What the roots read after a send say about the two sides' ends. */
type ReadBack =
  | { readonly kind: 'unread'; readonly message: string }
  /** Every end still under the root that was split. */
  | { readonly kind: 'unchanged' }
  /** Some end of each side under one root. */
  | { readonly kind: 'joined'; readonly roots: readonly string[] }
  /** Apart: `kept` the larger side's root where its ends are under one. */
  | {
      readonly kind: 'split'
      readonly kept: string | undefined
      readonly roots: readonly string[]
    }

async function readBack(
  services: SplitWriteServices,
  graphene: GrapheneSource,
  root: string,
  { sources, sinks, kept }: Plan,
  options: CaveRequestOptions,
): Promise<ReadBack> {
  const a = sources.map((end) => end.supervoxel)
  const b = sinks.map((end) => end.supervoxel)
  const ends = [...a, ...b]
  const roots = await rootsOrError(() => services.roots(graphene, ends, options), ends.length)
  if (typeof roots === 'string') return { kind: 'unread', message: roots }
  const all = [...new Set(roots)]
  if (all.length === 1 && all[0] === root) return { kind: 'unchanged' }
  const rootsA = new Set(roots.slice(0, a.length))
  const rootsB = new Set(roots.slice(a.length))
  if ([...rootsA].some((one) => rootsB.has(one))) return { kind: 'joined', roots: all }
  const keptRoots = kept === 'a' ? rootsA : rootsB
  return {
    kind: 'split',
    kept: keptRoots.size === 1 ? [...keptRoots][0] : undefined,
    roots: all,
  }
}
