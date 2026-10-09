import { describe, expect, it } from 'vitest'

import type { SkeletonGeometry } from '../../core/values'
import type { KeyTree } from './arborOps'
import { buildArbor, keyTree, landmarkDistances } from './arborOps'
import { arbour } from './__fixtures__/arbour'
import { ySkeleton } from './__fixtures__/ySkeleton'
import type { ArborShape } from './arborLayout'
import {
  arborLayout,
  equalAngleLayout,
  pointOnPiece,
  radialLayout,
  rectangularLayout,
  subwayLayout,
} from './arborLayout'

/** A skeleton's reduced tree, rooted at node 0, with each landmark's geodesic distance. */
function reduced(skeleton: SkeletonGeometry): { tree: KeyTree; d: Float64Array } {
  const arbor = buildArbor(skeleton, 0)
  const tree = keyTree(arbor)
  return { tree, d: landmarkDistances(tree, arbor.geodesic) }
}

/** The shared Y's reduced tree: landmarks 0, 2, 3 and 5. */
const yTree = () => reduced(ySkeleton())

/** A random branching skeleton's reduced tree: a thin tree in a big box, which is what a neuron is. */
function randomTree(nodes: number, seed = 3): { tree: KeyTree; d: Float64Array } {
  return reduced(arbour(nodes, seed, { jump: 0.08, step: 800, radius: 100 }))
}

const at = (tree: KeyTree, node: number): number => tree.nodes.indexOf(node)

const pieceLength = (shape: ArborShape, k: number): number =>
  Math.hypot(shape.x1[k]! - shape.x0[k]!, shape.y1[k]! - shape.y0[k]!)

/** Every segment drawn at exactly its length along the tree. */
function expectExactLengths(shape: ArborShape, tree: KeyTree, d: Float64Array): void {
  for (let k = 1; k < d.length; k++) {
    expect(pieceLength(shape, k)).toBeCloseTo(d[k]! - d[tree.parent[k]!]!, 6)
  }
}

describe('rectangularLayout', () => {
  const { tree, d } = yTree()
  const shape = rectangularLayout(tree, d)

  it('puts distance on x and a branch point midway between its outermost children', () => {
    expect(Array.from(shape.x1)).toEqual(Array.from(d))
    expect(shape.y1[at(tree, 5)]).toBe(0.5)
    expect(shape.y1[at(tree, 3)]).toBe(1.5)
    // A branch point sits midway between its outermost children, and so does a one-child root.
    expect(shape.y1[at(tree, 2)]).toBe(1)
    expect(shape.y1[at(tree, 0)]).toBe(1)
    expect(shape.isotropic).toBe(false)
  })

  it('starts each piece at its parent’s distance and bars each branch point', () => {
    expect(shape.x0[at(tree, 3)]).toBe(2000)
    expect(shape.connectors).toEqual([
      { kind: 'line', at: at(tree, 2), x: 2000, y0: 0.5, y1: 1.5 },
    ])
  })
})

describe('child order', () => {
  /*
   * A trunk 0 → 1 → 2 → 3 → 4, 2 µm a step, with a 300 nm twig off each of 1, 2 and 3: the shape
   * that drew corner to corner as a staircase when the heaviest child always went first.
   */
  function trunkWithTwigs(): { tree: KeyTree; d: Float64Array; trunkTip: number } {
    const xyz = [0, 0, 0, 2000, 0, 0, 4000, 0, 0, 6000, 0, 0, 8000, 0, 0]
    const parents = [-1, 0, 1, 2, 3]
    for (const step of [1, 2, 3]) {
      xyz.push(step * 2000, 300, 0)
      parents.push(step)
    }
    const { tree, d } = reduced({
      id: 't',
      positions: Float32Array.from(xyz),
      radii: new Float32Array(parents.length).fill(100),
      parents: Int32Array.from(parents),
    })
    return { tree, d, trunkTip: at(tree, 4) }
  }

  it('ladder sends the trunk to the first slot at every branch point', () => {
    const { tree, d, trunkTip } = trunkWithTwigs()
    expect(rectangularLayout(tree, d, 'ladder').y1[trunkTip]).toBe(0.5)
  })

  it('balanced keeps the trunk off the edges of the leaf axis', () => {
    const { tree, d, trunkTip } = trunkWithTwigs()
    const y = rectangularLayout(tree, d, 'balanced').y1[trunkTip]!
    expect(y).toBeGreaterThan(0.5)
    expect(y).toBeLessThan(3.5)
  })
})

describe('radialLayout', () => {
  it('puts every landmark at its distance from the origin', () => {
    const { tree, d } = randomTree(400)
    const shape = radialLayout(tree, d)
    for (let k = 0; k < d.length; k++) {
      expect(Math.hypot(shape.x1[k]!, shape.y1[k]!)).toBeCloseTo(d[k]!, 6)
    }
    expect(shape.isotropic).toBe(true)
  })

  it('grows the bounds to cover an arc’s bulge, not just its ends', () => {
    const { tree, d } = yTree()
    const shape = radialLayout(tree, d)
    // Two leaves, at π/2 and 3π/2, so both ends lie on the y axis — but the branch point's arc
    // between them passes through π at radius 2000, which only the bulge accounts for.
    expect(shape.bounds.minX).toBeCloseTo(-2000, 6)
  })
})

describe('subwayLayout', () => {
  const { tree, d } = yTree()
  const shape = subwayLayout(tree, d)

  it('runs the longest path along x', () => {
    expect(shape.x1[at(tree, 5)]).toBeCloseTo(4000, 9)
    expect(shape.y1[at(tree, 5)]).toBeCloseTo(0, 9)
  })

  it('leaves at 45°, flipped past an odd number of branch points', () => {
    const k = at(tree, 3)
    expect(shape.x1[k]).toBeCloseTo(2000 + 1000 * Math.SQRT1_2, 9)
    expect(shape.y1[k]).toBeCloseTo(-1000 * Math.SQRT1_2, 9)
  })

  it('draws every segment at its full length — navis shortens each branch by its first edge', () => {
    const big = randomTree(600)
    expectExactLengths(subwayLayout(big.tree, big.d), big.tree, big.d)
  })
})

/** Whether two pieces that share no landmark cross, by the orientation test. */
function crosses(shape: ArborShape, tree: KeyTree, a: number, b: number): boolean {
  const pa = tree.parent[a]!
  const pb = tree.parent[b]!
  if (pa === pb || pa === b || pb === a) return false
  const turn = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (cy - ay) * (bx - ax) - (by - ay) * (cx - ax)
  const [x, y] = [shape.x1, shape.y1]
  const d1 = turn(x[pa]!, y[pa]!, x[a]!, y[a]!, x[pb]!, y[pb]!)
  const d2 = turn(x[pa]!, y[pa]!, x[a]!, y[a]!, x[b]!, y[b]!)
  const d3 = turn(x[pb]!, y[pb]!, x[b]!, y[b]!, x[pa]!, y[pa]!)
  const d4 = turn(x[pb]!, y[pb]!, x[b]!, y[b]!, x[a]!, y[a]!)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/**
 * How unequal the daylight is, summed over branch points: at each, the spread between its
 * largest and smallest gap between neighbouring subtrees, as seen from it. Written from the
 * definition, by brute force, rather than by reusing the layout's own bookkeeping.
 */
function unevenness(shape: ArborShape, tree: KeyTree): number {
  const n = tree.nodes.length
  const all = Array.from({ length: n }, (_, k) => k)
  const [x, y] = [shape.x1, shape.y1]
  const below = (v: number, j: number): boolean => {
    for (let u = j; u >= 0; u = tree.parent[u]!) if (u === v) return true
    return false
  }
  let total = 0
  for (let v = 0; v < n; v++) {
    const groups: number[][] = []
    const kids = all.filter((k) => tree.parent[k] === v)
    for (const c of kids) groups.push(all.filter((j) => below(c, j)))
    if (v > 0) groups.push(all.filter((j) => !below(v, j)))
    if (groups.length < 2) continue
    // Each group's angular interval, about its own mean direction.
    const spans = groups.map((g) => {
      const angles = g.map((j) => Math.atan2(y[j]! - y[v]!, x[j]! - x[v]!))
      const mean = Math.atan2(
        angles.reduce((a, t) => a + Math.sin(t), 0),
        angles.reduce((a, t) => a + Math.cos(t), 0),
      )
      const offs = angles.map((t) => Math.atan2(Math.sin(t - mean), Math.cos(t - mean)))
      return [mean + Math.min(...offs), mean + Math.max(...offs)] as const
    })
    spans.sort((a, b) => a[0] - b[0])
    const gaps = spans.map((s, i) => {
      const next = spans[(i + 1) % spans.length]!
      let gap = next[0] - s[1]
      gap -= 2 * Math.PI * Math.floor(gap / (2 * Math.PI))
      return gap
    })
    total += Math.max(...gaps) - Math.min(...gaps)
  }
  return total
}

describe('equalAngleLayout', () => {
  it('draws every segment at its exact length, before and after daylight', () => {
    const { tree, d } = randomTree(800)
    for (const passes of [0, 5]) expectExactLengths(equalAngleLayout(tree, d, passes), tree, d)
  })

  it('crosses no branches', () => {
    const { tree, d } = randomTree(500)
    const shape = equalAngleLayout(tree, d)
    let crossings = 0
    for (let a = 1; a < d.length; a++) {
      for (let b = a + 1; b < d.length; b++) if (crosses(shape, tree, a, b)) crossings++
    }
    expect(crossings).toBe(0)
  })

  it('evens out the daylight between the subtrees at each branch point', () => {
    const { tree, d } = randomTree(300, 7)
    const before = unevenness(equalAngleLayout(tree, d, 0), tree)
    const after = unevenness(equalAngleLayout(tree, d), tree)
    expect(after).toBeLessThan(before * 0.8)
  })

  it('keeps the root at the origin', () => {
    const { tree, d } = randomTree(300)
    const shape = equalAngleLayout(tree, d)
    expect(shape.x1[0]).toBe(0)
    expect(shape.y1[0]).toBe(0)
  })
})

describe('arborLayout', () => {
  it('answers each layout by its own name', () => {
    const { tree, d } = yTree()
    for (const kind of ['rectangular', 'radial', 'subway', 'equalAngle'] as const) {
      expect(arborLayout(kind, tree, d).kind).toBe(kind)
    }
  })
})

describe('pointOnPiece', () => {
  it('places a distance along its segment’s piece', () => {
    const { tree, d } = yTree()
    const shape = rectangularLayout(tree, d)
    // 500 nm past the branch point, on the segment ending at leaf 3.
    expect(pointOnPiece(shape, d, tree, at(tree, 3), 2500)).toEqual([2500, 1.5])
  })
})
