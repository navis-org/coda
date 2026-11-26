/**
 * The check a hand pick passes before it is written (`handPicks.ts`, user, 2026-11-19). **Reads
 * only**: the segmentation around the place the reader pointed at, as Submit's pre-flight reads it
 * (`mergeAnchors.ts`), and the piece's size. Apart from `handPicks.ts` so the node, which reads the
 * stored picks, imports no server.
 */

import { errorMessage } from '../../core/errors'
import type { CaveRequestOptions } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import { l2ChunkCounts } from '../../data/cave/rootIds'
import type { Triple } from '../../data/precomputed/volume'
import { NM_PER_UM } from '../../data/units'
import { distance2 } from './handPicks'
import type { AnchorPair, AnchorVolume, Anchors } from './mergeAnchors'
import { UNKNOWN_GAP_REACH_NM, anchorMerge, openAnchorVolume } from './mergeAnchors'
import { rootNow } from './mergeRecord'

/** What a pick is checked against: the segment, the place, and the neuron as it stands. */
export interface PickRequest {
  readonly datastack: string
  readonly segment: string
  readonly positionNm: Triple
  /** The neuron as the card has it — the seed — and its root now, after this card's merges. */
  readonly seed: string
  readonly neuronRoot: string
  /** The pieces the neuron is extended with and not merged yet: its tips are on them too. */
  readonly pieces: readonly string[]
  /**
   * Of those, the ones Submit merged onto each other short of the neuron, each with their root
   * now (`MergedSoFar.joined`): what the segmentation has them under.
   */
  readonly joined?: ReadonlyMap<string, string> | undefined
  /** Of those, the ones followed through an edit, each with the root it is under now (`MergedSoFar.moved`). */
  readonly moved?: ReadonlyMap<string, string> | undefined
}

export type PickCheck =
  | {
      readonly ok: true
      /** The root it touches, as the queue names it: the seed, or one of `pieces`. */
      readonly root: string
      readonly contactNm: Triple
      readonly gapUm: number
      readonly l2Chunks: number | undefined
      /**
       * The two supervoxels Submit merges by: the picked piece's nearest the neuron, and the
       * neuron's (or its piece's) nearest the pick. What a review card follows a split of either
       * by (`HandPick.candSv`, `HandPick.tipSv`).
       */
      readonly candSv: string
      readonly tipSv: string
    }
  | { readonly ok: false; readonly message: string }

/** What the check asks of the servers, apart so it can be tested without one. */
export interface PickServices {
  openVolume(datastack: string, options: CaveRequestOptions): Promise<AnchorVolume>
  anchor(volume: AnchorVolume, pair: AnchorPair, options: CaveRequestOptions): Promise<Anchors>
  l2(
    graphene: GrapheneSource,
    roots: readonly string[],
    options: CaveRequestOptions,
  ): Promise<Map<string, number>>
}

const LIVE: PickServices = {
  // At the server's now, as Submit's plan reads them: the roots this card's last merges made.
  openVolume: (datastack, options) => openAnchorVolume(datastack, 'server', options),
  anchor: anchorMerge,
  l2: l2ChunkCounts,
}

/** How far from the place the pieces are looked for, in words. */
const REACH = `${(UNKNOWN_GAP_REACH_NM / NM_PER_UM).toFixed(1)} µm`

/**
 * Check a pick against the segmentation (reads only): find both pieces' nearest voxels around the
 * place, as Submit will, and their contact and gap — or say why it cannot be merged. Looked for
 * within `UNKNOWN_GAP_REACH_NM` of the place, so the gap is at most twice that and Submit's own
 * reach around the midpoint (`anchorReachNm`) always holds both. Throws only for a cancel.
 */
export async function checkPick(
  request: PickRequest,
  options: CaveRequestOptions,
  services: PickServices = LIVE,
): Promise<PickCheck> {
  const { segment, seed, neuronRoot, pieces } = request
  const rootOf = (id: string) => rootNow(request, id)
  if (segment === seed || segment === neuronRoot) {
    return { ok: false, message: 'That is the neuron itself.' }
  }
  if (pieces.some((piece) => piece === segment || rootOf(piece) === segment)) {
    return { ok: false, message: 'That piece is already accepted on this neuron.' }
  }
  try {
    const volume = await services.openVolume(request.datastack, options)
    // The size beside the anchors, from the volume's own chunkedgraph: a nicety, so a failure to
    // read it never refuses the pick.
    const size = services
      .l2(volume.graphene, [segment], options)
      .then((counts) => counts.get(segment))
      .catch(() => undefined)
    const anchors = await services.anchor(
      volume,
      {
        neuronRoot,
        alsoNeuron: [...new Set(pieces.map(rootOf))],
        candidateRoot: segment,
        contactNm: request.positionNm,
        // Unmeasured: looked for at `UNKNOWN_GAP_REACH_NM`.
        minDistUm: undefined,
      },
      options,
    )
    if (!anchors.ok) return { ok: false, message: refusalOf(anchors, segment) }
    const on = anchors.onRoot
    /*
     * The piece under `on`: its own root, or the one it was followed to. Where several are under
     * it — pieces Submit joined short of the neuron, or pieces merged with each other since — which
     * of them the pick continues cannot be told, and it would be placed on whichever came first.
     */
    const under = pieces.filter((piece) => rootOf(piece) === on)
    const root =
      on === neuronRoot || on === undefined
        ? seed
        : under.length === 1 && !request.joined?.has(under[0]!)
          ? under[0]
          : undefined
    if (root === undefined) {
      const joined = under.some((piece) => request.joined?.has(piece))
      return {
        ok: false,
        message: joined
          ? `The nearest part of the neuron there is on ${on}, pieces Submit joined short of the neuron. Submit them, then pick again.`
          : under.length > 1
            ? `The nearest part of the neuron there is on ${on}, which ${under.join(' and ')} are all part of now, so which the pick continues cannot be told.`
            : `The nearest part of the neuron there is on ${on}, which is neither the neuron nor a piece accepted on it.`,
      }
    }
    const a = anchors.neuron.positionNm
    const b = anchors.candidate.positionNm
    const mid = (i: number) => Math.round((a[i]! + b[i]!) / 2)
    const contactNm: Triple = [mid(0), mid(1), mid(2)]
    const gapUm = Math.sqrt(distance2(a, b)) / NM_PER_UM
    return {
      ok: true,
      root,
      contactNm,
      gapUm: Math.round(gapUm * 1000) / 1000,
      l2Chunks: await size,
      candSv: anchors.candidate.supervoxel,
      tipSv: anchors.neuron.supervoxel,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      ok: false,
      message: `The pick could not be checked: ${errorMessage(error)}`,
    }
  }
}

/** A refused anchor, said of a pick rather than of a suggestion. */
function refusalOf(anchors: Extract<Anchors, { ok: false }>, segment: string): string {
  switch (anchors.reason) {
    case 'neuron-absent':
      return `No part of the neuron, or of a piece accepted on it, lies within ${REACH} of where you pointed. Point at ${segment} close to where it meets one of them.`
    case 'candidate-absent':
      return `${segment} is not within ${REACH} of where you pointed in the segmentation today. It may have been edited since the viewer loaded it.`
    default:
      return anchors.message
  }
}
