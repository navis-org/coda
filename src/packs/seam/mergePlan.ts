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
import type { CaveRequestOptions } from '../../data/cave/client'
import { datastackRecord } from '../../data/cave/datastack'
import type { GrapheneSource } from '../../data/cave/graphene'
import { parseGrapheneSource } from '../../data/cave/graphene'
import type { MergeEnd } from '../../data/cave/merge'
import type { EditPermission } from '../../data/cave/permissions'
import { editPermission } from '../../data/cave/permissions'
import type { Instant } from '../../data/cave/rootIds'
import { isLatestRoots, rootTimestamps, supervoxelRoots } from '../../data/cave/rootIds'
import type { AnchorPair, AnchorRefusal, AnchorVolume, Anchors } from './mergeAnchors'
import { anchorMerge, openAnchorVolume } from './mergeAnchors'
import type { AcceptedRow, QueueTip, Verdicts } from './reviewQueue'
import type { MergeRecord, MergeRecordEntry } from './mergeRecord'
import { mergedSoFar, sharedNewRoot } from './mergeRecord'
import { acceptedPieces, tipsOf } from './reviewQueue'

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
       * A lost reply the roots show was this merge (`MergedSoFar.unsettled`): `currentRoot` is
       * already its root. The caller records it as soon as the plan arrives (`settledEntry`),
       * whether or not anything is merged after it.
       */
      readonly settled?:
        { readonly entry: MergeRecordEntry; readonly newRoot: string } | undefined
      /** In the order the reader met them in the queue. */
      readonly merges: readonly PlannedMerge[]
      /** In the same order. */
      readonly rejected: readonly RejectedMerge[]
    }

/** A plan that was made — what the confirm overlay is opened with, and the batch runs. */
export type ReadyPlan = Extract<MergePlan, { ok: true }>

export interface PlanRequest {
  readonly datastack: string
  /** The whole queue: the plan takes the reviewed neuron's tips from it, and no other's. */
  readonly queue: readonly QueueTip[]
  readonly reviewedRoot: string
  readonly verdicts: Verdicts
  readonly record: MergeRecord
}

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
  const pieces = acceptedPieces(tipsOf(request.queue, reviewedRoot), request.verdicts)
  const rejected: RejectedMerge[] = []
  const reject = (candidateRoot: string, reason: PlanRefusal, message: string) =>
    rejected.push({ candidateRoot, rows: pieces.get(candidateRoot)!, reason, message })

  const graphene = await services.chunkedgraph(datastack, options)
  if (!graphene) {
    return {
      ok: false,
      message: `${datastack} has no chunkedgraph (no \`graphene://\` segmentation), so nothing can be merged there.`,
    }
  }

  // This workflow's own merges: what is done, the neuron's root now, and other neurons' pieces.
  const own = mergedSoFar(request.record, reviewedRoot)
  /*
   * Merges whose reply was lost and that nothing has settled: if one landed, the neuron is at a
   * root the record does not name, and the currency check below would refuse it on every Submit.
   */
  const settled = await settle(own.unsettled, own.currentRoot, graphene)
  const currentRoot = settled?.newRoot ?? own.currentRoot
  const inNeuron = new Set(own.pieces)
  if (settled) inNeuron.add(settled.entry.candidateRoot)
  // Every root this neuron has had, and every root another reviewed neuron has or has had.
  const ownRoots = new Set([...own.roots, currentRoot])
  const otherNeurons = new Set([...request.queue.map((tip) => tip.neuronId), ...own.otherRoots])
  for (const root of ownRoots) otherNeurons.delete(root)
  const open = [...pieces.keys()].filter((candidateRoot) => {
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
    } else {
      return true
    }
    return false
  })

  /** The plan as it stands, refusals in the order the reader met their pieces, as merges are. */
  const order = new Map([...pieces.keys()].map((candidateRoot, i) => [candidateRoot, i]))
  const planned = (merges: PlannedMerge[]): MergePlan => ({
    ok: true,
    datastack,
    graphene,
    reviewedRoot,
    currentRoot,
    ...(settled ? { settled } : {}),
    merges,
    rejected: [...rejected].sort(
      (a, b) => order.get(a.candidateRoot)! - order.get(b.candidateRoot)!,
    ),
  })
  // Nothing left to send: every piece's reason is already known, and no server is needed for it.
  if (open.length === 0) return planned([])

  /*
   * Permission first, then currency: one round trip slower than asking both at once, and worth
   * it — a reader who may not edit is usually refused the currency read too, and its 401/403
   * would replace the plan's own sentence and raise the token alarm.
   */
  const permission = await services.permission(graphene, options)
  if (!permission.mayEdit) {
    return {
      ok: false,
      message: permission.termsPending
        ? `You may edit ${permission.dataset} once you have accepted its terms of service.`
        : `Your CAVE account may not edit ${permission.dataset}.`,
    }
  }

  const latest = await services.latest(graphene, [currentRoot, ...open], options)
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
    reject(candidateRoot, 'outdated', 'This piece has been edited since it was suggested.')
    return false
  })
  if (current.length === 0) return planned([])

  // Anchors, one piece at a time: they share the volume's chunks. The volume is opened only now,
  // once a current piece needs it.
  const volume = await services.openVolume(datastack, options)
  const merges: PlannedMerge[] = []
  for (const candidateRoot of current) {
    const rows = pieces.get(candidateRoot)!
    const { row, anchors } = await anchorRows(volume, currentRoot, candidateRoot, rows)
    if (anchors.ok) {
      merges.push({
        candidateRoot,
        rows,
        used: row,
        neuron: anchors.neuron,
        candidate: anchors.candidate,
        joinsNeuron: otherNeurons.has(candidateRoot),
      })
    } else {
      reject(candidateRoot, anchors.reason, anchors.message)
    }
  }
  return planned(merges)

  /**
   * The first lost reply that the roots show was **this merge and nothing after it**:
   *
   *  1. both its supervoxels are under one new root at the server's now (`sharedNewRoot`), and
   *  2. just before that root was made, they were under exactly the neuron's root and the piece's.
   *
   * The second is what tells our merge from somebody else's later edit: after one, both ends sit
   * under *their* root, made from ours, and adopting it would plan onto a neuron somebody else has
   * edited — what "an outdated neuron refuses every piece" forbids. So that case is left unsettled
   * and refused, as is any other. Only entries checked against the root the record names now.
   */
  async function settle(
    entries: readonly MergeRecordEntry[],
    recorded: string,
    on: GrapheneSource,
  ): Promise<{ entry: MergeRecordEntry; newRoot: string } | undefined> {
    for (const entry of entries) {
      if (entry.neuronRoot !== recorded) continue
      const ends = [entry.neuron.supervoxel, entry.candidate.supervoxel]
      const newRoot = sharedNewRoot(await services.roots(on, ends, 'server', options), recorded)
      if (newRoot === undefined) continue
      const [made] = await services.created(on, [newRoot], options)
      const before = await services.roots(on, ends, made! - 1, options)
      if (before[0] === recorded && before[1] === entry.candidateRoot) return { entry, newRoot }
    }
    return undefined
  }

  /** The first of a piece's rows that anchors, else the nearest row's refusal. */
  async function anchorRows(
    on: AnchorVolume,
    neuronRoot: string,
    candidateRoot: string,
    rows: readonly AcceptedRow[],
  ): Promise<{ row: AcceptedRow; anchors: Anchors }> {
    let nearest: { row: AcceptedRow; anchors: Anchors } | undefined
    for (const row of rows) {
      const { contactNm, minDistUm } = row.candidate
      const anchors = await services.anchor(
        on,
        { neuronRoot, candidateRoot, contactNm, minDistUm },
        options,
      )
      if (anchors.ok) return { row, anchors }
      nearest ??= { row, anchors }
    }
    return nearest!
  }
}
