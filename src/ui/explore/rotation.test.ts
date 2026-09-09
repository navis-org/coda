/**
 * The rocking preview's arithmetic.
 *
 * Everything here is checkable without a DOM, which is the whole reason the module is separate —
 * jsdom has no canvas and this repo drives no browser in its suite, so a rotation that only
 * existed inside the component would be verified by nothing at all. What the browser is still
 * needed for is whether it *looks* like a rotation; what is here is whether it could.
 */

import { describe, expect, it } from 'vitest'

import {
  DECIMATE_MAX_NODES,
  ROTATION_FRAMES,
  buildOrder,
  createRotation,
  decimateSkeleton,
  frameAngles,
  pivotOf,
  rockFrame,
  rotateY,
  sweptBounds,
} from './rotation'

/** A chain of `n` nodes along +y, with a fixed x/z so rotation has something to move. */
function chain(n: number, branchEvery = 0, offset = 0) {
  const positions = new Float32Array(n * 3)
  const parents = new Int32Array(n)
  parents[0] = -1
  // The root too, or `offset` leaves node 0 at the origin and the chain spans the whole distance
  // rather than sitting at it — which is a different test from the one intended.
  positions[0] = offset + 100
  positions[2] = offset + 50
  for (let i = 1; i < n; i++) {
    positions[i * 3] = offset + 100 + (i % 7) * 10
    positions[i * 3 + 1] = i * 10
    positions[i * 3 + 2] = offset + 50 + (i % 5) * 10
    parents[i] = branchEvery > 0 && i % branchEvery === 0 ? Math.floor(i / 2) : i - 1
  }
  return { positions, parents }
}

describe('frameAngles', () => {
  it('spans the whole sweep inclusive, so the ends are drawn', () => {
    const angles = frameAngles(16, 45)
    expect(angles).toHaveLength(16)
    expect((angles[0]! * 180) / Math.PI).toBeCloseTo(-45)
    expect((angles[15]! * 180) / Math.PI).toBeCloseTo(45)
    // 90° over fifteen steps.
    expect(((angles[1]! - angles[0]!) * 180) / Math.PI).toBeCloseTo(6, 0)
  })

  it('is symmetric about zero, or the neuron rocks off centre', () => {
    const angles = frameAngles(ROTATION_FRAMES)
    expect(angles[0]! + angles[angles.length - 1]!).toBeCloseTo(0)
  })

  /*
   * The rock starts on the thumbnail's own view, so there has to be a frame at exactly 0° — which
   * an even count does not have. At 16 the nearest sit at ±2.8° and the crossfade would begin on a
   * view that is visibly not the static picture.
   */
  it('has an exact centre frame, which is what the rock starts on', () => {
    expect(ROTATION_FRAMES % 2).toBe(1)
    const angles = frameAngles(ROTATION_FRAMES)
    expect(angles[(ROTATION_FRAMES - 1) / 2]).toBeCloseTo(0, 10)
  })
})

describe('rotateY', () => {
  it('leaves the vertical axis alone', () => {
    const source = new Float32Array([10, 77, 20])
    const turned = rotateY(source, Math.PI / 4)
    expect(turned[1]).toBe(77)
  })

  it('is a rotation: it preserves distance from the vertical axis', () => {
    const source = new Float32Array([30, 0, 40])
    const turned = rotateY(source, 0.9)
    expect(Math.hypot(turned[0]!, turned[2]!)).toBeCloseTo(50, 4)
  })

  it('does not write into the buffer it was given', () => {
    const source = new Float32Array([1, 2, 3])
    rotateY(source, 1)
    expect(Array.from(source)).toEqual([1, 2, 3])
  })
})

describe('pivotOf', () => {
  /*
   * The bug this exists for. Positions are nanometres in *dataset* space, so a neuron sits
   * hundreds of microns from the volume origin — rotating about the origin swings it round an
   * enormous arc rather than turning it in place, `sweptBounds` grows to cover the arc, and the
   * fit shrinks the neuron to a smudge sliding across the tile.
   */
  it('is the centre of the geometry, not the origin', () => {
    const { positions } = chain(50, 0, 400_000)
    const pivot = pivotOf(positions)
    expect(pivot[0]).toBeGreaterThan(390_000)
    expect(pivot[2]).toBeGreaterThan(390_000)
  })

  it('answers the origin for empty geometry rather than a NaN', () => {
    expect(pivotOf(new Float32Array(0))).toEqual([0, 0, 0])
  })
})

describe('rotating in place', () => {
  it('leaves the pivot itself where it is', () => {
    const pivot: [number, number, number] = [400_000, 0, 400_000]
    const turned = rotateY(new Float32Array(pivot), 0.7, pivot)
    expect(turned[0]).toBeCloseTo(pivot[0], 1)
    expect(turned[2]).toBeCloseTo(pivot[2], 1)
  })

  /*
   * The measurable signature of the bug: a neuron 400 µm from the origin swept about the origin
   * has a swept box hundreds of times its own width, so it is drawn hundreds of times too small.
   * About its own centre the swept box is the same as a neuron sitting at the origin.
   */
  it('sweeps a distant neuron no wider than a centred one', () => {
    const angles = frameAngles()
    const near = chain(200, 0, 0)
    const far = chain(200, 0, 400_000)

    const nearSpan = (() => {
      const box = sweptBounds(near.positions, angles, pivotOf(near.positions))
      return box.max[0] - box.min[0]
    })()
    const farSpan = (() => {
      const box = sweptBounds(far.positions, angles, pivotOf(far.positions))
      return box.max[0] - box.min[0]
    })()
    expect(farSpan).toBeCloseTo(nearSpan, 1)

    // And what it was doing before: about the origin, the same neuron sweeps ~500 µm.
    const aboutOrigin = sweptBounds(far.positions, angles)
    expect(aboutOrigin.max[0] - aboutOrigin.min[0]).toBeGreaterThan(nearSpan * 100)
  })

  it('draws a distant neuron at the same size as a centred one', () => {
    const near = createRotation({ kind: 'skeleton', ...chain(200, 0, 0) }, 96)
    const far = createRotation({ kind: 'skeleton', ...chain(200, 0, 400_000) }, 96)
    const painted = (mask: { coverage: Uint8Array }) =>
      mask.coverage.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)
    // Same drawing, wherever the neuron happens to sit in the volume.
    expect(painted(far.render(0))).toBe(painted(near.render(0)))
  })
})

describe('sweptBounds', () => {
  /*
   * The failure this prevents is the one that cannot be seen from a single frame: `fitToTile`
   * derives its box from whatever positions it is handed, so a per-frame fit re-frames each
   * rotated copy and the neuron pulses as it turns.
   */
  it('covers every angle, so no frame overflows the tile it was fitted to', () => {
    const { positions } = chain(50)
    const angles = frameAngles(16, 45)
    const box = sweptBounds(positions, angles)
    for (const theta of angles) {
      const turned = rotateY(positions, theta)
      for (let i = 0; i < turned.length; i += 3) {
        expect(turned[i]!).toBeGreaterThanOrEqual(box.min[0] - 1e-3)
        expect(turned[i]!).toBeLessThanOrEqual(box.max[0] + 1e-3)
        expect(turned[i + 2]!).toBeGreaterThanOrEqual(box.min[2] - 1e-3)
        expect(turned[i + 2]!).toBeLessThanOrEqual(box.max[2] + 1e-3)
      }
    }
  })

  it('is wider than any one frame, which is what makes the sweep hold still', () => {
    const { positions } = chain(50)
    const box = sweptBounds(positions, frameAngles(16, 45))
    const flat = sweptBounds(positions, [0])
    expect(box.max[0] - box.min[0]).toBeGreaterThan(flat.max[0] - flat.min[0])
    // Y is unrotated, so it must not have grown.
    expect(box.max[1] - box.min[1]).toBeCloseTo(flat.max[1] - flat.min[1])
  })

  it('answers a degenerate box for empty geometry rather than infinities', () => {
    const box = sweptBounds(new Float32Array(0), frameAngles())
    expect(box.min.every(Number.isFinite)).toBe(true)
    expect(box.max.every(Number.isFinite)).toBe(true)
  })
})

describe('decimateSkeleton', () => {
  it('leaves a skeleton under the cap exactly as it was', () => {
    const { positions, parents } = chain(100)
    const skeleton = { positions, parents }
    // By identity, which is what makes `createRotation`'s second call a free guard.
    expect(decimateSkeleton(skeleton, DECIMATE_MAX_NODES)).toBe(skeleton)
  })

  it('thins a traced-arbor-sized skeleton by more than five times', () => {
    const { positions, parents } = chain(16840, 11)
    const out = decimateSkeleton({ positions, parents }, 3000)
    expect(out.parents.length).toBeLessThan(16840 / 5)
  })

  /*
   * The cap is a target and structure is the floor — this arbor branches every eleventh node, so
   * it has 3,062 branch points and leaves against a cap of 3,000 and keeps every one of them.
   * Thinning into those would not be decimating the drawing but changing it, which is the whole
   * reason this is not a uniform subsample. Asserted so the overshoot is a stated property rather
   * than something a later reader tightens the cap to "fix".
   */
  it('keeps structure past the cap rather than dropping branch points', () => {
    const { positions, parents } = chain(16840, 11)
    const out = decimateSkeleton({ positions, parents }, 3000)
    expect(out.parents.length).toBeGreaterThan(3000)
    expect(out.parents.length).toBeLessThan(3200)
  })

  it('honours the cap exactly where structure leaves room', () => {
    // A long run with few branches: the quota governs, and a stride would overshoot it.
    const { positions, parents } = chain(16840, 400)
    const out = decimateSkeleton({ positions, parents }, 3000)
    expect(out.parents.length).toBeLessThanOrEqual(3000)
    expect(out.parents.length).toBeGreaterThan(2900)
  })

  it('keeps every branch point and leaf, which is what keeps the shape', () => {
    const { positions, parents } = chain(5000, 9)
    const children = new Int32Array(5000)
    for (let i = 0; i < 5000; i++) {
      const p = parents[i]!
      if (p >= 0) children[p] = children[p]! + 1
    }
    const structural = Array.from({ length: 5000 }, (_, i) => i).filter(
      (i) => parents[i]! < 0 || children[i] !== 1,
    ).length
    const out = decimateSkeleton({ positions, parents }, 3000)
    // Every structural node survived, so the count cannot have fallen below them.
    expect(out.parents.length).toBeGreaterThanOrEqual(structural)
  })

  it('leaves no dangling parent index', () => {
    const { positions, parents } = chain(9000, 13)
    const out = decimateSkeleton({ positions, parents }, 2000)
    const n = out.parents.length
    for (let i = 0; i < n; i++) {
      const p = out.parents[i]!
      expect(p).toBeGreaterThanOrEqual(-1)
      expect(p).toBeLessThan(n)
      expect(p).not.toBe(i)
    }
  })

  /*
   * The ordering trap. `spanningForest` guarantees a parent precedes its child, and CATMAID's
   * `decodeCompactSkeleton` does not go through it — it maps the server's node order straight
   * through, so a parent may appear after its child. Decimation is the first thing here to walk a
   * parent *chain*, so it is the first thing that can get this wrong.
   */
  it('handles a parent that appears after its child, as CATMAID hands them over', () => {
    const n = 6000
    const positions = new Float32Array(n * 3)
    const parents = new Int32Array(n)
    // Reversed: node i's parent is i + 1, and the last node is the root.
    for (let i = 0; i < n; i++) {
      positions[i * 3] = 100 + (i % 7) * 10
      positions[i * 3 + 1] = (n - i) * 10
      positions[i * 3 + 2] = 50
      parents[i] = i + 1 < n ? i + 1 : -1
    }
    const out = decimateSkeleton({ positions, parents }, 1500)
    expect(out.parents.length).toBeLessThanOrEqual(1500)
    // A run of 6,000 with one root and one leaf thins to the budget rather than collapsing to
    // the two structural nodes, which is what a forward-pass-only walk would produce.
    expect(out.parents.length).toBeGreaterThan(100)
    const roots = Array.from(out.parents).filter((p) => p === -1).length
    expect(roots).toBe(1)
  })

  it('terminates on a cycle rather than hanging', () => {
    const n = 4000
    const positions = new Float32Array(n * 3)
    const parents = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      positions[i * 3 + 1] = i
      parents[i] = (i + 1) % n
    }
    // A malformed skeleton is what `data/skeletonTree.ts` exists to prevent; a consumer that
    // walks to a root on one loops forever. The cap is the whole assertion.
    const out = decimateSkeleton({ positions, parents }, 500)
    expect(out.parents.length).toBeGreaterThan(0)
  })
})

describe('createRotation', () => {
  it('renders every frame at the requested size, deterministically', () => {
    const { positions, parents } = chain(400)
    const rotation = createRotation({ kind: 'skeleton', positions, parents }, 64)
    expect(rotation.frames).toBe(ROTATION_FRAMES)
    const first = rotation.render(0)
    expect(first.size).toBe(64)
    // Deterministic, which is what lets a caller build frames across several ticks.
    expect(Array.from(rotation.render(0).coverage)).toEqual(Array.from(first.coverage))
  })

  it('draws different pictures at the two ends of the sweep', () => {
    const { positions, parents } = chain(400)
    const rotation = createRotation({ kind: 'skeleton', positions, parents }, 64)
    const left = rotation.render(0).coverage
    const right = rotation.render(rotation.frames - 1).coverage
    expect(Array.from(left)).not.toEqual(Array.from(right))
  })

  /*
   * The pulse. Every frame shares one box, so the drawn extent must not grow and shrink across
   * the sweep the way it does when each frame fits itself. Measured as painted rows, which is a
   * proxy for how tall the neuron is drawn — and Y is the axis rotation does not touch, so a
   * shared fit holds it exactly constant while a per-frame fit does not.
   */
  it('holds the vertical extent still across the sweep', () => {
    const { positions, parents } = chain(400)
    const rotation = createRotation({ kind: 'skeleton', positions, parents }, 96)
    const heights = new Set<number>()
    for (let i = 0; i < rotation.frames; i++) {
      const mask = rotation.render(i)
      let top = -1
      let bottom = -1
      for (let y = 0; y < mask.size; y++) {
        for (let x = 0; x < mask.size; x++) {
          if (mask.coverage[y * mask.size + x]! > 0) {
            if (top < 0) top = y
            bottom = y
            break
          }
        }
      }
      heights.add(bottom - top)
    }
    expect(heights.size).toBe(1)
  })

  it('clamps an out-of-range frame rather than drawing nothing', () => {
    const { positions, parents } = chain(200)
    const rotation = createRotation({ kind: 'skeleton', positions, parents }, 48)
    expect(Array.from(rotation.render(-5).coverage)).toEqual(
      Array.from(rotation.render(0).coverage),
    )
    expect(Array.from(rotation.render(999).coverage)).toEqual(
      Array.from(rotation.render(rotation.frames - 1).coverage),
    )
  })
})

/**
 * How the sweep is played and in what order it is built.
 *
 * Beside the rest of the sweep's arithmetic rather than in the component suite: these are pure
 * integer functions over `ROTATION_FRAMES`, whose oddness is `rockFrame`'s precondition, and
 * asserting them from jsdom meant importing this module to test something exported from a `.tsx`.
 */
describe('playback', () => {
  it("starts the rock on the thumbnail's own view and departs from it both ways", () => {
    /*
     * Two things at once, and the first was wrong before: a ping-pong starting at phase 0 begins
     * at frame 0, which is the −45° extreme, so the animation cut to the far side and travelled
     * back. It has to begin on the unrotated view — the picture the static mask already shows and
     * the one it is crossfading from.
     */
    const frames = ROTATION_FRAMES
    const centre = (frames - 1) / 2
    expect(rockFrame(0, frames)).toBe(centre)

    // A quarter in is one extreme, three quarters the other, and half way back at the centre.
    expect(rockFrame(0.25, frames)).toBe(frames - 1)
    expect(rockFrame(0.5, frames)).toBe(centre)
    expect(rockFrame(0.75, frames)).toBe(0)

    // Never off the end, at any phase.
    for (let i = 0; i <= 200; i++) {
      const at = rockFrame(i / 200, frames)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThan(frames)
    }
  })

  it('builds the frame the rock starts on first, so the framing settles once', () => {
    /*
     * A sweep is framed by `sweptBounds` and the static mask by its own, and a rotating body needs
     * more room than a still one — measured in a browser, 1.6× smaller linearly, 2.6× the painted
     * area. Building left-to-right would show the −45° frame first and cut to it, which is both a
     * change of framing *and* a jump to the far extreme.
     */
    const frames = ROTATION_FRAMES
    const order = buildOrder(frames)
    expect(order[0]).toBe(rockFrame(0, frames))
    // Every frame exactly once.
    expect([...order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: frames }, (_, i) => i),
    )
  })

  it('eases at the turning points rather than reversing on the spot', () => {
    /*
     * A sine *is* an eased ping-pong. Measured as frame movement per unit phase: near an extreme
     * it should crawl, and through the centre it should be at its fastest — a linear triangle
     * moves at one rate throughout and the reversal reads as a judder.
     */
    const frames = ROTATION_FRAMES
    const step = (from: number) =>
      Math.abs(rockFrame(from + 0.02, frames) - rockFrame(from, frames))
    expect(step(0.25)).toBeLessThan(step(0))
  })
})
