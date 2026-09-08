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
import type { ProjectedRegion } from './roiProjection'
import {
  MAX_ROI_ZOOM,
  ROI_VIEWS,
  autoLabelled,
  explodedShifts,
  homologyKey,
  regionGeometry,
  regionSide,
  fitFrame,
  meshSurfaceArea,
  meshVolume,
  panRoiWindow,
  pointToScene,
  projectPoint,
  projectRegions,
  relaxShifts,
  windowFrame,
  zoomRoiWindow,
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
    id: label,
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
    'CA(R)',
    'PED(R)',
    'AL(R)',
    'LH(R)',
    'SLP(R)',
    'SMP(R)',
    'aL(R)',
    'bL(R)',
    'gL(R)',
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
    return { ...base, id: label, positions }
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

  /** Every drawn point of the arrangement `shifts` describes, inside the box. */
  function framed(regions: ReturnType<typeof projectRegions>, shifts: Float64Array): boolean {
    const width = 600
    const height = 400
    const frame = fitFrame(regionGeometry(regions).bounds, shifts, width, height, 10)
    for (let i = 0; i < regions.length; i++) {
      for (const ring of regions[i]!.rings) {
        for (let at = 0; at < ring.length; at += 2) {
          const px = (ring[at]! + shifts[i * 2]!) * frame.scale + frame.offsetX
          const py = (ring[at + 1]! + shifts[i * 2 + 1]!) * frame.scale + frame.offsetY
          if (px < -0.5 || px > width + 0.5 || py < -0.5 || py > height + 0.5) return false
        }
      }
    }
    return true
  }

  it('keeps every region in view at every setting of the slider', () => {
    /*
     * The property the whole thing exists for, asked across the slider rather than at its ends:
     * the frame follows the arrangement, so nothing is ever drawn outside the card and nothing
     * is reserved for an arrangement that is not on screen.
     */
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    for (const percent of [0, 1, 25, 50, 75, 99, 100]) {
      expect(framed(regions, explodedShifts(shifts, percent / 100))).toBe(true)
    }
  })

  it('spends the whole card at rest, which holding the frame at full explode did not', () => {
    /*
     * The bug, and the number is the reported one: 218 nested regions reserved room for an
     * arrangement several times the brain, so the resting map sat in a corner. A frame fitted to
     * what is drawn is by definition the largest one that keeps everything in view, so at rest it
     * *is* the resting fit — where the held frame was a fraction of it.
     *
     * The other side of the same inequality is the trade this makes, and it is worth naming
     * rather than giving a test of its own: the regions do get smaller as they spread. That is
     * what the old behaviour existed to avoid, and the test below is why avoiding it is no
     * longer necessary — a refit hides separation only when the explode is a homothety.
     */
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    const rest = fitFrame(
      regionGeometry(regions).bounds,
      explodedShifts(shifts, 0),
      600,
      400,
      10,
    )
    const held = fitFrame(regionGeometry(regions).bounds, shifts, 600, 400, 10)
    expect(rest.scale).toBeGreaterThan(held.scale)
    expect(rest).toEqual(
      fitFrame(
        regionGeometry(regions).bounds,
        new Float64Array(regions.length * 2),
        600,
        400,
        10,
      ),
    )
  })

  it('is not a homothety, so refitting cannot hide the separation', () => {
    /*
     * The failure the held frame was defending against, asked directly: under a *radial* explode
     * the refitted picture is the resting one to within a scale, so nothing on screen moves. It
     * is asked as the ratio of two inter-centre distances — invariant under any homothety, so a
     * refit cannot rescue it and cannot disguise it either.
     */
    const regions = projectRegions(meshes, 'frontal')
    const shifts = relaxShifts(regions)
    const zero = new Float64Array(regions.length * 2)

    /** The ratio of two inter-centre distances — invariant under any homothety. */
    function shapeRatio(displacements: Float64Array): number {
      const at = (i: number): [number, number] => [
        regions[i]!.centre[0] + (displacements[i * 2] ?? 0),
        regions[i]!.centre[1] + (displacements[i * 2 + 1] ?? 0),
      ]
      const span = (i: number, j: number): number => {
        const [x0, y0] = at(i)
        const [x1, y1] = at(j)
        return Math.hypot(x1 - x0, y1 - y0)
      }
      return span(0, 1) / span(2, 3)
    }

    /** A radial push from the centroid — the explode this viewer used to have. */
    let cx = 0
    let cy = 0
    for (const region of regions) {
      cx += region.centre[0] / regions.length
      cy += region.centre[1] / regions.length
    }
    const radial = new Float64Array(regions.length * 2)
    for (let i = 0; i < regions.length; i++) {
      radial[i * 2] = (regions[i]!.centre[0] - cx) * 0.8
      radial[i * 2 + 1] = (regions[i]!.centre[1] - cy) * 0.8
    }

    // The instrument first: a homothety really does leave this untouched, which is why a refit
    // under the old explode left nothing on screen changing but the size.
    expect(shapeRatio(radial)).toBeCloseTo(shapeRatio(zero), 6)
    // And the relaxation really does not, which is what makes refitting safe here.
    expect(shapeRatio(shifts)).not.toBeCloseTo(shapeRatio(zero), 2)
  })

  it('degrades to an identity frame when there is nothing to frame', () => {
    expect(fitFrame(regionGeometry([]).bounds, new Float64Array(0), 100, 100)).toEqual({
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      // A degenerate scene has degenerate bounds, which `clampRoiWindow` reads as "nothing to
      // pan along" and pins to the centre — so an empty map cannot be dragged off itself.
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    })
  })
})

describe('what a mesh knows about itself', () => {
  /** Unit cube, consistently wound. */
  const cube: MeshGeometry = {
    id: 'cube',
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    indices: new Uint32Array([
      0,
      2,
      1,
      0,
      3,
      2, // bottom
      4,
      5,
      6,
      4,
      6,
      7, // top
      0,
      1,
      5,
      0,
      5,
      4, // front
      2,
      3,
      7,
      2,
      7,
      6, // back
      0,
      4,
      7,
      0,
      7,
      3, // left
      1,
      2,
      6,
      1,
      6,
      5, // right
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

/**
 * The zoom window.
 *
 * A window over the projection rather than a transform over the drawing — the rule
 * `HeatmapViewer` and `DendrogramViewer` both record, and the reason it matters here is that an
 * SVG transform would carry the region names and the stroke widths with it. What that buys is
 * asserted below: the same frame arithmetic, so labels are re-thinned and the export follows.
 *
 * Headless because the component's version of any of this is covered by nothing — jsdom performs
 * no layout.
 */
describe('the zoom window', () => {
  const WIDTH = 600
  const HEIGHT = 400

  /** A square region, which is all `fitFrame` and `autoLabelled` read of one. */
  function square(cx: number, cy: number, r: number, label: string): ProjectedRegion {
    return {
      index: 0,
      label,
      rings: [
        new Float32Array([cx - r, cy - r, cx + r, cy - r, cx + r, cy + r, cx - r, cy + r]),
      ],
      centre: [cx, cy],
      depth: 0,
      radius: r,
    }
  }

  const scene = [square(-200, 0, 150, 'big'), square(200, 0, 5, 'small')]
  const noShift = new Float64Array(scene.length * 2)
  const sceneAreas = regionGeometry(scene).areas
  const fit = fitFrame(regionGeometry(scene).bounds, noShift, WIDTH, HEIGHT, 10)

  it('hands back the fitted frame itself at magnification 1', () => {
    // By identity, which is what lets `zoomed` be a `!==` and the ⤢ button's disabled state
    // agree with the caption without either restating the arithmetic.
    expect(windowFrame(fit, undefined, WIDTH, HEIGHT)).toBe(fit)
    expect(windowFrame(fit, { zoom: 1, cx: 0, cy: 0 }, WIDTH, HEIGHT)).toBe(fit)
  })

  it('holds the point under the pointer still while zooming about it', () => {
    // The whole of what "zoom about the pointer" means, and the half that is silently wrong if
    // the anchor is taken from the fitted frame rather than the current one.
    const at: [number, number] = [420, 130]
    let window = zoomRoiWindow(fit, undefined, at[0], at[1], 0.5, WIDTH, HEIGHT)
    const after = pointToScene(windowFrame(fit, window, WIDTH, HEIGHT), at[0], at[1])
    const before = pointToScene(fit, at[0], at[1])
    expect(after[0]).toBeCloseTo(before[0], 3)
    expect(after[1]).toBeCloseTo(before[1], 3)

    /*
     * And again from a zoomed state, about a *different* pixel — which is the only arrangement
     * that can see the mistake. Anchoring on the fitted frame rather than the current one gives
     * the same answer for every zoom about one unmoving pointer, so a test that scrolls twice in
     * one place passes with the anchor read from the wrong frame.
     */
    const elsewhere: [number, number] = [250, 240]
    const held = pointToScene(
      windowFrame(fit, window, WIDTH, HEIGHT),
      elsewhere[0],
      elsewhere[1],
    )
    window = zoomRoiWindow(fit, window, elsewhere[0], elsewhere[1], 0.5, WIDTH, HEIGHT)
    const moved = pointToScene(
      windowFrame(fit, window, WIDTH, HEIGHT),
      elsewhere[0],
      elsewhere[1],
    )
    expect(moved[0]).toBeCloseTo(held[0], 3)
    expect(moved[1]).toBeCloseTo(held[1], 3)
  })

  it('stops at the magnification ceiling rather than at nothing', () => {
    let window = zoomRoiWindow(fit, undefined, 300, 200, 0.5, WIDTH, HEIGHT)
    for (let i = 0; i < 40; i++)
      window = zoomRoiWindow(fit, window, 300, 200, 0.5, WIDTH, HEIGHT)
    expect(window.zoom).toBe(MAX_ROI_ZOOM)
  })

  it('cannot be panned off the scene', () => {
    /*
     * The bound is per axis and it is what is *left over*: a drag that runs a long way past the
     * edge leaves the scene's own edge at the edge of the box, never an empty card. The failure
     * without it is a map somebody has to zoom out of to find again.
     */
    let window = zoomRoiWindow(fit, undefined, 300, 200, 0.25, WIDTH, HEIGHT)
    window = panRoiWindow(fit, window, -100000, -100000, WIDTH, HEIGHT)
    const frame = windowFrame(fit, window, WIDTH, HEIGHT)
    const [right, bottom] = pointToScene(frame, WIDTH, HEIGHT)
    expect(right).toBeLessThanOrEqual(fit.bounds.maxX + 1e-6)
    expect(bottom).toBeLessThanOrEqual(fit.bounds.maxY + 1e-6)

    window = panRoiWindow(fit, window, 100000, 100000, WIDTH, HEIGHT)
    const [left, top] = pointToScene(windowFrame(fit, window, WIDTH, HEIGHT), 0, 0)
    expect(left).toBeGreaterThanOrEqual(fit.bounds.minX - 1e-6)
    expect(top).toBeGreaterThanOrEqual(fit.bounds.minY - 1e-6)
  })

  it('pins the centre on an axis with nothing to pan along', () => {
    // The scene is wider than it is tall, so at the fit the vertical has slack — and a window
    // free to drift down it would let a fitted map be dragged, which is the gesture that must
    // stay with the regions. This is also what makes magnification 1 reproduce the fit exactly.
    const window = panRoiWindow(fit, { zoom: 1, cx: 0, cy: 0 }, 0, 5000, WIDTH, HEIGHT)
    expect(window.cy).toBeCloseTo((fit.bounds.minY + fit.bounds.maxY) / 2, 6)
  })

  it('re-thins the labels for the window, which is the point of zooming', () => {
    /*
     * Ranked over the whole scene, a magnified card spends its budget on regions that are no
     * longer in the box — so zooming in on a crowded corner showed *fewer* names than the fitted
     * picture. `small` is a thousandth of this scene and half of what is on screen at ×8.
     */
    const atFit = autoLabelled(scene, sceneAreas, noShift, fit, WIDTH, HEIGHT, 18)
    expect(atFit.map((i) => scene[i]!.label)).toEqual(['big'])

    const window = { zoom: MAX_ROI_ZOOM, cx: 200, cy: 0 }
    const frame = windowFrame(fit, window, WIDTH, HEIGHT)
    const zoomed = autoLabelled(scene, sceneAreas, noShift, frame, WIDTH, HEIGHT, 18)
    expect(zoomed.map((i) => scene[i]!.label)).toEqual(['small'])
  })

  it('judges a label where the region is drawn, never where a full explode would put it', () => {
    /*
     * The frame and the thinning read one array (`explodedShifts`), and this is what the two
     * coming apart looks like: a region on screen loses its name because the arrangement it is
     * *not* being drawn in would have put it outside the card.
     *
     * Pinned here rather than on the card, and the reason is worth recording — on the mock
     * connectome the two arrays give the same answer at every setting of the slider, measured at
     * 0/25/50/75/100%, because its six regions are large next to their displacements and no
     * anchor ever leaves the box either way. A component test of this passes whatever the
     * component does.
     */
    const pair = [square(0, 0, 120, 'here'), square(0, 0, 60, 'there')]
    const shifts = new Float64Array([0, 0, 4000, 0])
    const quarter = explodedShifts(shifts, 0.25)
    const frame = fitFrame(regionGeometry(pair).bounds, quarter, WIDTH, HEIGHT, 10)

    expect(
      autoLabelled(pair, regionGeometry(pair).areas, quarter, frame, WIDTH, HEIGHT, 18),
    ).toHaveLength(2)
    expect(
      autoLabelled(pair, regionGeometry(pair).areas, shifts, frame, WIDTH, HEIGHT, 18),
    ).toHaveLength(1)
  })

  it('spends a full budget on the biggest of what is on screen', () => {
    /*
     * The cap rather than the area threshold, and it has to be asked at the *fit* — at ×8 about
     * `small` only one region is on screen at all, so a budget of one binds for the same reason
     * the test above passes and says nothing about ranking.
     */
    // Three regions on screen, a budget of two: the two largest, largest first. (That `small`
    // falls under the area floor at the fit is the test above's, more precisely.)
    const crowd = [
      square(-200, 0, 150, 'big'),
      square(150, 0, 120, 'mid'),
      square(340, 0, 90, 'least'),
    ]
    const none = new Float64Array(crowd.length * 2)
    const frame = fitFrame(regionGeometry(crowd).bounds, none, WIDTH, HEIGHT, 10)
    const picked = autoLabelled(
      crowd,
      regionGeometry(crowd).areas,
      none,
      frame,
      WIDTH,
      HEIGHT,
      2,
    )
    expect(picked.map((i) => crowd[i]!.label)).toEqual(['big', 'mid'])
  })
})
