import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { boundsOf, makeTable } from '../../core/values'
import { sitesFrom } from './topologyOps'
import { ySkeleton } from './__fixtures__/ySkeleton'
import type { Arbor, Placement } from './arborOps'
import {
  DEFAULT_CABLE,
  buildArbor,
  distalPoints,
  distalSynapses,
  distanceAt,
  electrotonicDistances,
  focusOn,
  healedBridges,
  inSubtree,
  keyTree,
  landmarkDistances,
  lengthConstantNm,
  orientPlacement,
  parseFocus,
  projectSynapses,
  pruneTwigs,
  resolveRoot,
  rootChoiceOf,
  stampedRadius,
  summariseDistal,
  synapseFlow,
  writeFocus,
} from './arborOps'

/** The Y's reduced tree, rooted at 0, with each landmark's geodesic distance. */
function yReduced() {
  const arbor = buildArbor(ySkeleton(), 0)
  const tree = keyTree(arbor)
  return { tree, d: landmarkDistances(tree, arbor.geodesic) }
}

/** A synapse in the Y's plane. */
function site(x: number, yy: number, polarity = 'post') {
  return { x, y: yy, z: 0, polarity }
}

/** How far a placed synapse sits from the arbour's root. */
function rootDistance(arbor: Arbor, placement: Placement, s: number): number {
  return distanceAt(arbor, arbor.geodesic, { node: placement.node[s]!, t: placement.t[s]! })
}

describe('buildArbor', () => {
  it('measures geodesic distance from the delivered root', () => {
    const arbor = buildArbor(ySkeleton(), 0)
    expect(Array.from(arbor.geodesic)).toEqual([0, 1000, 2000, 3000, 3000, 4000])
    expect(arbor.unreached).toBe(0)
    expect(arbor.order[0]).toBe(0)
  })

  it('re-roots, reversing the edges between the old root and the new one', () => {
    const arbor = buildArbor(ySkeleton(), 3)
    expect(Array.from(arbor.geodesic)).toEqual([3000, 2000, 1000, 0, 2000, 3000])
    expect(Array.from(arbor.parent)).toEqual([1, 2, 3, -1, 2, 4])
  })

  it('answers subtree membership as an interval', () => {
    const arbor = buildArbor(ySkeleton(), 0)
    expect(inSubtree(arbor, 2, 5)).toBe(true)
    expect(inSubtree(arbor, 2, 2)).toBe(true)
    expect(inSubtree(arbor, 4, 3)).toBe(false)
    expect(inSubtree(arbor, 3, 2)).toBe(false)
  })

  it('counts the fragments it cannot reach rather than attaching them', () => {
    const arbor = buildArbor(ySkeleton(undefined, [-1, 0, 1, 2, -1, 4]), 0)
    expect(arbor.unreached).toBe(2)
    expect(arbor.tin[4]).toBe(-1)
    expect(Number.isNaN(arbor.geodesic[5]!)).toBe(true)
  })
})

describe('resolveRoot', () => {
  it('takes the largest fragment’s root for a forest', () => {
    // Fragments {4, 5} rooted at 4 and {0..3} rooted at 0.
    expect(resolveRoot(ySkeleton(undefined, [-1, 0, 1, 2, -1, 4]), 'source')).toEqual({
      node: 0,
      fellBack: false,
    })
    expect(resolveRoot(ySkeleton(undefined, [1, -1, 1, 2, -1, 4]), 'source').node).toBe(1)
  })

  it('takes the widest soma-labelled node, and falls back where no soma is labelled', () => {
    const skeleton = {
      ...ySkeleton([500, 900, 1200, 500, 500, 500]),
      compartments: Uint8Array.from([3, 1, 1, 3, 3, 3]),
    }
    expect(resolveRoot(skeleton, 'soma')).toEqual({ node: 2, fellBack: false })
    // No soma labelled: the delivered root stands in, and says so.
    expect(resolveRoot(ySkeleton(), 'soma')).toEqual({ node: 0, fellBack: true })
  })

  it('takes a picked node, and ignores one that no longer exists', () => {
    expect(resolveRoot(ySkeleton(), 4)).toEqual({ node: 4, fellBack: false })
    expect(resolveRoot(ySkeleton(), 40)).toEqual({ node: 0, fellBack: true })
  })
})

describe('rootChoiceOf', () => {
  it('reads the Root params one way for the card and the Run', () => {
    expect(rootChoiceOf('picked', 7)).toBe(7)
    expect(rootChoiceOf('source', 7)).toBe('source')
    expect(rootChoiceOf('soma', 7)).toBe('soma')
  })
})

describe('healedBridges', () => {
  // {4, 5} arrived rooted at 5; healing joined 4 onto 2 and so turned 5 → 4 round.
  const original = Int32Array.from([-1, 0, 1, 2, 5, -1])
  const healed = Int32Array.from([-1, 0, 1, 2, 2, 4])

  it('flags only the edge a heal added, not traced edges it reversed', () => {
    expect(Array.from(healedBridges(original, healed))).toEqual([0, 0, 0, 0, 1, 0])
  })

  it('keeps a bridge flagged when re-rooting turns it round', () => {
    const arbor = buildArbor(
      ySkeleton(undefined, Array.from(healed)),
      5,
      healedBridges(original, healed),
    )
    // Rooted at 5 the bridge is the edge 2 → 4, recorded against 2.
    expect(arbor.parent[2]).toBe(4)
    expect(Array.from(arbor.bridge!)).toEqual([0, 0, 1, 0, 0, 0])
  })
})

describe('electrotonicDistances', () => {
  it('divides each edge by the length constant of its mean radius', () => {
    const skeleton = ySkeleton([500, 500, 500, 125, 500, 500])
    const arbor = buildArbor(skeleton, 0)
    const result = electrotonicDistances(skeleton, arbor, { units: 'nm' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // λ = √(Rm · r / 2Ri), worked in centimetres straight from the constants.
    const lambda = (rNm: number) => Math.sqrt((20_800 * rNm * 1e-7) / (2 * 266)) * 1e7
    expect(lengthConstantNm(500, DEFAULT_CABLE)).toBeCloseTo(lambda(500), 6)
    expect(result.distance[5]).toBeCloseTo(4000 / lambda(500), 12)
    expect(result.distance[3]).toBeCloseTo(2000 / lambda(500) + 1000 / lambda(312.5), 12)
  })

  it('refuses rather than patching a node with no radius, and says how many', () => {
    const skeleton = ySkeleton([500, 0, 500, 500, 500, 500])
    const result = electrotonicDistances(skeleton, buildArbor(skeleton, 0), { units: 'nm' })
    expect(result).toEqual({
      ok: false,
      reason: 'Electrotonic distance needs a radius on every node, and 1 of 6 nodes have none.',
    })
    const none = ySkeleton([0, 0, 0, 0, 0, 0])
    expect(electrotonicDistances(none, buildArbor(none, 0), { units: 'nm' })).toEqual({
      ok: false,
      reason: 'Electrotonic distance needs radii, and this skeleton has none.',
    })
  })

  it('refuses coordinates that say they are not nanometres, and lets unknown units through', () => {
    // `checkGeometryUnits`' rule, shared with NBLAST and Distance: absent means unknown, not wrong.
    const arbor = buildArbor(ySkeleton(), 0)
    const voxels = electrotonicDistances(ySkeleton(), arbor, { units: 'voxels' })
    expect(voxels.ok).toBe(false)
    if (!voxels.ok) expect(voxels.reason).toMatch(/^This neuron’s coordinates are in voxels/)
    expect(electrotonicDistances(ySkeleton(), arbor, {}).ok).toBe(true)
  })
})

describe('stampedRadius', () => {
  it('names the radius most of an arbour shares, and nothing for measured radii', () => {
    const stamped = ySkeleton([256, 256, 256, 256, 768, 90])
    expect(stampedRadius(stamped, buildArbor(stamped, 0))).toEqual({
      radius: 256,
      share: 4 / 6,
    })
    const measured = ySkeleton([100, 120, 140, 160, 180, 200])
    expect(stampedRadius(measured, buildArbor(measured, 0))).toBeUndefined()
    // CATMAID leaves most radii at 0, which is the refusal's business, not this note's.
    const unsized = ySkeleton([0, 0, 0, 0, 120, 140])
    expect(stampedRadius(unsized, buildArbor(unsized, 0))).toBeUndefined()
  })
})

describe('keyTree', () => {
  it('keeps the root, branch points and leaves, and files every node under its segment', () => {
    const tree = keyTree(buildArbor(ySkeleton(), 0))
    expect(Array.from(tree.nodes).sort()).toEqual([0, 2, 3, 5])
    const index = (v: number) => Array.from(tree.nodes).indexOf(v)
    expect(tree.parent[index(2)]).toBe(index(0))
    expect(tree.parent[index(3)]).toBe(index(2))
    expect(tree.parent[index(5)]).toBe(index(2))
    expect(tree.segmentOf[0]).toBe(-1)
    expect(tree.segmentOf[1]).toBe(index(2))
    expect(tree.segmentOf[4]).toBe(index(5))
  })

  it('keeps a root with one child as a landmark', () => {
    const tree = keyTree(buildArbor(ySkeleton(), 3))
    expect(tree.nodes[0]).toBe(3)
    // 3 → 2 is a segment of its own; 2 is the branch point.
    expect(tree.segmentOf[2]).toBe(Array.from(tree.nodes).indexOf(2))
  })
})

describe('projectSynapses and orientPlacement', () => {
  it('places a synapse along the nearest edge, not on the nearest node', () => {
    const skeleton = ySkeleton()
    const arbor = buildArbor(skeleton, 0)
    const placement = orientPlacement(arbor, projectSynapses(skeleton, [site(2400, 100)]))
    expect(placement.node[0]).toBe(3)
    expect(placement.t[0]).toBeCloseTo(0.4, 6)
    expect(rootDistance(arbor, placement, 0)).toBeCloseTo(2400, 3)
  })

  it('keeps a synapse on the same point when re-rooting reverses its edge', () => {
    const skeleton = ySkeleton()
    const projection = projectSynapses(skeleton, [site(2400, 100), site(500, 50)])
    // Rooted at 3, the edge 2 → 3 runs the other way: the synapse 40% along it from 2 is 60% along
    // it from 3, and 600 nm from the new root.
    const arbor = buildArbor(skeleton, 3)
    const placement = orientPlacement(arbor, projection)
    expect(placement.node[0]).toBe(2)
    expect(placement.t[0]).toBeCloseTo(0.6, 6)
    expect(rootDistance(arbor, placement, 0)).toBeCloseTo(600, 3)
    expect(rootDistance(arbor, placement, 1)).toBeCloseTo(2500, 3)
  })

  it('counts a synapse on an unreached fragment as unplaced', () => {
    const skeleton = ySkeleton(undefined, [-1, 0, 1, 2, -1, 4])
    const placement = orientPlacement(
      buildArbor(skeleton, 0),
      projectSynapses(skeleton, [site(2000, 1900)]),
    )
    expect(placement.node[0]).toBe(-1)
    expect(placement.unplaced).toBe(1)
  })
})

describe('distalSynapses', () => {
  const skeleton = ySkeleton()
  const arbor = buildArbor(skeleton, 0)
  const sites = [
    site(2400, 100), // node 3, t 0.4: 2400 from the root
    site(2050, 1500, 'pre'), // node 5, t 0.5: 3500
    site(500, 50), // node 1, t 0.5: 500
  ]
  const placement = orientPlacement(arbor, projectSynapses(skeleton, sites))

  it('keeps what lies below the point, measured from the point', () => {
    const distal = distalSynapses(arbor, placement, arbor.geodesic, { node: 2, t: 1 })
    expect(Array.from(distal.indices)).toEqual([0, 1])
    expect(distal.distances[0]).toBeCloseTo(400, 3)
    expect(distal.distances[1]).toBeCloseTo(1500, 3)
  })

  it('splits an edge: a synapse further down the same edge is distal, one above it is not', () => {
    expect(
      Array.from(distalSynapses(arbor, placement, arbor.geodesic, { node: 3, t: 0.2 }).indices),
    ).toEqual([0])
    expect(
      Array.from(distalSynapses(arbor, placement, arbor.geodesic, { node: 3, t: 0.5 }).indices),
    ).toEqual([])
  })

  it('rolls up by label and side, most synapses first', () => {
    const distal = distalSynapses(arbor, placement, arbor.geodesic, { node: 0, t: 1 })
    const labels = ['Tm3', 'Mi1', 'Tm3']
    const rows = summariseDistal(
      distal,
      (s) => labels[s]!,
      (s) => sites[s]!.polarity,
    )
    // Distances are interpolated from a float32 fraction, so they are close rather than exact.
    const rounded = rows.map((row) => ({
      ...row,
      min: Math.round(row.min),
      median: Math.round(row.median),
      max: Math.round(row.max),
    }))
    expect(rounded).toEqual([
      { label: 'Tm3', polarity: 'post', count: 2, min: 500, median: 1450, max: 2400 },
      { label: 'Mi1', polarity: 'pre', count: 1, min: 3500, median: 3500, max: 3500 },
    ])
  })
})

describe('pruneTwigs', () => {
  it('hides short leaf segments and merges the branch point left with one child', () => {
    const { tree, d } = yReduced()
    const pruned = pruneTwigs(tree, d, 1500)
    expect(pruned.hidden).toBe(1)
    expect(Array.from(pruned.tree.nodes)).toEqual([0, 5])
    expect(Array.from(pruned.tree.parent)).toEqual([-1, 0])
    // Landmark 2's segment now runs on to 5; the twig to 3 is hidden.
    expect(pruned.drawnAs[tree.nodes.indexOf(2)]).toBe(1)
    expect(pruned.drawnAs[tree.nodes.indexOf(3)]).toBe(-1)
    expect(pruned.tree.segmentOf[1]).toBe(1)
    expect(pruned.tree.segmentOf[3]).toBe(-1)
  })

  it('hands back the same tree when nothing is short enough', () => {
    const { tree, d } = yReduced()
    expect(pruneTwigs(tree, d, 500).tree).toBe(tree)
  })
})

describe('synapseFlow', () => {
  /*
   * An input at 1, between the root and the branch point, and an output on each branch (3 and 5).
   * Each branch carries one path, input to output, so it scores 1; node 1 has its input on its
   * own node, so nothing crosses its edge in either direction; and the branch point takes its
   * largest child's flow — navis's correction — though two paths leave through it.
   * Cross-checked: these match navis-fastcore plus that correction exactly, which a
   * scratch comparison over a 3,000-node tree with 4,000 synapses also confirmed in all three modes.
   */
  it('counts input-to-output paths through each edge, and applies navis’s branch-point rule', () => {
    const arbor = buildArbor(ySkeleton(), 0)
    const placement = {
      node: Int32Array.from([1, 3, 5]),
      t: Float32Array.from([1, 1, 1]),
      unplaced: 0,
    }
    const sides = ['post', 'pre', 'pre']
    expect(Array.from(synapseFlow(arbor, placement, (s) => sides[s]!))).toEqual([
      0, 0, 1, 1, 1, 1,
    ])
    expect(Array.from(synapseFlow(arbor, placement, (s) => sides[s]!, 'centripetal'))).toEqual([
      0, 0, 0, 0, 0, 0,
    ])
  })
})

describe('the focus param', () => {
  it('round-trips a point with its neuron, and reads it only on that neuron', () => {
    const arbor = buildArbor(ySkeleton(), 0)
    const text = writeFocus({ neuronId: '1001', point: { node: 4, t: 0.25 } })
    expect(text).toBe('1001:4:0.2500')
    expect(parseFocus(text)).toEqual({ neuronId: '1001', point: { node: 4, t: 0.25 } })
    expect(focusOn(text, '1001', arbor)).toEqual({ node: 4, t: 0.25 })
    // Another neuron's point, a node past the tree, and the old `node:t` form all read as none.
    expect(focusOn(text, '1002', arbor)).toBeUndefined()
    expect(focusOn('1001:99:0.5', '1001', arbor)).toBeUndefined()
    expect(parseFocus('4:0.25')).toBeUndefined()
    expect(writeFocus(undefined)).toBe('')
  })
})

describe('distalPoints', () => {
  it('keeps the synapses beyond the point, with their distances in micrometres', () => {
    const skeleton = ySkeleton()
    const arbor = buildArbor(skeleton, 0)
    const positions = Float32Array.from([2400, 100, 0, 2050, 1500, 0, 500, 50, 0])
    const cloud = {
      kind: 'points' as const,
      positions,
      attributes: makeTable(tableSchema(column('polarity', 'str')), {
        polarity: ['post', 'pre', 'post'],
      }),
      bounds: boundsOf([positions]),
      units: 'nm' as const,
    }
    const placement = orientPlacement(arbor, projectSynapses(skeleton, sitesFrom(cloud)))
    const distal = distalSynapses(arbor, placement, arbor.geodesic, { node: 2, t: 1 })
    const points = distalPoints(cloud, arbor, placement, distal)
    // The two on the branches beyond 2; the one at 500 nm from the root is proximal.
    expect(points.attributes.length).toBe(2)
    expect(points.attributes.data['polarity']).toEqual(['post', 'pre'])
    const from = points.attributes.data['distanceFromPoint'] as number[]
    const root = points.attributes.data['distanceFromRoot'] as number[]
    expect(from[0]).toBeCloseTo(0.4, 4)
    expect(root[1]).toBeCloseTo(3.5, 4)
  })
})
