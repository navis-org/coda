/**
 * The arithmetic, against numbers worked out by hand.
 *
 * Every failure this file exists for produces a *plausible* matrix: a weighting applied to the
 * wrong array, a direction taken backwards, a mirrored half that is subtly not the other half.
 * So the fixtures are geometry whose answers are exact — axis-aligned segments, right-angled
 * triangles — rather than anything realistic, and the symmetric fast path is checked against the
 * walk it replaces rather than against a recorded expectation.
 */

import { describe, expect, it } from 'vitest'
import { quantileSorted } from '../../core/stats'
import type { MeshGeometry, SkeletonGeometry } from '../../core/values'
import type { DistanceParams, Samples } from './geometryDistance'
import {
  centroidOf,
  checkDistanceSize,
  countLookups,
  combineDirections,
  directedNearest,
  directedWithin,
  distanceMeasure,
  distanceParamsFrom,
  distanceValueLabel,
  distanceValues,
  mixedQuantityRefusal,
  closestPairApplies,
  estimatedSeconds,
  descentApplies,
  needsQueryIndexes,
  pairsWalked,
  symmetricCells,
  SYMMETRY_OPTIONS,
  medianScratch,
  sampleCount,
  samplesOf,
  symmetryOptionsFor,
} from './geometryDistance'
import { chain } from './__fixtures__/chain'
import { rng } from './__fixtures__/rng'
import type { TargetIndex } from './geometryDistance'
import { treeFor } from './geometryIndex'

/** One right-angled triangle with legs `a` and `b` in the z = `z` plane. */
function triangle(id: string, a: number, b: number, z = 0): MeshGeometry {
  return {
    id,
    positions: Float32Array.from([0, 0, z, a, 0, z, 0, b, z]),
    indices: Uint32Array.from([0, 1, 2]),
  }
}

/*
 * Indexes come from `treeFor` throughout — **not a hand-built stand-in**. Written out here, this
 * suite exercised only the per-sample fallback and the dual-tree arm was invisible at the
 * module's own test seam, which is what `TargetIndex.points` was added to fix.
 */

/**
 * A stub index answering from a table, keyed by the sample's own x — `chain` spaces its nodes
 * evenly, so `x / 1000` is the index.
 *
 * It is the only way to hand a *non-finite* distance to `directedNearest`, a real tree always
 * finding something. Module scope and one spelling, for `chain.ts`' reason: this was written
 * twice in this file with the step hard-coded in one copy, which is how a `TargetIndex` gaining a
 * field leaves the second stub with a silent `undefined`.
 */
const table = (values: readonly number[]): TargetIndex => ({
  nearest: (x) => values[Math.round(x / 1000)] ?? Infinity,
  hasWithin: (x, _y, _z, dist) => (values[Math.round(x / 1000)] ?? Infinity) <= dist,
})

const PARAMS = {
  method: 'nearest',
  statistic: 'min',
  within: 2,
  report: 'absolute',
  symmetry: 'mean',
  limit: 500,
}

/** `PARAMS` with a few keys changed, which is what every case below wants. */
const params = (overrides: Record<string, unknown> = {}): DistanceParams =>
  distanceParamsFrom({ ...PARAMS, ...overrides })

describe('samplesOf', () => {
  it('weights a skeleton node by half the cable at it, summing to the whole', () => {
    // Five nodes, four 100 nm edges: the ends carry 50, the three interior nodes 100.
    const samples = samplesOf(chain('a', 5, 100))
    expect(Array.from(samples.weights)).toEqual([50, 100, 100, 100, 50])
    expect(samples.total).toBe(400)
  })

  it('weights a mesh vertex by a third of the area at it, summing to the whole', () => {
    // Legs of 6 and 8: area 24, a third of it at each of the three corners.
    const samples = samplesOf(triangle('m', 6, 8))
    expect(samples.total).toBeCloseTo(24, 6)
    expect(Array.from(samples.weights)).toEqual([8, 8, 8])
  })

  it('gives a lone node no weight rather than a made-up one', () => {
    const samples = samplesOf(chain('a', 1, 100))
    expect(samples.total).toBe(0)
    expect(Array.from(samples.weights)).toEqual([0])
  })
})

describe('centroidOf', () => {
  it('takes the centre of mass of the cable, not of the nodes', () => {
    /*
     * The failure this pins: nodes bunched at one end. Four nodes at 0, 10, 20 and 1000 have a
     * *node* mean of 257.5 and a cable centre of mass at 500 — the midpoint of a cable that is
     * almost all one long edge. An unweighted centroid would be dragged to wherever a tracer
     * happened to click most.
     */
    const positions = Float32Array.from([0, 0, 0, 10, 0, 0, 20, 0, 0, 1000, 0, 0])
    const item: SkeletonGeometry = {
      id: 'a',
      positions,
      radii: new Float32Array(4),
      parents: Int32Array.from([-1, 0, 1, 2]),
    }
    expect(centroidOf(item)[0]).toBeCloseTo(500, 6)
  })

  it('falls back to the plain mean where there is no cable and no area', () => {
    const item: SkeletonGeometry = {
      id: 'a',
      positions: Float32Array.from([0, 0, 0, 100, 0, 0]),
      radii: new Float32Array(2),
      // Two roots: real positions, no edge between them, so no weight anywhere.
      parents: Int32Array.from([-1, -1]),
    }
    expect(centroidOf(item)[0]).toBeCloseTo(50, 6)
  })
})

describe('directedNearest', () => {
  // Query runs along y = 0 from x = 0 to 400; target along y = 300 from x = 0 to 400. Every
  // query node is exactly 300 from the node opposite it, so every statistic is 300.
  const query = chain('q', 5, 100, 0)
  const target = chain('t', 5, 100, 300)

  it('answers every statistic on a parallel pair', () => {
    for (const statistic of ['min', 'mean', 'median', 'max'] as const) {
      expect(directedNearest(samplesOf(query), treeFor(target), statistic)).toBeCloseTo(300, 4)
    }
  })

  it('separates the closest approach from the furthest — the Hausdorff distance', () => {
    // A target of one node at the query's far end: distances run 400, 300, 200, 100, 0.
    const one = chain('t', 1, 0, 0)
    const shifted: SkeletonGeometry = { ...one, positions: Float32Array.from([400, 0, 0]) }
    expect(directedNearest(samplesOf(query), treeFor(shifted), 'min')).toBeCloseTo(0, 4)
    expect(directedNearest(samplesOf(query), treeFor(shifted), 'max')).toBeCloseTo(400, 4)
    // Weighted mean: ends carry 50 of the 400 nm of cable, the interior nodes 100 each.
    // (400·50 + 300·100 + 200·100 + 100·100 + 0·50) / 400 = 200.
    expect(directedNearest(samplesOf(query), treeFor(shifted), 'mean')).toBeCloseTo(200, 4)
    expect(directedNearest(samplesOf(query), treeFor(shifted), 'median')).toBeCloseTo(200, 4)
  })

  it('does not move when the query is resampled, which is the whole point of the weighting', () => {
    /*
     * The same cable — 0 to 400 nm along x — traced at two spacings, against the same target.
     * An unweighted mean gives 250 for the coarse chain and 209.5 for the fine one; weighted,
     * both are the cable's own mean and agree.
     */
    const coarse = chain('q', 3, 200, 0)
    const fine = chain('q', 41, 10, 0)
    const far = chain('t', 1, 0, 0)
    const at: SkeletonGeometry = { ...far, positions: Float32Array.from([0, 0, 0]) }
    const a = directedNearest(samplesOf(coarse), treeFor(at), 'mean')
    const b = directedNearest(samplesOf(fine), treeFor(at), 'mean')
    expect(a).toBeCloseTo(200, 4)
    expect(b).toBeCloseTo(200, 1)
  })

  it('counts a weightless node for min and max and not for the average', () => {
    // A lone node has no cable at it; it is still part of the neuron.
    const lone = chain('q', 1, 0, 0)
    const target500: SkeletonGeometry = {
      ...lone,
      positions: Float32Array.from([500, 0, 0]),
    }
    expect(directedNearest(samplesOf(lone), treeFor(target500), 'min')).toBeCloseTo(500, 4)
    // No weight at all: the plain mean is the honest fallback, not NaN.
    expect(directedNearest(samplesOf(lone), treeFor(target500), 'mean')).toBeCloseTo(500, 4)
  })
})

describe('the median scratch', () => {
  it('reads no distance a previous pair left behind', () => {
    /*
     * The licence the shared buffer rests on: `distances` is written at sample index `i` and read
     * only where `order` points, so a stale value sits in a slot nothing looks at. Getting that
     * wrong is a silently wrong number rather than a crash, which is why it is asserted against a
     * fresh buffer rather than against a recorded expectation.
     */
    const samples = samplesOf(chain('q', 8, 1000))
    const huge = table([9e9, 9e9, 9e9, 9e9, 9e9, 9e9, 9e9, 9e9])
    // Only the first two samples are measurable; the rest come back `Infinity` and are skipped,
    // so their slots still hold 9e9 from the call before.
    const sparse = table([10, 30, Infinity, Infinity, Infinity, Infinity, Infinity, Infinity])

    const shared = medianScratch(8)
    directedNearest(samples, huge, 'median', shared)
    const after = directedNearest(samples, sparse, 'median', shared)

    expect(after).toBe(directedNearest(samples, sparse, 'median', medianScratch(8)))
    expect(after).toBeLessThan(100)
  })

  it('gives the same answers across a run as a fresh buffer would, at every size', () => {
    // Pairs of different lengths through one scratch: a shorter neuron after a longer one is
    // where a length-dependent bug would show.
    const scratch = medianScratch(40)
    for (const nodes of [40, 3, 17, 40, 2]) {
      const samples = samplesOf(chain('q', nodes, 1000))
      const index = table(Array.from({ length: nodes }, (_, i) => (i % 5) * 100 + 1))
      expect(directedNearest(samples, index, 'median', scratch)).toBe(
        directedNearest(samples, index, 'median', medianScratch(nodes)),
      )
    }
  })

  it('allocates its own where a caller supplies none', () => {
    const samples = samplesOf(chain('q', 4, 1000))
    const index = table([5, 15, 25, 35])
    expect(directedNearest(samples, index, 'median')).toBe(
      directedNearest(samples, index, 'median', medianScratch(4)),
    )
  })
})

describe('the median sort', () => {
  /*
   * `sortByDistance` is not exported, so these reach it through the statistic it serves — and
   * they check *properties* rather than a second implementation of the walk, which would agree
   * with a broken sort as readily as with a working one. A sort that mis-orders a run of equal
   * keys, or drops the tail of a partition, returns a real distance from the right neuron at the
   * wrong rank: nothing about the number looks wrong.
   */
  /** A `Samples` built to order, which is the only way to control the weights exactly. */
  const samplesWith = (distances: readonly number[], weights: readonly number[]): Samples => ({
    positions: Float32Array.from(distances.flatMap((_, i) => [i * 1000, 0, 0])),
    weights: Float64Array.from(weights),
    total: weights.reduce((sum, w) => sum + w, 0),
    count: distances.length,
  })

  it('equals quantileSorted where every sample weighs the same, which is what the walk claims', () => {
    /*
     * `weightedMedian` reads a set carrying no weight at all as one where every sample weighs the
     * same, and says the two agree by construction: at uniform weights the half-weight point *is*
     * the middle. `quantileSorted` is the app's one definition of a quantile, so it is the oracle
     * — and an independent one, since it sorts values where this sorts indices.
     */
    const next = rng(7)
    for (const count of [1, 2, 3, 8, 9, 40, 101]) {
      const distances = Array.from({ length: count }, () => next() * 1000)
      const samples = samplesWith(
        distances,
        distances.map(() => 0),
      )
      const sorted = Float64Array.from(distances).sort()
      expect(directedNearest(samples, table(distances), 'median')).toBeCloseTo(
        quantileSorted(sorted, 0.5),
        9,
      )
    }
  })

  it('answers a weighted median by its defining property, over runs a sort can trip on', () => {
    /*
     * Half the weight is no further than the answer and half is no nearer. Checked rather than
     * recomputed, so the assertion cannot be satisfied by the same mistake twice — and over the
     * four shapes that break a quicksort differently: distinct keys, a handful of repeated ones,
     * already ordered, and every key the same.
     */
    const next = rng(11)
    const shapes = {
      distinct: (i: number) => next() * 1000 + i * 1e-9,
      ties: () => Math.floor(next() * 4) * 100,
      ordered: (i: number) => i * 10,
      reversed: (i: number, n: number) => (n - i) * 10,
      constant: () => 42,
    }
    const scratch = medianScratch(200)
    for (const [name, at] of Object.entries(shapes)) {
      for (const count of [2, 5, 17, 60, 200]) {
        const distances = Array.from({ length: count }, (_, i) => at(i, count))
        const weights = distances.map(() => next() * 9 + 1)
        const samples = samplesWith(distances, weights)
        const median = directedNearest(samples, table(distances), 'median', scratch)
        const half = samples.total / 2
        const below = distances.reduce((sum, d, i) => (d < median ? sum + weights[i]! : sum), 0)
        const above = distances.reduce((sum, d, i) => (d > median ? sum + weights[i]! : sum), 0)
        // The label through `expect`'s second argument, so a failure prints the two numbers that
        // disagree rather than a diff of two nearly identical sentences.
        const where = `${name} x ${count}`
        expect(below, where).toBeLessThanOrEqual(half + 1e-9)
        expect(above, where).toBeLessThanOrEqual(half + 1e-9)
        // …and it is a distance the set actually contains, or the midpoint of two of them.
        expect(median).toBeGreaterThanOrEqual(Math.min(...distances))
        expect(median).toBeLessThanOrEqual(Math.max(...distances))
      }
    }
  })

  it('sorts a run longer than the insertion tail, which is the only path that partitions', () => {
    // Under `INSERTION_RUN` the quicksort never runs at all, so a suite of small fixtures would
    // exercise the insertion sort and nothing else. Descending input is its worst ordering.
    const count = 500
    const distances = Array.from({ length: count }, (_, i) => count - i)
    const weights = distances.map(() => 1)
    const samples = samplesWith(distances, weights)
    // 500 samples of equal weight: the half falls between the 250th and 251st smallest.
    expect(directedNearest(samples, table(distances), 'median')).toBeCloseTo(250.5, 9)
  })
})

describe('directedWithin', () => {
  const query = chain('q', 5, 100, 0)

  it('sums the cable at the nodes that are close enough, and no more', () => {
    // A target node at x = 0: nodes at 0 and 100 are within 150, carrying 50 + 100 = 150 nm.
    const lone = chain('t', 1, 0, 0)
    expect(directedWithin(samplesOf(query), treeFor(lone), 150)).toBeCloseTo(150, 4)
    // Within 450 nm every node but the last qualifies: 50 + 100 + 100 + 100 = 350.
    expect(directedWithin(samplesOf(query), treeFor(lone), 350)).toBeCloseTo(350, 4)
    // Far enough away for all of it.
    expect(directedWithin(samplesOf(query), treeFor(lone), 1000)).toBeCloseTo(400, 4)
  })

  it('is bounded by the neuron’s own cable however dense the other one is', () => {
    /*
     * The property that separates this from `navis.cable_overlap`, which sums the length of each
     * query node *once per target point that picks it* — so a dense target inflates the overlap
     * of a sparse query past its own total. Here the same cable is counted once whether the
     * target has one node or a thousand.
     */
    const sparse = chain('t', 1, 0, 1)
    const dense = chain('t', 1000, 1, 1)
    const total = samplesOf(query).total
    expect(directedWithin(samplesOf(query), treeFor(sparse), 1e6)).toBeCloseTo(total, 4)
    expect(directedWithin(samplesOf(query), treeFor(dense), 1e6)).toBeCloseTo(total, 4)
  })
})

describe('combineDirections', () => {
  it('combines the two directions each way', () => {
    expect(combineDirections(2, 6, 'mean')).toBe(4)
    expect(combineDirections(2, 6, 'min')).toBe(2)
    expect(combineDirections(2, 6, 'max')).toBe(6)
    expect(combineDirections(2, 6, 'query')).toBe(2)
  })

  it('propagates an unmeasured direction rather than falling back on the other', () => {
    // The smaller of a measured 4 and a pair half of which says nothing is not 4.
    expect(combineDirections(4, NaN, 'min')).toBeNaN()
    expect(combineDirections(NaN, 4, 'mean')).toBeNaN()
    // Except where the reverse is never asked for.
    expect(combineDirections(4, NaN, 'query')).toBe(4)
  })
})

describe('distanceValues', () => {
  const items = [chain('a', 3, 100, 0), chain('b', 3, 100, 1000), chain('c', 3, 100, 3000)]
  const indexes = items.map(treeFor)

  const walk = (overrides: Record<string, unknown>, allByAll = true) => ({
    queryItems: items,
    targetItems: items,
    targetIndexes: indexes,
    queryIndexes: indexes,
    params: distanceParamsFrom({ ...PARAMS, ...overrides }),
    queryKind: 'skeletons' as const,
    allByAll,
  })

  it('reports micrometres, with a zero diagonal on an all-by-all', () => {
    return distanceValues(walk({})).then((values) => {
      // Row-major 3 x 3. The chains are 1,000 and 2,000 nm apart in y.
      expect(Array.from(values)).toEqual([0, 1, 3, 1, 0, 2, 3, 2, 0])
    })
  })

  it('mirrors the upper triangle rather than recomputing it — and gets the same matrix', async () => {
    /*
     * The fast path against the walk it replaces. A mirror written into the wrong cell gives a
     * matrix that is still full of plausible distances, so this compares cell for cell with
     * `allByAll: false`, which computes every pair.
     */
    for (const statistic of ['min', 'mean', 'max'] as const) {
      for (const symmetry of ['mean', 'min', 'max'] as const) {
        const mirroredRun = await distanceValues(walk({ statistic, symmetry }, true))
        const full = await distanceValues(walk({ statistic, symmetry }, false))
        expect(Array.from(mirroredRun)).toEqual(Array.from(full))
      }
    }
  })

  it('mirrors a closest approach and a centroid even on one direction', async () => {
    /*
     * The pair `symmetricCells` was added for. Both are symmetric quantities, so `Symmetry:
     * query against target only` — which an empty options list keeps in the params after the
     * control goes dead — must still halve the walk and must halve it into the right cells.
     */
    for (const overrides of [{ statistic: 'min' }, { method: 'centroid' }] as const) {
      const settings = { ...overrides, symmetry: 'query' } as const
      const mirroredRun = await distanceValues(walk(settings, true))
      const full = await distanceValues(walk(settings, false))
      expect(Array.from(mirroredRun)).toEqual(Array.from(full))
      // …and the matrix really is symmetric, or "the same as the full walk" is two bugs agreeing.
      expect(mirroredRun[1]).toBeCloseTo(mirroredRun[3]!, 12)
      expect(mirroredRun[2]).toBeCloseTo(mirroredRun[6]!, 12)
    }
  })

  it('walks half the grid where the cells are symmetric, not only where two directions are', async () => {
    /*
     * **The halving is invisible in the values**, which is why this counts rather than compares:
     * an unmirrored walk computes every cell and arrives at the same matrix, just twice as
     * slowly, so the test above passes whether or not the mirror fires. `TargetIndex.points` is
     * the seam `cellFor` asks once per side per *evaluated* pair, so a getter over it is the cell
     * count without reaching inside the walk.
     *
     * Three neurons: six cells mirrored, nine not. Put `symmetry !== 'query'` back in place of
     * `symmetricCells` and this reads nine.
     */
    let reads = 0
    const counted = items.map((item) => {
      const built = treeFor(item)
      return {
        ...built,
        get points() {
          reads++
          return built.points
        },
      }
    })
    const cellsFor = async (symmetry: 'mean' | 'query') => {
      reads = 0
      await distanceValues({
        queryItems: items,
        targetItems: items,
        targetIndexes: counted,
        queryIndexes: counted,
        params: distanceParamsFrom({ ...PARAMS, statistic: 'min', symmetry }),
        queryKind: 'skeletons' as const,
        allByAll: true,
      })
      // One read per side of each pair the descent was asked about.
      return reads / 2
    }
    expect(await cellsFor('mean')).toBe(6)
    expect(await cellsFor('query')).toBe(6)
  })

  it('does not mirror an asymmetric measurement', async () => {
    // Two neurons of very different extents: measured one way only, the matrix is not symmetric,
    // and mirroring it would invent the other half.
    const small = chain('s', 2, 100, 0)
    const large = chain('l', 40, 100, 0)
    const pair = [small, large]
    const values = await distanceValues({
      queryItems: pair,
      targetItems: pair,
      targetIndexes: pair.map(treeFor),
      params: distanceParamsFrom({ ...PARAMS, statistic: 'max', symmetry: 'query' }),
      queryKind: 'skeletons' as const,
      allByAll: true,
    })
    // small → large is 0 (it lies on the large one); large → small is its far end, 3,800 nm.
    expect(values[1]).toBeCloseTo(0, 6)
    expect(values[2]).toBeCloseTo(3.8, 6)
  })

  it('reports a within-fraction of one for a neuron against itself', async () => {
    const values = await distanceValues(
      walk({ method: 'within', report: 'fraction', within: 0.5 }),
    )
    expect(values[0]).toBeCloseTo(1, 6)
    expect(values[4]).toBeCloseTo(1, 6)
    // A thousand nanometres away is well past half a micrometre.
    expect(values[1]).toBeCloseTo(0, 6)
  })

  it('reports absolute overlap in µm of cable', async () => {
    const values = await distanceValues(walk({ method: 'within', within: 0.5 }))
    // Each chain is 200 nm of cable: 0.2 µm, all of it within half a micrometre of itself.
    expect(values[0]).toBeCloseTo(0.2, 6)
  })

  it('measures centroids without asking either side for an index', async () => {
    const values = await distanceValues({
      queryItems: items,
      targetItems: items,
      targetIndexes: [],
      params: distanceParamsFrom({ ...PARAMS, method: 'centroid' }),
      queryKind: 'skeletons' as const,
      allByAll: true,
    })
    expect(Array.from(values)).toEqual([0, 1, 3, 1, 0, 2, 3, 2, 0])
  })
})

describe('a neuron with nothing to measure', () => {
  /*
   * A one-node skeleton has no cable at it, so `samplesOf` gives it a total of zero — which is a
   * real value a source can produce and the one input where the `within` shortcut and the walk it
   * stands in for used to disagree.
   */
  const lone = chain('lone', 1, 100)
  const near = chain('near', 5, 100)
  const far = chain('far', 5, 100, 900_000)
  const query = [lone]
  const targets = [near, far]

  const cells = async (report: 'absolute' | 'fraction') =>
    Array.from(
      await distanceValues({
        queryItems: query,
        targetItems: targets,
        targetIndexes: targets.map(treeFor),
        queryIndexes: query.map(treeFor),
        params: distanceParamsFrom({
          ...PARAMS,
          method: 'within',
          report,
          within: 1,
          symmetry: 'query',
        }),
        queryKind: 'skeletons' as const,
        allByAll: false,
      }),
    )

  it('answers a fraction the same way whether or not the pre-rejection fires', async () => {
    /*
     * The far pair is rejected by the descent and the near one is walked, and both are asking the
     * same question of a neuron that has no cable to take a fraction of. The shortcut returned a
     * literal 0, so the answer depended on how far away the *other* neuron was — near said "not
     * measured" and far said "none of it", about the same neuron, in one row.
     */
    const [nearCell, farCell] = await cells('fraction')
    expect(nearCell).toBeNaN()
    expect(farCell).toBeNaN()
  })

  it('answers an absolute zero either way, which is what it always did', async () => {
    const [nearCell, farCell] = await cells('absolute')
    expect(nearCell).toBe(0)
    expect(farCell).toBe(0)
  })

  it('still answers a fraction of one for a neuron that has cable', async () => {
    // The rule is about an absent denominator, not about the shortcut: a real neuron is unmoved.
    const values = await distanceValues({
      queryItems: [near],
      targetItems: targets,
      targetIndexes: targets.map(treeFor),
      queryIndexes: [near].map(treeFor),
      params: distanceParamsFrom({
        ...PARAMS,
        method: 'within',
        report: 'fraction',
        within: 1,
        symmetry: 'query',
      }),
      queryKind: 'skeletons' as const,
      allByAll: false,
    })
    expect(values[0]).toBeCloseTo(1, 9)
    expect(values[1]).toBe(0)
  })
})

describe('the box-gap pre-rejection', () => {
  /*
   * The half of `within`'s shortcut that serves every kind. It is a *lower* bound on the
   * distance, so the way it goes wrong is rejecting a pair that does have cable within the
   * distance — a flat zero cell that looks exactly like a true one. The boundary is where that
   * shows, so these sit either side of it and on it.
   */
  const near = chain('near', 5, 100)
  const far = chain('far', 5, 100, 1000)

  const cell = async (withinUm: number) =>
    (
      await distanceValues({
        queryItems: [near],
        targetItems: [far],
        targetIndexes: [treeFor(far)],
        queryIndexes: [treeFor(near)],
        params: distanceParamsFrom({
          ...PARAMS,
          method: 'within',
          within: withinUm,
          symmetry: 'query',
        }),
        queryKind: 'skeletons' as const,
        allByAll: false,
      })
    )[0]

  it('rejects only past the gap, and never on it', async () => {
    // The two chains are 1,000 nm apart in y, so the boxes are too.
    expect(await cell(0.5)).toBe(0)
    // Exactly on it: the bound is inclusive, as `hasWithin`'s is, so every node counts.
    expect(await cell(1)).toBeCloseTo(0.4, 9)
    expect(await cell(1.5)).toBeCloseTo(0.4, 9)
  })

  it('agrees with the walk where the boxes overlap and the neurons do not touch', async () => {
    /*
     * Boxes that overlap tell the shortcut nothing, so this is the case it must hand on rather
     * than answer — two chains crossing in x with a gap in y larger than the distance asked
     * about.
     */
    const across = {
      ...chain('across', 5, 100, 400),
      positions: Float32Array.from([
        200, 400, 0, 200, 300, 0, 200, 200, 0, 200, 100, 0, 200, 0, 0,
      ]),
    }
    const values = await distanceValues({
      queryItems: [near],
      targetItems: [across],
      targetIndexes: [treeFor(across)],
      queryIndexes: [treeFor(near)],
      params: distanceParamsFrom({
        ...PARAMS,
        method: 'within',
        within: 0.05,
        symmetry: 'query',
      }),
      queryKind: 'skeletons' as const,
      allByAll: false,
    })
    // The boxes overlap, so nothing is rejected; the chains meet at (200, 0), so some cable is
    // within 50 nm of the other and the answer is neither zero nor the whole neuron.
    expect(values[0]!).toBeGreaterThan(0)
    expect(values[0]!).toBeLessThan(0.4)
  })
})

describe('sampleCount', () => {
  it('counts a skeleton by its parents, which is what the tree is built over', () => {
    /*
     * `kdTree.ts` builds over `parents.length` and says the two "agree on every skeleton a source
     * produces, and where they do not the tree is the one that must not read past the tree". The
     * weights were allocated at that count and every reader walked `positions.length / 3`, so a
     * disagreement read `weights[i]` as `undefined` and turned a whole pair into `NaN`.
     */
    const ragged: SkeletonGeometry = {
      id: 'ragged',
      // Three nodes of parents against four positions' worth of buffer.
      positions: Float32Array.from([0, 0, 0, 100, 0, 0, 200, 0, 0, 300, 0, 0]),
      radii: new Float32Array(3),
      parents: Int32Array.from([-1, 0, 1]),
    }
    expect(sampleCount(ragged)).toBe(3)
    expect(samplesOf(ragged).count).toBe(3)
    expect(samplesOf(ragged).weights.length).toBe(3)

    // …and the statistics answer a number rather than NaN, which is the symptom.
    const target = treeFor(chain('t', 3, 100, 1000))
    for (const statistic of ['min', 'mean', 'median', 'max'] as const) {
      expect(directedNearest(samplesOf(ragged), target, statistic)).toBeCloseTo(1000, 6)
    }
    expect(directedWithin(samplesOf(ragged), target, 1100)).toBeGreaterThan(0)
  })

  it('counts a mesh by its vertices', () => {
    const square: MeshGeometry = {
      id: 'm',
      positions: Float32Array.from([0, 0, 0, 100, 0, 0, 0, 100, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    }
    expect(sampleCount(square)).toBe(3)
    expect(samplesOf(square).count).toBe(3)
  })
})

describe('what the cells are called and what they are', () => {
  it('names the statistic, the distance and the quantity', () => {
    const label = (
      overrides: Record<string, unknown>,
      kind: 'skeletons' | 'meshes' = 'skeletons',
    ) => distanceValueLabel(distanceParamsFrom({ ...PARAMS, ...overrides }), kind)
    expect(label({})).toBe('closest approach (µm)')
    expect(label({ statistic: 'max' })).toBe('Hausdorff distance (µm)')
    expect(label({ method: 'centroid' })).toBe('centroid distance (µm)')
    expect(label({ method: 'within' })).toBe('cable within 2 µm (µm)')
    expect(label({ method: 'within' }, 'meshes')).toBe('surface area within 2 µm (µm²)')
    expect(label({ method: 'within', report: 'fraction' })).toBe(
      'fraction of cable within 2 µm',
    )
  })

  it('tells Linkage which matrices it may cluster as they stand', () => {
    const measure = (overrides: Record<string, unknown>) =>
      distanceMeasure(distanceParamsFrom({ ...PARAMS, ...overrides }))
    expect(measure({})).toBe('distance')
    expect(measure({ method: 'centroid' })).toBe('distance')
    // Bounded by 1, so `1 - x` is a proper distance.
    expect(measure({ method: 'within', report: 'fraction' })).toBe('similarity')
    // Unbounded µm: `1 - 340` is the negative-distance trap `checkLinkageDistances` refuses.
    expect(measure({ method: 'within' })).toBe('count')
  })
})

describe('mixedQuantityRefusal', () => {
  it('refuses to average µm of cable against µm² of surface', () => {
    const message = mixedQuantityRefusal({
      params: params({ method: 'within' }),
      queryKind: 'skeletons',
      targetKind: 'meshes',
    })
    expect(message).toContain('µm²')
    expect(message).toContain('query against target only')
  })

  it('says nothing where the two directions are the same quantity, or only one is taken', () => {
    expect(
      mixedQuantityRefusal({
        params: params({ method: 'within' }),
        queryKind: 'skeletons',
        targetKind: 'skeletons',
      }),
    ).toBeUndefined()
    expect(
      mixedQuantityRefusal({
        params: params({ method: 'within', symmetry: 'query' }),
        queryKind: 'skeletons',
        targetKind: 'meshes',
      }),
    ).toBeUndefined()
    // Distances are µm whichever kind they were measured on.
    expect(
      mixedQuantityRefusal({
        params: params({}),
        queryKind: 'skeletons',
        targetKind: 'meshes',
      }),
    ).toBeUndefined()
  })

  it('says nothing about an unresolved socket', () => {
    expect(
      mixedQuantityRefusal({
        params: params({ method: 'within' }),
        queryKind: 'skeletons',
        targetKind: undefined,
      }),
    ).toBeUndefined()
    expect(
      mixedQuantityRefusal({
        params: params({ method: 'within' }),
        queryKind: undefined,
        targetKind: undefined,
      }),
    ).toBeUndefined()
  })
})

describe('countLookups', () => {
  const a = [chain('a', 100, 10), chain('b', 200, 10)]
  const b = [chain('c', 50, 10)]

  it('counts a search per query sample, over the pairs actually computed', () => {
    // Mean of 100 and 200 samples, over six pairs, one direction.
    expect(countLookups(a, b, distanceParamsFrom({ ...PARAMS, symmetry: 'query' }), 6)).toBe(
      900,
    )
  })

  it('counts the reverse direction too where it will be taken', () => {
    // Plus the target's 50 a pair.
    expect(countLookups(a, b, distanceParamsFrom({ ...PARAMS }), 6)).toBe(1200)
  })

  it('counts half a grid for a mirrored all-by-all, not all of it', () => {
    // The commonest shape there is, and counting the whole grid was a straight factor of two.
    const whole = countLookups(a, a, distanceParamsFrom({ ...PARAMS }), 2 * 2)
    const upper = countLookups(a, a, distanceParamsFrom({ ...PARAMS }), (2 * 3) / 2)
    expect(upper).toBeLessThan(whole)
    expect(upper / whole).toBeCloseTo(0.75, 6)
  })

  it('counts nothing for a centroid, which asks no point anything', () => {
    expect(countLookups(a, b, distanceParamsFrom({ ...PARAMS, method: 'centroid' }), 6)).toBe(0)
  })
})

describe('closestPairApplies and the indexes it needs', () => {
  it('answers for a closest approach between two point sets, whatever the symmetry', () => {
    /*
     * **`Symmetry` is not part of it**, and that is the defect this pins. The descent answers a
     * symmetric quantity, so it serves every setting — but the node used to build the query-side
     * index only when two directions were combined, which switched the fast path off for
     * `query against target only` and then priced the run as though it had run anyway.
     */
    for (const symmetry of ['mean', 'min', 'max', 'query'] as const) {
      expect(
        closestPairApplies({
          params: params({ symmetry }),
          queryKind: 'skeletons',
          targetKind: 'skeletons',
        }),
      ).toBe(true)
      expect(
        needsQueryIndexes({
          params: params({ symmetry }),
          queryKind: 'skeletons',
          targetKind: 'skeletons',
        }),
      ).toBe(true)
    }
  })

  it('declines a surface, which shares no descent with a point set', () => {
    expect(
      closestPairApplies({ params: params({}), queryKind: 'meshes', targetKind: 'meshes' }),
    ).toBe(false)
    expect(
      closestPairApplies({ params: params({}), queryKind: 'skeletons', targetKind: 'meshes' }),
    ).toBe(false)
  })

  it('declines every method but a closest approach', () => {
    for (const overrides of [
      { statistic: 'mean' },
      { statistic: 'median' },
      { statistic: 'max' },
      { method: 'within' },
      { method: 'centroid' },
    ]) {
      expect(
        closestPairApplies({
          params: params(overrides),
          queryKind: 'skeletons',
          targetKind: 'skeletons',
        }),
      ).toBe(false)
    }
  })

  it('descends for within too, which is what the query-side trees are for', () => {
    /*
     * The defect this pins, and it is `closestPairApplies`' own one method over: `within` asks
     * the descent as an exact pre-rejection, so it reads the query side's tree exactly as a
     * closest approach does — and `needsQueryIndexes` asked only about the closest approach, so
     * on two ports with one direction the pre-rejection had no tree and never fired. An
     * all-by-all hands its target indexes over as its query indexes, so the two ports and the
     * one disagreed about the same settings.
     */
    for (const symmetry of ['mean', 'min', 'max', 'query'] as const) {
      const within = params({ method: 'within', symmetry })
      expect(
        descentApplies({ params: within, queryKind: 'skeletons', targetKind: 'skeletons' }),
      ).toBe(true)
      expect(
        needsQueryIndexes({ params: within, queryKind: 'skeletons', targetKind: 'skeletons' }),
      ).toBe(true)
      // …and it is still not the descent's *answer*, which is what the cell reads.
      expect(
        closestPairApplies({ params: within, queryKind: 'skeletons', targetKind: 'skeletons' }),
      ).toBe(false)
    }
  })

  it('declines a descent for within wherever a surface is on either port', () => {
    const within = params({ method: 'within', symmetry: 'query' })
    expect(
      descentApplies({ params: within, queryKind: 'skeletons', targetKind: 'meshes' }),
    ).toBe(false)
    expect(descentApplies({ params: within, queryKind: 'meshes', targetKind: 'meshes' })).toBe(
      false,
    )
    expect(
      needsQueryIndexes({ params: within, queryKind: 'meshes', targetKind: 'meshes' }),
    ).toBe(false)
  })

  it('declines a descent for the statistics that walk every sample', () => {
    for (const statistic of ['mean', 'median', 'max'] as const) {
      expect(
        descentApplies({
          params: params({ statistic }),
          queryKind: 'skeletons',
          targetKind: 'skeletons',
        }),
      ).toBe(false)
    }
    expect(
      descentApplies({
        params: params({ method: 'centroid' }),
        queryKind: 'skeletons',
        targetKind: 'skeletons',
      }),
    ).toBe(false)
  })

  it('still needs a query index wherever two directions are combined', () => {
    // The other half of `needsQueryIndexes`, which is what it meant before the descent existed.
    expect(
      needsQueryIndexes({
        params: params({ statistic: 'mean' }),
        queryKind: 'skeletons',
        targetKind: 'meshes',
      }),
    ).toBe(true)
    expect(
      needsQueryIndexes({
        params: params({ statistic: 'mean', symmetry: 'query' }),
        queryKind: 'meshes',
        targetKind: 'meshes',
      }),
    ).toBe(false)
  })
})

describe('symmetricCells and the pairs it lets the walk skip', () => {
  it('is true wherever the two directions are combined, whatever the kinds', () => {
    for (const symmetry of ['mean', 'min', 'max'] as const) {
      for (const [q, t] of [
        ['skeletons', 'skeletons'],
        ['meshes', 'meshes'],
        ['skeletons', 'meshes'],
      ] as const) {
        expect(
          symmetricCells({
            params: params({ symmetry, statistic: 'max' }),
            queryKind: q,
            targetKind: t,
          }),
        ).toBe(true)
      }
    }
  })

  it('is true for the two quantities that are symmetric on one direction alone', () => {
    /*
     * The defect this pins: `symmetry === 'query'` was read as "the matrix is asymmetric", and
     * it is not — a centroid distance has one direction by construction, and a closest approach
     * between two point sets is a property of the two *sets*. An all-by-all in either of those
     * walked the whole grid and was priced at half of it.
     */
    const one = { symmetry: 'query' } as const
    expect(
      symmetricCells({
        params: params({ ...one, method: 'centroid' }),
        queryKind: 'skeletons',
        targetKind: 'skeletons',
      }),
    ).toBe(true)
    expect(
      symmetricCells({
        params: params({ ...one, method: 'centroid' }),
        queryKind: 'meshes',
        targetKind: 'meshes',
      }),
    ).toBe(true)
    expect(
      symmetricCells({ params: params(one), queryKind: 'skeletons', targetKind: 'skeletons' }),
    ).toBe(true)
    // …and that last one is the descent's, so a surface on either port takes it back.
    expect(
      symmetricCells({ params: params(one), queryKind: 'skeletons', targetKind: 'meshes' }),
    ).toBe(false)
    expect(
      symmetricCells({ params: params(one), queryKind: 'meshes', targetKind: 'meshes' }),
    ).toBe(false)
  })

  it('is false for one direction of anything that samples', () => {
    for (const overrides of [
      { statistic: 'mean' },
      { statistic: 'median' },
      { statistic: 'max' },
      { method: 'within' },
      { method: 'within', report: 'fraction' },
    ]) {
      expect(
        symmetricCells({
          params: params({ ...overrides, symmetry: 'query' }),
          queryKind: 'skeletons',
          targetKind: 'skeletons',
        }),
      ).toBe(false)
    }
  })

  it('halves an all-by-all only where the cells are symmetric', () => {
    const upper = (10 * 11) / 2
    expect(
      pairsWalked(
        10,
        10,
        { params: params({}), queryKind: 'skeletons', targetKind: undefined },
        true,
      ),
    ).toBe(upper)
    // The configuration the estimate was wrong for: one direction, but a symmetric quantity.
    expect(
      pairsWalked(
        10,
        10,
        {
          params: params({ symmetry: 'query' }),
          queryKind: 'skeletons',
          targetKind: undefined,
        },
        true,
      ),
    ).toBe(upper)
    // One direction of a statistic that samples: the whole grid, and it had better say so.
    expect(
      pairsWalked(
        10,
        10,
        {
          params: params({ symmetry: 'query', statistic: 'mean' }),
          queryKind: 'skeletons',
          targetKind: undefined,
        },
        true,
      ),
    ).toBe(100)
    // Two ports never mirror, whatever the two sides hold.
    expect(
      pairsWalked(
        10,
        4,
        { params: params({}), queryKind: 'skeletons', targetKind: 'skeletons' },
        false,
      ),
    ).toBe(40)
  })
})

describe('the Symmetry control', () => {
  it('is dead for a closest approach between two skeletons', () => {
    // Symmetric by construction, so every setting is the identity over two equal numbers.
    expect(
      symmetryOptionsFor({
        params: params({}),
        queryKind: 'skeletons',
        targetKind: 'skeletons',
      }),
    ).toEqual([])
    expect(
      symmetryOptionsFor({ params: params({}), queryKind: 'skeletons', targetKind: undefined }),
    ).toEqual([])
  })

  it('stays live wherever a mesh is on either port, which is where it is load-bearing', () => {
    /*
     * The case a `visibleIf` on `min` alone would have got wrong. A point set against a surface
     * and a surface against a point set are different measurements — only the query side is ever
     * sampled — so the two directions genuinely differ and the setting decides the answer.
     */
    for (const pair of [
      ['skeletons', 'meshes'],
      ['meshes', 'skeletons'],
      ['meshes', 'meshes'],
      ['meshes', undefined],
    ] as const) {
      expect(
        symmetryOptionsFor({ params: params({}), queryKind: pair[0], targetKind: pair[1] }),
      ).toBe(SYMMETRY_OPTIONS)
    }
  })

  it('stays live for every method that combines two directions', () => {
    for (const overrides of [
      { statistic: 'mean' },
      { statistic: 'max' },
      { method: 'within' },
    ]) {
      expect(
        symmetryOptionsFor({
          params: params(overrides),
          queryKind: 'skeletons',
          targetKind: 'skeletons',
        }),
      ).toBe(SYMMETRY_OPTIONS)
    }
  })

  it('stays live while a socket has not resolved', () => {
    // A half-built graph is not one whose settings should start greying themselves out.
    expect(
      symmetryOptionsFor({ params: params({}), queryKind: undefined, targetKind: undefined }),
    ).toBe(SYMMETRY_OPTIONS)
  })
})

describe('what it says it will cost', () => {
  const warner = () => {
    const seen: string[] = []
    return { warn: (m: string) => seen.push(m), seen }
  }
  it('prices a closest approach by the pair and everything else by the sample', () => {
    /*
     * The two shapes, and the reason there are two. A 2,600 x 2,600 all-by-all of 2,000-node
     * skeletons is 3.4 M pairs and 27 G nominal lookups; priced per lookup it reads as hours,
     * and `closestPair` does not perform a single one of them.
     */
    const pairs = (2_600 * 2_601) / 2
    const lookups = 2_000 * 2_600 * 2_600 * 2
    const closest = estimatedSeconds(pairs, lookups, {
      params: params({}),
      queryKind: 'skeletons',
      targetKind: undefined,
    })
    const mean = estimatedSeconds(pairs, lookups, {
      params: params({ statistic: 'mean' }),
      queryKind: 'skeletons',
      targetKind: undefined,
    })
    expect(closest).toBeLessThan(15 * 60)
    expect(mean).toBeGreaterThan(closest * 20)
  })

  it('prices a mesh dearer than a skeleton, and a mixed pair at the slower of the two', () => {
    const at = (query: 'skeletons' | 'meshes', target?: 'skeletons' | 'meshes') =>
      estimatedSeconds(100, 1e6, {
        params: params({ statistic: 'mean' }),
        queryKind: query,
        targetKind: target,
      })
    expect(at('meshes')).toBeGreaterThan(at('skeletons'))
    expect(at('skeletons', 'meshes')).toBe(at('meshes'))
    expect(at('meshes', 'skeletons')).toBe(at('meshes'))
  })

  it('charges nothing for a centroid, which searches nothing', () => {
    // Composed through `countLookups`, which is the one place that policy lives now —
    // `estimatedSeconds` no longer carries a second copy of it.
    const items = [chain('a', 10, 100)]
    const centroid = params({ method: 'centroid' })
    expect(
      estimatedSeconds(1e9, countLookups(items, items, centroid, 1e9), {
        params: centroid,
        queryKind: 'skeletons',
        targetKind: undefined,
      }),
    ).toBe(0)
  })

  it('offers the lever only where it works, and says the duration once', () => {
    /*
     * A coarser resample is worth a factor of ten to a statistic that asks every sample its own
     * question and nothing at all to a dual-tree descent, so offering it on a closest approach
     * would be advice that does not work. Nothing replaces it there: the progress bar says
     * whether the run is moving, and the neurons on the two ports are the question being asked.
     */
    const spread = warner()
    checkDistanceSize(spread, 500, 500, 600, {
      params: params({ statistic: 'mean' }),
      queryKind: 'skeletons',
      targetKind: undefined,
    })
    expect(spread.seen[0]).toContain('Clean Skeletons')

    const closest = warner()
    checkDistanceSize(closest, 500, 500, 600, {
      params: params({}),
      queryKind: 'skeletons',
      targetKind: undefined,
    })
    expect(closest.seen[0]).not.toContain('Clean Skeletons')

    // The duration appears once. Through `warnOverThreshold` it appeared twice — once as the
    // count past the threshold and once in the sentence explaining it.
    expect(closest.seen[0]!.match(/10 minutes/g)).toHaveLength(1)
    expect(closest.seen[0]).toBe(
      'A 500 x 500 comparison is about 10 minutes of searching. Running anyway; cancel if that ' +
        'is not what you meant.',
    )
  })

  it('stays quiet under five minutes, which the progress bar already describes', () => {
    const ctx = warner()
    // A minute of searching used to be worth a sentence; at thirty seconds the threshold was
    // firing in front of waits nobody would have sat through wondering.
    checkDistanceSize(ctx, 500, 500, 60, {
      params: params({}),
      queryKind: 'skeletons',
      targetKind: undefined,
    })
    expect(ctx.seen).toEqual([])
    checkDistanceSize(ctx, 500, 500, 301, {
      params: params({}),
      queryKind: 'skeletons',
      targetKind: undefined,
    })
    expect(ctx.seen).toHaveLength(1)
  })

  it('refuses a matrix that cannot be allocated, whatever it would have cost', () => {
    // The one thing here that is a refusal rather than a warning: `CRASH_FLOOR_BYTES`.
    expect(() =>
      checkDistanceSize(warner(), 100_000, 100_000, 0, {
        params: params({}),
        queryKind: 'skeletons',
        targetKind: undefined,
      }),
    ).toThrow(/matrix/)
  })
})
