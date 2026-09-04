/**
 * What the tree says about itself, checked against navis-fastcore rather than against intuition.
 *
 * Both trees below were run through `navis_fastcore` 0.13.0 — the exact wheel `sources.json`
 * pins — and the expected arrays are its output transcribed. That matters most for Strahler: a
 * plausible implementation and the reference one disagree only at a converging branch where
 * *some* of the children share the maximum, which no bifurcating fixture can reach.
 */

import { describe, expect, it } from 'vitest'

import type { SkeletonGeometry } from '../../core/values'
import {
  GRID_SPREAD,
  cellKey,
  NODE_BRANCH,
  assignSynapses,
  NODE_LEAF,
  NODE_ROOT,
  NODE_SLAB,
  classifyNodes,
  maxRootDistance,
  morphometrics,
  morphometricsSchema,
  morphometricsTable,
  parentDistances,
  segmentStats,
  skeletonTree,
  strahlerOrders,
} from './topologyOps'

/**
 * A skeleton from a parent list, with **every edge exactly 1 µm**.
 *
 * Each node is placed one micrometre from its parent, along a different axis per child rank, so
 * a connected tree of `n` nodes has `n - 1` µm of cable whatever its shape. The first version of
 * this helper spaced nodes by array index instead, which made an edge's length depend on how far
 * apart parent and child happened to sit in the parent list — so every length assertion was
 * really asserting the fixture's own layout, and three of them disagreed with the arithmetic for
 * reasons that had nothing to do with the code under test.
 *
 * Positions are nanometres, as every source hands them over, which is what keeps the µm
 * conversion visible in the assertions rather than agreed with silently.
 */
const AXES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
]

function skeletonOf(
  parents: number[],
  options: { id?: string; radii?: number[]; positions?: number[] } = {},
): SkeletonGeometry {
  let positions = options.positions
  if (!positions) {
    const xyz = new Array<number>(parents.length * 3).fill(0)
    const rank = new Map<number, number>()
    let roots = 0
    parents.forEach((parent, i) => {
      if (parent < 0 || parent >= parents.length) {
        // Roots far enough apart that no two components touch.
        xyz[i * 3] = roots++ * 100_000
        return
      }
      const nth = rank.get(parent) ?? 0
      rank.set(parent, nth + 1)
      const axis = AXES[nth % AXES.length]!
      xyz[i * 3] = xyz[parent * 3]! + axis[0] * 1000
      xyz[i * 3 + 1] = xyz[parent * 3 + 1]! + axis[1] * 1000
      xyz[i * 3 + 2] = xyz[parent * 3 + 2]! + axis[2] * 1000
    })
    positions = xyz
  }
  return {
    id: options.id ?? 'n1',
    positions: new Float32Array(positions),
    radii: new Float32Array(options.radii ?? parents.map(() => 0)),
    parents: new Int32Array(parents),
  }
}

/** `fastcore.classify_nodes`' own docstring tree. */
const DOC_TREE = [-1, 0, 1, 2, 1, 4, 5, 5]

/**
 * A five-way branch, four of whose children carry the maximum order.
 *
 * fastcore says node 1 is order 3. An implementation that raises the order only when *every*
 * child ties returns 2 here and is right about every bifurcation, which is why this tree exists.
 */
const WIDE_BRANCH = [-1, 0, 1, 1, 2, 2, 3, 3, 1, 1, 8, 8, 9, 9, 1]

describe('skeletonTree', () => {
  it('collects children and roots', () => {
    const tree = skeletonTree(skeletonOf(DOC_TREE))
    expect(tree.roots).toEqual([0])
    expect(tree.children[1]).toEqual([2, 4])
    expect(tree.children[5]).toEqual([6, 7])
    expect(tree.children[3]).toEqual([])
  })

  it('reads an out-of-range parent as a root rather than following it', () => {
    // A node pointing past the end of the array is unattached. Followed, it reads `undefined`
    // coordinates and turns every sum downstream into NaN.
    const tree = skeletonTree(skeletonOf([-1, 0, 99]))
    expect(tree.roots).toEqual([0, 2])
  })

  it('handles a forest', () => {
    const tree = skeletonTree(skeletonOf([-1, 0, -1, 2]))
    expect(tree.roots).toEqual([0, 2])
  })
})

describe('classifyNodes', () => {
  it('agrees with fastcore on its own example', () => {
    // fastcore: array([0, 2, 3, 1, 3, 2, 1, 1])
    expect([...classifyNodes(skeletonOf(DOC_TREE))]).toEqual([
      NODE_ROOT,
      NODE_BRANCH,
      NODE_SLAB,
      NODE_LEAF,
      NODE_SLAB,
      NODE_BRANCH,
      NODE_LEAF,
      NODE_LEAF,
    ])
  })
})

describe('strahlerOrders', () => {
  it('agrees with fastcore on its own example', () => {
    // fastcore: array([2, 2, 1, 1, 2, 2, 1, 1])
    expect([...strahlerOrders(skeletonOf(DOC_TREE))]).toEqual([2, 2, 1, 1, 2, 2, 1, 1])
  })

  it('raises the order when two of several children tie at the maximum', () => {
    // fastcore: array([3, 3, 2, 2, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1])
    const orders = strahlerOrders(skeletonOf(WIDE_BRANCH))
    expect([...orders]).toEqual([3, 3, 2, 2, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1])
    // Named separately because this is the assertion the whole fixture exists for: node 1 has
    // five children, four at order 2 and one at order 1.
    expect(orders[1]).toBe(3)
  })

  it('does not recurse — a long unbranched neurite must not overflow the stack', () => {
    // 60,000 nodes is a CATMAID skeleton's order of magnitude, and well past any engine's
    // default stack. A recursive post-order throws here rather than returning a wrong answer.
    const parents = Array.from({ length: 60_000 }, (_, i) => i - 1)
    const orders = strahlerOrders(skeletonOf(parents))
    expect(orders[0]).toBe(1)
    expect(orders[59_999]).toBe(1)
  })
})

describe('parentDistances', () => {
  it('measures each node to its parent and leaves roots at zero', () => {
    const d = parentDistances(skeletonOf([-1, 0, 1]))
    expect([...d]).toEqual([0, 1000, 1000])
  })
})

describe('segmentStats', () => {
  it('breaks the arbour at branch points, counting the edge into each one', () => {
    /*
     * DOC_TREE is: 0-1, then 1 branches to 2-3 and to 4-5, and 5 branches to 6 and 7.
     * Runs: [1] from the root, [2,3], [4,5], [6], [7] — five, and every edge is in exactly one
     * of them. The total is what pins the "a branch point belongs to both runs" rule: 7 edges.
     */
    const runs = segmentStats(skeletonOf(DOC_TREE))
    expect(runs).toHaveLength(5)
    const total = runs.reduce((sum, r) => sum + r.length, 0)
    expect(total).toBeCloseTo(7000, 6)
  })

  it('reports an unmeasurable tortuosity as null rather than as 1', () => {
    // Two nodes at the same coordinate: the run has length and no span. Straightness is not 1
    // here, it is unknown, and a 1 would be a manufactured measurement among real ones.
    const doubled = skeletonOf([-1, 0], { positions: [0, 0, 0, 0, 0, 0] })
    expect(segmentStats(doubled)[0]?.tortuosity).toBeNull()
  })

  it('measures a bend as more tortuous than a straight run', () => {
    // A right-angle: two 1 µm hops spanning √2 µm.
    const bent = skeletonOf([-1, 0, 1], { positions: [0, 0, 0, 1000, 0, 0, 1000, 1000, 0] })
    expect(segmentStats(bent)[0]?.tortuosity).toBeCloseTo(2 / Math.SQRT2, 6)
  })
})

describe('maxRootDistance', () => {
  it('measures from the root rather than across it', () => {
    /*
     * Two 2-hop arms off one root. The longest *path* in the skeleton crosses the root and is
     * 4 µm; the longest reach from the soma is 2 µm, which is the number a morphometrics table
     * is asked for. `longest_path` would answer the other one.
     */
    const arms = skeletonOf([-1, 0, 1, 0, 3])
    expect(maxRootDistance(arms)).toBeCloseTo(2000, 6)
  })
})

describe('morphometrics', () => {
  it('measures the doc tree in micrometres', () => {
    const m = morphometrics(skeletonOf(DOC_TREE, { id: '12345' }))
    expect(m.neuronId).toBe('12345')
    expect(m.cableLength).toBeCloseTo(7, 6)
    expect(m.nodes).toBe(8)
    expect(m.branchPoints).toBe(2)
    expect(m.endPoints).toBe(3)
    expect(m.segments).toBe(5)
    expect(m.fragments).toBe(1)
    expect(m.maxStrahler).toBe(2)
  })

  it('counts a fragmented reconstruction rather than healing it', () => {
    // Two disconnected pieces. The cable is honestly the sum; `fragments` is what says the
    // number covers more than one connected thing.
    const m = morphometrics(skeletonOf([-1, 0, -1, 2]))
    expect(m.fragments).toBe(2)
    expect(m.cableLength).toBeCloseTo(2, 6)
  })

  it('reports a missing radius as null, never as zero', () => {
    // male-CNS declares no vertex attributes, so its radii are genuinely all zero. A mean of
    // 0 µm would be a measurement claiming the neuron has no thickness.
    expect(morphometrics(skeletonOf([-1, 0])).meanRadius).toBeNull()
    const withRadii = skeletonOf([-1, 0], { radii: [500, 1500] })
    expect(morphometrics(withRadii).meanRadius).toBeCloseTo(1, 6)
  })

  it('leaves a zero radius out of the mean rather than dragging it down', () => {
    // A CAVE L2 chunk too small to have a `max_dt_nm` is 0, beside real radii on the same
    // skeleton. Averaging those in reports a neuron thinner than any node actually measured.
    const mixed = skeletonOf([-1, 0, 1], { radii: [0, 1000, 3000] })
    expect(morphometrics(mixed).meanRadius).toBeCloseTo(2, 6)
  })

  it('splits cable across Strahler orders without losing any', () => {
    const m = morphometrics(skeletonOf(DOC_TREE))
    const summed = m.cableByStrahler.reduce((a, b) => a + b, 0)
    expect(summed).toBeCloseTo(m.cableLength, 6)
    // Index 0 is unused: no edge has order 0.
    expect(m.cableByStrahler[0]).toBe(0)
  })

  it('averages tortuosity over the runs that have one', () => {
    const straight = morphometrics(skeletonOf([-1, 0, 1]))
    expect(straight.meanTortuosity).toBeCloseTo(1, 6)
  })
})

describe('morphometricsTable', () => {
  it('emits exactly the columns its schema declares', () => {
    // Invariant 3, walked rather than restated: a column added to one half and not the other
    // fails here instead of emptying a downstream picker after a Run.
    const table = morphometricsTable([morphometrics(skeletonOf(DOC_TREE))])
    const declared = morphometricsSchema().columns.map((c) => c.name)
    expect(Object.keys(table.data).sort()).toEqual([...declared].sort())
    expect(table.length).toBe(1)
  })

  it('keeps a wide id as text', () => {
    // Invariant 8. `720575940379080000` parsed as a float64 is a different neuron.
    const id = '720575940379080123'
    const table = morphometricsTable([morphometrics(skeletonOf([-1, 0], { id }))])
    expect(table.data['neuronId']?.[0]).toBe(id)
  })

  it('carries a null tortuosity through as null', () => {
    const doubled = skeletonOf([-1, 0], { positions: [0, 0, 0, 0, 0, 0] })
    const table = morphometricsTable([morphometrics(doubled)])
    expect(table.data['meanTortuosity']?.[0]).toBeNull()
  })
})

describe('assignSynapses', () => {
  /** Three nodes in a line at 0, 1 and 2 µm along x. */
  const line = skeletonOf([-1, 0, 1])

  it('puts each synapse on the nearest node', () => {
    const { nodeOf } = assignSynapses(line, [
      { x: 100, y: 0, z: 0, polarity: 'pre' },
      { x: 1100, y: 0, z: 0, polarity: 'post' },
      { x: 2400, y: 0, z: 0, polarity: 'post' },
    ])
    expect([...nodeOf]).toEqual([0, 1, 2])
  })

  it('counts pre and post separately', () => {
    const { pre, post } = assignSynapses(line, [
      { x: 0, y: 0, z: 0, polarity: 'pre' },
      { x: 0, y: 0, z: 0, polarity: 'pre' },
      { x: 2000, y: 0, z: 0, polarity: 'post' },
    ])
    expect([...pre]).toEqual([2, 0, 0])
    expect([...post]).toEqual([0, 0, 1])
  })

  it('counts an unrecognised polarity as postsynaptic rather than dropping it', () => {
    // A synapse counted nowhere would move the flow centrality without appearing in any total
    // that could explain it. The three backends agree on `pre` and not on the other spelling.
    const { pre, post } = assignSynapses(line, [{ x: 0, y: 0, z: 0, polarity: 'POST' }])
    expect([...pre]).toEqual([0, 0, 0])
    expect([...post]).toEqual([1, 0, 0])
  })

  it('agrees with brute force on a scattered arbour', () => {
    /*
     * The grid's whole risk is the off-by-one at a shell boundary: a node in the corner of the
     * current ring can be further away than one just inside the next. That returns a plausible
     * wrong node rather than failing, so it is checked against the definition rather than
     * against a fixture.
     */
    const parents = [-1]
    for (let i = 1; i < 200; i++) parents.push(Math.floor((i - 1) / 2))
    const arbour = skeletonOf(parents)

    const sites = Array.from({ length: 150 }, (_, i) => ({
      // Deterministic scatter across the arbour's own extent, deliberately off-lattice.
      x: ((i * 7919) % 9000) - 500,
      y: ((i * 104_729) % 7000) - 500,
      z: ((i * 1301) % 5000) - 500,
      polarity: i % 2 === 0 ? 'pre' : 'post',
    }))

    const { nodeOf } = assignSynapses(arbour, sites)
    sites.forEach((site, s) => {
      let best = -1
      let bestDist = Infinity
      for (let i = 0; i < parents.length; i++) {
        const d =
          (arbour.positions[i * 3]! - site.x) ** 2 +
          (arbour.positions[i * 3 + 1]! - site.y) ** 2 +
          (arbour.positions[i * 3 + 2]! - site.z) ** 2
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      expect(nodeOf[s]).toBe(best)
    })
  })

  it('answers -1 for every synapse when the skeleton is empty', () => {
    const empty = skeletonOf([])
    expect([...assignSynapses(empty, [{ x: 0, y: 0, z: 0, polarity: 'pre' }]).nodeOf]).toEqual([
      -1,
    ])
  })
})

describe('the synapse grid key', () => {
  /*
   * This replaced a `` `${x},${y},${z}` `` template — numeric, because the string version
   * allocated one per skeleton node and up to 27 per synapse. The packing is what has to be
   * checked, and it went in wrong the first time: a `SPREAD` of a million looks generous and puts
   * the largest key at 8e18, three orders of magnitude past float64's exact-integer range, where
   * distinct cells silently alias onto one bucket.
   */
  it('keeps every key an exactly representable integer', () => {
    const span = 2 * GRID_SPREAD
    expect(span ** 3).toBeLessThan(Number.MAX_SAFE_INTEGER)
    // The extreme corner, which is the one that overflows first.
    const top = cellKey(GRID_SPREAD - 1, GRID_SPREAD - 1, GRID_SPREAD - 1)
    expect(Number.isSafeInteger(top)).toBe(true)
  })

  it('gives distinct cells distinct keys, including across axes', () => {
    // The failure a wrong multiplier gives: (1,0,0) and (0,1,0) colliding, which merges two
    // buckets and makes `nearest` answer from the wrong part of the arbour.
    const keys = [
      cellKey(0, 0, 0),
      cellKey(1, 0, 0),
      cellKey(0, 1, 0),
      cellKey(0, 0, 1),
      cellKey(-1, 0, 0),
      cellKey(0, -1, 0),
      cellKey(0, 0, -1),
      cellKey(1, 1, 1),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})
