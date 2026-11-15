/**
 * The plan a search makes of its own reading, before it reads any of it.
 *
 * What is checkable here is the part that decides whether the cache evicts well: which chunks an
 * end is said to want, how that moves as ends are searched, and the two shapes that would make
 * the whole thing quietly useless rather than loudly wrong — a key the reader does not use, and
 * a plan built in a different order from the walk.
 */

import { describe, expect, it } from 'vitest'

import { chunkKeyOf, chunksCovering, boxAround } from '../../data/precomputed/volume'
import type { Triple, VolumeScale } from '../../data/precomputed/volume'
import { chunkPlanFor } from './chunkPlan'

const BASE = 'https://example.test/seg'

/** A scale with chunks a convenient 100 nm across, so a tip's box is countable by hand. */
const SCALE: VolumeScale = {
  key: '10_10_10',
  resolution: [10, 10, 10],
  size: [10000, 10000, 10000],
  chunkSize: [10, 10, 10],
  voxelOffset: [0, 0, 0],
  encoding: 'raw',
  dataType: 'uint64',
}

const boxes = { base: BASE, scale: SCALE, halfWidthNm: 40 }

/** The keys the *reader* would use for this tip's search box — the comparison that matters. */
function readerKeys(tip: Triple): string[] {
  return chunksCovering(SCALE, boxAround(SCALE, tip, 40)).map((chunk) =>
    chunkKeyOf(BASE, SCALE, chunk),
  )
}

describe('the chunk plan', () => {
  const far: Triple = [5000, 5000, 5000]
  // Far enough that the two boxes cover overlapping but different chunks: at 10 nm voxels and
  // chunks of 10, a 40 nm half-width puts `far` on chunks 49-50 and `near` on 50-51.
  const near: Triple = [5060, 5000, 5000]
  /** Hoisted: every test below asks one of these two questions of the same pair of boxes. */
  const shared = readerKeys(far).filter((key) => readerKeys(near).includes(key))
  const onlyFirst = readerKeys(far).filter((key) => !readerKeys(near).includes(key))

  /**
   * **The one way this fails silently.** A plan whose keys are not the reader's finds nothing,
   * answers `Infinity` for every chunk, and turns the policy back into guesswork without a word.
   * `chunkKeyOf` exists so the two have one spelling; this holds them to it.
   */
  it('names chunks exactly as the reader asks for them', () => {
    const plan = chunkPlanFor([far], boxes)
    const keys = readerKeys(far)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(plan.nextUse(key)).toBe(0)
  })

  it('says nothing is coming for a chunk no end will read', () => {
    const plan = chunkPlanFor([far], boxes)
    expect(plan.nextUse(`${BASE}/10_10_10/nowhere`)).toBe(Infinity)
  })

  /** Positions count in ends, so a chunk two ends want is wanted at the first of them. */
  it('answers with the nearest end that wants it', () => {
    const plan = chunkPlanFor([far, near], boxes)
    expect(shared.length).toBeGreaterThan(0)
    for (const key of shared) expect(plan.nextUse(key)).toBe(0)
  })

  /**
   * The whole mechanism in one case: once the end that wanted a chunk has been searched, the
   * chunk is wanted at `Infinity` and the cache drops it first. That is the "evict it when its
   * last end has passed" rule, arriving as a consequence rather than as its own machinery.
   */
  it('stops wanting a chunk once the last end that reads it is done', () => {
    const plan = chunkPlanFor([far, near], boxes)
    // A chunk only the first end reads — the two boxes overlap, so take the difference.
    expect(onlyFirst.length).toBeGreaterThan(0)
    expect(plan.nextUse(onlyFirst[0]!)).toBe(0)
    plan.advance()
    expect(plan.nextUse(onlyFirst[0]!)).toBe(Infinity)
    // And one the second end still wants is still wanted, at its own position.
    expect(plan.nextUse(shared[0]!)).toBe(1)
  })

  /** Asked twice at the same position it must answer the same — eviction asks per held chunk. */
  it('is idempotent at a position', () => {
    const plan = chunkPlanFor([far, near], boxes)
    plan.advance()
    expect(plan.nextUse(shared[0]!)).toBe(1)
    expect(plan.nextUse(shared[0]!)).toBe(1)
  })

  /**
   * A geometry-only run reads no patch box, so naming its chunks would hold bytes nothing asks
   * for and evict bytes something does. Absent `patchScale` means the search boxes alone.
   */
  it('plans the search boxes alone where no assessor runs', () => {
    const withPatch = chunkPlanFor([far], {
      ...boxes,
      patchScale: SCALE,
      patchReachNm: 200,
    })
    const searchOnly = chunkPlanFor([far], boxes)
    expect(searchOnly.chunks).toBeLessThan(withPatch.chunks)
    expect(searchOnly.chunks).toBe(readerKeys(far).length)
  })

  it('knows how many chunks it is planning for', () => {
    expect(chunkPlanFor([], boxes).chunks).toBe(0)
    expect(chunkPlanFor([far], boxes).chunks).toBe(readerKeys(far).length)
  })
})
