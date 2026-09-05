/**
 * Prefuse's force simulation.
 *
 * A layout is the hardest kind of code to test, because almost any arrangement of dots looks
 * like a layout. So what is pinned here is not "the picture is good" but the handful of
 * properties whose violation would produce a picture that still looks like one:
 *
 * - the two n-body paths must agree, since only one of them runs on a large graph;
 * - the same graph must land in the same place twice, or every unrelated edit reshuffles it;
 * - nothing may become NaN, since a single NaN propagates through the centre of mass and
 *   takes the whole layout with it, silently, one iteration later.
 *
 * The pictures themselves were checked by rendering the real 36k-node graph — see
 * [docs/viewers.md](../../../docs/viewers.md).
 */

import { describe, expect, it } from 'vitest'

import {
  PREFUSE_DEFAULTS,
  addRepulsion,
  prefuseLayout,
  prefuseRun,
  spiralSeed,
} from './prefuseForce'

const distance = (out: { x: Float64Array; y: Float64Array }, a: number, b: number): number =>
  Math.hypot(out.x[a]! - out.x[b]!, out.y[a]! - out.y[b]!)

describe('the Barnes-Hut approximation', () => {
  /**
   * A scatter with real structure — clumps plus strays — rather than uniform noise. A
   * quadtree bug hides in a uniform cloud, where every box holds about the same mass.
   */
  function clumped(n: number): { x: Float64Array; y: Float64Array } {
    const x = new Float64Array(n)
    const y = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const clump = i % 5
      x[i] = clump * 400 + ((i * 37) % 61)
      y[i] = clump * 130 + ((i * 53) % 47)
    }
    return { x, y }
  }

  /** Worst per-node error against the exact sum, relative to the largest force in it. */
  function error(theta: number, n = 300): number {
    const { x, y } = clumped(n)
    const ex = new Float64Array(n)
    const ey = new Float64Array(n)
    addRepulsion(n, x, y, ex, ey, 3, -1, 0.9, false)
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)
    addRepulsion(n, x, y, fx, fy, 3, -1, theta, true)
    let worst = 0
    let scale = 0
    for (let i = 0; i < n; i++) {
      scale = Math.max(scale, Math.hypot(ex[i]!, ey[i]!))
      worst = Math.max(worst, Math.hypot(ex[i]! - fx[i]!, ey[i]! - fy[i]!))
    }
    return worst / scale
  }

  it('is the exact pairwise sum when nothing is approximated', () => {
    /*
     * The strongest statement available about the quadtree, and much better than a tolerance:
     * with theta at zero no box is ever accepted, every walk descends to the leaves, and the
     * answer must be the pairwise sum to the last bit. That pins the quadrant arithmetic, the
     * centre-of-mass roll-up and the leaf chains all at once — a mis-signed quadrant or a
     * forgotten leaf shows up here as a gross error, where at prefuse's own theta it would
     * hide inside the approximation's own slack.
     */
    expect(error(0)).toBeLessThan(1e-12)
  })

  it('degrades smoothly as theta opens, and no faster', () => {
    // Measured: 2.4e-5 at 0.1, 4.3e-3 at 0.3, 2.5e-2 at 0.5, 0.155 at prefuse's default 0.9.
    // Coarse — which is prefuse's choice, not ours — so what is pinned is the *shape* of the
    // curve. A structural bug does not respect it; it costs the same at every theta.
    expect(error(0.1)).toBeLessThan(1e-3)
    expect(error(0.3)).toBeLessThan(1e-2)
    expect(error(0.9)).toBeLessThan(0.25)
    expect(error(0.1)).toBeLessThan(error(0.3))
    expect(error(0.3)).toBeLessThan(error(0.9))
  })

  it('survives coincident points, which prefuse subdivides forever on', () => {
    // Prefuse divides its quadtree until two points separate; two points at the same location
    // never do, and it lives on float precision running out. The leaf chain is what replaces
    // that, and this is the case that would hang or stack-overflow without it.
    const n = 120
    const x = new Float64Array(n).fill(10)
    const y = new Float64Array(n).fill(-4)
    x[0] = 500
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)
    addRepulsion(n, x, y, fx, fy, 3, -1, 0.9, true)
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(fx[i]!)).toBe(true)
      expect(Number.isFinite(fy[i]!)).toBe(true)
    }
    // The stray is pushed away from the pile it is left of, not towards it.
    expect(fx[0]!).toBeGreaterThan(0)
  })

  it('repels rather than attracts, which is what prefuse’s negative constant means', () => {
    const x = Float64Array.from([0, 100])
    const y = Float64Array.from([0, 0])
    const fx = new Float64Array(2)
    const fy = new Float64Array(2)
    addRepulsion(2, x, y, fx, fy, 3, -1, 0.9, false)
    expect(fx[0]!).toBeLessThan(0)
    expect(fx[1]!).toBeGreaterThan(0)
  })
})

describe('the simulation', () => {
  it('pulls a linked pair towards the rest length', () => {
    const settings = { ...PREFUSE_DEFAULTS, springLength: 50 }
    const far = prefuseLayout(2, [[0, 1]], settings, undefined, {
      x: Float64Array.from([0, 900]),
      y: Float64Array.from([0, 0]),
    })
    expect(distance(far, 0, 1)).toBeLessThan(900)
  })

  it('pushes an unlinked pair apart', () => {
    const out = prefuseLayout(2, [], PREFUSE_DEFAULTS, undefined, {
      x: Float64Array.from([0, 20]),
      y: Float64Array.from([0, 0]),
    })
    expect(distance(out, 0, 1)).toBeGreaterThan(20)
  })

  it('lands in the same place twice', () => {
    // Not a nicety. Positions are recomputed whenever anything presentational changes, so a
    // layout that wandered would reshuffle the picture every time a colour was picked.
    const edges: Array<[number, number]> = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [0, 2],
    ]
    const first = prefuseLayout(4, edges)
    const second = prefuseLayout(4, edges)
    expect([...second.x]).toEqual([...first.x])
    expect([...second.y]).toEqual([...first.y])
  })

  it('keeps every coordinate finite on a star, a chain and a clique', () => {
    // One NaN reaches every node through the next centre-of-mass pass, so this is a whole
    // layout silently becoming nothing.
    const star: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [0, i + 1])
    const chain: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [i, i + 1])
    const clique: Array<[number, number]> = []
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) clique.push([i, j])
    for (const [n, edges] of [
      [21, star],
      [41, chain],
      [12, clique],
    ] as const) {
      const out = prefuseLayout(n, edges)
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(out.x[i]!)).toBe(true)
        expect(Number.isFinite(out.y[i]!)).toBe(true)
      }
    }
  })

  it('runs the tree path without diverging', () => {
    // Above `DIRECT_BELOW` a different n-body path runs, and nothing else in this file drives
    // it through a whole simulation rather than a single force evaluation.
    const n = 400
    const edges: Array<[number, number]> = Array.from({ length: n - 1 }, (_, i) => [i, i + 1])
    const out = prefuseLayout(n, edges)
    let extent = 0
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(out.x[i]!)).toBe(true)
      extent = Math.max(extent, Math.abs(out.x[i]!), Math.abs(out.y[i]!))
    }
    expect(extent).toBeGreaterThan(0)
    expect(extent).toBeLessThan(1e7)
  })

  it('ignores self-loops, which have no layout meaning', () => {
    const withLoop = prefuseLayout(3, [
      [0, 1],
      [1, 2],
      [1, 1],
    ])
    const without = prefuseLayout(3, [
      [0, 1],
      [1, 2],
    ])
    expect([...withLoop.x]).toEqual([...without.x])
  })

  it('stops when asked, landing on wherever it reached', () => {
    let asked = 0
    const edges: Array<[number, number]> = [
      [0, 1],
      [1, 2],
    ]
    const stopped = prefuseLayout(3, edges, PREFUSE_DEFAULTS, () => ++asked > 3)
    const full = prefuseLayout(3, edges)
    expect(asked).toBe(4)
    for (let i = 0; i < 3; i++) expect(Number.isFinite(stopped.x[i]!)).toBe(true)
    expect([...stopped.x]).not.toEqual([...full.x])
  })

  it('places nothing for an empty graph and one node for a single', () => {
    expect(prefuseLayout(0, []).x).toHaveLength(0)
    const one = prefuseLayout(1, [])
    expect(one.x).toHaveLength(1)
    expect(Number.isFinite(one.x[0]!)).toBe(true)
  })
})

describe('running in slices', () => {
  const edges: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => [i, i + 1])

  it('lands in exactly the same place as running straight through', () => {
    /*
     * The property the whole slicing mechanism rests on, and the one that would fail silently.
     * The annealing schedule compounds — `timestep *= (1 - i / total)` — so it is *state*, not
     * a function of the pass index alone. A slice that restarted it would re-heat the
     * simulation every time the thread was handed back, and the layout would drift a little
     * further from the settled one with every yield. The picture would still look like a
     * picture.
     */
    const whole = prefuseLayout(61, edges)
    const run = prefuseRun(61, edges)
    while (!run.advance(7)) {
      /* seven at a time, so the slices do not divide the pass count evenly */
    }
    expect([...run.positions.x]).toEqual([...whole.x])
    expect([...run.positions.y]).toEqual([...whole.y])
  })

  it('reports done only once the schedule is spent, whatever the slice size', () => {
    const run = prefuseRun(61, edges, { ...PREFUSE_DEFAULTS, iterations: 10 })
    expect(run.advance(4)).toBe(false)
    expect(run.advance(4)).toBe(false)
    expect(run.advance(4)).toBe(true)
    // Past the end it stays done rather than running on.
    expect(run.advance(4)).toBe(true)
  })

  it('treats a lone node and an empty set as already finished', () => {
    expect(prefuseRun(1, []).advance(1)).toBe(true)
    expect(prefuseRun(0, []).advance(1)).toBe(true)
  })
})

describe('the seed', () => {
  it('places no two nodes on the same spot', () => {
    // The reason it exists. Prefuse drops every node on one point and lets a random nudge in
    // the spring force break the symmetry; random is not available to a layout that has to be
    // reproducible, and an unlinked node would never be nudged at all.
    const { x, y } = spiralSeed(500, 300)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(`${x[i]},${y[i]}`)
    expect(seen.size).toBe(500)
  })

  it('fills a disc rather than a ring', () => {
    // A ring seed leaves every node on the hull, which the repulsion then has to spend its
    // whole budget undoing.
    const { x, y } = spiralSeed(400, 100)
    const radii = Array.from({ length: 400 }, (_, i) => Math.hypot(x[i]!, y[i]!))
    const inner = radii.filter((r) => r < 50).length
    expect(inner).toBeGreaterThan(80)
    expect(Math.max(...radii)).toBeLessThanOrEqual(100.0001)
  })
})
