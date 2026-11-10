/**
 * What a tip is, which is five decisions and not one of them obvious.
 *
 * Each test below pins a decision SEAM's `p_tip` fit depends on, and three of the four are places
 * where the plausible implementation is a different answer: counting children instead of edges,
 * leaving the tip on the skeleton instead of snapping it to the surface, and snapping without a
 * bound. None of them throws, and none of them is visible in a tip count.
 */

import { describe, expect, it } from 'vitest'

import { SEAM_TIP_RULE, degreeOneNodes, kinkNodes, thinKinks, tipsOf } from './tips'

/** A Y: 0 → 1 → {2, 3}. Nodes 0, 2 and 3 are the ends; 1 is the branch point. */
const Y_PARENTS = Int32Array.from([-1, 0, 1, 1])
const Y_POSITIONS = Float32Array.from([0, 0, 0, 1000, 0, 0, 2000, 1000, 0, 2000, -1000, 0])

describe('degreeOneNodes', () => {
  /**
   * The decision `classifyNodes` would get wrong, and silently: a root with one child is an end
   * of the cable, and asking about children alone calls it a root and not a leaf.
   */
  it('counts the parent edge too, so a root with one child is an end', () => {
    expect([...degreeOneNodes(Y_PARENTS)]).toEqual([0, 2, 3])
  })

  /** The other half of the same rule, called out in SEAM's own comment. */
  it('an isolated node has degree zero and is not an end', () => {
    expect([...degreeOneNodes(Int32Array.from([-1]))]).toEqual([])
    // Node 1 is alone and is not an end; 0 and 2 are the two ends of the one edge there is.
    expect([...degreeOneNodes(Int32Array.from([-1, -1, 0]))]).toEqual([0, 2])
  })

  it('a bare two-node fragment is two ends', () => {
    expect([...degreeOneNodes(Int32Array.from([-1, 0]))]).toEqual([0, 1])
  })

  /** A parent index pointing outside the array is ignored rather than crashing a neuron. */
  it('ignores a parent that is out of range', () => {
    // 0 and 1 are the ends of the edge between them; 2 claims a parent that is not there, so it
    // has no edges at all.
    expect([...degreeOneNodes(Int32Array.from([-1, 0, 99]))]).toEqual([0, 1])
  })
})

describe('tipsOf', () => {
  it('returns every end when there is no mesh and no soma', () => {
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, undefined)
    expect(tips.fromNode).toEqual(Int32Array.from([0, 2, 3]))
    expect(tips.kinds).toEqual(['tip', 'tip', 'tip'])
    expect([...tips.positions.slice(0, 3)]).toEqual([0, 0, 0])
  })

  /**
   * The decision with no symptom. A skeleton runs down the middle of the neurite and Model E
   * scores the surface, so an unsnapped tip asks about a point half a radius away from anything
   * the model has an opinion about — and the answer it gets back is a perfectly ordinary number.
   */
  it('snaps each tip onto the nearest mesh vertex', () => {
    const mesh = { positions: Float32Array.from([0, 300, 0, 2000, 1300, 0, 2000, -1300, 0]) }
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, mesh)
    expect([...tips.positions]).toEqual([0, 300, 0, 2000, 1300, 0, 2000, -1300, 0])
    expect(tips.unsnapped).toBe(0)
  })

  /**
   * And the bound on that snap. An unbounded search always answers, so a node left behind by a
   * mesh that has since been cut would snap to a vertex somewhere else entirely.
   */
  it('drops a tip with no mesh vertex within reach, and counts it', () => {
    const mesh = { positions: Float32Array.from([1e6, 1e6, 1e6]) }
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, mesh)
    expect(tips.fromNode.length).toBe(0)
    expect(tips.unsnapped).toBe(3)
  })

  it('honours a tighter snap bound', () => {
    // Node 0 has a vertex 300 nm away and node 3 sits on one; node 2's nearest is 2 µm off.
    const mesh = { positions: Float32Array.from([0, 300, 0, 2000, 9000, 0, 2000, -1000, 0]) }
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, mesh, {
      snapWithinNm: 500,
    })
    expect([...tips.fromNode]).toEqual([0, 3])
    expect(tips.unsnapped).toBe(1)
  })

  /** A cell body is a hairball of ends and not one of them is a missing neurite. */
  it('drops tips within SOMA_UM of the soma, and counts them', () => {
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, undefined, {
      somaNm: [0, 0, 0],
    })
    // Node 0 sits on the soma; the two branch ends are ~2.2 µm away, well inside 10 µm.
    expect(tips.fromNode.length).toBe(0)
    expect(tips.nearSoma).toBe(3)
  })

  it('keeps tips outside the soma radius', () => {
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, undefined, {
      somaNm: [0, 0, 0],
      rule: { ...SEAM_TIP_RULE, somaUm: 1 },
    })
    expect([...tips.fromNode]).toEqual([2, 3])
    expect(tips.nearSoma).toBe(1)
  })

  /** The mask is measured where the end *is*, which after snapping is not where the node was. */
  it('measures the soma mask after snapping, not before', () => {
    const mesh = { positions: Float32Array.from([0, 1500, 0, 2000, 1000, 0, 2000, -1000, 0]) }
    const tips = tipsOf({ positions: Y_POSITIONS, parents: Y_PARENTS }, mesh, {
      somaNm: [0, 2000, 0],
      rule: { ...SEAM_TIP_RULE, somaUm: 1 },
    })
    // Node 0 sits 2 µm from the soma — outside the 1 µm mask — but its nearest vertex is 0.5 µm
    // from it, so the end is on the soma and goes. Unsnapped, this tip would have been kept.
    expect([...tips.fromNode]).toEqual([2, 3])
    expect(tips.nearSoma).toBe(1)
  })

  it('an empty skeleton has no tips', () => {
    const tips = tipsOf(
      { positions: new Float32Array(0), parents: new Int32Array(0) },
      undefined,
    )
    expect(tips.positions.length).toBe(0)
    expect(tips.kinds).toEqual([])
  })
})

/**
 * A right-angled chain at 500 nm spacing: eight nodes along x, then eight along y. The corner is
 * node 8, and it is the only kink in it — which is the point. Its neighbours turn by 45°, the
 * nodes near either end run out of path before a micrometre, and the two ends are degree-one
 * nodes rather than kinks at all.
 */
const CORNER_PARENTS = Int32Array.from(Array.from({ length: 17 }, (_, i) => i - 1))
const CORNER_POSITIONS = Float32Array.from(
  Array.from({ length: 17 }, (_, i) =>
    i <= 8 ? [i * 500, 0, 0] : [4000, (i - 8) * 500, 0],
  ).flat(),
)

describe('kinkNodes', () => {
  /** The shape the rule is for: a straight run that turns a corner and carries on. */
  it('finds the corner of a chain and nothing else', () => {
    const found = kinkNodes({ positions: CORNER_POSITIONS, parents: CORNER_PARENTS }, 1000, 60)
    expect(found.map((k) => k.node)).toEqual([8])
    expect(found[0]!.angle).toBeCloseTo(90)
  })

  /**
   * The disqualification, which is a decision and not an implementation detail: a node too near
   * an end has less than a micrometre of path to measure over, and a turn measured over 200 nm is
   * noise that would outrank a real one. SEAM skips it rather than measuring a shorter arm.
   */
  it('skips a node that runs out of path before the full length', () => {
    // Four nodes, 500 nm apart, bent hard at node 1 — which has only 500 nm of path above it.
    const parents = Int32Array.from([-1, 0, 1, 2])
    const positions = Float32Array.from([0, 0, 0, 500, 0, 0, 500, 500, 0, 500, 1000, 0])
    expect(kinkNodes({ positions, parents }, 1000, 60)).toEqual([])
  })

  /** A gentle bend is not a kink, which is what the threshold is for. */
  it('leaves a turn under the threshold alone', () => {
    expect(
      kinkNodes({ positions: CORNER_POSITIONS, parents: CORNER_PARENTS }, 1000, 120),
    ).toEqual([])
  })

  /**
   * A branch point is where the skeleton genuinely divides, so the turn there is the shape of a
   * fork rather than a swallowed end. The rule asks for exactly one child.
   */
  it('ignores a node with two children', () => {
    expect(
      kinkNodes({ positions: Y_POSITIONS, parents: Y_PARENTS }, 500, 10).map((k) => k.node),
    ).toEqual([])
  })
})

describe('thinKinks', () => {
  /**
   * Two decisions at once, and both are about which of a cluster survives rather than how many:
   * the sharper of two nearby turns is the one kept, and a turn beside a tip is dropped because
   * it is the same place as the tip — the one the calibration was fitted on.
   */
  it('keeps the sharpest of a cluster and drops anything beside a tip', () => {
    const positions = Float32Array.from([0, 0, 0, 1500, 0, 0, 10000, 0, 0, 10000, 1000, 0])
    const found = [
      { node: 0, angle: 70 },
      { node: 1, angle: 80 },
      { node: 2, angle: 65 },
    ]
    expect(thinKinks({ positions }, found, Int32Array.from([3]), 2000)).toEqual([1])
  })

  /** With no tips the exclusion has nothing to measure against, which is not the same as none. */
  it('keeps a kink where there is no tip at all', () => {
    const positions = Float32Array.from([0, 0, 0])
    expect(
      thinKinks({ positions }, [{ node: 0, angle: 70 }], Int32Array.from([]), 2000),
    ).toEqual([0])
  })
})

describe('tipsOf with kinks', () => {
  /** Off unless asked for: the switch is what makes a kink an extra candidate, not a new rule. */
  it('finds no kinks unless asked', () => {
    const tips = tipsOf({ positions: CORNER_POSITIONS, parents: CORNER_PARENTS }, undefined)
    expect(tips.kinds).toEqual(['tip', 'tip'])
    expect(tips.kinks).toBe(0)
  })

  /** Tips first, then the kinks — `tip_candidates.py`'s order, and the one the `kind` column says. */
  it('appends the kinks after the tips, each labelled', () => {
    const tips = tipsOf({ positions: CORNER_POSITIONS, parents: CORNER_PARENTS }, undefined, {
      kinks: true,
    })
    expect(tips.kinds).toEqual(['tip', 'tip', 'kink'])
    expect([...tips.fromNode]).toEqual([0, 16, 8])
    expect(tips.kinks).toBe(1)
    expect([...tips.positions.slice(6)]).toEqual([4000, 0, 0])
  })

  /**
   * A kink goes through the same snap and the same soma mask a tip does. SEAM snaps the whole
   * list in one query and masks the whole list after, and the asymmetry — a kink left on the
   * skeleton while its tips sit on the surface — would ask Model E about two different kinds of
   * point under one column.
   */
  it('snaps and soma-masks a kink exactly as a tip', () => {
    const mesh = { positions: Float32Array.from([4000, 300, 0, 0, 0, 0, 4000, 4000, 0]) }
    const tips = tipsOf({ positions: CORNER_POSITIONS, parents: CORNER_PARENTS }, mesh, {
      kinks: true,
    })
    // The corner snapped onto the vertex 300 nm off it, rather than staying on the skeleton.
    expect([...tips.positions.slice(6)]).toEqual([4000, 300, 0])

    const masked = tipsOf({ positions: CORNER_POSITIONS, parents: CORNER_PARENTS }, mesh, {
      kinks: true,
      somaNm: [4000, 300, 0],
      rule: { ...SEAM_TIP_RULE, somaUm: 1 },
    })
    expect(masked.kinds).toEqual(['tip', 'tip'])
    expect(masked.kinks).toBe(0)
    expect(masked.nearSoma).toBe(1)
  })
})
