/**
 * Where to merge: the supervoxel of each piece at a suggestion's contact, and a point inside it.
 *
 * Phase 1 of `docs/seam-merge-plan.md`. **Read-only** — it reads voxels and asks the chunkedgraph
 * which root each supervoxel belongs to at one instant, and nothing else.
 *
 * ## Why this exists
 *
 * A merge is two `(supervoxel, position)` pairs, and a suggestion carries neither: it has two
 * root ids and one contact point. SEAM's contact is the **midpoint** between the candidate's
 * voxel nearest the neuron and the neuron's voxel nearest that (`seam/cutout.py`,
 * `summarize_cutout`), so each piece's nearest voxel lies within half the gap of it. This reads a
 * box around the contact and finds, for each root, its voxel nearest the contact.
 *
 * The server would find supervoxels for root ids itself, but it looks an outdated root up as it
 * *was* (phase 0), so it is no guard. Here the roots are asked **at now**: a neuron or candidate
 * edited since the suggestion was made is simply not found near its contact, and the merge is
 * refused with that reason before anything is sent.
 *
 * ## The scale is the graph's own
 *
 * The server divides a position by its segmentation resolution and truncates to a voxel, then
 * looks the supervoxel up at that voxel. So this reads the volume at the chunkedgraph's base
 * scale (`graph.cv_mip`) — 16 nm on Aedes, not the 32 nm the search reads — and sends voxel
 * **centres**, which truncate back onto the voxel they came from at any resolution.
 *
 * ## One volume per pre-flight
 *
 * An `AnchorVolume` is a `BoxReader` (`rootedBox.ts`) — one instant, a chunk cache and a
 * supervoxel → root map — and boxes are read through the same `labelledBox` the search uses. One
 * neuron's accepted pairs sit close together, so
 * neighbouring anchors share chunks and supervoxels. The map is only true at its instant: open a
 * new volume for each pre-flight, and never use one for the per-merge re-check, which has to see
 * the roots each merge just changed.
 */

import type { CaveRequestOptions } from '../../data/cave/client'
import type { Instant } from '../../data/cave/rootIds'
import type { GraphLayout } from '../../data/cave/graphLayout'
import { isNodeId } from '../../data/cave/graphLayout'
import type { MergeEnd } from '../../data/cave/merge'
import { MAX_MERGE_CHUNKS, mergeChunkDistance } from '../../data/cave/merge'
import { findSupervoxels } from '../../data/cave/volumes'
import { chunkCache } from '../../data/precomputed/chunkCache'
import type { Triple, VolumeScale } from '../../data/precomputed/volume'
import { boxAround, openVolume } from '../../data/precomputed/volume'
import { NM_PER_UM } from '../../data/units'
import type { Candidate } from './reviewQueue'
import type { BoxReader, RootedBox } from './rootedBox'
import { boxReader, labelledBox } from './rootedBox'

/**
 * How far past half the gap a piece's nearest voxel may lie.
 *
 * The contact was computed at the search's scale (32 × 32 × 45 nm on Aedes), whose voxel diagonal
 * is ~64 nm, and this reads at the base scale, so the two disagree by about a voxel. Half a
 * micrometre is several of those and still small against a neurite's length, so a piece found
 * within it is the piece that was there, not another part of it further along.
 */
export const ANCHOR_MARGIN_NM = 500

/** Where the row does not say how far apart the pieces were. */
export const UNKNOWN_GAP_REACH_NM = 1500

/**
 * The largest reach ever read, and the ceiling checked before a box is allocated.
 *
 * At the base scale (16 × 16 × 45 nm on Aedes) a 2 µm reach is a 250 × 250 × 89 box, 5.6 M
 * voxels; the search's own 3 µm reach read here would be 19 M, four times the search's box,
 * because this reads at twice its resolution. Half a gap of 3 µm is still inside it, and a merge
 * across more than that is not a contact any more. A row needing more is refused as
 * `gap-too-wide` before anything is read, rather than read short and reported as an edited
 * neuron.
 */
export const MAX_REACH_NM = 2000

/**
 * What one pre-flight may hold of fetched chunks. One neuron's pairs share a handful of 16 nm
 * chunks of a few MB each; this is room for a few dozen, and it is dropped with the volume.
 */
const ANCHOR_CHUNK_BYTES = 128 * 1024 * 1024

/** Why a pair cannot be anchored. Every one is a reason not to send the merge. */
export type AnchorRefusal =
  /** The two roots are the same id: nothing to merge. */
  | 'same-root'
  /** A root id that is not a segment id, is 0 ("no object"), or does not fit in 64 bits. */
  | 'bad-id'
  /** The row has no contact point to look around. */
  | 'no-contact'
  /** The search measured the pieces further apart than this reads (`MAX_REACH_NM`). */
  | 'gap-too-wide'
  /** The row's gap is negative or infinite: bad data, not an unmeasured gap. */
  | 'bad-gap'
  /** The contact's box lies outside the segmentation volume. */
  | 'outside-volume'
  /** No voxel of the neuron's root, at the volume's instant, within reach of the contact. */
  | 'neuron-absent'
  /** No voxel of the candidate's root, at the volume's instant, within reach of the contact. */
  | 'candidate-absent'
  /** The two supervoxels are further apart than the server allows. */
  | 'too-far'

export type Anchors =
  | {
      readonly ok: true
      readonly neuron: MergeEnd
      readonly candidate: MergeEnd
      /** The two supervoxels' Chebyshev distance in chunks — at most `MAX_MERGE_CHUNKS`. */
      readonly chunks: number
    }
  | { readonly ok: false; readonly reason: AnchorRefusal; readonly message: string }

/**
 * One accepted suggestion, as far as anchoring needs it: the review queue's own fields for where
 * and how far, so the two cannot drift, and the two roots. `contactNm` is undefined for a row that
 * carries none (`reviewQueue`), which is refused rather than looked for at the origin.
 */
export type AnchorPair = Pick<Candidate, 'contactNm' | 'minDistUm'> & {
  readonly neuronRoot: string
  readonly candidateRoot: string
}

/**
 * How far from the contact to look, nm: half the gap the search measured, plus the margin — or
 * undefined where that is more than `MAX_REACH_NM`, which the caller refuses.
 *
 * A row with no gap is given a fixed reach rather than the margin alone, since "unmeasured" is not
 * "touching".
 */
export function anchorReachNm(minDistUm: number | undefined): number | undefined {
  // Unmeasured, not wrong: a negative or infinite gap is refused before this (`bad-gap`).
  if (minDistUm === undefined || Number.isNaN(minDistUm)) return UNKNOWN_GAP_REACH_NM
  const reach = (minDistUm! * NM_PER_UM) / 2 + ANCHOR_MARGIN_NM
  return reach <= MAX_REACH_NM ? reach : undefined
}

/** A voxel centre along one axis, in absolute nanometres — the one spelling of "centre". */
function centreNm(box: RootedBox, axis: number, at: number): number {
  return (box.loVoxels[axis]! + at + 0.5) * box.resolutionNm[axis]!
}

/**
 * The anchors in a box that has been read and rooted — the whole decision, with no I/O.
 *
 * For each root, the voxel nearest the contact (anisotropic, in nanometres), kept only within
 * `reachNm`. Ties go to the first voxel in scan order, so the answer is the same every time. A
 * root of `0n` — no object, label 0 included (`rootsAtInstant`) — matches neither, since both
 * roots are refused as `0` before a box is read.
 */
export function anchorsInBox(
  box: RootedBox,
  neuronRoot: bigint,
  candidateRoot: bigint,
  contactNm: Triple,
  reachNm: number,
  layout: GraphLayout,
): Anchors {
  // 0 = neither; 1 = the neuron; 2 = the candidate. Indexes `best` and `at` below.
  const kind = new Uint8Array(box.roots.length)
  for (let slot = 0; slot < kind.length; slot++) {
    const root = box.roots[slot]
    kind[slot] = root === neuronRoot ? 1 : root === candidateRoot ? 2 : 0
  }

  // Squared distance from the contact to each voxel centre, per axis, so the scan adds three.
  const axis = (a: number): Float64Array =>
    Float64Array.from(
      { length: box.size[a]! },
      (_, i) => (centreNm(box, a, i) - contactNm[a]!) ** 2,
    )
  const dx = axis(0)
  const dy = axis(1)
  const dz = axis(2)
  const [sx, sy, sz] = box.size as Triple
  const limit = reachNm * reachNm
  const best = [Infinity, Infinity, Infinity]
  const at = [-1, -1, -1]
  for (let k = 0, v = 0; k < sz; k++) {
    for (let j = 0; j < sy; j++, v += sx) {
      const yz = dy[j]! + dz[k]!
      // A whole row out of reach: nothing in it can be chosen.
      if (yz > limit) continue
      for (let i = 0; i < sx; i++) {
        const d = dx[i]! + yz
        if (d > limit) continue
        const which = kind[box.index[v + i]!]!
        if (which !== 0 && d < best[which]!) {
          best[which] = d
          at[which] = v + i
        }
      }
    }
  }

  const reach = `${(reachNm / NM_PER_UM).toFixed(2)} µm`
  if (at[1]! < 0) {
    return refuse(
      'neuron-absent',
      `No part of neuron ${neuronRoot} lies within ${reach} of the contact today. The neuron ` +
        'may have been edited since the suggestion was made.',
    )
  }
  if (at[2]! < 0) {
    return refuse(
      'candidate-absent',
      `No part of candidate ${candidateRoot} lies within ${reach} of the contact today. It may ` +
        'have been edited or merged since the suggestion was made.',
    )
  }
  const neuron = endAt(box, at[1]!)
  const candidate = endAt(box, at[2]!)
  const chunks = mergeChunkDistance(
    layout,
    BigInt(neuron.supervoxel),
    BigInt(candidate.supervoxel),
  )
  if (chunks > MAX_MERGE_CHUNKS) {
    return refuse(
      'too-far',
      `The two pieces meet ${chunks} chunks apart; the chunkedgraph refuses a merge across more ` +
        `than ${MAX_MERGE_CHUNKS}.`,
    )
  }
  return { ok: true, neuron, candidate, chunks }
}

/** The supervoxel at voxel `v` of the box, and that voxel's centre in absolute nanometres. */
function endAt(box: RootedBox, v: number): MergeEnd {
  const sx = box.size[0]!
  const sy = box.size[1]!
  return {
    supervoxel: String(box.labels[box.index[v]!]!),
    positionNm: [
      centreNm(box, 0, v % sx),
      centreNm(box, 1, Math.floor(v / sx) % sy),
      centreNm(box, 2, Math.floor(v / (sx * sy))),
    ],
  }
}

function refuse(reason: AnchorRefusal, message: string): Anchors {
  return { ok: false, reason, message }
}

/** One pre-flight's reader: the base scale, the id layout, and `labelledBox`'s memo at one instant. */
export type AnchorVolume = BoxReader & {
  /** The chunkedgraph's base scale: the one merge positions are in. */
  readonly scale: VolumeScale
  readonly layout: GraphLayout
}

/**
 * Open a datastack's supervoxels at the chunkedgraph's own base scale, rooted at `at` (epoch ms —
 * **now**, for merges about to be sent). One per pre-flight; see the header.
 */
export async function openAnchorVolume(
  datastack: string,
  at: Instant,
  options: CaveRequestOptions,
): Promise<AnchorVolume> {
  const source = await findSupervoxels(datastack, options)
  const { layout } = source
  // Refused before the bucket is asked anything: the layout came with the chunkedgraph's info.
  if (!layout) {
    throw new Error(
      `${datastack}'s chunkedgraph publishes no usable \`graph\` layout in its info, so which ` +
        'chunk a supervoxel sits in cannot be read off its id.',
    )
  }
  const info = await openVolume(source.base, options)
  // By resolution, never by `baseMip` as a position: see `GraphLayout.baseResolutionNm`.
  const want = layout.baseResolutionNm
  const scale = info.scales.find((s) =>
    s.resolution.every((nm, a) => Math.abs(nm - want[a]!) < 1e-6),
  )
  if (!scale) {
    throw new Error(
      `${datastack}'s chunkedgraph is built on ${want.join(' × ')} nm supervoxels, which its ` +
        'volume does not offer in an encoding Coda reads.',
    )
  }
  return {
    ...boxReader({ ...source, info }, at, chunkCache(ANCHOR_CHUNK_BYTES)),
    scale,
    layout,
  }
}

/**
 * Anchor one accepted pair: read the box around its contact at the volume's instant, choose.
 *
 * A refusal is about this pair. A **throw** is about the datastack — a request that failed, or a
 * supervoxel that does not decode as one (`mergeChunkDistance`) — and is true of every pair, so a
 * caller stops the whole pre-flight on it rather than refusing pairs one by one.
 */
export async function anchorMerge(
  volume: AnchorVolume,
  pair: AnchorPair,
  options: CaveRequestOptions,
): Promise<Anchors> {
  const { neuronRoot, candidateRoot, contactNm } = pair
  for (const id of [neuronRoot, candidateRoot]) {
    if (!isNodeId(id)) {
      return refuse('bad-id', `Not a segment id: ${id}.`)
    }
  }
  if (neuronRoot === candidateRoot) {
    return refuse(
      'same-root',
      `The neuron and the candidate are the same segment, ${neuronRoot}.`,
    )
  }
  if (!contactNm || !contactNm.every(Number.isFinite)) {
    return refuse('no-contact', 'The suggestion carries no contact point to merge at.')
  }
  const gap = pair.minDistUm
  if (gap !== undefined && !Number.isNaN(gap) && !(gap >= 0 && Number.isFinite(gap))) {
    return refuse('bad-gap', `The search's gap for this pair, ${gap} µm, is not a distance.`)
  }
  const reachNm = anchorReachNm(pair.minDistUm)
  if (reachNm === undefined) {
    return refuse(
      'gap-too-wide',
      `The search measured these pieces ${pair.minDistUm} µm apart, further than a merge point ` +
        `is looked for (${(MAX_REACH_NM / NM_PER_UM).toFixed(0)} µm from the contact).`,
    )
  }
  let box
  try {
    box = boxAround(volume.scale, contactNm, reachNm)
  } catch {
    return refuse('outside-volume', 'The contact lies outside the segmentation volume.')
  }
  const read = await labelledBox(volume, volume.scale, box, options)
  return anchorsInBox(
    read,
    BigInt(neuronRoot),
    BigInt(candidateRoot),
    contactNm,
    reachNm,
    volume.layout,
  )
}
