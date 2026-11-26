/**
 * Choosing where to merge, on boxes built here. The decision is the part that fails without
 * throwing: a wrong voxel is still a supervoxel and the server would still merge it — it would
 * just be a different place on the neuron, or a piece of something else.
 *
 * The voxels are anisotropic (16 × 16 × 45 nm, Aedes' base scale), and one test places a piece
 * where measuring in voxels and measuring in nanometres choose different voxels.
 */

import { describe, expect, it } from 'vitest'

import { parseGraphLayout } from '../../data/cave/graphLayout'
import { AEDES_GRAPH_INFO, nodeId } from '../../test/chunkedgraphIds'
import type { AnchorVolume } from './mergeAnchors'
import type { RootedBox } from './rootedBox'
import {
  ANCHOR_MARGIN_NM,
  MAX_REACH_NM,
  UNKNOWN_GAP_REACH_NM,
  anchorMerge,
  anchorReachNm,
  anchorsInBox,
} from './mergeAnchors'

const layout = parseGraphLayout(AEDES_GRAPH_INFO)!

const NEURON = 720575940621522189n
const CANDIDATE = 720575940630442210n
const OTHER = 720575940699999999n

const RES = [16, 16, 45] as const
const LO = [1000, 2000, 300] as const
const SIZE = [20, 20, 6] as const
/** The chunk every supervoxel is in unless a test moves a root's. */
const CHUNK = [10, 10, 2] as const

/** The voxel centre of box voxel (i, j, k), absolute nm. */
const centre = (i: number, j: number, k: number) =>
  [(LO[0] + i + 0.5) * RES[0], (LO[1] + j + 0.5) * RES[1], (LO[2] + k + 0.5) * RES[2]] as const

/** The index of box voxel (i, j, k), x fastest. */
const voxel = (i: number, j: number, k: number) => i + SIZE[0] * (j + SIZE[1] * k)

/**
 * A box where **every voxel is its own supervoxel**, so which voxel was chosen is readable off
 * the supervoxel id (its counter is the voxel index plus one). `rootOf` says what each voxel
 * belongs to now; `0n` is background, label 0. `chunkOf` puts a root's supervoxels in a chunk.
 */
function boxOf(
  rootOf: (i: number, j: number, k: number) => bigint,
  chunkOf: (root: bigint) => readonly number[] = () => CHUNK,
  layer = 1,
): RootedBox {
  const labels: bigint[] = [0n]
  const roots: bigint[] = [0n]
  const index = new Uint16Array(SIZE[0] * SIZE[1] * SIZE[2])
  for (let k = 0, v = 0; k < SIZE[2]; k++) {
    for (let j = 0; j < SIZE[1]; j++) {
      for (let i = 0; i < SIZE[0]; i++, v++) {
        const root = rootOf(i, j, k)
        if (root === 0n) continue
        index[v] = labels.length
        labels.push(nodeId(layer, chunkOf(root), v + 1))
        roots.push(root)
      }
    }
  }
  return {
    labels: BigUint64Array.from(labels),
    roots: BigUint64Array.from(roots),
    index,
    size: SIZE,
    loVoxels: LO,
    resolutionNm: RES,
  }
}

/** The neuron fills x < 8, the candidate x > 11, background between. */
const slab = (i: number) => (i < 8 ? NEURON : i > 11 ? CANDIDATE : 0n)

/** The supervoxel `boxOf` gives voxel (i, j, k), in the default chunk. */
const svAt = (i: number, j: number, k: number) => String(nodeId(1, CHUNK, voxel(i, j, k) + 1))

/** Halfway across the gap, at row 10 and slice 3 — where SEAM puts a contact. */
const CONTACT = centre(9.5, 10, 3)

describe('anchoring a merge', () => {
  it('takes each piece’s voxel nearest the contact, and its supervoxel', () => {
    const got = anchorsInBox(boxOf(slab), NEURON, CANDIDATE, CONTACT, 1000, layout)
    if (!got.ok) throw new Error(got.message)
    // Column 7 is the neuron's edge nearest the gap, column 12 the candidate's.
    expect(got.neuron).toEqual({ supervoxel: svAt(7, 10, 3), positionNm: centre(7, 10, 3) })
    expect(got.candidate).toEqual({
      supervoxel: svAt(12, 10, 3),
      positionNm: centre(12, 10, 3),
    })
    expect(got.chunks).toBe(0)
    // The server divides by its resolution and truncates to a voxel: a centre must come back to
    // the voxel it was taken from, or the server looks the supervoxel up one voxel over.
    const back = got.neuron.positionNm.map((nm, a) => Math.trunc(nm / RES[a]!))
    expect(back).toEqual([LO[0] + 7, LO[1] + 10, LO[2] + 3])
  })

  /**
   * Two neuron voxels: two across in x (32 nm) and one up in z (45 nm). Counting voxels picks the
   * z neighbour; measuring nanometres — what the server and SEAM both do — picks the x one.
   */
  it('measures in nanometres, not voxels', () => {
    const c = [5, 10, 3] as const
    const box = boxOf((i, j, k) =>
      (i === c[0] + 2 && j === c[1] && k === c[2]) ||
      (i === c[0] && j === c[1] && k === c[2] + 1)
        ? NEURON
        : i === 15 && j === c[1] && k === c[2]
          ? CANDIDATE
          : 0n,
    )
    const got = anchorsInBox(box, NEURON, CANDIDATE, centre(...c), 1000, layout)
    if (!got.ok) throw new Error(got.message)
    expect(got.neuron.supervoxel).toBe(svAt(c[0] + 2, c[1], c[2]))
  })

  /** Edited since the suggestion: the neuron's supervoxels now answer to another root. */
  it('refuses when the neuron is not there today', () => {
    const edited = boxOf((i) => (i < 8 ? OTHER : i > 11 ? CANDIDATE : 0n))
    expect(anchorsInBox(edited, NEURON, CANDIDATE, CONTACT, 1000, layout)).toMatchObject({
      ok: false,
      reason: 'neuron-absent',
    })
  })

  it('refuses when the candidate is not there today', () => {
    const merged = boxOf((i) => (i < 8 || i > 11 ? NEURON : 0n))
    expect(anchorsInBox(merged, NEURON, CANDIDATE, CONTACT, 1000, layout)).toMatchObject({
      ok: false,
      reason: 'candidate-absent',
    })
  })

  /** A piece only further away than the reach is not the piece the suggestion was about. */
  it('ignores voxels beyond the reach', () => {
    // Both pieces' nearest voxels are 2.5 columns (40 nm) from the contact in x.
    expect(anchorsInBox(boxOf(slab), NEURON, CANDIDATE, CONTACT, 39, layout)).toMatchObject({
      reason: 'neuron-absent',
    })
    expect(anchorsInBox(boxOf(slab), NEURON, CANDIDATE, CONTACT, 41, layout).ok).toBe(true)
  })

  it('refuses two supervoxels further apart than the server allows', () => {
    const inChunk = (x: number) => (root: bigint) =>
      root === CANDIDATE ? [x, CHUNK[1], CHUNK[2]] : CHUNK
    const far = anchorsInBox(boxOf(slab, inChunk(14)), NEURON, CANDIDATE, CONTACT, 1000, layout)
    expect(far).toMatchObject({ ok: false, reason: 'too-far' })
    const near = anchorsInBox(
      boxOf(slab, inChunk(13)),
      NEURON,
      CANDIDATE,
      CONTACT,
      1000,
      layout,
    )
    expect(near.ok).toBe(true)
  })

  /** A label out of the graph's own watershed that is not layer 1 is a broken setup, not a pair. */
  it('throws when the box’s supervoxels are not supervoxels of the graph', () => {
    const box = boxOf(slab, undefined, 2)
    expect(() => anchorsInBox(box, NEURON, CANDIDATE, CONTACT, 1000, layout)).toThrow(
      /not a supervoxel/,
    )
  })
})

describe('how far from the contact to look', () => {
  it('is half the measured gap plus the margin', () => {
    expect(anchorReachNm(0.4)).toBe(200 + ANCHOR_MARGIN_NM)
    expect(anchorReachNm(0)).toBe(ANCHOR_MARGIN_NM)
  })

  /** Read short, a wide gap would come back "neuron absent — edited?", which names the wrong cause. */
  it('refuses a gap wider than it reads, rather than reading short', () => {
    expect(anchorReachNm((2 * (MAX_REACH_NM - ANCHOR_MARGIN_NM)) / 1000)).toBe(MAX_REACH_NM)
    expect(anchorReachNm(50)).toBeUndefined()
  })

  /** "Unmeasured" is not "touching". */
  it('is a fixed reach where the gap is unknown', () => {
    expect(anchorReachNm(undefined)).toBe(UNKNOWN_GAP_REACH_NM)
    expect(anchorReachNm(Number.NaN)).toBe(UNKNOWN_GAP_REACH_NM)
  })
})

describe('refusals made before anything is read', () => {
  /** A volume whose every use throws: these refusals must not reach it. */
  const untouchable = new Proxy({} as AnchorVolume, {
    get() {
      throw new Error('read the volume')
    },
  })
  const options = {} as Parameters<typeof anchorMerge>[2]
  const pair = (neuronRoot: string, candidateRoot: string) => ({
    neuronRoot,
    candidateRoot,
    contactNm: CONTACT,
    minDistUm: undefined,
  })

  it('refuses a pair that is one segment', async () => {
    const got = await anchorMerge(untouchable, pair(String(NEURON), String(NEURON)), options)
    expect(got).toMatchObject({ ok: false, reason: 'same-root' })
  })

  /** The neuron's side can be several roots (`alsoNeuron`): the candidate is none of them. */
  it('refuses a candidate that is one of the roots read as the neuron’s side', async () => {
    const got = await anchorMerge(
      untouchable,
      { ...pair(String(NEURON), String(CANDIDATE)), alsoNeuron: [String(CANDIDATE)] },
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'same-root' })
  })

  it('refuses a root on the neuron’s side that is not a segment id', async () => {
    const got = await anchorMerge(
      untouchable,
      { ...pair(String(NEURON), String(CANDIDATE)), alsoNeuron: ['0'] },
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'bad-id' })
  })

  it('refuses an id that is not a segment id', async () => {
    const got = await anchorMerge(untouchable, pair('7.2e17', String(CANDIDATE)), options)
    expect(got).toMatchObject({ ok: false, reason: 'bad-id' })
  })

  /** Digits are not enough: a chunkedgraph id is unsigned 64-bit. */
  it('refuses an id too large to be one', async () => {
    const got = await anchorMerge(
      untouchable,
      pair(String(NEURON), '99999999999999999999999'),
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'bad-id' })
  })

  /** A row without a contact must not be looked for at the origin, which is a real place. */
  it('refuses a row with no contact', async () => {
    const got = await anchorMerge(
      untouchable,
      { ...pair(String(NEURON), String(CANDIDATE)), contactNm: undefined },
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'no-contact' })
  })

  /** Bad data is not an unmeasured gap: looked for at the default reach, it would misreport. */
  it('refuses a negative gap', async () => {
    const got = await anchorMerge(
      untouchable,
      { ...pair(String(NEURON), String(CANDIDATE)), minDistUm: -0.2 },
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'bad-gap' })
  })

  it('refuses a contact with a missing coordinate', async () => {
    const got = await anchorMerge(
      untouchable,
      { ...pair(String(NEURON), String(CANDIDATE)), contactNm: [1, Number.NaN, 3] },
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'no-contact' })
  })

  it('refuses a gap wider than it reads', async () => {
    const got = await anchorMerge(
      untouchable,
      { ...pair(String(NEURON), String(CANDIDATE)), minDistUm: 50 },
      options,
    )
    expect(got).toMatchObject({ ok: false, reason: 'gap-too-wide' })
  })

  /** 0 is "no object": a well-formed id that names nothing. */
  it('refuses root 0', async () => {
    const got = await anchorMerge(untouchable, pair(String(NEURON), '0'), options)
    expect(got).toMatchObject({ ok: false, reason: 'bad-id' })
  })
})
