/**
 * Following the reviewed neuron through an edit this card did not make — a split, usually
 * (`docs/seam-split-review-plan.md`, phase 2). **Reads only**: the roots its tips' supervoxels
 * are under now, and, at a tie, how big each part is. What a follow writes — on the reader's press, or on an edit said
 * to the card (`data/cave/rootEdits.ts`) — is a
 * `FollowEntry` on the merge record (`mergeRecord.ts`), which moves the neuron's root as a merge
 * does; which tips leave the list is worked out from that entry (`cutOffTips`), by the card and
 * by the node's `evaluate` alike.
 *
 * ## Why supervoxels
 *
 * A split cuts the links between supervoxels and never changes one. So the supervoxel a tip was
 * found on (`tip_sv`, published by Find Merge Candidates) is under one part or the other afterwards, and
 * one batched lookup places every tip of the neuron: 1,581 in 374 ms on Aedes (phase 0).
 *
 * ## Which part is the neuron (user, 2026-11-24)
 *
 * The part holding the most of its tips; at a tie, the larger, by level-2 chunk count. On 120 past
 * Aedes splits the two agreed in all but one large case, an almost even split — so where another
 * part holds at least `NEAR_EVEN` as many tips, the card offers to follow that one instead.
 */

import { countStrings } from '../../core/collections'
import { errorMessage } from '../../core/errors'
import { compareIds } from '../../core/ids'
import type { CaveRequestOptions } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import { grapheneFor, l2ChunkCounts, supervoxelRoots } from '../../data/cave/rootIds'
import type {
  FollowEntry,
  MergeRecord,
  MergedSoFar,
  PieceFollow,
  RecordScope,
} from './mergeRecord'
import { isFollow, isPieceFollow, mergeEntries, mergedSoFar } from './mergeRecord'
import { piecesOf } from './pieces'
import type { AcceptedRow, QueueTip, Verdicts } from './reviewQueue'
import { acceptedPairs, acceptedPieces, gapOf } from './reviewQueue'

/** Where another part holds at least this share of the followed one's tips, it is offered too. */
export const NEAR_EVEN = 0.8

/** What a follow places: the tips' supervoxels, and each merged piece's. */
export interface FollowAnchors {
  /** The neuron's own tips' and its merged pieces' tips' `tip_sv`. */
  readonly tips: readonly string[]
  /** Pieces this workflow merged into the neuron, each with the supervoxel it was merged by. */
  readonly pieces: readonly { readonly id: string; readonly supervoxel: string }[]
  /**
   * Merged pieces whose supervoxel the record no longer holds (a short entry, `shortenedRecord`):
   * not placed, so they stay in the neuron whatever part they went with. Said, not hidden.
   */
  readonly unknown?: number
}

export interface FollowRequest {
  readonly scope: RecordScope
  readonly reviewedRoot: string
  /** The neuron's root as the record has it: the one found outdated, or followed last. */
  readonly from: string
  readonly anchors: FollowAnchors
  /** The part to follow, where the reader chose one (`others`); else the rule above decides. */
  readonly prefer?: string | undefined
}

export type FollowAnswer =
  | { readonly ok: true; readonly entry: FollowEntry }
  | { readonly ok: false; readonly message: string }

/** What a follow asks of the servers, apart so it can be tested without one. */
export interface FollowServices {
  graphene(datastack: string, options: CaveRequestOptions): Promise<GrapheneSource | undefined>
  roots(
    graphene: GrapheneSource,
    supervoxels: readonly string[],
    options: CaveRequestOptions,
  ): Promise<string[]>
  sizes(
    graphene: GrapheneSource,
    roots: readonly string[],
    options: CaveRequestOptions,
  ): Promise<Map<string, number>>
  now(): Date
}

const LIVE: FollowServices = {
  graphene: grapheneFor,
  // At the server's now: where the parts are as the reader sees them.
  roots: (graphene, supervoxels, options) =>
    supervoxelRoots(graphene, supervoxels, 'server', options),
  sizes: l2ChunkCounts,
  now: () => new Date(),
}

/**
 * Read where the neuron's tips are now and decide the part to follow — or say, in a sentence, why
 * the neuron cannot be followed. Throws only for a cancel.
 */
export async function followEdit(
  request: FollowRequest,
  options: CaveRequestOptions,
  services: FollowServices = LIVE,
): Promise<FollowAnswer> {
  const { anchors } = request
  if (anchors.tips.length === 0) {
    return {
      ok: false,
      message:
        'These suggestions say nothing about which supervoxel each tip is on, so where the tips ' +
        'went cannot be read. Run Find Merge Candidates again on the neuron’s new root.',
    }
  }
  try {
    const supervoxels = [...anchors.tips, ...anchors.pieces.map((piece) => piece.supervoxel)]
    const read = await rootsNow(request.scope.datastack, supervoxels, options, services)
    if ('message' in read) return { ok: false, message: read.message }
    const { graphene, roots } = read
    const tipRoots = roots.slice(0, anchors.tips.length)
    const counts = tipsPerRoot(tipRoots)
    if (counts.length === 0) {
      return { ok: false, message: 'None of the neuron’s tips is on any object now.' }
    }
    let to = request.prefer
    if (to === undefined) {
      const top = counts.filter((one) => one.tips === counts[0]!.tips).map((one) => one.root)
      to = top.length === 1 ? top[0]! : await largest(top, graphene, options, services)
    }
    // A part chosen from an earlier reading may have been edited since: it must hold a tip now.
    if (request.prefer !== undefined && !counts.some((one) => one.root === request.prefer)) {
      return {
        ok: false,
        message: `${request.prefer} holds none of the neuron’s tips now; it may have been edited since.`,
      }
    }
    // Chosen, it may be the root already followed: tips searched since are placed again.
    if (request.prefer === undefined && to === request.from) {
      return {
        ok: false,
        message: 'The neuron has not been edited: there is nothing to follow.',
      }
    }
    const away = anchors.tips.filter((_, at) => elsewhere(tipRoots[at], to))
    // As for a tip, a piece on no object is not said to have gone anywhere.
    const left = anchors.pieces
      .filter((_, at) => elsewhere(roots[anchors.tips.length + at], to))
      .map((piece) => piece.id)
    return {
      ok: true,
      entry: {
        kind: 'followed',
        deployment: request.scope.deployment,
        datastack: request.scope.datastack,
        reviewedRoot: request.reviewedRoot,
        from: request.from,
        to,
        at: services.now().toISOString(),
        away,
        placed: [...anchors.tips],
        kept: counts.find((one) => one.root === to)?.tips ?? 0,
        others: counts.filter((one) => one.root !== to),
        left,
      },
    }
  } catch (error) {
    return unread(error, 'Where the neuron’s tips went')
  }
}

/** Each supervoxel's root at the server's now, with the chunkedgraph asked — or why not. */
async function rootsNow(
  datastack: string,
  supervoxels: readonly string[],
  options: CaveRequestOptions,
  services: Pick<FollowServices, 'graphene' | 'roots'>,
): Promise<{ graphene: GrapheneSource; roots: string[] } | { message: string }> {
  const graphene = await services.graphene(datastack, options)
  if (!graphene) return { message: `${datastack} has no chunkedgraph to ask.` }
  const roots = await services.roots(graphene, supervoxels, options)
  // One answer per supervoxel, or none is placed: a missing one would read as "on no object".
  if (roots.length !== supervoxels.length) {
    throw new Error(
      `the chunkedgraph answered ${roots.length} of ${supervoxels.length} supervoxels`,
    )
  }
  return { graphene, roots }
}

/**
 * Whether a supervoxel's root now is another part than `to` — and some object: one on none (`0`)
 * is not said to have gone anywhere, so its tip or piece is kept.
 */
const elsewhere = (root: string | undefined, to: string) => root !== to && root !== '0'

/** A read that failed, said; a cancel goes through as one. */
function unread(error: unknown, what: string): { ok: false; message: string } {
  if (error instanceof DOMException && error.name === 'AbortError') throw error
  return { ok: false, message: `${what} could not be read: ${errorMessage(error)}` }
}

/** How many tips each root holds, most first, then by id; `0` (no object) is not a part. */
function tipsPerRoot(roots: readonly string[]): { root: string; tips: number }[] {
  return [...countStrings(roots.filter((root) => root !== '0'))]
    .map(([root, tips]) => ({ root, tips }))
    .sort((a, b) => b.tips - a.tips || compareIds(a.root, b.root))
}

/** Of parts holding as many tips, the larger by level-2 chunks; the first listed where unknown. */
async function largest(
  roots: readonly string[],
  graphene: GrapheneSource,
  options: CaveRequestOptions,
  services: FollowServices,
): Promise<string> {
  const sizes = await services.sizes(graphene, roots, options)
  return roots.reduce((best, root) =>
    (sizes.get(root) ?? -1) > (sizes.get(best) ?? -1) ? root : best,
  )
}

/**
 * What following one piece of the list reads (`docs/seam-split-review-plan.md`, phase 4): the
 * contact supervoxel it is placed by, and its own tips' (where it was extended).
 */
export interface PieceAnchors {
  readonly piece: string
  /** Its root as the record has it now: its own, or the one it was followed to last. */
  readonly from: string
  /** `cand_sv` of its row nearest the neuron — among the rows it was accepted on, where it was. */
  readonly contact: string
  readonly tips: readonly string[]
}

/**
 * The anchors a follow of `piece` reads, or undefined where none of its rows says which supervoxel
 * its contact is on (a published set, a search before 2026-11-24): then it cannot be followed.
 *
 * Its contact is read off the rows **still listed** (`listed`, after `cutOffTips`): a row on a tip
 * that went with a part split off the neuron is no contact with it. The rows it was accepted on
 * come first, since its verdict is about those contacts; then its rows on the neuron's own tips,
 * then any other; each nearest gap first. Its own tips are read from `own`, the list before any
 * follow, so a follow places them all afresh.
 */
export function pieceAnchorsOf(
  listed: readonly QueueTip[],
  own: readonly QueueTip[],
  piece: string,
  from: string,
  /** `acceptedPieces` over `listed`, read once for every piece followed together. */
  acceptedHere: ReadonlyMap<string, readonly AcceptedRow[]>,
): PieceAnchors | undefined {
  const accepted = (acceptedHere.get(piece) ?? []).map((row) => row.candidate)
  const rows = listed
    .flatMap((tip) =>
      tip.candidates
        .filter((one) => one.candidateId === piece)
        .map((one) => ({ one, onNeuron: tip.neuronId === tip.seed })),
    )
    .sort((a, b) => Number(b.onNeuron) - Number(a.onNeuron) || gapOf(a.one) - gapOf(b.one))
    .map((row) => row.one)
  const contact = [...accepted, ...rows].find((one) => one.candSv !== undefined)?.candSv
  if (contact === undefined) return undefined
  const tips = own.flatMap((tip) =>
    tip.neuronId === piece && tip.tipSv !== undefined ? [tip.tipSv] : [],
  )
  return { piece, from, contact, tips }
}

export type PieceFollowAnswer =
  | {
      readonly ok: true
      /** One per piece edited since; a piece found as it was is in neither list. */
      readonly entries: readonly PieceFollow[]
      readonly refused: readonly { readonly piece: string; readonly message: string }[]
    }
  | { readonly ok: false; readonly message: string }

/**
 * Follow pieces of the list through an edit (reads only): one lookup of every contact and tip
 * supervoxel at the server's now. Each piece goes to the root its contact is under — the part that
 * touches the neuron, so its verdict carries over (user, 2026-11-24) — and its own tips on any
 * other root leave the list. A contact on no object refuses that piece. Throws only for a cancel.
 */
export async function followPieces(
  request: {
    readonly scope: RecordScope
    readonly reviewedRoot: string
    readonly pieces: readonly PieceAnchors[]
  },
  options: CaveRequestOptions,
  services: Pick<FollowServices, 'graphene' | 'roots' | 'now'> = LIVE,
): Promise<PieceFollowAnswer> {
  const { scope, reviewedRoot, pieces } = request
  try {
    const supervoxels = pieces.flatMap((one) => [one.contact, ...one.tips])
    const read = await rootsNow(scope.datastack, supervoxels, options, services)
    if ('message' in read) return { ok: false, message: read.message }
    const { roots } = read
    const at = services.now().toISOString()
    const entries: PieceFollow[] = []
    const refused: { piece: string; message: string }[] = []
    let next = 0
    for (const one of pieces) {
      const to = roots[next]!
      const tipRoots = roots.slice(next + 1, next + 1 + one.tips.length)
      next += 1 + one.tips.length
      if (to === '0' || to === undefined) {
        refused.push({
          piece: one.piece,
          message: `Where ${one.piece} meets the neuron is on no object now, so it cannot be followed.`,
        })
        continue
      }
      if (to === one.from) continue
      entries.push({
        kind: 'piece-followed',
        deployment: scope.deployment,
        datastack: scope.datastack,
        reviewedRoot,
        piece: one.piece,
        from: one.from,
        to,
        at,
        supervoxel: one.contact,
        away: one.tips.filter((_, i) => elsewhere(tipRoots[i], to)),
      })
    }
    return { ok: true, entries, refused }
  } catch (error) {
    return unread(error, 'Where the piece went')
  }
}

/**
 * Another part the card may offer to follow instead: the one with the most tips after the
 * followed, where it holds at least `NEAR_EVEN` as many.
 */
export function nearEvenOf(
  entry: FollowEntry | undefined,
): { readonly root: string; readonly tips: number } | undefined {
  const next = entry?.others[0]
  return entry && next && next.tips >= NEAR_EVEN * entry.kept ? next : undefined
}

/**
 * What a follow places for a neuron: its own tips' supervoxels and those of the tips of pieces
 * merged into it — `inNeuronOf`, its `pieces` **and its `left`**, so a piece the last follow lost is
 * placed again and an undone split gives it back — and those pieces' own. A piece not merged yet
 * is a separate root: its tips leave with the tip it was accepted on (`cutOffTips`).
 */
export function anchorsOf(
  mine: readonly QueueTip[],
  record: MergeRecord,
  reviewedRoot: string,
  so: Pick<MergedSoFar, 'pieces' | 'left' | 'pieceFollows'>,
): FollowAnchors {
  const inNeuron = inNeuronOf(so)
  const tips = new Set<string>()
  for (const tip of mine) {
    if (tip.tipSv === undefined) continue
    if (tip.neuronId === reviewedRoot || inNeuron.has(tip.neuronId)) tips.add(tip.tipSv)
  }
  // Each piece by the merge that took it in: the first `merged` or `already-merged` entry.
  const pieces = new Map<string, string>()
  let unknown = 0
  for (const entry of mergeEntries(record)) {
    if (entry.reviewedRoot !== reviewedRoot || !inNeuron.has(entry.candidateRoot)) continue
    if (entry.outcome !== 'merged' && entry.outcome !== 'already-merged') continue
    if (pieces.has(entry.candidateRoot)) continue
    if ('short' in entry) {
      unknown += 1
      continue
    }
    pieces.set(entry.candidateRoot, entry.candidate.supervoxel)
  }
  // A piece merged in by hand, found so by its follow (`PieceFollow`): placed by its contact.
  for (const [id, follow] of so.pieceFollows) {
    if (inNeuron.has(id) && !pieces.has(id)) pieces.set(id, follow.supervoxel)
  }
  return {
    tips: [...tips],
    pieces: [...pieces].map(([id, supervoxel]) => ({ id, supervoxel })),
    unknown,
  }
}

/**
 * The tips a follow takes off the list, as text (`seed|root|end_uid`, sorted; `''` for none) — the
 * form `unreachedTips` answers in, so the card can compare it by value and `withoutTips` drop it.
 * They are every tip a follow found on another part (`FollowEntry.away`) — the neuron's own, and
 * those of pieces merged into it — **and the tips of every piece no longer reached** through
 * accepted pieces once those are gone: where an accepted piece sits is one derivation, `piecesOf`
 * over the accepted pairs, so a piece accepted only at a dropped tip, and everything beyond it,
 * goes too. One function for the card and for the node's `evaluate`, so the list, Submit's plan and
 * `Layers` cannot disagree about what is left. A tip with no supervoxel is never dropped.
 */
export function cutOffTips(
  queue: readonly QueueTip[],
  record: MergeRecord,
  scope: RecordScope | undefined,
  verdicts: Verdicts,
): string {
  const cut = new Map<
    string,
    {
      away: ReadonlySet<string>
      inNeuron: ReadonlySet<string>
      left: ReadonlySet<string>
      /** Each followed piece's own tips found on another root (`PieceFollow.away`). */
      pieceAway: ReadonlyMap<string, ReadonlySet<string>>
    }
  >()
  const seeds = record.filter((e) => isFollow(e) || isPieceFollow(e)).map((e) => e.reviewedRoot)
  for (const seed of new Set(seeds)) {
    const so = mergedSoFar(record, seed, scope)
    const pieceAway = new Map(
      [...so.pieceFollows]
        .filter(([, f]) => f.away.length > 0)
        .map(([id, f]) => [id, new Set(f.away)]),
    )
    if (so.followed || pieceAway.size > 0) {
      cut.set(seed, {
        away: new Set(so.followed?.away),
        inNeuron: so.pieces,
        left: so.left,
        pieceAway,
      })
    }
  }
  const merged = (tip: QueueTip, of: { inNeuron: ReadonlySet<string> }) =>
    tip.neuronId === tip.seed || of.inNeuron.has(tip.neuronId)
  // Away by its supervoxel, or the tip of a merged piece the follow lost: gone with it.
  const away = (tip: QueueTip) => {
    const of = cut.get(tip.seed)
    if (of === undefined) return false
    if (of.left.has(tip.neuronId)) return true
    if (tip.tipSv === undefined) return false
    // A followed piece's own tip on a part the piece was not followed to.
    if (of.pieceAway.get(tip.neuronId)?.has(tip.tipSv)) return true
    return of.away.has(tip.tipSv) && merged(tip, of)
  }
  if (!queue.some(away)) return ''
  const rest = queue.filter((tip) => !away(tip))
  /*
   * Walked from the neuron **and the pieces still merged into it**, as Submit's plan walks
   * (`acceptedTree`): a piece accepted on a merged piece's tip hangs on that piece, whichever tip of
   * the neuron the merged piece was accepted at. Each start is read back as its neuron.
   */
  const ownerOf = new Map<string, string>()
  for (const [seed, of] of cut) {
    ownerOf.set(seed, seed)
    for (const id of of.inNeuron) ownerOf.set(id, seed)
  }
  const reached = new Set(
    piecesOf(acceptedPairs(acceptedPieces(rest, verdicts)), [...ownerOf.keys()]).map(
      (piece) => `${ownerOf.get(piece.seed)}|${piece.id}`,
    ),
  )
  return queue
    .filter((tip) => {
      const of = cut.get(tip.seed)
      if (of === undefined) return false
      return away(tip) || (!merged(tip, of) && !reached.has(`${tip.seed}|${tip.neuronId}`))
    })
    .map((tip) => `${tip.seed}|${tip.neuronId}|${tip.endUid}`)
    .sort()
    .join(';')
}

/**
 * The roots whose tips are the neuron's now: the pieces merged into it **and those the last follow
 * lost** (`MergedSoFar.left`), whose tips are placed by their own supervoxels, as the neuron's are.
 */
export function inNeuronOf(so: Pick<MergedSoFar, 'pieces' | 'left'>): ReadonlySet<string> {
  return new Set([...so.pieces, ...so.left])
}
