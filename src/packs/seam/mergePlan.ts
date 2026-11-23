/**
 * The pre-flight behind Submit: which of the picked neuron's accepted pieces can be merged, and
 * why each of the rest cannot (`docs/seam-merge-plan.md`, phase 3). **Reads only** — it imports
 * nothing that writes, and `importGraph.test.ts` keeps the writer out of reach.
 *
 *  1. **The accepted pieces** (`acceptedPieces`, the rule the scene's green pieces read too).
 *  2. **Minus what this workflow has already merged** (`mergedSoFar` over the record), which also
 *     says what the neuron's root is now: each merge gives it a new one.
 *     A piece that is another neuron in the queue is planned, flagged (`joinsNeuron`).
 *  3. **Permission** (`editPermission`), then **currency at the server's now**: the neuron's root,
 *     then every piece's. An outdated neuron refuses every piece (user, 2026-11-15); an outdated
 *     piece is refused on its own.
 *  4. **Anchors** for each current piece (`mergeAnchors.ts`), trying its rows in turn.
 *
 * ## A neuron grown piece by piece is a tree of merges
 *
 * A piece can be accepted on a tip of another accepted piece (`docs/seam-extend-plan.md`), and
 * none of it is merged before Submit. So the plan is a tree, and four things follow:
 *
 *  - **Listed parents first.** `merges` lists a piece after every piece between it and the
 *    neuron, which is how the dialog's ticks read it; the batch sends from the tips in.
 *  - **A merge's neuron end may be on a piece that is not in the neuron yet.** The search measured
 *    the contact to the neuron and the pieces between read as one object, so the anchor is looked
 *    for on any of them (`AnchorPair.alsoNeuron`), and `needs` names the piece it landed on. The
 *    batch merges it onto that piece, wherever that piece is by then (`mergeBatch.ts`).
 *  - **A piece is refused where a piece on its way to the neuron is** (`parent-refused`): it has
 *    nothing to be merged onto.
 *  - **Pieces this workflow joined short of the neuron** — a batch that stopped part way —
 *    **are one piece now**, under one root (`MergedSoFar.joined`). The farthest in of them is
 *    planned at that root (`pieceRoot`) and carries the rest; the others are `joined`.
 *
 * ## Why step 3 needs no lineage lookup
 *
 * A piece that is not current is `outdated`, never "already merged by someone else": a merge
 * into the neuron gives the **neuron** a new root, so the neuron's expected root would no longer
 * be current and every piece is refused first. With that root current, nothing has touched the
 * neuron, so the piece changed elsewhere. This workflow's own merges come from the record. The
 * plan doc had `get_latest_roots` here; pychunkedgraph has no such route, and caveclient's walks
 * the root's lineage graph — for an edited neuron its whole history.
 *
 * ## One instant, and not the per-merge check
 *
 * The anchors and the currency are both read at the server's now — never the browser's clock,
 * which may be behind the server's and miss the roots this workflow's last batch made. Neither is
 * the guarantee: phase 5 asks each merge's two supervoxels again, at the server's now,
 * immediately before sending it. A plan is what the reader confirms, not a promise about the
 * moment of sending.
 */

import { errorMessage } from '../../core/errors'
import { slots as slotsOf } from '../../data/concurrency'
import type { CaveRequestOptions } from '../../data/cave/client'
import { datastackRecord } from '../../data/cave/datastack'
import type { GrapheneSource } from '../../data/cave/graphene'
import { parseGrapheneSource } from '../../data/cave/graphene'
import type { GraphLayout } from '../../data/cave/graphLayout'
import { isNodeId } from '../../data/cave/graphLayout'
import type { MergeEnd } from '../../data/cave/merge'
import type { EditPermission } from '../../data/cave/permissions'
import { editPermission, editRefusal } from '../../data/cave/permissions'
import type { Instant } from '../../data/cave/rootIds'
import { isLatestRoots, rootTimestamps, supervoxelRoots } from '../../data/cave/rootIds'
import type { AnchorPair, AnchorRefusal, AnchorVolume, Anchors } from './mergeAnchors'
import { anchorMerge, openAnchorVolume } from './mergeAnchors'
import type { AcceptedRow, QueueTip, Verdicts } from './reviewQueue'
import type { MergeRecord, MergeRecordEntry } from './mergeRecord'
import { mergedSoFar, rootNow as rootNowIn, settledEntry, sharedNewRoot } from './mergeRecord'
import { piecesOf, verdictKey } from './pieces'
import { acceptedPairs, acceptedPieces, tipsOf } from './reviewQueue'

/** Why an accepted piece is not in the plan. Every one is a reason not to send. */
export type PlanRefusal =
  /** This workflow merged it already, or it is the neuron itself (any root it has had). */
  | 'already-merged'
  /** This workflow merged it into another reviewed neuron already: it is part of that one now. */
  | 'merged-elsewhere'
  /** Its root is not current: the piece was edited since the suggestions were made. */
  | 'outdated'
  /** The neuron's root is not current, so none of its merges is made (user, 2026-11-15). */
  | 'neuron-outdated'
  /** A piece between it and the neuron cannot be merged, so it has nothing to be merged onto. */
  | 'parent-refused'
  /**
   * This workflow merged it onto the piece it was accepted on already, short of the neuron (a batch
   * that stopped part way): it goes in with that piece's merge, which is planned.
   */
  | 'joined'
  | AnchorRefusal

export interface PlannedMerge {
  readonly candidateRoot: string
  /** Every row the piece was accepted on, nearest gap first. */
  readonly rows: readonly AcceptedRow[]
  /** The row whose contact the merge is made at. */
  readonly used: AcceptedRow
  readonly neuron: MergeEnd
  readonly candidate: MergeEnd
  /**
   * The piece is itself another neuron under review (in the queue, or what this workflow merged
   * one into): the merge joins two reviewed neurons. Planned like any other, and **flagged** for
   * the dialog to show before the reader confirms (user, 2026-11-16).
   */
  readonly joinsNeuron: boolean
  /**
   * The piece it hangs on, where that is a piece this plan merges — `undefined` where it hangs
   * on the neuron itself, or on a piece already in it. What the dialog's ticks follow: unticked,
   * everything beyond it is unticked with it.
   */
  readonly parent?: string | undefined
  /**
   * The piece of this plan the neuron end is on, where it is not on the neuron as it stands.
   * Always earlier in `merges` — usually `parent`, not always: the candidate touches whichever
   * piece is there.
   *
   * **A merge waits for both** (`mergeBatch.ts`): `needs`, without which its end is not in the
   * neuron, and `parent`, without which the reader's reason for it is gone — it was accepted as
   * a continuation of that piece.
   */
  readonly needs?: string | undefined
  /**
   * The root the piece is under now, where that is not its own: pieces this workflow merged onto it
   * already, short of the neuron (`MergedSoFar.joined`). What its end is checked against.
   */
  readonly pieceRoot?: string | undefined
  /**
   * Accepted by Auto-extend alone: every pair it was accepted on is in `PlanRequest.unjudged`.
   * The dialog tags it, and once merged it goes to SEAM as `auto-accepted`, never as `accept`
   * (`docs/seam-auto-extend-plan.md`).
   */
  readonly auto: boolean
}

export interface RejectedMerge {
  readonly candidateRoot: string
  readonly rows: readonly AcceptedRow[]
  readonly reason: PlanRefusal
  readonly message: string
}

export type MergePlan =
  /** Nothing can be planned: no permission, not a chunkedgraph, or a check that failed. */
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true
      readonly datastack: string
      readonly graphene: GrapheneSource
      /** The neuron as the queue names it. */
      readonly reviewedRoot: string
      /** Its root now: the reviewed one, or the last this workflow's merges produced. */
      readonly currentRoot: string
      /**
       * Lost replies the roots show were made (`MergedSoFar.unsettled`), as the entries that say
       * so (`settledEntry`): the plan is made as if they were recorded. The caller appends them as
       * soon as the plan arrives, whether or not anything is merged after them.
       */
      readonly settled?: readonly MergeRecordEntry[] | undefined
      /**
       * The chunkedgraph's id layout, from the anchor volume: what `prepareMerges` checks every
       * end is a supervoxel with. Present whenever `merges` is not empty.
       */
      readonly layout?: GraphLayout | undefined
      /** From the neuron outwards: a piece after every piece between it and the neuron. */
      readonly merges: readonly PlannedMerge[]
      /** In the same order. */
      readonly rejected: readonly RejectedMerge[]
    }

/** A plan that was made — what the confirm overlay is opened with, and the batch runs. */
export type ReadyPlan = Extract<MergePlan, { ok: true }>

export interface PlanRequest {
  /** With the options' deployment, where it is planned and which record entries count. */
  readonly datastack: string
  /** The whole queue: the plan takes the reviewed neuron's tips from it, and no other's. */
  readonly queue: readonly QueueTip[]
  readonly reviewedRoot: string
  readonly verdicts: Verdicts
  /**
   * The accepts in `verdicts` that are Auto-extend's alone, by pair (`autoJudged().unjudged`) —
   * what marks a merge `auto`. Absent is none.
   */
  readonly unjudged?: ReadonlyMap<string, string> | undefined
  readonly record: MergeRecord
  /**
   * Progress through the anchor step, the one that takes the time: how many of the pieces that
   * reached it are decided — found, refused, or refused for a parent — of how many. Not called
   * before it, whose requests are one each. `onProgress`, as the readers' `(done, total)` is.
   */
  readonly onProgress?: (done: number, total: number) => void
}

/**
 * How many pieces' anchors are read at once. Six: about four and a half times one at a time, and
 * flat past it, the bytes being the limit there — measured in `docs/seam-merge-plan.md`, phase 3,
 * step 4 (`pnpm probe:seam-anchors`).
 */
export const ANCHORS_IN_FLIGHT = 6

/** What the plan asks of the servers, apart so the logic can be tested without one. */
export interface PlanServices {
  /** The datastack's chunkedgraph, or undefined where it has none. */
  chunkedgraph(
    datastack: string,
    options: CaveRequestOptions,
  ): Promise<GrapheneSource | undefined>
  permission(graphene: GrapheneSource, options: CaveRequestOptions): Promise<EditPermission>
  latest(
    graphene: GrapheneSource,
    roots: readonly string[],
    options: CaveRequestOptions,
  ): Promise<boolean[]>
  openVolume(datastack: string, options: CaveRequestOptions): Promise<AnchorVolume>
  /** Each supervoxel's root at `at`, in order (`supervoxelRoots`). */
  roots(
    graphene: GrapheneSource,
    supervoxels: readonly string[],
    at: Instant,
    options: CaveRequestOptions,
  ): Promise<string[]>
  /** When each root was made, epoch ms (`rootTimestamps`). */
  created(
    graphene: GrapheneSource,
    roots: readonly string[],
    options: CaveRequestOptions,
  ): Promise<number[]>
  anchor(volume: AnchorVolume, pair: AnchorPair, options: CaveRequestOptions): Promise<Anchors>
}

const LIVE: PlanServices = {
  // The datastack record is held for the session (`datastackRecord`), so this costs nothing twice.
  chunkedgraph: async (datastack, options) =>
    parseGrapheneSource((await datastackRecord(datastack, options)).segmentation_source),
  permission: editPermission,
  latest: (graphene, roots, options) => isLatestRoots(graphene, roots, 'server', options),
  roots: supervoxelRoots,
  created: rootTimestamps,
  /*
   * At the server's now, as the currency check: a plan made right after a batch must see the roots
   * that batch made, and a browser clock behind the server's would ask about a moment before them
   * and find the neuron absent at every contact.
   */
  openVolume: (datastack, options) => openAnchorVolume(datastack, 'server', options),
  anchor: anchorMerge,
}

/** The pre-flight. Throws only for a cancel; every other failure is a plan that says so. */
export async function planMerges(
  request: PlanRequest,
  options: CaveRequestOptions,
  services: PlanServices = LIVE,
): Promise<MergePlan> {
  try {
    return await plan(request, options, services)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      ok: false,
      message: `The check before merging could not finish: ${errorMessage(error)}`,
    }
  }
}

async function plan(
  request: PlanRequest,
  options: CaveRequestOptions,
  services: PlanServices,
): Promise<MergePlan> {
  const { datastack, reviewedRoot } = request
  const { deployment } = options
  const graphene = await services.chunkedgraph(datastack, options)
  if (!graphene) {
    return {
      ok: false,
      message: `${datastack} has no chunkedgraph (no \`graphene://\` segmentation), so nothing can be merged there.`,
    }
  }

  // This workflow's own merges: what is done, the neuron's root now, and other neurons' pieces.
  const scope = { deployment, datastack }
  const recorded = mergedSoFar(request.record, reviewedRoot, scope)
  /*
   * Merges whose reply was lost and that nothing has settled: where one landed, its pieces are
   * under a root the record does not name, and the currency check below would refuse them on every
   * Submit. Read again with those that did, as the record will be once the caller appends them.
   */
  const at = new Date().toISOString()
  // Each its own pair of roots, so asked side by side.
  const settled = (
    await Promise.all(
      recorded.unsettled.map(async (entry) => {
        const newRoot = await settle(entry, graphene)
        return newRoot === undefined ? undefined : settledEntry(entry, newRoot, at)
      }),
    )
  ).filter((entry) => entry !== undefined)
  const own =
    settled.length === 0
      ? recorded
      : mergedSoFar([...request.record, ...settled], reviewedRoot, scope)
  const { currentRoot, pieces: inNeuron } = own
  /** A piece's root now: its own, or that of the pieces this workflow merged onto it. */
  const rootNow = (id: string) => rootNowIn(own.joined, id)
  /*
   * The tree grows from the neuron **as it stands**: the reviewed root and every piece this
   * workflow has merged into it already. A piece accepted on one of those is one step out,
   * whatever became of the accept that first brought that piece in, and is placed there rather
   * than under a piece that is still its own root.
   */
  const { pieces, pathOf } = acceptedTree(
    acceptedPieces(tipsOf(request.queue, reviewedRoot), request.verdicts),
    [reviewedRoot, ...inNeuron],
  )
  const rejected: RejectedMerge[] = []
  const reject = (candidateRoot: string, reason: PlanRefusal, message: string) =>
    rejected.push({ candidateRoot, rows: pieces.get(candidateRoot)!, reason, message })
  // Every root this neuron has had, and every root another reviewed neuron has or has had.
  const ownRoots = new Set([...own.roots, currentRoot])
  // By `seed`: a piece this neuron or another is extended with is not a neuron under review.
  const otherNeurons = new Set([...request.queue.map((tip) => tip.seed), ...own.otherRoots])
  for (const root of ownRoots) otherNeurons.delete(root)
  /** The piece it hangs on is under the same root: the two went together already. */
  const joinedOnto = (id: string): string | undefined => {
    const parent = pathOf.get(id)?.[0]
    return own.joined.has(id) && parent !== undefined && rootNow(parent) === rootNow(id)
      ? parent
      : undefined
  }
  /** Pieces joined with it short of the neuron that the reader no longer accepts. */
  const dropped = (id: string): string[] => {
    if (!own.joined.has(id)) return []
    const root = rootNow(id)
    return [...own.joined]
      .filter(([member, at]) => at === root && member !== id && !pieces.has(member))
      .map(([member]) => member)
  }
  const open = [...pieces.keys()].filter((candidateRoot) => {
    const onto = joinedOnto(candidateRoot)
    if (inNeuron.has(candidateRoot)) {
      reject(
        candidateRoot,
        'already-merged',
        'Merged into the neuron already, by this workflow.',
      )
    } else if (ownRoots.has(candidateRoot)) {
      reject(candidateRoot, 'already-merged', 'This is the neuron itself.')
    } else if (own.elsewhere.has(candidateRoot)) {
      reject(
        candidateRoot,
        'merged-elsewhere',
        'Merged into another neuron under review already, by this workflow.',
      )
    } else if (onto !== undefined) {
      reject(
        candidateRoot,
        'joined',
        `Merged onto ${onto} by this workflow already; it goes into the neuron with it.`,
      )
    } else if (dropped(candidateRoot).length > 0) {
      const names = dropped(candidateRoot)
      reject(
        candidateRoot,
        'joined',
        `This workflow merged it with ${names.join(', ')}, which ${names.length === 1 ? 'is' : 'are'} ` +
          'no longer accepted: merging it into the neuron would take them in too.',
      )
    } else if (!isNodeId(candidateRoot)) {
      // Before any request: one cell that is no id would fail the whole currency read.
      reject(candidateRoot, 'bad-id', `Not a segment id: ${candidateRoot}.`)
    } else {
      return true
    }
    return false
  })

  /** The plan as it stands, refusals in the order of their pieces, as merges are. */
  const order = new Map([...pieces.keys()].map((candidateRoot, i) => [candidateRoot, i]))
  const planned = (merges: PlannedMerge[], layout?: GraphLayout): MergePlan => ({
    ok: true,
    datastack,
    graphene,
    reviewedRoot,
    currentRoot,
    ...(settled.length > 0 ? { settled } : {}),
    ...(layout ? { layout } : {}),
    merges,
    rejected: [...rejected].sort(
      (a, b) => order.get(a.candidateRoot)! - order.get(b.candidateRoot)!,
    ),
  })
  // Nothing left to send: every piece's reason is already known, and no server is needed for it.
  if (open.length === 0) return planned([])
  if (!isNodeId(currentRoot)) {
    return { ok: false, message: `The neuron's id is not a segment id: ${currentRoot}.` }
  }

  /*
   * Permission first, then currency: one round trip slower than asking both at once, and worth
   * it — a reader who may not edit is usually refused the currency read too, and its 401/403
   * would replace the plan's own sentence and raise the token alarm.
   */
  const refusal = editRefusal(await services.permission(graphene, options))
  if (refusal) return { ok: false, message: refusal }

  const latest = await services.latest(graphene, [currentRoot, ...open.map(rootNow)], options)
  // One verdict per root, or currency is unknown — never a piece planned on a missing answer.
  if (latest.length !== open.length + 1) {
    throw new Error(
      `The currency check answered ${latest.length} of ${open.length + 1} roots, so which are current is unknown.`,
    )
  }
  if (!latest[0]) {
    for (const candidateRoot of open) {
      reject(
        candidateRoot,
        'neuron-outdated',
        `The neuron (${currentRoot}) has been edited since, so none of its merges is made. ` +
          'Run the suggestions again on its new root.',
      )
    }
    return planned([])
  }
  const current = open.filter((candidateRoot, i) => {
    if (latest[i + 1]) return true
    reject(
      candidateRoot,
      'outdated',
      rootNow(candidateRoot) === candidateRoot
        ? 'This piece has been edited since it was suggested.'
        : `This piece and the pieces this workflow merged onto it (${rootNow(candidateRoot)}) have been edited since.`,
    )
    return false
  })
  if (current.length === 0) return planned([])

  /*
   * Anchors, `ANCHORS_IN_FLIGHT` pieces at a time on one volume, which they share: its chunks,
   * and its memo of supervoxel roots, whose lookups are shared while in flight. The volume is
   * opened only now, once a current piece needs it.
   *
   * **A piece's box is read beside its parent's, and kept only if the parent anchors.** The read
   * needs only the pieces on its way to the neuron, never their anchors, so a chain of pieces
   * accepted on pieces runs side by side rather than a link at a time; a read under a parent that
   * is then refused is the one thing wasted. Tree order puts every parent first, so the slots go
   * to parents first and the waits cannot go round in a circle.
   */
  const volume = await services.openVolume(datastack, options)
  /** A failure about the datastack, the first: it ends the check, and the pieces waiting with it. */
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  /** That failure: the pieces it stops reject as aborted, sooner, and must not be what is said. */
  let failure: { error: unknown } | undefined
  const slots = slotsOf(ANCHORS_IN_FLIGHT)
  let done = 0
  const decided = new Map<string, Promise<PlannedMerge | undefined>>()
  /**
   * The pieces known to be refused, marked the moment they are — a failed anchor inside its slot,
   * before the slot passes on, often to the piece hanging on it — so a read still queued under
   * one does not start.
   */
  const refused = new Set<string>()
  for (const candidateRoot of current) {
    decided.set(
      candidateRoot,
      decide(candidateRoot).then((merge) => {
        done += 1
        try {
          request.onProgress?.(done, current.length)
        } catch {
          // A count that could not be shown is no reason to lose the plan it counts.
        }
        return merge
      }),
    )
  }
  const merges = await Promise.all(decided.values()).catch((error: unknown) => {
    stop.abort()
    throw failure ? failure.error : error
  })
  return planned(
    merges.filter((merge) => merge !== undefined),
    volume.layout,
  )

  /** One piece's merge, or undefined where it is refused, which says why. */
  async function decide(candidateRoot: string): Promise<PlannedMerge | undefined> {
    const rows = pieces.get(candidateRoot)!
    const path = pathOf.get(candidateRoot)
    if (path === undefined) {
      refused.add(candidateRoot)
      reject(
        candidateRoot,
        'parent-refused',
        'It has no way back to the neuron through the accepted pieces, so there is nothing to merge it onto.',
      )
      return undefined
    }
    /*
     * The pieces on the way that are still their own roots, nearest first. **The way stops at
     * the first piece that is in the neuron already**: from there inwards it is the neuron as it
     * stands, whatever became of the pieces beyond — one that was edited and never merged does
     * not hold up a piece whose own parent is in.
     *
     * Only the nearest is waited for: its own way is this one less itself, so it anchors only
     * where every piece further in does.
     */
    const merged = path.findIndex((id) => inNeuron.has(id))
    const unmerged = merged < 0 ? path : path.slice(0, merged)
    /*
     * A piece on the way that this workflow joined to others short of the neuron goes in with the
     * merge of the farthest in of them (`joined`): that one is the merge waited for, and their
     * root is what its end is found on.
     */
    const carrier = (id: string) => {
      let last: string | undefined
      for (const other of unmerged) if (rootNow(other) === rootNow(id)) last = other
      return last
    }
    const parent = unmerged[0] === undefined ? undefined : carrier(unmerged[0])
    const alsoNeuron = [...new Set(unmerged.map(rootNow))]
    // A parent that is not being anchored at all was refused before this step.
    const before = parent === undefined ? undefined : decided.get(parent)
    const parentRefused = () => {
      refused.add(candidateRoot)
      reject(
        candidateRoot,
        'parent-refused',
        `${parent}, which lies between it and the neuron, cannot be merged, so this piece has nothing to be merged onto.`,
      )
      return undefined
    }
    if (parent !== undefined && before === undefined) return parentRefused()
    /*
     * The neuron's side is **the neuron and the pieces on this piece's own way to it** — what
     * the reader accepted it as a continuation of. Not every piece planned so far: two pieces
     * accepted on neighbouring tips of the neuron would then be merged onto each other, an edge
     * nobody accepted, and each would wait for the other. Whatever the anchor lands on is merged
     * before this (`needs`), and the batch checks the end is under its root at that moment.
     */
    const [read, parentMerge] = await Promise.all([
      slots.run(async () => {
        // Any piece on the way, not only the parent: one further in may be refused while the
        // parent's own read is still out.
        if (unmerged.some((id) => refused.has(id))) {
          refused.add(candidateRoot)
          return undefined
        }
        try {
          const got = await anchorRows(
            volume,
            currentRoot,
            alsoNeuron,
            rootNow(candidateRoot),
            rows,
          )
          if (!got.anchors.ok) refused.add(candidateRoot)
          return got
        } catch (error) {
          /*
           * A read under a parent that is then refused is one the one-at-a-time loop never
           * sent, so its failure is not the check's: wait for the parent, and where it is
           * refused, say that instead. Otherwise, before the slot passes on: nothing new is
           * sent after the first failure.
           */
          if (
            !signal.aborted &&
            before &&
            (await before.catch(() => undefined)) === undefined
          ) {
            refused.add(candidateRoot)
            return undefined
          }
          failure ??= { error }
          stop.abort()
          throw error
        }
      }, signal),
      before,
    ])
    // No read is only ever a parent refused, which this says.
    if (!read || (parent !== undefined && parentMerge === undefined)) return parentRefused()
    const { row, anchors } = read
    if (!anchors.ok) {
      reject(candidateRoot, anchors.reason, anchors.message)
      return undefined
    }
    const on = anchors.onRoot
    const pieceRoot = rootNow(candidateRoot)
    return {
      candidateRoot,
      ...(pieceRoot === candidateRoot ? {} : { pieceRoot }),
      rows,
      used: row,
      neuron: anchors.neuron,
      candidate: anchors.candidate,
      joinsNeuron: otherNeurons.has(candidateRoot),
      // Every pair it was accepted on Auto-extend's alone — and there is at least one.
      auto:
        rows.length > 0 &&
        rows.every(
          (one) => request.unjudged?.has(verdictKey(one.neuronId, candidateRoot)) === true,
        ),
      parent,
      needs: on !== undefined && on !== currentRoot ? carrier(on) : undefined,
    }
  }

  /**
   * The root a lost reply made, where the roots show it was **this merge and nothing after it**:
   *
   *  1. both its supervoxels are under one new root at the server's now (`sharedNewRoot`), and
   *  2. just before that root was made, they were under exactly the two roots it was checked
   *     against — the neuron's (or the pieces' it was merged onto) and the piece's.
   *
   * The second is what tells our merge from somebody else's later edit: after one, both ends sit
   * under *their* root, made from ours, and adopting it would plan onto a neuron somebody else has
   * edited — what "an outdated neuron refuses every piece" forbids. So that case is left unsettled
   * and refused, as is any other.
   */
  async function settle(
    entry: MergeRecordEntry,
    on: GrapheneSource,
  ): Promise<string | undefined> {
    const ends = [entry.neuron.supervoxel, entry.candidate.supervoxel]
    const onto = entry.neuronRoot
    const newRoot = sharedNewRoot(await services.roots(on, ends, 'server', options), onto)
    if (newRoot === undefined) return undefined
    const [made] = await services.created(on, [newRoot], options)
    const before = await services.roots(on, ends, made! - 1, options)
    const piece = entry.candidateRootAt ?? entry.candidateRoot
    return before[0] === onto && before[1] === piece ? newRoot : undefined
  }

  /**
   * The first of a piece's rows that anchors, else the nearest row's refusal.
   *
   * **An anchor counts only where the root its neuron end is under is known to be the neuron's
   * side**: an end on any other root — or on one nobody named, where there is more than the
   * neuron to tell apart — cannot be confirmed, since nothing says it is part of the neuron
   * when the merge is sent. That row is refused and the next one tried.
   */
  async function anchorRows(
    on: AnchorVolume,
    neuronRoot: string,
    alsoNeuron: readonly string[],
    candidateRoot: string,
    rows: readonly AcceptedRow[],
  ): Promise<{ row: AcceptedRow; anchors: Anchors }> {
    let nearest: { row: AcceptedRow; anchors: Anchors } | undefined
    for (const row of rows) {
      const { contactNm, minDistUm } = row.candidate
      const anchors = await services.anchor(
        on,
        { neuronRoot, alsoNeuron, candidateRoot, contactNm, minDistUm },
        { ...options, signal },
      )
      const under = anchors.ok ? anchors.onRoot : undefined
      const known =
        under === undefined
          ? alsoNeuron.length === 0
          : under === neuronRoot || alsoNeuron.includes(under)
      if (anchors.ok && known) return { row, anchors }
      nearest ??= {
        row,
        anchors: anchors.ok
          ? {
              ok: false,
              reason: 'neuron-absent',
              message: `The merge point found is on ${under ?? 'a root that was not named'}, which is neither the neuron nor a piece between it and this one.`,
            }
          : anchors,
      }
    }
    return nearest!
  }
}

/**
 * The accepted pieces as a tree from the neuron outwards.
 *
 * **By `piecesOf`, the rule the search and the review card place a piece by** (`pieces.ts`): over
 * every root a piece was accepted on, it is put at the fewest steps from the neuron, then on the
 * lower parent id — so a piece accepted both on the neuron and on a piece of it is merged
 * straight onto the neuron, and two pieces accepted on each other cannot hold each other up. The
 * plan cannot be handed the card's own tree: that one holds the *extended* pieces only, and a
 * piece accepted on a piece's tip and never extended has to be placed too.
 *
 * - **Each piece on one root**, with only its rows there: it is merged once, onto one thing.
 * - **`pathOf`**: the pieces between it and the neuron, nearest first — empty for a piece
 *   accepted on the neuron itself, and **absent** for one with no way back to the neuron through
 *   the accepted pieces, which the plan refuses.
 * - **In tree order**: a piece after every piece on its path, and otherwise as the reader met
 *   them.
 */
export function acceptedTree(
  accepted: ReadonlyMap<string, readonly AcceptedRow[]>,
  seeds: readonly string[],
): { pieces: Map<string, AcceptedRow[]>; pathOf: Map<string, string[]> } {
  const pairs = acceptedPairs(accepted)
  const rowsOf = new Map<string, AcceptedRow[]>()
  const pathOf = new Map<string, string[]>()
  for (const placed of piecesOf(pairs, seeds)) {
    rowsOf.set(
      placed.id,
      accepted.get(placed.id)!.filter((row) => row.neuronId === placed.parent),
    )
    // `path` runs from the neuron to the piece; what lies between, nearest first.
    pathOf.set(placed.id, placed.path.slice(1, -1).reverse())
  }
  /*
   * By how far out, then as the reader met them — a piece after every piece on its path, and
   * otherwise in the order of the list they were accepted in. One with no way back keeps the
   * place it was met at: it is refused whatever its place, and its refusal is listed there.
   */
  const depth = (id: string) => pathOf.get(id)?.length ?? 0
  const pieces = new Map(
    [...accepted.keys()]
      .map((id, met) => ({ id, met }))
      .sort((a, b) => depth(a.id) - depth(b.id) || a.met - b.met)
      .map(({ id }) => [id, rowsOf.get(id) ?? [...accepted.get(id)!]]),
  )
  return { pieces, pathOf }
}

/**
 * The ticks of the confirm dialog after one is changed, kept to what can be sent.
 *
 * A piece accepted on a piece is merged onto it, so: **unticking a piece unticks every piece
 * that waits for it, and ticking a piece ticks every piece it waits for** (`PlannedMerge.parent`
 * and `needs`). The batch refuses a selection that breaks this (`prepareMerges`); here it
 * cannot be made.
 */
/**
 * The pieces of the plan a merge waits for: the one its neuron end is on, and the one it was
 * accepted as a continuation of. Each once. **The one spelling**, read by the dialog's ticks
 * and by the batch, so the ticks cannot make a list the batch refuses.
 */
export function waitsFor(merge: PlannedMerge): string[] {
  return [...new Set([merge.needs, merge.parent])].filter((id) => id !== undefined)
}

export function tickedWith(
  merges: readonly PlannedMerge[],
  ticked: ReadonlySet<string>,
  candidateRoot: string,
  on: boolean,
): Set<string> {
  const next = new Set(ticked)
  if (on) {
    // It, and everything it waits for, and everything those wait for.
    const byRoot = new Map(merges.map((merge) => [merge.candidateRoot, merge]))
    const todo = [candidateRoot]
    for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
      const merge = byRoot.get(at)
      if (!merge || next.has(at)) continue
      next.add(at)
      todo.push(...waitsFor(merge))
    }
    return next
  }
  next.delete(candidateRoot)
  return withoutOrphans(merges, next)
}

/** `ticked` less every piece whose way to the neuron passes through an unticked one. */
export function withoutOrphans(
  merges: readonly PlannedMerge[],
  ticked: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>()
  // Parents come first in `merges`, so one pass decides each piece after its parent.
  for (const merge of merges) {
    if (!ticked.has(merge.candidateRoot)) continue
    const held = waitsFor(merge).some((id) => !next.has(id))
    if (!held) next.add(merge.candidateRoot)
  }
  return next
}
