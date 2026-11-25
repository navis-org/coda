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
 * found on (`tip_sv`, published by Suggest Merges) is under one part or the other afterwards, and
 * one batched lookup places every tip of the neuron: 1,581 in 374 ms on Aedes (phase 0).
 *
 * ## Which part is the neuron (user, 2026-11-24)
 *
 * The part holding the most of its tips; at a tie, the larger, by level-2 chunk count. On 120 past
 * Aedes splits the two agreed in all but one large case, an almost even split — so where another
 * part holds at least `NEAR_EVEN` as many tips, the card offers to follow that one instead.
 */

import { countStrings } from '../../core/collections'
import { compareIds } from '../../core/ids'
import type { CaveRequestOptions } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import { grapheneFor, l2ChunkCounts, supervoxelRoots } from '../../data/cave/rootIds'
import type { FollowEntry, MergeRecord, MergedSoFar, RecordScope } from './mergeRecord'
import { isFollow, mergeEntries, mergedSoFar } from './mergeRecord'
import { piecesOf } from './pieces'
import type { QueueTip, Verdicts } from './reviewQueue'
import { acceptedPairs, acceptedPieces } from './reviewQueue'

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
        'went cannot be read. Run Suggest Merges again on the neuron’s new root.',
    }
  }
  try {
    const graphene = await services.graphene(request.scope.datastack, options)
    if (!graphene) {
      return { ok: false, message: `${request.scope.datastack} has no chunkedgraph to ask.` }
    }
    const supervoxels = [...anchors.tips, ...anchors.pieces.map((piece) => piece.supervoxel)]
    const roots = await services.roots(graphene, supervoxels, options)
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
    const away = anchors.tips.filter((_, at) => tipRoots[at] !== to && tipRoots[at] !== '0')
    // As for a tip, a piece on no object is not said to have gone anywhere.
    const left = anchors.pieces
      .filter((_, at) => {
        const root = roots[anchors.tips.length + at]
        return root !== to && root !== '0'
      })
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
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      ok: false,
      message: `Where the neuron’s tips went could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
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
  so: Pick<MergedSoFar, 'pieces' | 'left'>,
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
    { away: ReadonlySet<string>; inNeuron: ReadonlySet<string>; left: ReadonlySet<string> }
  >()
  for (const seed of new Set(record.filter(isFollow).map((entry) => entry.reviewedRoot))) {
    const so = mergedSoFar(record, seed, scope)
    if (so.followed) {
      cut.set(seed, { away: new Set(so.followed.away), inNeuron: so.pieces, left: so.left })
    }
  }
  const merged = (tip: QueueTip, of: { inNeuron: ReadonlySet<string> }) =>
    tip.neuronId === tip.seed || of.inNeuron.has(tip.neuronId)
  // Away by its supervoxel, or the tip of a merged piece the follow lost: gone with it.
  const away = (tip: QueueTip) => {
    const of = cut.get(tip.seed)
    if (of === undefined) return false
    if (of.left.has(tip.neuronId)) return true
    return tip.tipSv !== undefined && of.away.has(tip.tipSv) && merged(tip, of)
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
