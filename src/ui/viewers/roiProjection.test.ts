/**
 * Flattening region meshes into a map.
 *
 * Three things here would each produce a picture that looks entirely plausible and is wrong, so
 * each has a test rather than a comment: an axis mapping that quietly transposes a view, an
 * outline that fills in its own concavities, and an explode that scales the arrangement instead
 * of un-stacking it.
 */

import { describe, expect, it } from 'vitest'

import type { MeshGeometry } from '../../core/values'
import { generateRoiMesh } from '../../data/mock/morphology'
import type { XY } from '../raster'
import {
  ROI_VIEWS,
  homologyKey,
  regionSide,
  fitFrame,
  meshSurfaceArea,
  meshVolume,
  projectPoint,
  projectRegions,
  relaxShifts,
} from './roiProjection'

/** A flat plate in the z = depth plane, as two triangles. */
function plate(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  depth = 0,
): { positions: number[]; indices: number[] } {
  return {
    positions: [x0, y0, depth, x1, y0, depth, x1, y1, depth, x0, y1, depth],
    indices: [0, 1, 2, 0, 2, 3],
  }
}

function merge(label: string, parts: Array<ReturnType<typeof plate>>): MeshGeometry {
  const positions: number[] = []
  const indices: number[] = []
  for (const part of parts) {
    const base = positions.length / 3
    positions.push(...part.positions)
    for (const i of part.indices) indices.push(base + i)
  }
  return {
    bodyId: 0,
    label,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
}

/** Ray casting over a flat x,y ring, so it can be asked whether it really excludes a hollow. */
function inside(ring: Float32Array, point: XY): boolean {
  let hit = false
  const points = ring.length / 2
  for (let i = 0, j = points - 1; i < points; j = i++) {
    const xi = ring[i * 2]!
    const yi = ring[i * 2 + 1]!
    const xj = ring[j * 2]!
    const yj = ring[j * 2 + 1]!
    if (yi > point[1] !== yj > point[1]) {
      const cross = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
      if (point[0] < cross) hit = !hit
    }
  }
  return hit
}

/** How many pairs of regions overlap, treating each as its solver disc. */
function overlappingPairs(
  regions: ReadonlyArray<{ centre: XY; radius: number }>,
  shifts: Float64Array,
  amount: number,
): number {
  let count = 0
  for (let i = 0; i < regions.length - 1; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const ax = regions[i]!.centre[0] + (shifts[i * 2] ?? 0) * amount
      const ay = regions[i]!.centre[1] + (shifts[i * 2 + 1] ?? 0) * amount
      const bx = regions[j]!.centre[0] + (shifts[j * 2] ?? 0) * amount
      const by = regions[j]!.centre[1] + (shifts[j * 2 + 1] ?? 0) * amount
      if (Math.hypot(ax - bx, ay - by) < regions[i]!.radius + regions[j]!.radius) count++
    }
  }
  return count
}

describe('projectPoint', () => {
  it('maps each anatomical plane to its own pair of axes', () => {
    // x medial→lateral, y dorsal→ventral, z anterior→posterior.
    expect(projectPoint(1, 2, 3, 'frontal')).toEqual([1, 2, 3])
    // Dorsal looks down y, with anterior at the top of the picture.
    expect(projectPoint(1, 2, 3, 'dorsal')).toEqual([1, 3, 2])
    // Lateral looks down x, with anterior to the left.
    expect(projectPoint(1, 2, 3, 'lateral')).toEqual([3, 2, -1])
  })

  it('offers exactly three planes and no camera', () => {
    /*
     * The decision the caching rests on. With an arbitrary camera the meshes have to be kept,
     * because any angle can be asked for later; with three answers they are flattened once and
     * discarded, and what is stored is polyline rather than 29-62 MB of geometry.
     */
    expect(ROI_VIEWS).toEqual(['frontal', 'dorsal', 'lateral'])
  })

  it('projects down a different axis in each plane', () => {
    // Each plane keeps two of the three axes and spends the third on depth, so between them
    // they carry every coordinate — which is why three is enough to read a brain from.
    const kept = ROI_VIEWS.map((view) => {
      const [x, y] = projectPoint(1, 2, 3, view)
      return [x, y].join(',')
    })
    expect(new Set(kept).size).toBe(3)
  })
})

describe('projectRegions', () => {
  it('gives every region an outline, keyed to its mesh', () => {
    const meshes = ['CA(R)', 'PED(R)', 'AL(R)'].map((roi) => generateRoiMesh(roi))
    const regions = projectRegions(meshes, 'frontal')

    expect(regions).toHaveLength(3)
    expect(regions.map((r) => r.label)).toEqual(['CA(R)', 'PED(R)', 'AL(R)'])
    // The index is what lets a caller reach the attribute row for a region.
    expect(regions.map((r) => r.index)).toEqual([0, 1, 2])
    for (const region of regions) {
      expect(region.rings.length).toBeGreaterThan(0)
      expect(region.rings[0]!.length / 2).toBeGreaterThan(3)
      expect(region.radius).toBeGreaterThan(0)
    }
  })

  it('keeps a concavity rather than filling it in', () => {
    /*
     * The failure this whole approach exists to avoid. A C opening to the right: anything that
     * sweeps angles about the centroid reports the hollow as part of the region, which on a real
     * connectome means the mushroom body lobes swallowing the peduncle between them.
     */
    const c = merge('C', [
      plate(0, 0, 100, 25), // top arm
      plate(0, 0, 25, 100), // spine
      plate(0, 75, 100, 100), // bottom arm
    ])
    const [region] = projectRegions([c], 'frontal')
    expect(region).toBeDefined()
    const ring = region!.rings[0]!

    expect(inside(ring, [10, 50])).toBe(true) // spine
    expect(inside(ring, [70, 12])).toBe(true) // top arm
    expect(inside(ring, [70, 88])).toBe(true) // bottom arm
    expect(inside(ring, [70, 50])).toBe(false) // the hollow
  })

  it('separates a region that projects to two pieces', () => {
    const split = merge('split', [plate(0, 0, 30, 30), plate(70, 0, 100, 30)])
    const [region] = projectRegions([split], 'frontal')
    expect(region!.rings).toHaveLength(2)
  })

  it('orders depth away from the viewer, so a painter pass draws back to front', () => {
    const near = merge('near', [plate(0, 0, 40, 40, -100)])
    const far = merge('far', [plate(0, 0, 40, 40, 100)])
    const [a, b] = projectRegions([near, far], 'frontal')
    expect(a!.depth).toBeLessThan(b!.depth)
  })

  it('answers nothing rather than dividing by zero on a degenerate scene', () => {
    const point = merge('point', [plate(5, 5, 5, 5)])
    expect(projectRegions([point], 'frontal')).toEqual([])
    expect(projectRegions([], 'frontal')).toEqual([])
  })
})

describe('relaxShifts', () => {
  const meshes = [
    'CA(R)', 'PED(R)', 'AL(R)', 'LH(R)', 'SLP(R)', 'SMP(R)', 'aL(R)', 'bL(R)', 'gL(R)',
  ].map((roi) => generateRoiMesh(roi))

  it('un-stacks the arrangement', () => {
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    const before = overlappingPairs(regions, shifts, 0)
    const after = overlappingPairs(regions, shifts, 1)
    expect(before).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
  })

  it('is not a uniform scale, which is the whole reason it is not a radial push', () => {
    /*
     * A homothety moves every region by an amount proportional to its distance from the
     * centroid, so the ratio of shift to that distance is the same for all of them — and the
     * picture then only ever appears to shrink. Relaxation is non-uniform by construction: some
     * regions barely move, and the spread of that ratio is what says so.
     */
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    let cx = 0
    let cy = 0
    for (const region of regions) {
      cx += region.centre[0]
      cy += region.centre[1]
    }
    cx /= regions.length
    cy /= regions.length

    const ratios = regions.map((region, i) => {
      const distance = Math.hypot(region.centre[0] - cx, region.centre[1] - cy)
      const shift = Math.hypot(shifts[i * 2]!, shifts[i * 2 + 1]!)
      return distance > 1 ? shift / distance : 0
    })
    const spread = Math.max(...ratios) - Math.min(...ratios)
    expect(spread).toBeGreaterThan(0.2)
  })

  it('is deterministic, because two renders of one graph must not disagree', () => {
    const regions = projectRegions(meshes, 'frontal')
    expect(Array.from(relaxShifts(regions))).toEqual(Array.from(relaxShifts(regions)))
  })

  it('separates regions whose projected centres coincide exactly', () => {
    /*
     * Not hypothetical: a lateral view of a bilaterally symmetric brain projects every left and
     * right twin onto the same point, so the tie-break is the normal case there rather than a
     * guard against corrupt input.
     */
    const one = merge('L', [plate(0, 0, 40, 40)])
    const two = merge('R', [plate(0, 0, 40, 40)])
    const regions = projectRegions([one, two], 'frontal')
    expect(regions[0]!.centre).toEqual(regions[1]!.centre)

    const shifts = relaxShifts(regions)
    const moved = Math.hypot(shifts[0]! - shifts[2]!, shifts[1]! - shifts[3]!)
    expect(moved).toBeGreaterThan(0)
  })

  it('answers an empty scene without complaint', () => {
    expect(relaxShifts([])).toHaveLength(0)
  })
})

describe('left and right', () => {
  it('reads the side off the suffix, and midline as an answer', () => {
    expect(regionSide('ME(R)')).toBe('right')
    expect(regionSide("a'L(L)")).toBe('left')
    // Not a parse failure: FB, EB, PB and GNG span the midline and carry no suffix.
    expect(regionSide('FB')).toBeUndefined()
    expect(regionSide('GNG')).toBeUndefined()
  })

  it('pairs a sub-region with its own twin rather than with its parent', () => {
    expect(homologyKey('ME(L)')).toBe(homologyKey('ME(R)'))
    expect(homologyKey('ME(R)_col_12')).toBe(homologyKey('ME(L)_col_12'))
    expect(homologyKey('ME(R)_col_12')).not.toBe(homologyKey('ME(R)'))
  })
})

describe('the explode is symmetrical', () => {
  /**
   * A brain: two mirrored regions either side of the midline, one structure on it.
   *
   * Real shells rather than the flat plates the tests above use, because these have to survive
   * the *lateral* projection — a plate lies in one z plane, so projected down x it is a line
   * with no area and is dropped before any of this is reached.
   */
  function shell(label: string, shift: [number, number, number], mirror = false): MeshGeometry {
    const base = generateRoiMesh(label.replace(/\((L|R)\)/, '(R)'))
    const positions = new Float32Array(base.positions.length)
    for (let i = 0; i < positions.length; i += 3) {
      const x = base.positions[i]!
      positions[i] = (mirror ? -x : x) + shift[0]
      positions[i + 1] = base.positions[i + 1]! + shift[1]
      positions[i + 2] = base.positions[i + 2]! + shift[2]
    }
    return { ...base, label, positions }
  }

  function brain(): MeshGeometry[] {
    // Centred on x = 0 so the midline is where the mirror says it is.
    const right = shell('X(R)', [2600, 0, 0])
    const left = shell('X(L)', [-2600, 0, 0], true)
    const mid = shell('FB', [0, 0, 0])
    // The midline shell is built from the same seed, so recentre it on zero.
    let cx = 0
    for (let i = 0; i < mid.positions.length; i += 3) cx += mid.positions[i]!
    cx /= mid.positions.length / 3
    const centred = new Float32Array(mid.positions.length)
    for (let i = 0; i < centred.length; i += 3) {
      centred[i] = mid.positions[i]! - cx
      centred[i + 1] = mid.positions[i + 1]!
      centred[i + 2] = mid.positions[i + 2]!
    }
    return [right, left, { ...mid, positions: centred }]
  }

  it('moves homologous regions along mirrored vectors', () => {
    /*
     * The point of the constraint. Unconstrained, the pair gets whatever the collision order
     * happens to produce, and a bilaterally symmetric brain explodes lopsided — which reads as a
     * mistake, because the anatomy it is drawn from plainly is not.
     */
    const regions = projectRegions(brain(), 'frontal')
    const shifts = relaxShifts(regions, 'frontal')
    const at = (label: string) => regions.findIndex((r) => r.label === label)
    const r = at('X(R)')
    const l = at('X(L)')

    // A displacement mirrors as (-dx, dy).
    expect(shifts[r * 2]! + shifts[l * 2]!).toBeCloseTo(0, 6)
    expect(shifts[r * 2 + 1]! - shifts[l * 2 + 1]!).toBeCloseTo(0, 6)
  })

  it('holds a midline structure on the midline', () => {
    // Sideways drift would break the one axis the picture can be read against. Along the
    // midline it may still move, which is where the room is anyway.
    const regions = projectRegions(brain(), 'frontal')
    const shifts = relaxShifts(regions, 'frontal')
    const mid = regions.findIndex((r) => r.label === 'FB')
    expect(shifts[mid * 2]).toBeCloseTo(0, 6)
  })

  it('applies in the dorsal plane too, where x is still the horizontal axis', () => {
    const regions = projectRegions(brain(), 'dorsal')
    const shifts = relaxShifts(regions, 'dorsal')
    const r = regions.findIndex((x) => x.label === 'X(R)')
    const l = regions.findIndex((x) => x.label === 'X(L)')
    expect(shifts[r * 2]! + shifts[l * 2]!).toBeCloseTo(0, 6)
  })

  it('does not apply in the lateral plane, where it would pin the twins together', () => {
    /*
     * Lateral projects down x, so the mirror axis is the depth axis: homologous regions land on
     * exactly the same point and "mirrored" degenerates to "identical". Constraining them there
     * would hold every twin superimposed forever — the one thing the explode exists to fix in
     * that view.
     */
    const regions = projectRegions(brain(), 'lateral')
    const shifts = relaxShifts(regions, 'lateral')
    const r = regions.findIndex((x) => x.label === 'X(R)')
    const l = regions.findIndex((x) => x.label === 'X(L)')
    const apart = Math.hypot(
      shifts[r * 2]! - shifts[l * 2]!,
      shifts[r * 2 + 1]! - shifts[l * 2 + 1]!,
    )
    expect(apart).toBeGreaterThan(0)
  })

  it('still separates what it is constraining', () => {
    // A constraint that bought symmetry by not exploding would be no constraint at all.
    const regions = projectRegions(brain(), 'frontal')
    const shifts = relaxShifts(regions, 'frontal')
    expect(overlappingPairs(regions, shifts, 1)).toBeLessThanOrEqual(
      overlappingPairs(regions, shifts, 0),
    )
    let moved = 0
    for (let i = 0; i < regions.length; i++) {
      moved = Math.max(moved, Math.hypot(shifts[i * 2]!, shifts[i * 2 + 1]!))
    }
    expect(moved).toBeGreaterThan(0)
  })

  it('leaves a half brain alone, where there is no symmetry to preserve', () => {
    /*
     * hemibrain is one hemisphere plus the midline, so most of its regions have no twin. Pinning
     * a midline structure's sideways travel there would buy symmetry the dataset does not have,
     * while still costing the solver a degree of freedom it could have spent separating
     * something — so the constraint stands down when nothing pairs.
     */
    const oneSided = [brain()[0]!, brain()[2]!]
    const regions = projectRegions(oneSided, 'frontal')
    const shifts = relaxShifts(regions, 'frontal')
    const mid = regions.findIndex((r) => r.label === 'FB')
    expect(Math.abs(shifts[mid * 2]!)).toBeGreaterThan(0)
  })
})

describe('fitFrame', () => {
  const meshes = ['CA(R)', 'PED(R)', 'AL(R)', 'LH(R)'].map((roi) => generateRoiMesh(roi))

  it('frames the fully exploded scene, so the frame never moves as the slider does', () => {
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    const frame = fitFrame(regions, shifts, 600, 400, 10)

    // Every point at full explode lands inside the box…
    for (let i = 0; i < regions.length; i++) {
      for (const ring of regions[i]!.rings) {
        for (let at = 0; at < ring.length; at += 2) {
          const px = (ring[at]! + shifts[i * 2]!) * frame.scale + frame.offsetX
          const py = (ring[at + 1]! + shifts[i * 2 + 1]!) * frame.scale + frame.offsetY
          expect(px).toBeGreaterThanOrEqual(-0.5)
          expect(px).toBeLessThanOrEqual(600.5)
          expect(py).toBeGreaterThanOrEqual(-0.5)
          expect(py).toBeLessThanOrEqual(400.5)
        }
      }
    }
    // …and so does everything at rest, which is what "held at full" buys.
    expect(frame.scale).toBeGreaterThan(0)
  })

  it('costs some size at rest, and reports how much honestly', () => {
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    const exploded = fitFrame(regions, shifts, 600, 400, 10)
    const rest = fitFrame(regions, new Float64Array(regions.length * 2), 600, 400, 10)
    // The frame held at full explode draws the resting scene smaller than a refit would — that
    // is the trade, and it is bounded rather than arbitrary.
    expect(exploded.scale).toBeLessThan(rest.scale)
    expect(exploded.scale / rest.scale).toBeGreaterThan(0.4)
  })

  it('degrades to an identity frame when there is nothing to frame', () => {
    expect(fitFrame([], new Float64Array(0), 100, 100)).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    })
  })
})

describe('what a mesh knows about itself', () => {
  /** Unit cube, consistently wound. */
  const cube: MeshGeometry = {
    bodyId: 0,
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, // bottom
      4, 5, 6, 4, 6, 7, // top
      0, 1, 5, 0, 5, 4, // front
      2, 3, 7, 2, 7, 6, // back
      0, 4, 7, 0, 7, 3, // left
      1, 2, 6, 1, 6, 5, // right
    ]),
  }

  it('measures enclosed volume', () => {
    expect(meshVolume(cube.positions, cube.indices)).toBeCloseTo(1)
  })

  it('measures surface area', () => {
    expect(meshSurfaceArea(cube.positions, cube.indices)).toBeCloseTo(6)
  })

  it('reports a positive volume whichever way the exporter wound its faces', () => {
    // Winding is a property of whoever made the file, not of the shape.
    const flipped = new Uint32Array(cube.indices)
    for (let t = 0; t < flipped.length; t += 3) {
      const swap = flipped[t + 1]!
      flipped[t + 1] = flipped[t + 2]!
      flipped[t + 2] = swap
    }
    expect(meshVolume(cube.positions, flipped)).toBeCloseTo(1)
  })

  it('scales with the cube of a linear factor', () => {
    const doubled = new Float32Array(cube.positions.map((v) => v * 2))
    expect(meshVolume(doubled, cube.indices)).toBeCloseTo(8)
    expect(meshSurfaceArea(doubled, cube.indices)).toBeCloseTo(24)
  })

  it('answers zero for a mesh with no faces', () => {
    expect(meshVolume(new Float32Array(9), new Uint32Array(0))).toBe(0)
    expect(meshSurfaceArea(new Float32Array(9), new Uint32Array(0))).toBe(0)
  })
})
