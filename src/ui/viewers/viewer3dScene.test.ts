/**
 * The 3D viewer's arithmetic, which is all of it that a test can reach.
 *
 * jsdom has no WebGL, so `Viewer3D.tsx` cannot be rendered here at all — every bug this file
 * is about was invisible to the suite until the maths came out of the components. Three of
 * them were live: a background that only applied on the first frame, a translucent mesh
 * default that made every surface look half-loaded, and a camera framing expressed in
 * absolute nanometres while the scene it framed sat on the origin.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { Bounds3, MeshesValue, PointsValue, SkeletonsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { CHART_INK, chartSurface } from '../colors'
import {
  AMBIENT_INTENSITY,
  buildPoints,
  buildSkeletonSegments,
  compassLayout,
  detailNote,
  DIMMED_HEX,
  DIMMED_RGB,
  framingFor,
  hiddenCount,
  idsForLabel,
  KEY_INTENSITY,
  labelIndex,
  MAX_LINE_WIDTH,
  MIN_LINE_WIDTH,
  neuronAtSegment,
  neuronAtVertex,
  referenceRadius,
  sceneLights,
  sceneMode,
  sceneSurface,
  skeletonSegmentColors,
  skeletonSegmentWidths,
  skeletonSegmentWorldWidths,
  skeletonWidthPlan,
  surfaceStyle,
  toggleHiddenLabel,
  toggleLabelSelection,
  toggleSelection,
  visibilityFor,
} from './viewer3dScene'

const SCHEMA = tableSchema(column('neuronId', 'i64'))

/** The buffers are float32, so an expectation written in doubles never matches exactly. */
const f32 = (rgb: readonly number[]) => [...new Float32Array(rgb)]
const BOUNDS: Bounds3 = { min: [0, 0, 0], max: [100, 40, 20] }

/**
 * Two neurons: a three-point chain and a two-point stub — four points, two segments.
 *
 * Deliberately uneven, because a fixture where both items have the same segment count cannot
 * tell a correct `segmentItem` from an off-by-one one.
 */
function skeletons(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '111',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
        radii: new Float32Array([1, 1, 1]),
        parents: new Int32Array([-1, 0, 1]),
      },
      {
        id: '222',
        positions: new Float32Array([10, 0, 0, 11, 0, 0]),
        radii: new Float32Array([1, 1]),
        parents: new Int32Array([-1, 0]),
      },
    ],
    attributes: makeTable(SCHEMA, { neuronId: [111, 222] }),
    bounds: BOUNDS,
  }
}

describe('buildSkeletonSegments', () => {
  it('emits one segment per parented point, and none for a root', () => {
    const built = buildSkeletonSegments(skeletons())
    // 2 + 1, not 3 + 2: a root has no parent to draw a line to.
    expect(built.segments).toBe(3)
    expect(built.positions).toHaveLength(3 * 6)
  })

  it('writes both endpoints of a segment, child then parent', () => {
    const built = buildSkeletonSegments(skeletons())
    expect([...built.positions.slice(0, 6)]).toEqual([1, 0, 0, 0, 0, 0])
  })

  it('keeps the segment→item map, which is the whole reason to flatten', () => {
    const built = buildSkeletonSegments(skeletons())
    expect([...built.segmentItem]).toEqual([0, 0, 1])
  })

  it('survives a skeleton with nothing in it', () => {
    const empty: SkeletonsValue = {
      ...skeletons(),
      items: [
        { id: '1', positions: new Float32Array(), radii: new Float32Array(), parents: new Int32Array() },
      ],
    }
    expect(buildSkeletonSegments(empty).segments).toBe(0)
  })
})

/**
 * A chain of `radii.length` points, each parented to the one before it.
 *
 * Written as a helper because every width case is about the *distribution* of radii and about
 * nothing else — a fixture that also varied the branching would make it unclear which of the
 * two a failure was about.
 */
function chain(radii: number[]): SkeletonsValue {
  const positions = new Float32Array(radii.length * 3)
  const parents = new Int32Array(radii.length)
  for (let i = 0; i < radii.length; i++) {
    positions[i * 3] = i
    parents[i] = i - 1
  }
  return {
    kind: 'skeletons',
    items: [{ id: '1', positions, radii: new Float32Array(radii), parents }],
    attributes: makeTable(SCHEMA, { neuronId: [1] }),
    bounds: BOUNDS,
  }
}

describe('line widths from radii', () => {
  describe('buildSkeletonSegments', () => {
    it('carries the radius of each endpoint, in the order it writes the endpoints', () => {
      // Child then parent, matching `positions` — the two buffers are read by one shader and
      // an order that disagreed would taper every segment backwards.
      const built = buildSkeletonSegments(chain([1, 2, 3]))
      expect([...built.segmentRadii]).toEqual([2, 1, 3, 2])
    })
  })

  describe('referenceRadius', () => {
    it('takes the p95, so one fat node cannot flatten everything else to the floor', () => {
      /*
       * The failure this is about: scaling against the *maximum* lets a single bad radius —
       * a soma, a mis-traced node, a CAVE chunk whose `max_dt_nm` ran away — decide how wide
       * every other node is drawn. Nineteen endpoints at 1 and one at 100; the reference has
       * to be 1, or the arbour draws at 1/100th of the setting and the mode looks broken.
       */
      const built = buildSkeletonSegments(chain([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100]))
      expect(referenceRadius(built)).toBe(1)
    })

    it('is 0 when nothing has a positive radius, which is a real source and not an error', () => {
      // CATMAID stores −1 for "unset" and the source clamps it to 0; a CAVE L2 chunk too
      // small to have a `max_dt_nm` is 0 as well.
      expect(referenceRadius(buildSkeletonSegments(chain([0, 0, 0])))).toBe(0)
    })

    it('sorts numerically, not as text', () => {
      // `Float32Array.sort` does; a plain `Array.sort` would put 100 before 9 and pick the
      // p95 out of a differently-ordered list.
      const built = buildSkeletonSegments(chain([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 100]))
      expect(referenceRadius(built)).toBe(9)
    })

    it('sees only what is drawn, so hiding the thick neuron rescales the rest', () => {
      const thin = chain([1, 1, 1])
      const two: SkeletonsValue = {
        ...thin,
        items: [...thin.items, { ...chain([50, 50, 50]).items[0]!, id: '2' }],
        attributes: makeTable(SCHEMA, { neuronId: [1, 2] }),
      }
      expect(referenceRadius(buildSkeletonSegments(two))).toBe(50)
      expect(referenceRadius(buildSkeletonSegments(two, (i) => i === 0))).toBe(1)
    })
  })

  describe('skeletonSegmentWidths', () => {
    it('draws the reference node at the setting, and the rest in proportion', () => {
      const built = buildSkeletonSegments(chain([1, 2]))
      // One segment, endpoints [2, 1]; the p95 of two values is the larger, so 2 is the
      // reference and lands on the scale exactly.
      expect([...skeletonSegmentWidths(built, 4)!]).toEqual([4, 2])
    })

    it('floors a zero radius rather than drawing nothing there', () => {
      /*
       * Below a pixel a line is not reliably drawn at all, so an unset radius would take the
       * twigs off the picture entirely — which reads as a fetch that returned only trunks
       * rather than as a width setting.
       */
      const widths = skeletonSegmentWidths(buildSkeletonSegments(chain([0, 2])), 4)!
      expect([...widths]).toEqual([4, MIN_LINE_WIDTH])
    })

    it('ceilings the tail beyond the reference', () => {
      const built = buildSkeletonSegments(chain([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100]))
      const widths = skeletonSegmentWidths(built, 4)!
      // 4 × 100 / 1 is 400 pixels of quad across a card that is 600 wide.
      expect(Math.max(...widths)).toBe(MAX_LINE_WIDTH)
      expect(Math.min(...widths)).toBe(4)
    })

    it('declines rather than returning a buffer of floors when there are no radii', () => {
      /*
       * The caller reads `undefined` as "use the uniform path". A buffer of 1s would draw the
       * same picture as a hairline at four times the vertex data — the fat path's whole cost
       * for none of its benefit.
       */
      expect(skeletonSegmentWidths(buildSkeletonSegments(chain([0, 0, 0])), 4)).toBeUndefined()
    })
  })

  describe('skeletonSegmentWorldWidths', () => {
    it('is the diameter, in the scene’s own units, with nothing rescaled', () => {
      const built = buildSkeletonSegments(chain([1, 2]))
      // The same fixture the pixel mode maps onto [4, 2] against its p95. Here 2 and 1 are
      // radii in nanometres and come out as diameters, untouched by any reference.
      expect([...skeletonSegmentWorldWidths(built, 1)!]).toEqual([4, 2])
    })

    it('multiplies rather than targeting a width', () => {
      expect([...skeletonSegmentWorldWidths(buildSkeletonSegments(chain([1, 2])), 3)!]).toEqual([
        12, 6,
      ])
    })

    it('does not ceiling the tail, because a wide neurite really is wide', () => {
      /*
       * The opposite decision from the pixel mode's `MAX_LINE_WIDTH`, and it follows from what
       * the number means: 200 px of quad is a rendering problem, where 100 nm across a scene
       * measured in nanometres is the soma. Clamping it would draw a lie to scale.
       */
      const built = buildSkeletonSegments(chain([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100]))
      expect(Math.max(...skeletonSegmentWorldWidths(built, 1)!)).toBe(200)
    })

    it('leaves an unmeasured node at zero for the shader’s pixel floor to catch', () => {
      /*
       * Deliberately not `MIN_LINE_WIDTH`'s counterpart: a floor in nanometres is a floor at
       * one zoom level and nothing at any other. `MIN_WORLD_PIXELS` applies it per vertex in
       * the shader, where the projection is known.
       */
      expect([...skeletonSegmentWorldWidths(buildSkeletonSegments(chain([0, 2])), 1)!]).toEqual([
        4, 0,
      ])
    })

    it('never returns a negative width, because CATMAID writes −1 for unmeasured', () => {
      // A negative diameter extrudes the box inside out, which draws as a hole rather than as
      // a thin line.
      const built = buildSkeletonSegments(chain([-1, 2]))
      expect(Math.min(...skeletonSegmentWorldWidths(built, 1)!)).toBe(0)
    })

    it('declines on the same skeletons the pixel mode declines on', () => {
      // Both ask `referenceRadius`, so the two modes fall back to the uniform path together
      // rather than one of them drawing an invisible scene.
      expect(
        skeletonSegmentWorldWidths(buildSkeletonSegments(chain([0, 0, 0])), 1),
      ).toBeUndefined()
    })
  })

  describe('skeletonWidthPlan', () => {
    const scales = { uniform: 1, radius: 4, world: 2 }

    it('gives each mode its own scale, in its own space', () => {
      const built = buildSkeletonSegments(chain([1, 2]))
      expect(skeletonWidthPlan(built, 'uniform', scales)).toMatchObject({
        widths: undefined,
        uniform: 1,
        worldUnits: false,
        fat: false,
      })
      expect(skeletonWidthPlan(built, 'radius', scales)).toMatchObject({
        uniform: 4,
        worldUnits: false,
        fat: true,
      })
      // The p95 diameter, not the multiplier: `LineSegments2.raycast` measures its pick
      // corridor from this, so a 2 handed to a world-units material would make a scene 10^5 nm
      // across pickable only within two nanometres.
      expect(skeletonWidthPlan(built, 'world', scales)).toMatchObject({
        uniform: 8,
        worldUnits: true,
        fat: true,
      })
    })

    it('never reports world units without the buffer that makes them safe', () => {
      /*
       * The invariant the whole function exists for. Falling back to the stock `LineMaterial`
       * leaves three's unpatched fragment shader in place, whose view ray is 100 µm long in a
       * scene measured in nanometres — so a world-units material without our patch draws the
       * arbour and then loses it whole on zoom-out. Deriving the flag from the buffer rather
       * than from the mode is what makes that unreachable.
       */
      const none = buildSkeletonSegments(chain([0, 0, 0]))
      const plan = skeletonWidthPlan(none, 'world', scales)
      expect(plan.widths).toBeUndefined()
      expect(plan.worldUnits).toBe(false)
      // And it lands on the uniform width, in pixels, rather than on the world multiplier.
      expect(plan.uniform).toBe(scales.uniform)
      for (const mode of ['uniform', 'radius', 'world'] as const) {
        const p = skeletonWidthPlan(none, mode, scales)
        expect(p.worldUnits && p.widths === undefined, mode).toBe(false)
      }
    })

    it('keeps a width of 1 on the hairline path, and any taper off it', () => {
      // A fat line of width 1 everywhere is the hairline picture at four times the vertex data.
      const none = buildSkeletonSegments(chain([0, 0, 0]))
      expect(skeletonWidthPlan(none, 'uniform', scales).fat).toBe(false)
      expect(skeletonWidthPlan(none, 'uniform', { ...scales, uniform: 2 }).fat).toBe(true)
      expect(skeletonWidthPlan(buildSkeletonSegments(chain([1, 2])), 'radius', scales).fat).toBe(
        true,
      )
    })
  })
})

describe('sceneLights', () => {
  it('scales both lights by one number, keeping the ratio', () => {
    // The ratio is the look — how much shape a surface shows — and it was chosen once against
    // the palette. A slider that could change it would be a second, harder decision.
    const one = sceneLights(1)
    expect(one).toEqual({ ambient: AMBIENT_INTENSITY, key: KEY_INTENSITY })
    const half = sceneLights(0.5)
    expect(half.ambient / half.key).toBeCloseTo(one.ambient / one.key, 10)
    expect(half.ambient).toBeCloseTo(AMBIENT_INTENSITY / 2, 10)
  })

  it('falls back to the calibrated pair rather than to darkness', () => {
    /*
     * This reads a stored param, so the bad inputs are a graph saved by an older build and a
     * hand-edited share link — and the failure to avoid is a canvas that opens black, which
     * looks like a viewer that did not load rather than like a setting.
     */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(sceneLights(bad), String(bad)).toEqual({
        ambient: AMBIENT_INTENSITY,
        key: KEY_INTENSITY,
      })
    }
  })

  it('lets a deliberate zero be zero', () => {
    // 0 is not in the slider's range, but it is a legitimate number to ask for and it is not
    // the same case as `NaN`: nothing is being recovered from.
    expect(sceneLights(0)).toEqual({ ambient: 0, key: 0 })
  })
})

describe('skeletonSegmentColors', () => {
  const built = buildSkeletonSegments(skeletons())
  const byItem = (index: number) => (index === 0 ? '#ff0000' : '#0000ff')

  it('paints both vertices of a segment the same, in its own item colour', () => {
    const colors = skeletonSegmentColors(built, skeletons(), byItem, new Set())
    expect([...colors.slice(0, 6)]).toEqual([1, 0, 0, 1, 0, 0])
    // The third segment belongs to the second neuron.
    expect([...colors.slice(12, 18)]).toEqual([0, 0, 1, 0, 0, 1])
  })

  it('dims everything the selection does not name, and only while there is one', () => {
    const none = skeletonSegmentColors(built, skeletons(), byItem, new Set())
    expect(none[12]).toBe(0)

    const picked = skeletonSegmentColors(built, skeletons(), byItem, new Set(['111']))
    // The selected neuron keeps its colour...
    expect([...picked.slice(0, 3)]).toEqual([1, 0, 0])
    // ...and the other one takes the palette grey rather than its blue.
    expect([...picked.slice(12, 15)]).toEqual(f32(DIMMED_RGB))
  })

  it('selects on the geometry id, which is text', () => {
    // The ids here are 18 digits apart only in their last one: held as numbers they would be
    // the same float, which is invariant 8's failure and a silently empty selection on CAVE.
    const wide: SkeletonsValue = {
      ...skeletons(),
      items: [
        { ...skeletons().items[0]!, id: '720575940622093456' },
        { ...skeletons().items[1]!, id: '720575940622093457' },
      ],
    }
    const picked = skeletonSegmentColors(built, wide, byItem, new Set(['720575940622093457']))
    expect([...picked.slice(12, 15)]).toEqual([0, 0, 1])
    // The first is now the dimmed one.
    expect([...picked.slice(0, 3)]).toEqual(f32(DIMMED_RGB))
  })
})

describe('neuronAtVertex', () => {
  const built = buildSkeletonSegments(skeletons())
  const value = skeletons()

  it('maps a hit vertex back through the segment it belongs to', () => {
    // Two vertices per segment, so 0 and 1 are the first segment and 5 is the third.
    expect(neuronAtVertex(built, value, 0)).toBe('111')
    expect(neuronAtVertex(built, value, 1)).toBe('111')
    expect(neuronAtVertex(built, value, 5)).toBe('222')
  })

  it('reads a segment index directly, which is what a fat line reports', () => {
    // The two renderers disagree about what a hit *is*: `LineSegments` gives a vertex, of which
    // there are two per segment, and `LineSegments2` gives the segment as a `faceIndex`.
    // Converting at the call site is how the two paths end up off by a factor of two.
    expect(neuronAtSegment(built, value, 0)).toBe('111')
    expect(neuronAtSegment(built, value, 2)).toBe('222')
    expect(neuronAtVertex(built, value, 4)).toBe(neuronAtSegment(built, value, 2))
    expect(neuronAtSegment(built, value, undefined)).toBeUndefined()
    expect(neuronAtSegment(built, value, 99)).toBeUndefined()
  })

  it('declines rather than guessing when the raycast named no vertex', () => {
    expect(neuronAtVertex(built, value, undefined)).toBeUndefined()
    expect(neuronAtVertex(built, value, 999)).toBeUndefined()
  })
})

describe('toggleSelection', () => {
  it('adds what is missing and removes what is there', () => {
    expect(toggleSelection([], '5')).toEqual(['5'])
    expect(toggleSelection(['5', '6'], '5')).toEqual(['6'])
  })
})

describe('buildPoints', () => {
  const points: PointsValue = {
    kind: 'points',
    positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    attributes: makeTable(SCHEMA, { neuronId: [1, 2, 3] }),
    bounds: BOUNDS,
  }
  const byRow = (i: number) => ['#ffffff', '#000000', '#ff0000'][i]!

  it('is per point, because a synapse row is its own thing', () => {
    const built = buildPoints(points, byRow)
    expect(built.count).toBe(3)
    expect([...built.colors.slice(0, 6)]).toEqual([1, 1, 1, 0, 0, 0])
  })

  it('drops a hidden point and its colour together', () => {
    // The two buffers are index-aligned on one geometry: filtering positions but not colours
    // paints every surviving synapse in a different one's colour.
    const built = buildPoints(points, byRow, (i) => i !== 1)
    expect(built.count).toBe(2)
    expect([...built.positions]).toEqual([0, 0, 0, 2, 2, 2])
    expect([...built.colors]).toEqual([1, 1, 1, 1, 0, 0])
  })
})

describe('surfaceStyle', () => {
  it('writes depth when opaque, so a mesh occludes the skeleton inside it', () => {
    const style = surfaceStyle('#aabbcc', 1, false)
    expect(style).toEqual({
      color: '#aabbcc',
      opacity: 1,
      transparent: false,
      depthWrite: true,
    })
  })

  it('stops writing depth as soon as it is translucent', () => {
    // Otherwise whichever triangle draws first hides the ones behind it and a neuron reads as
    // a pile of facets. This is the pair that has to move together — the bug was one opacity
    // default away from being permanent.
    const style = surfaceStyle('#aabbcc', 0.25, false)
    expect(style.transparent).toBe(true)
    expect(style.depthWrite).toBe(false)
  })

  it('dims to the palette grey rather than to a hex nobody can find', () => {
    const style = surfaceStyle('#aabbcc', 1, true)
    expect(style.color).toBe(DIMMED_HEX)
    expect(DIMMED_HEX).toBe(CHART_INK.dark.muted)
    // A dimmed surface has to let the selection show through it, opaque setting or not.
    expect(style.transparent).toBe(true)
    expect(style.opacity).toBeLessThan(1)
  })

  it('never makes a dimmed surface more visible than the setting asked for', () => {
    expect(surfaceStyle('#aabbcc', 0.1, true).opacity).toBe(0.1)
  })
})

describe('framingFor', () => {
  it('frames the recentred scene, not the coordinates it arrived in', () => {
    // The viewer draws everything at −centre, so a camera placed at the bounding box's own
    // coordinates would be one whole brain away from what it is meant to be looking at — and
    // the compass, which measures its snap radius from the world origin, would follow it there.
    const framing = framingFor({ min: [1000, 1000, 1000], max: [1100, 1100, 1100] })
    expect(framing.center).toEqual([1050, 1050, 1050])
    expect(framing.position[0]).toBe(0)
    expect(framing.position[1]).toBe(0)
    expect(framing.position[2]).toBeGreaterThan(0)
  })

  it('scales the clip planes to the scene, because nanometres are big', () => {
    const framing = framingFor(BOUNDS)
    expect(framing.size).toBe(100)
    expect(framing.near).toBe(0.1)
    expect(framing.far).toBe(4000)

    const brain = framingFor({ min: [0, 0, 0], max: [500000, 250000, 250000] })
    // A fixed near plane would spend the depth buffer on the first micron and z-fight.
    expect(brain.near).toBe(500)
  })

  it('has an answer for a scene with no bounds at all', () => {
    const framing = framingFor(undefined)
    expect(framing.center).toEqual([0, 0, 0])
    expect(framing.size).toBe(1)
    expect(Number.isFinite(framing.far)).toBe(true)
  })
})

describe('background', () => {
  it('pins the surface, and reads it off the theme rather than a hex', () => {
    expect(sceneSurface('dark', 'light')).toBe(chartSurface('dark'))
    expect(sceneSurface('light', 'dark')).toBe(chartSurface('light'))
  })

  it('follows the app when it is asked to', () => {
    expect(sceneSurface('theme', 'light')).toBe(chartSurface('light'))
    expect(sceneSurface('theme', 'dark')).toBe(chartSurface('dark'))
  })

  it('takes the ink with it, or a pinned light canvas gets black-on-black labels', () => {
    expect(sceneMode('light', 'dark')).toBe('light')
    expect(sceneMode('theme', 'dark')).toBe('dark')
  })

  it('offers a real black, which is not the dark theme', () => {
    // `#1a1a19` is a *surface*; a figure cut out on a page wants the actual colour. So this one
    // names a hex where the others name a mode — and still reads as dark for the ink.
    expect(sceneSurface('black', 'light')).toBe('#000000')
    expect(sceneSurface('black', 'light')).not.toBe(chartSurface('dark'))
    expect(sceneMode('black', 'light')).toBe('dark')
  })
})

describe('detailNote', () => {
  const base: MeshesValue = {
    kind: 'meshes',
    items: [],
    attributes: makeTable(SCHEMA, { neuronId: [] }),
    bounds: BOUNDS,
  }

  it('says which level, when the source published levels', () => {
    const note = detailNote({ ...base, detail: { lod: 2, levels: 4, triangles: 12345 } })
    expect(note?.label).toBe('mesh LOD 2/3')
    expect(note?.title).toContain('0 is finest')
    expect(note?.title).toContain('12,345')
  })

  it('says simplified instead, where naming a level would report "0 of 0"', () => {
    const note = detailNote({
      ...base,
      detail: { lod: 0, levels: 0, triangles: 900, decimated: true },
    })
    expect(note?.label).toBe('meshes simplified')
    expect(note?.title).not.toContain('level 0 of')
  })

  it('names the control that changes it, either way', () => {
    for (const detail of [
      { lod: 1, levels: 3, triangles: 10 },
      { lod: 0, levels: 0, triangles: 10, decimated: true },
    ]) {
      expect(detailNote({ ...base, detail })?.title).toContain('Detail')
    }
  })

  it('is absent for a source that publishes nothing about it', () => {
    expect(detailNote(base)).toBeUndefined()
    expect(detailNote(undefined)).toBeUndefined()
  })
})

describe('the interactive legend', () => {
  const labelAt = (i: number) => ['LC4', 'LC6', 'LC4'][i]
  const items = [{ id: '111' }, { id: '222' }, { id: '333' }]

  describe('visibilityFor', () => {
    it('hides the rows under a hidden key and nothing else', () => {
      const visible = visibilityFor(labelAt, new Set(['LC6']))
      expect([0, 1, 2].map(visible)).toEqual([true, false, true])
    })

    it('shows everything when nothing is hidden', () => {
      expect(visibilityFor(labelAt, new Set())(1)).toBe(true)
    })

    it('shows everything when the encoding has no keys at all', () => {
      // Constant, sequential and literal encodings have no legend, so there is no name the
      // hidden list could be referring to. Refusing to draw them would be hiding by a name
      // nobody chose.
      expect(visibilityFor(undefined, new Set(['LC6']))(1)).toBe(true)
    })

    it('counts what it removed, because the caption has to admit it', () => {
      const visible = visibilityFor(labelAt, new Set(['LC4']))
      expect(hiddenCount(3, visible)).toBe(2)
    })
  })

  describe('idsForLabel', () => {
    it('collects the geometry ids under one key', () => {
      expect(idsForLabel(items, labelAt, 'LC4')).toEqual(['111', '333'])
    })

    it('has nothing to offer for a channel with no keys', () => {
      expect(idsForLabel(items, undefined, 'LC4')).toEqual([])
    })

    it('indexes every key in one pass, which is what the legend actually asks for', () => {
      /*
       * `idsForLabel` walks the whole list per label. The legend asks per *key*, and under the
       * `hash` encoding a key is a neuron — so twelve keys over five hundred skeletons was six
       * thousand `labelAt` calls per render before this existed.
       */
      const index = labelIndex(items, labelAt)
      expect(index.get('LC4')).toEqual(['111', '333'])
      expect(index.get('LC6')).toEqual(['222'])
      expect(index.get('nothing')).toBeUndefined()
    })

    it('skips an item with no id, which cannot be selected anyway', () => {
      // Keying it under an empty string would give the legend a key that reports a selection
      // never arriving.
      const withBlank = [{ id: '' }, { id: '222' }]
      expect([...labelIndex(withBlank, () => 'LC4').entries()]).toEqual([['LC4', ['222']]])
    })
  })

  describe('toggleLabelSelection', () => {
    it('selects a whole key at once', () => {
      expect(toggleLabelSelection([], ['111', '333'])).toEqual(['111', '333'])
    })

    it('fills in the rest when only some of the key was picked by hand', () => {
      // "Again" has to mean *all of them are selected*, or a key half-picked in the scene
      // loses that work on the click that was meant to complete it.
      expect(toggleLabelSelection(['111'], ['111', '333'])).toEqual(['111', '333'])
    })

    it('lets the key go once every one of its ids is in', () => {
      expect(toggleLabelSelection(['9', '111', '333'], ['111', '333'])).toEqual(['9'])
    })

    it('leaves the selection alone for a key that addresses nothing', () => {
      expect(toggleLabelSelection(['9'], [])).toEqual(['9'])
    })
  })

  describe('toggleHiddenLabel', () => {
    const all = ['LC4', 'LC6', 'T4']

    it('hides one key and shows it again', () => {
      expect(toggleHiddenLabel([], all, 'LC6', false)).toEqual(['LC6'])
      expect(toggleHiddenLabel(['LC6'], all, 'LC6', false)).toEqual([])
    })

    it('solo hides every other key', () => {
      expect(toggleHiddenLabel([], all, 'LC6', true).sort()).toEqual(['LC4', 'T4'])
    })

    it('solo on an already-soloed key restores everything, so the gesture is its own undo', () => {
      expect(toggleHiddenLabel(['LC4', 'T4'], all, 'LC6', true)).toEqual([])
    })

    it('solo from a partly-hidden state isolates rather than toggling back', () => {
      expect(toggleHiddenLabel(['LC4'], all, 'LC6', true).sort()).toEqual(['LC4', 'T4'])
    })
  })
})

describe('compassLayout', () => {
  const overlay = { width: 1472, height: 750 }
  const card = { width: 462, height: 185 }

  it('halves the gizmo on a card, because it is sized in pixels rather than in canvas', () => {
    // The same 40px object in a picture a quarter the size reads as three times the mark.
    expect(compassLayout(false, overlay).scale).toBe(40)
    expect(compassLayout(true, card).scale).toBe(20)
  })

  it('keeps the inset clear of the arms at every size', () => {
    for (const [compact, size] of [
      [false, overlay],
      [true, card],
      [true, { width: 200, height: 90 }],
    ] as const) {
      const { scale, margin } = compassLayout(compact, size)
      expect(margin[0]).toBeGreaterThanOrEqual(scale * 0.7)
      expect(margin[1]).toBeGreaterThanOrEqual(scale * 0.7)
    }
  })

  it('pulls the inset in on a short preview rather than parking the compass in the middle', () => {
    // drei's default is a flat 80px from each edge, which on a 90px-tall canvas is the centre.
    const short = compassLayout(true, { width: 200, height: 90 })
    expect(short.margin[1]).toBeLessThan(45)
  })
})
