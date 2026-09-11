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
import { CHART_INK, chartSurface, parseHex } from '../colors'
import {
  DIM_SCALE,
  emphasisSizes,
  AMBIENT_INTENSITY,
  buildPoints,
  buildSkeletonSegments,
  compassLayout,
  detailNote,
  dimFor,
  DIMMED_MIN_CONTRAST,
  framingFor,
  hiddenCount,
  idsForLabel,
  KEY_INTENSITY,
  labelIndex,
  MAX_LINE_WIDTH,
  MIN_LINE_WIDTH,
  neuronAtSegment,
  neuronAtVertex,
  pointerNdc,
  referenceRadius,
  sceneDim,
  sceneLights,
  sceneMode,
  sceneSurface,
  skeletonNote,
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
import type { DimOf } from './viewer3dScene'

const SCHEMA = tableSchema(column('neuronId', 'i64'))

/** The buffers are float32, so an expectation written in doubles never matches exactly. */
const f32 = (rgb: readonly number[]) => [...new Float32Array(rgb)]

/** A colour in linear light — the sRGB transfer written out independently of the implementation. */
const linear = (hex: string) =>
  parseHex(hex).map((byte) => {
    const c = byte / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
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
        {
          id: '1',
          positions: new Float32Array(),
          radii: new Float32Array(),
          parents: new Int32Array(),
        },
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
      expect([...skeletonSegmentWorldWidths(buildSkeletonSegments(chain([1, 2])), 3)!]).toEqual(
        [12, 6],
      )
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
      expect([...skeletonSegmentWorldWidths(buildSkeletonSegments(chain([0, 2])), 1)!]).toEqual(
        [4, 0],
      )
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
      expect(
        skeletonWidthPlan(buildSkeletonSegments(chain([1, 2])), 'radius', scales).fat,
      ).toBe(true)
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
  /*
   * A stand-in for the scene's dimming, with a distinct answer per colour — so what is asserted
   * here is the *wiring* (which colour is dimmed, and through what), and `dimFor` below is where
   * the greys themselves are pinned.
   */
  const DIMS: Record<string, string> = {
    '#ff0000': '#606060',
    '#0000ff': '#404040',
    '#00ff00': '#808080',
  }
  const dim = (hex: string) => DIMS[hex] ?? '#ffffff'
  /** The scene's `dimOf` with these ids selected: every other neuron dims through `dim`. */
  const except =
    (...ids: string[]): DimOf =>
    (id) =>
      ids.includes(id) ? undefined : dim
  const dimmed = (hex: string) => f32(linear(dim(hex)))

  it('writes linear light, which is what three reads a vertex colour as', () => {
    /*
     * The encoded triplet written straight in is encoded a second time on screen: every skeleton
     * drew lighter and greyer than its legend swatch. Pure primaries cannot show it — 0 and 1 are
     * the same in both spaces — so a mid grey is the case: encoded 0.502, linear 0.216.
     */
    const colors = skeletonSegmentColors(built, skeletons(), () => '#808080', undefined)
    expect(colors[0]).toBeCloseTo(0.2158605, 5)
  })

  it('paints both vertices of a segment the same, in its own item colour', () => {
    const colors = skeletonSegmentColors(built, skeletons(), byItem, undefined)
    expect([...colors.slice(0, 6)]).toEqual([1, 0, 0, 1, 0, 0])
    // The third segment belongs to the second neuron.
    expect([...colors.slice(12, 18)]).toEqual([0, 0, 1, 0, 0, 1])
  })

  it('dims everything the selection does not name, and only while there is one', () => {
    const none = skeletonSegmentColors(built, skeletons(), byItem, undefined)
    expect(none[12]).toBe(0)

    const picked = skeletonSegmentColors(built, skeletons(), byItem, except('111'))
    // The selected neuron keeps its colour...
    expect([...picked.slice(0, 3)]).toEqual([1, 0, 0])
    // ...and the other one is its blue, dimmed.
    expect([...picked.slice(12, 15)]).toEqual(dimmed('#0000ff'))
  })

  it('dims each neuron from its own colour, so two deselected neurons stay apart', () => {
    // The point of the rule: one shared grey made every deselected arbour the same mark.
    const neither = skeletonSegmentColors(built, skeletons(), byItem, except('999'))
    expect([...neither.slice(0, 3)]).toEqual(dimmed('#ff0000'))
    expect([...neither.slice(12, 15)]).toEqual(dimmed('#0000ff'))
  })

  it('dims a per-node colour from that colour, not the neuron’s', () => {
    // Topology's compartment channel: the arbour keeps its compartments apart while dimmed.
    const byNode = (item: number, node: number) =>
      item === 0 && node === 2 ? '#00ff00' : undefined
    const colors = skeletonSegmentColors(built, skeletons(), byItem, except('999'), byNode)
    // Segment 1 runs from node 2 of the first neuron; segment 0 from node 1 falls back.
    expect([...colors.slice(6, 9)]).toEqual(dimmed('#00ff00'))
    expect([...colors.slice(0, 3)]).toEqual(dimmed('#ff0000'))
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
    const picked = skeletonSegmentColors(built, wide, byItem, except('720575940622093457'))
    expect([...picked.slice(12, 15)]).toEqual([0, 0, 1])
    // The first is now the dimmed one.
    expect([...picked.slice(0, 3)]).toEqual(dimmed('#ff0000'))
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

  it('writes linear light, as three reads a vertex colour', () => {
    // Same trap as the skeleton buffer; a mid grey is the case primaries cannot show.
    const built = buildPoints(points, () => '#808080')
    expect(built.colors[0]).toBeCloseTo(0.2158605, 5)
  })
})

describe('surfaceStyle', () => {
  it('writes depth when opaque, so a mesh occludes the skeleton inside it', () => {
    const style = surfaceStyle('#aabbcc', 1, undefined)
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
    const style = surfaceStyle('#aabbcc', 0.25, undefined)
    expect(style.transparent).toBe(true)
    expect(style.depthWrite).toBe(false)
  })

  it('dims through the scene’s rule', () => {
    const dim = (hex: string) => (hex === '#aabbcc' ? '#555555' : '#999999')
    const style = surfaceStyle('#aabbcc', 1, dim)
    expect(style.color).toBe('#555555')
    // A dimmed surface has to let the selection show through it, opaque setting or not.
    expect(style.transparent).toBe(true)
    expect(style.opacity).toBeLessThan(1)
  })

  it('never makes a dimmed surface more visible than the setting asked for', () => {
    expect(surfaceStyle('#aabbcc', 0.1, () => '#555555').opacity).toBe(0.1)
  })
})

describe('dimFor', () => {
  /** WCAG relative luminance and CIE L*, written out independently of the implementation. */
  const luminance = (hex: string) => {
    const [r, g, b] = linear(hex)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const lightness = (hex: string) => {
    const y = luminance(hex)
    return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }

  const dark = chartSurface('dark')
  const light = chartSurface('light')
  const onDark = dimFor(dark, CHART_INK.dark.secondary)
  const onLight = dimFor(light, CHART_INK.light.secondary)
  const onBlack = dimFor('#000000', CHART_INK.dark.secondary)
  const HUES = ['#ff5470', '#3ec46d', '#4a9df5', '#d8ff6e', '#7a2b9c', '#ffff00', '#0000ff']
  const EXTREMES = [...HUES, '#000000', '#808080', '#ffffff']

  it('is achromatic', () => {
    for (const dim of [onDark, onLight, onBlack]) {
      for (const hex of EXTREMES) expect(dim(hex)).toMatch(/^#([0-9a-f]{2})\1\1$/)
    }
  })

  it('keeps the lightness order, which is what tells two dimmed neurons apart', () => {
    // Never reversed anywhere, and strictly kept above the floor — yellow, green, pink are all
    // light enough to clear it on a dark ground.
    const byLightness = [...EXTREMES].sort((a, b) => lightness(a) - lightness(b))
    for (const dim of [onDark, onLight]) {
      const out = byLightness.map((hex) => lightness(dim(hex)))
      for (let i = 1; i < out.length; i++)
        expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]! - 0.5)
    }
    expect(lightness(onDark('#ffff00'))).toBeGreaterThan(lightness(onDark('#3ec46d')))
    expect(lightness(onDark('#3ec46d'))).toBeGreaterThan(lightness(onDark('#ff5470')))
    // On a light ground the same three are all near the surface, which is where a floor-and-clamp
    // version piled them onto one grey. Paler still means nearer the surface, and still distinct.
    expect(lightness(onLight('#ffff00'))).toBeGreaterThan(lightness(onLight('#3ec46d')))
    expect(lightness(onLight('#3ec46d'))).toBeGreaterThan(lightness(onLight('#ff5470')))
  })

  it('keeps a dark hue off the floor that black sits on', () => {
    // Pure blue is dark but not the surface; flooring it made it black's grey on a dark ground.
    expect(onDark('#0000ff')).not.toBe(onDark('#000000'))
    expect(lightness(onDark('#0000ff'))).toBeGreaterThan(lightness(onDark('#000000')))
  })

  it('pulls the brightest colour back to the secondary ink, not past it', () => {
    // So nothing deselected outshines the chart's own secondary register — the complaint the
    // luminance-keeping grey drew, where most of a hashed scene dimmed *lighter* than before.
    expect(lightness(onDark('#ffffff'))).toBeCloseTo(lightness(CHART_INK.dark.secondary), 0)
    expect(lightness(onLight('#000000'))).toBeCloseTo(lightness(CHART_INK.light.secondary), 0)
    for (const hex of HUES) {
      expect(lightness(onDark(hex))).toBeLessThanOrEqual(
        lightness(CHART_INK.dark.secondary) + 0.5,
      )
    }
  })

  it('recedes: a colour lighter than the ink dims darker than it was', () => {
    for (const hex of ['#ffff00', '#d8ff6e', '#ffffff']) {
      expect(lightness(onDark(hex))).toBeLessThan(lightness(hex))
    }
  })

  it('never goes under 3:1 against the surface, on any background', () => {
    // A dimmed arbour is still data. Within one 8-bit step of the floor, which rounding can take.
    for (const [dim, surface] of [
      [onDark, dark],
      [onLight, light],
      [onBlack, '#000000'],
    ] as const) {
      for (const hex of EXTREMES) {
        expect(contrast(dim(hex), surface)).toBeGreaterThan(DIMMED_MIN_CONTRAST - 0.05)
      }
    }
  })
})

describe('sceneDim', () => {
  it('dims against the surface the scene is drawn on, not the app’s', () => {
    // A light background pinned under a dark app recedes towards white, by the light ink.
    const pinned = sceneDim('light', 'dark')
    const reference = dimFor(chartSurface('light'), CHART_INK.light.secondary)
    for (const hex of ['#ff0000', '#0000ff', '#ffff00'])
      expect(pinned(hex)).toBe(reference(hex))
    expect(sceneDim('theme', 'dark')('#ffff00')).toBe(
      dimFor(chartSurface('dark'), CHART_INK.dark.secondary)('#ffff00'),
    )
    expect(sceneDim('black', 'light')('#ffff00')).toBe(
      dimFor('#000000', CHART_INK.dark.secondary)('#ffff00'),
    )
  })
})

describe('pointerNdc', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 }

  it('maps the canvas onto −1..1, y up', () => {
    expect(pointerNdc({ x: 200, y: 100 }, rect)).toEqual([0, 0])
    expect(pointerNdc({ x: 100, y: 50 }, rect)).toEqual([-1, 1])
    expect(pointerNdc({ x: 300, y: 150 }, rect)).toEqual([1, -1])
  })

  it('lands the centre of a zoomed card on the centre of its scene', () => {
    /*
     * The card the probe measured: a 590px canvas drawn at pane zoom 0.48, 283.3px on screen.
     * React Three Fiber's default put a click at its centre at offsetX 295 over a size of 283.3,
     * i.e. x ≈ 1.08 — off the edge of the scene, and nothing was picked.
     */
    const zoomed = { left: 1276.3, top: 483.3, width: 283.29, height: 176.61 }
    const [x, y] = pointerNdc({ x: 1276.3 + 283.29 / 2, y: 483.3 + 176.61 / 2 }, zoomed)
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(0, 9)
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

describe('skeletonNote', () => {
  const base = {
    kind: 'skeletons' as const,
    items: [],
    attributes: makeTable(SCHEMA, { neuronId: [] }),
    bounds: BOUNDS,
  }

  it('names the route on the caption, with what it costs behind it', () => {
    // A bigger difference than a mesh's level of detail: a chunk-graph skeleton is a few
    // hundred nodes where a traced one is thousands, and only some routes carry radii — which
    // is what the `to scale` line widths read.
    const note = skeletonNote({
      ...base,
      provenance: { id: 'l2', label: 'level-2 chunk graph', detail: 'One node per chunk.' },
    })
    expect(note?.label).toBe('level-2 chunk graph')
    expect(note?.title).toContain('One node per chunk.')
  })

  it('names the control that changes it', () => {
    const note = skeletonNote({
      ...base,
      provenance: { id: 'neuprint', label: 'neuPrint SWC' },
    })
    expect(note?.title).toContain('Skeletons node')
  })

  it('is absent for a value that names no route', () => {
    expect(skeletonNote(base)).toBeUndefined()
    expect(skeletonNote(undefined)).toBeUndefined()
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

describe('the two sizes a split synapse cloud is drawn at', () => {
  /*
   * These numbers are a measurement, and the measurement is the reason the test exists.
   *
   * Fading the un-emphasised half was reported as broken three times — "fully opaque, and the
   * slider has no effect" — and each time the wiring was correct. Alpha *accumulates*: k
   * overlapping dots at alpha `a` composite to `1 - (1 - a)^k`, so at twenty deep a nominal 0.2
   * reaches 99% coverage and every slider position above it renders the same slab. Rendered at
   * 20,000 points in a real browser, alpha 0.2, 0.5 and 1.0 were indistinguishable.
   *
   * Shrinking the dim half is what gives alpha something to work with, and it is invisible to
   * every other kind of check: `DIM_SCALE` back at 1 draws a picture that is wrong only when you
   * look at a dense neuron, which is why it is pinned here as arithmetic rather than left to the
   * browser pass that found it.
   */
  it('draws the dim half smaller, not merely fainter', () => {
    expect(DIM_SCALE).toBeLessThan(1)
    expect(emphasisSizes(10).dim).toBeLessThan(10)
  })

  it('keeps the lit half larger than the base size, and both apart', () => {
    const { lit, dim } = emphasisSizes(10)
    expect(lit).toBeGreaterThan(10)
    // The ratio is what the eye searches on. 1.5 against 0.6 is 2.5x, well past the ~1.2x that
    // reads as "the same dot, slightly nearer".
    expect(lit / dim).toBeGreaterThan(2)
  })

  it('scales both halves from the caller’s size', () => {
    // Doubling `pointSize` must double both, or the Visuals slider changes the *relationship*
    // between lit and unlit rather than the size of the dots.
    const a = emphasisSizes(6)
    const b = emphasisSizes(12)
    expect(b.lit).toBeCloseTo(a.lit * 2)
    expect(b.dim).toBeCloseTo(a.dim * 2)
  })
})
