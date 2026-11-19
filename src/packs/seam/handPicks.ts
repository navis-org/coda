/**
 * Hand picks: a candidate the reader found in neuroglancer themselves, added to the review list
 * and accepted in one gesture (user, 2026-11-19) — for an open end Suggest Merges missed, or a
 * tip whose right candidate it did not list.
 *
 * ## A pick is a piece and a place
 *
 * A merge is two supervoxels and a point inside each (`mergeAnchors.ts`), found by looking around
 * a contact, so a pick has to say where as well as what: the segment under the pointer and the
 * place the pointer is on it. Before anything is written the place is checked (`pickCheck.ts`,
 * reads only): the nearest voxel of the neuron — or of a piece it is extended with — and of the picked
 * piece are found around it, as Submit will find them, and their midpoint and distance become the
 * pick's contact and gap. A pick that Submit could not anchor is refused there and then, in a
 * sentence, rather than at Submit.
 *
 * ## Where it is listed
 *
 * **On the tip of the root it touches nearest its contact, within `PICK_TIP_UM`** — SEAM's own
 * reach for a candidate to belong to a tip — as one more candidate of that tip's list; and where
 * no tip is that near, as a tip of its own, numbered `-n` so it can never take a run's number.
 * Placed from the tips **each time the queue is built** (`withPicks`), never stored by tip number:
 * `end_uid` is a run's counter, and a re-run renumbers it.
 *
 * A tip's row leads with its hand pick (`QueueRow.hand`), which is listed whatever the filters say
 * and sorted first: the reader vouched for it. It carries none of SEAM's numbers — none describe
 * it — and is never sent to SEAM's verdict log (user, 2026-11-19).
 *
 * ## Stored as the card's other work is
 *
 * In the `picks` param, beside the verdict that accepts it: one edit, one undo step, cleared by
 * Start over and by the eviction of its neuron (`withRecentWork`). Compact JSON, as the merge
 * record's short entries are: `[n, seed, root, candidate, x, y, z, gapUm, l2Chunks|null]`.
 */

import type { Triple } from '../../data/precomputed/volume'
import { NM_PER_UM } from '../../data/units'
import { OWN_TIP_UM } from './ownTip'
import type { Candidate, QueueTip } from './reviewQueue'
import { gapOf } from './reviewQueue'

/** How near a tip a pick's contact must be to join that tip's list: SEAM's own-tip reach. */
export const PICK_TIP_UM = OWN_TIP_UM

export interface HandPick {
  /**
   * Its number on this card, one above the highest held; a tip of its own is `end_uid` `-n`. A
   * number freed by an undo is given again, with the cursor the undo put back.
   */
  readonly n: number
  /** The neuron it was picked for. */
  readonly seed: string
  /** The root it touches: the neuron itself, or a piece the neuron is extended with. */
  readonly root: string
  readonly candidateId: string
  /** The midpoint of the two pieces' nearest voxels, absolute nm. */
  readonly contactNm: Triple
  /** How far apart those voxels are, µm. */
  readonly gapUm: number
  readonly l2Chunks: number | undefined
}

export function decodePicks(raw: unknown): HandPick[] {
  const text = String(raw ?? '').trim()
  if (!text) return []
  let rows: unknown
  try {
    rows = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row): HandPick[] => {
    if (!Array.isArray(row)) return []
    const [n, seed, root, candidateId, x, y, z, gapUm, l2] = row as unknown[]
    const numbers = [n, x, y, z, gapUm]
    if (!numbers.every((v) => typeof v === 'number' && Number.isFinite(v))) return []
    if (
      typeof seed !== 'string' ||
      typeof root !== 'string' ||
      typeof candidateId !== 'string'
    ) {
      return []
    }
    return [
      {
        n: n as number,
        seed,
        root,
        candidateId,
        contactNm: [x, y, z] as Triple,
        gapUm: gapUm as number,
        l2Chunks: typeof l2 === 'number' ? l2 : undefined,
      },
    ]
  })
}

export function encodePicks(picks: readonly HandPick[]): string {
  if (picks.length === 0) return ''
  return JSON.stringify(
    picks.map((pick) => [
      pick.n,
      pick.seed,
      pick.root,
      pick.candidateId,
      ...pick.contactNm,
      pick.gapUm,
      pick.l2Chunks ?? null,
    ]),
  )
}

/**
 * The queue with every pick listed (the header): on its root's tip nearest its contact within
 * `PICK_TIP_UM`, else as a tip of its own. A pick whose neuron the queue does not hold is left
 * out, as is one its tip already lists. The same array where there is no pick.
 */
export function withPicks(
  queue: readonly QueueTip[],
  picks: readonly HandPick[],
): readonly QueueTip[] {
  if (picks.length === 0) return queue
  const seeds = new Set(queue.map((tip) => tip.seed))
  const out = [...queue]
  for (const pick of picks) {
    if (!seeds.has(pick.seed)) continue
    const at = hostOf(out, pick)
    if (at === undefined) {
      out.push(ownTip(pick))
      continue
    }
    const tip = out[at]!
    if (tip.candidates.some((one) => one.candidateId === pick.candidateId)) continue
    out[at] = {
      ...tip,
      candidates: [...tip.candidates, handCandidate(pick, tip.candidates.length + 1)],
    }
  }
  return out
}

/**
 * Where these tips already list `candidateId`: at the smallest gap, as a piece is hung beneath
 * the row it touches nearest (`arrangeTree`). A pick of a piece already listed is that row.
 */
export function listedAt(
  tips: readonly QueueTip[],
  candidateId: string,
): { tip: QueueTip; candidate: Candidate } | undefined {
  let best: { tip: QueueTip; candidate: Candidate } | undefined
  for (const tip of tips) {
    for (const candidate of tip.candidates) {
      if (candidate.candidateId !== candidateId) continue
      if (!best || gapOf(candidate) < gapOf(best.candidate)) best = { tip, candidate }
    }
  }
  return best
}

/**
 * The index of the pick's root's tip nearest its contact within `PICK_TIP_UM`, the first on a tie
 * — on the pick's own neuron: a piece in two neurons' trees has tips under each.
 */
function hostOf(tips: readonly QueueTip[], pick: HandPick): number | undefined {
  let best = (PICK_TIP_UM * NM_PER_UM) ** 2
  let at: number | undefined
  tips.forEach((tip, i) => {
    if (tip.neuronId !== pick.root || tip.seed !== pick.seed || tip.junction) return
    const d = distance2(tip.tipNm, pick.contactNm)
    if (d < best || (at === undefined && d === best)) {
      best = d
      at = i
    }
  })
  return at
}

export function distance2(a: readonly number[], b: readonly number[]): number {
  return (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2
}

/** A pick as a candidate of the queue, at `rank` in its tip's list. */
function handCandidate(pick: HandPick, rank: number): Candidate {
  return {
    candidateId: pick.candidateId,
    rank,
    geoRank: undefined,
    volumeUm3: undefined,
    l2Chunks: pick.l2Chunks,
    minDistUm: pick.gapUm,
    contactNm: pick.contactNm,
    pCand: undefined,
    conf: undefined,
    shown: false,
    hand: true,
  }
}

/** A tip of the pick's own, where no tip of its root is near: at its contact, numbered `-n`. */
function ownTip(pick: HandPick): QueueTip {
  return {
    endUid: -pick.n,
    neuronId: pick.root,
    seed: pick.seed,
    junction: false,
    search: 'done',
    kind: 'hand',
    tipNm: pick.contactNm,
    r: undefined,
    q: undefined,
    pTip: undefined,
    shown: false,
    cleared: false,
    source: undefined,
    candidates: [handCandidate(pick, 1)],
  }
}
