/**
 * Everything the 3D viewer computes that is not a three.js object.
 *
 * `Viewer3D.tsx` is a `<Canvas>` and a handful of components; jsdom has no WebGL and never
 * will here, so anything left inside those components is covered by nothing at all. That is
 * the same split `networkDraw.ts` and `roiStyle.ts` record, and it is why the segment
 * builder, the colour buffers, the camera framing and the material decision live out here
 * where a test can call them.
 *
 * Nothing in this file imports three.js. The buffers it returns are plain typed arrays that
 * a `BufferAttribute` wraps without copying.
 */

import type { Bounds3, MeshesValue, PointsValue, SkeletonsValue } from '../../core/values'
import { boundsCenter, boundsSize } from '../../core/values'
import { CHART_INK, chartSurface } from '../colors'
import type { Mode } from '../colors'
import { hexToRgbFloat } from '../encoding'

/** How the scene's background is chosen. `theme` follows the app; the others pin it. */
export type BackgroundChoice = 'theme' | 'dark' | 'light' | 'black'

/**
 * Where a skeleton's line width comes from, and in which space it is measured.
 *
 * `uniform` is one number for the whole scene — the setting `Line width` has always been.
 * The other two both read `SkeletonGeometry.radii`, so a neurite is drawn at the calibre it
 * was traced or segmented at, and they differ in what the number *means*:
 *
 *  - `radius` is in **pixels**. Radii are rescaled so the p95 node lands on the width you set
 *    and everything else is proportional to it, clamped into a range that stays legible. The
 *    arbour looks the same at every zoom level, which is what you want when the picture is of
 *    the branching pattern.
 *  - `world` is in **nanometres**, the scene's own units, so a 200 nm neurite is 200 nm wide
 *    and thickens as you zoom in. Nothing is rescaled and nothing is clamped: this is the
 *    calibre as published, and the only honest one to measure off a screenshot.
 *
 * pygfx spells the same pair `thickness_mode` (uniform vs per-vertex) and `thickness_space`
 * (screen vs world); Coda folds them into one picker because the useful combinations are
 * these three and `uniform` in world units is not one of them.
 */
export type SkeletonWidthMode = 'uniform' | 'radius' | 'world'

/**
 * The colour a dimmed item takes while something else is selected.
 *
 * Read off the palette rather than written as a hex: `CHART_INK.muted` is the achromatic grey
 * every other viewer dims to, and it is the one colour guaranteed never to collide with a
 * categorical slot. It was a literal `#6a6a66` and a literal `[0.42, 0.42, 0.4]` — two
 * spellings of nearly the same grey, in one file, neither reachable from a palette change.
 */
export const DIMMED_HEX = CHART_INK.dark.muted
export const DIMMED_RGB: [number, number, number] = hexToRgbFloat(DIMMED_HEX)

/**
 * Which surface colour the scene clears to.
 *
 * Every branch goes through `chartSurface`: the explicit ones name a *mode* rather than a
 * hex, or "dark" here and the dark theme could drift apart with nothing to catch it.
 */
export function sceneSurface(background: BackgroundChoice, mode: Mode): string {
  // `black` is the one that is not a *theme*: the dark surface is `#1a1a19`, and a figure cut
  // out on a page wants the real thing. So it names a hex where the others name a mode.
  if (background === 'black') return '#000000'
  return chartSurface(background === 'theme' ? mode : background)
}

/**
 * The mode the *scene* is in, which is not always the mode the app is in.
 *
 * Pinning the background to light while the app is dark flips what counts as ink in there —
 * the compass labels, and anything else drawn over the surface rather than over the data.
 */
export function sceneMode(background: BackgroundChoice, mode: Mode): Mode {
  if (background === 'theme') return mode
  return background === 'light' ? 'light' : 'dark'
}

/**
 * The two lights, both raised 50% from the 0.85 / 0.6 they sat at since the viewer was written.
 *
 * The reason is a debt from `flat`. Dropping ACES tone mapping was forced — the curve is applied
 * per *material* in the ordinary path and per *image* through a composer, so switching AO on
 * darkened the background of a scene it had not touched — but it also took the curve's shoulder
 * off the geometry, and ACES lifts exactly the midtones a rough dielectric spends most of its
 * range in. The same mesh pixel went `#71a430` to `#61962d` at the time, and the surfaces have
 * read muted since. Raising the lights pays that back where it was lost, rather than putting a
 * curve back over the background.
 *
 * Measured on four opaque optic-lobe meshes, AO off, over ~23,000 surface pixels — with the
 * compass gizmo masked out, because it is unlit UI drawn over the canvas and was contributing
 * every "clipped" pixel in the first pass:
 *
 * | | 0.85 / 0.6 | 1.275 / 0.9 |
 * | --- | --- | --- |
 * | mean surface | `#82513a` | `#985f44` |
 * | mean luminance | 89.9 | 105.1 |
 * | brightest surface | `#b5b437` | `#d9d744` |
 * | highest channel | 181 | 217 |
 * | clipped pixels | 0 | 0 |
 *
 * **50% more light is 17% more pixel, and that is the sRGB curve rather than a mistake.** The
 * renderer works in linear light and the framebuffer is encoded: 1.5× radiance is 1.5^(1/2.2) ≈
 * 1.20× in the values a screenshot reads, and 1.17 is what came back. Anybody asking why the
 * numbers moved less than the setting has found this, not a bug.
 *
 * The ceiling is the thing to re-check if these go up again. `NoToneMapping` *clips* at 1.0
 * where a curve would roll off, so light that overshoots does not brighten a surface — it
 * desaturates it toward white and takes it out of the validated palette. At these intensities
 * the brightest surface channel is 217, so there is real headroom — and it is now measured
 * rather than assumed: nothing on these meshes saturates until the `Light intensity` slider
 * reaches 1.5, i.e. an effective ambient of 1.91. Its param records the rest of that curve.
 */
export const AMBIENT_INTENSITY = 1.275
export const KEY_INTENSITY = 0.9

/**
 * Both lights scaled by the `Light intensity` slider, which is one number and not two.
 *
 * The *ratio* between the fill and the key is a look — it decides how much shape a surface
 * shows — and it was chosen once, against the palette. Exposing it as a second slider would
 * offer everyone the job of re-deciding it, and the useful control is the one thing the AO
 * work left wrong: overall level.
 *
 * 1 is the calibrated pair. Above it the ceiling starts to matter and the slider's help says
 * where; see `AMBIENT_INTENSITY` for why `NoToneMapping` makes that a real edge rather than a
 * gradual one. A non-finite or negative value falls back to 1 rather than to darkness — this
 * reads a stored param, and a graph that reopens black looks like a broken viewer.
 */
export function sceneLights(intensity: number): { ambient: number; key: number } {
  const scale = Number.isFinite(intensity) && intensity >= 0 ? intensity : 1
  return { ambient: AMBIENT_INTENSITY * scale, key: KEY_INTENSITY * scale }
}

// ---------------------------------------------------------------------------
// Skeletons

export interface SkeletonSegments {
  /** Two endpoints per segment, xyz interleaved: `segments * 6` entries. */
  positions: Float32Array
  /**
   * The radius each endpoint arrived with, child then parent: `segments * 2` entries.
   *
   * Raw nanometres, exactly as the source published them — the mapping to a *drawn* width is
   * `skeletonSegmentWidths`, and the two are separate for the same reason colour is a separate
   * pass from geometry: changing how wide a median neurite is drawn must not rebuild positions.
   *
   * Carried here rather than looked up later because this is the one walk that knows which
   * point an endpoint came from. `SkeletonSegments` is a flattened soup; recovering `i` and
   * `parent` from it afterwards would mean storing an index per endpoint to save a float.
   */
  segmentRadii: Float32Array
  /** Which item each segment belongs to, for picking and for colouring. */
  segmentItem: Int32Array
  /**
   * Which *node* of that item each segment runs from — the child end.
   *
   * Carried for the same reason `segmentRadii` is: this walk is the only place that knows the
   * index, and recovering it afterwards from a flattened soup means storing it anyway. It exists
   * for per-node colour channels (Neuron Topology's compartment and Strahler), where a colour is
   * a fact about a point on the arbour rather than about the neuron — `segmentItem` can only
   * answer the latter.
   *
   * The child end rather than the parent, which is `compartmentStats`' rule too: attributing an
   * edge to its child is what makes a compartment's cable and its drawn extent the same set of
   * edges. Attributing to the parent would draw a boundary edge in the wrong compartment.
   */
  segmentNode: Int32Array
  segments: number
}

/**
 * Every skeleton flattened into one line-segment soup.
 *
 * One draw call for the whole collection rather than one per neuron: a hundred skeletons is
 * ~40k segments, and a draw call each would be 100+ per frame for no benefit — they share a
 * material, and selection is expressed through the colour buffer rather than through separate
 * objects. `segmentItem` is what maps a raycast hit back to the neuron that owns it — and it
 * indexes the *original* item list, so a filtered build still colours and picks correctly.
 *
 * A hidden item is left out of the buffer rather than drawn transparent, which is what also
 * makes it unpickable: geometry that is not there cannot be raycast, so hiding a key and
 * clicking where it used to be does nothing, rather than quietly selecting an invisible neuron.
 */
/**
 * Segments per skeleton, memoised on the geometry's identity.
 *
 * The count is a pure function of `parents`, which is immutable once decoded — the same licence
 * `boundsOf` and `cableLength` take. It earns its keep because this build is not a once-per-fetch
 * thing any more: a streamed value mints a fresh `SkeletonsValue` four times a second, and
 * hiding a legend key rebuilds too, so the counting pass over every node of every neuron was
 * being paid a dozen times for an answer that never changes. A number per item, so unlike
 * caching the segment buffers themselves it costs nothing to hold.
 */
const SEGMENT_COUNT = new WeakMap<SkeletonsValue['items'][number], number>()

function segmentsIn(item: SkeletonsValue['items'][number]): number {
  const hit = SEGMENT_COUNT.get(item)
  if (hit !== undefined) return hit
  let n = 0
  for (let i = 0; i < item.parents.length; i++) if (item.parents[i]! >= 0) n++
  SEGMENT_COUNT.set(item, n)
  return n
}

export function buildSkeletonSegments(
  skeletons: SkeletonsValue,
  visible: (itemIndex: number) => boolean = () => true,
): SkeletonSegments {
  let segments = 0
  skeletons.items.forEach((item, itemIndex) => {
    if (!visible(itemIndex)) return
    segments += segmentsIn(item)
  })

  const positions = new Float32Array(segments * 6)
  const segmentRadii = new Float32Array(segments * 2)
  const segmentItem = new Int32Array(segments)
  const segmentNode = new Int32Array(segments)
  let cursor = 0
  let segmentIndex = 0

  skeletons.items.forEach((item, itemIndex) => {
    if (!visible(itemIndex)) return
    for (let i = 0; i < item.parents.length; i++) {
      const parent = item.parents[i]!
      if (parent < 0) continue
      positions[cursor++] = item.positions[i * 3]!
      positions[cursor++] = item.positions[i * 3 + 1]!
      positions[cursor++] = item.positions[i * 3 + 2]!
      positions[cursor++] = item.positions[parent * 3]!
      positions[cursor++] = item.positions[parent * 3 + 1]!
      positions[cursor++] = item.positions[parent * 3 + 2]!
      segmentRadii[segmentIndex * 2] = item.radii[i] ?? 0
      segmentRadii[segmentIndex * 2 + 1] = item.radii[parent] ?? 0
      segmentNode[segmentIndex] = i
      segmentItem[segmentIndex++] = itemIndex
    }
  })

  return { positions, segmentRadii, segmentItem, segmentNode, segments }
}

/**
 * Per-vertex colours for the segment soup, both endpoints of a segment alike.
 *
 * A separate pass from the geometry so that restyling rewrites one attribute rather than
 * rebuilding positions — a colour change must not cost what a data change costs.
 */
export function skeletonSegmentColors(
  built: SkeletonSegments,
  skeletons: SkeletonsValue,
  colorAt: (index: number) => string,
  selected: ReadonlySet<string>,
  /**
   * A colour per *node*, taking precedence over `colorAt` where it answers.
   *
   * Optional because it defeats the per-item cache below — a compartment colour changes along
   * one neuron, so there is nothing to cache — and every existing caller wants the cheap path.
   * Returning `undefined` for a node falls back to the neuron's own colour, which is what lets a
   * partly-labelled arbour (a split that reached only some nodes) draw the rest normally rather
   * than in a colour that means "unlabelled" and looks like a decision.
   */
  nodeColorAt?: (itemIndex: number, nodeIndex: number) => string | undefined,
): Float32Array {
  const buffer = new Float32Array(built.segments * 6)
  const dimming = selected.size > 0
  /*
   * One `hexToRgbFloat` per *item*, not per segment. The parse is cheap and the segment count
   * is not: a hundred neurons is ~40k segments against ~100 distinct colours, so caching by
   * item turns 40k string parses per restyle into 100.
   */
  const cache = new Map<number, [number, number, number]>()
  /** Parsed hexes for the per-node channel, keyed by the colour rather than by the item. */
  const byColor = new Map<string, readonly [number, number, number]>()

  for (let s = 0; s < built.segments; s++) {
    const itemIndex = built.segmentItem[s]!
    /*
     * The per-node channel first, the per-item one as the fallback — resolved into one `rgb`
     * rather than into two branches that each dim and each write. Written as an early `continue`
     * the dimming rule and the two-vertex write both appeared twice in this one function, which
     * is two chances for a per-node scene and a per-neuron scene to disagree about what
     * "deselected" looks like.
     *
     * `byColor` parses once per *distinct* colour rather than once per segment — the trick
     * `buildPoints` documents below, needed here for the same reason. A per-node channel answers
     * three colours (compartment) or `maxStrahler` of them (order) across seventeen thousand
     * segments, so the uncached form was 17,000 `replace`/`parseInt` passes to produce a handful
     * of answers.
     */
    const own = nodeColorAt?.(itemIndex, built.segmentNode[s]!)
    let rgb: readonly [number, number, number]
    if (own !== undefined) {
      let parsed = byColor.get(own)
      if (!parsed) {
        parsed = hexToRgbFloat(own)
        byColor.set(own, parsed)
      }
      rgb = dimming && !selected.has(skeletons.items[itemIndex]?.id ?? '') ? DIMMED_RGB : parsed
    } else {
      let parsed = cache.get(itemIndex)
      if (!parsed) {
        const neuronId = skeletons.items[itemIndex]?.id ?? ''
        parsed =
          dimming && !selected.has(neuronId) ? DIMMED_RGB : hexToRgbFloat(colorAt(itemIndex))
        cache.set(itemIndex, parsed)
      }
      rgb = parsed
    }
    for (let v = 0; v < 2; v++) {
      buffer[s * 6 + v * 3] = rgb[0]
      buffer[s * 6 + v * 3 + 1] = rgb[1]
      buffer[s * 6 + v * 3 + 2] = rgb[2]
    }
  }
  return buffer
}

/**
 * The floor a drawn line width is held to, in screen pixels.
 *
 * Not a style choice: below one pixel a line stops being drawn reliably at all, which on a
 * neuron means the twigs disappear and the arbour reads as a fetch that returned only trunks.
 * Every source here has nodes this catches — CATMAID stores −1 for "unset" and `CatmaidSource`
 * clamps it to 0, and a CAVE L2 chunk too small to have a `max_dt_nm` is 0 as well.
 *
 * **It has a twin: `MIN_WORLD_PIXELS` in `flexLineMaterial.ts`, and the two are not the same
 * number.** They answer the same question — the thinnest a fat line may be drawn on screen —
 * for the same material, and they are apart because a world-units floor can only be applied
 * where the projection is known, i.e. in the shader. That much is settled. What is *not* settled
 * is 1 against 1.5: the second is pygfx's `1.415`, √2 for the diagonal case, and that argument
 * applies here as well. So the same neuron's twigs are floored at 1 px under `by radius` and
 * 1.5 px under `to scale`, which nobody decided. Left as it stands rather than quietly changing
 * how an existing mode looks; if you are here to tune the hairline floor, tune both.
 */
export const MIN_LINE_WIDTH = 1

/**
 * The ceiling, likewise in pixels.
 *
 * A radius distribution has outliers — a soma is one, and a mis-traced node is another — and
 * without a ceiling one of them draws a quad across the whole card. `referenceRadius` already
 * takes the p95 rather than the maximum for the same reason; this is the second half of it,
 * for the tail beyond that.
 */
export const MAX_LINE_WIDTH = 24

/**
 * The radius the `Width` setting is *about*: the p95 of everything drawn.
 *
 * Not the maximum, and that is the whole design of this function. Radii here are not measured,
 * they are derived — CATMAID's are hand-annotated where anybody bothered, and CAVE's are a
 * chunk's `max_dt_nm`, which is a distance transform over voxels. Both produce a tail. Scaling
 * against the maximum lets one node decide how wide every other node is drawn, so a single bad
 * radius flattens the whole arbour to the floor and the taper vanishes — the failure looks like
 * the feature not working rather than like one bad node.
 *
 * Memoised on the built soup, the same licence `segmentsIn` takes: it is a pure function of
 * buffers that are immutable once built, and the sort is the expensive part — a hundred
 * skeletons is ~80k endpoints, re-sorted on every change to a *width* without this.
 *
 * Returns 0 when nothing has a positive radius, which is a real state and not an error: a
 * source may publish none at all. The caller reads that as "no widths to draw" and falls back.
 */
const REFERENCE_RADIUS = new WeakMap<SkeletonSegments, number>()

export function referenceRadius(built: SkeletonSegments): number {
  const hit = REFERENCE_RADIUS.get(built)
  if (hit !== undefined) return hit

  let count = 0
  for (let i = 0; i < built.segmentRadii.length; i++) if (built.segmentRadii[i]! > 0) count++

  let reference = 0
  if (count > 0) {
    const positive = new Float32Array(count)
    let at = 0
    for (let i = 0; i < built.segmentRadii.length; i++) {
      const r = built.segmentRadii[i]!
      if (r > 0) positive[at++] = r
    }
    // A `Float32Array` sorts numerically by default, where a plain `Array` would sort these
    // as strings and put 100 before 9.
    positive.sort()
    // Nearest-rank, `ceil(p * n) - 1`, rather than the interpolating `floor(p * (n - 1))`.
    // They agree on anything the size of a real skeleton and disagree badly on a small one:
    // over two endpoints the second form picks the *smaller*, i.e. a p95 that is not even in
    // the top half. Test fixtures are exactly where a small one shows up.
    reference = positive[Math.max(0, Math.ceil(0.95 * count) - 1)]!
  }

  REFERENCE_RADIUS.set(built, reference)
  return reference
}

/**
 * Per-endpoint line widths in screen pixels, or `undefined` when the radii cannot carry them.
 *
 * `scale` is the width the p95 endpoint is drawn at; everything else is proportional to it and
 * clamped into `[MIN_LINE_WIDTH, MAX_LINE_WIDTH]`. Expressed that way round because it is the
 * only end of the distribution somebody can see and set by eye — "make the thick ones this
 * wide" is a decision, "make the median 1.4 and let the trunks land where they land" is not.
 *
 * **`undefined` is the honest answer for a skeleton with no radii**, and the reason it is a
 * return value rather than a buffer of floors is that the two are not the same picture: a
 * uniform 1px hairline is what the viewer already draws well and cheaply, where a *fat* line
 * of width 1 everywhere is the same picture at four times the vertex data. The caller falls
 * back to the uniform path rather than paying for a taper that is not in the data.
 */
export function skeletonSegmentWidths(
  built: SkeletonSegments,
  scale: number,
): Float32Array | undefined {
  const reference = referenceRadius(built)
  if (reference <= 0) return undefined

  const widths = new Float32Array(built.segmentRadii.length)
  for (let i = 0; i < widths.length; i++) {
    const width = (scale * built.segmentRadii[i]!) / reference
    widths[i] = Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, width))
  }
  return widths
}

/**
 * Radii as **world-space diameters**, or `undefined` when the source published no radii.
 *
 * The whole function, next to `skeletonSegmentWidths`' rescale-and-clamp, and the asymmetry is
 * the point: there is nothing to normalise against because the number already has a unit. A
 * node of radius 180 nm is 360 nm across, and `scale` is a multiplier for when the honest
 * picture is too thin to read rather than a target width.
 *
 * No floor here, unlike the pixel mode's `MIN_LINE_WIDTH`. A floor in nanometres would be a
 * floor at one zoom level and invisible or enormous at every other, so the one that matters —
 * "stay at least a pixel and a half wide on screen" — is applied per vertex in the shader,
 * where the projection is known. See `MIN_WORLD_PIXELS`.
 *
 * `Math.max(0, ...)` is not defensive: CATMAID writes -1 for a node nobody measured, and a
 * negative diameter would extrude the box inside out.
 */
export function skeletonSegmentWorldWidths(
  built: SkeletonSegments,
  scale: number,
): Float32Array | undefined {
  // The same "has this source got radii at all" question the pixel mode asks, asked the same
  // way, so the two modes fall back to the uniform path on exactly the same skeletons.
  if (referenceRadius(built) <= 0) return undefined

  const widths = new Float32Array(built.segmentRadii.length)
  for (let i = 0; i < widths.length; i++) {
    widths[i] = Math.max(0, 2 * scale * built.segmentRadii[i]!)
  }
  return widths
}

/**
 * A representative world-space diameter for the scene, for the things that need one number.
 *
 * `LineSegments2.raycast` measures its pick corridor from the material's uniform `linewidth`,
 * which cannot see the per-vertex widths — so in world units it needs a width in world units,
 * and the p95 is the same end of the distribution the pixel mode calibrates against.
 */
function worldPickWidth(built: SkeletonSegments, scale: number): number {
  return 2 * scale * referenceRadius(built)
}

/** Everything the renderer needs to draw a skeleton's lines, from the mode and the three scales. */
export interface SkeletonWidthPlan {
  /** A width per endpoint, or `undefined` for one width across the scene. */
  widths: Float32Array | undefined
  /** The material's `linewidth` uniform, in whichever space `worldUnits` says. */
  uniform: number
  /** Whether `widths` and `uniform` are nanometres rather than CSS pixels. */
  worldUnits: boolean
  /** Whether the fat path is worth its four-times vertex data. */
  fat: boolean
}

/**
 * The width mode resolved into the four answers the renderer actually needs.
 *
 * One function rather than four expressions in `Viewer3D.tsx`, and that is the covered/uncovered
 * split this file exists for: the *pieces* were already tested — `skeletonSegmentWidths`,
 * `skeletonSegmentWorldWidths`, `worldPickWidth` — but the decision that combines them was
 * assembled in a component no test can reach, and every way it can be wrong is silent. A pixel
 * width read as nanometres is an invisible line; an absent width attribute reads as 0, which is
 * nothing at all; a `worldUnits` material built without the per-vertex buffer is both.
 *
 * Two invariants live here rather than in a comment, and `viewer3dScene.test.ts` pins both:
 *
 *  - **`worldUnits` implies `widths`.** The stock `LineMaterial` the caller falls back to has
 *    three's unpatched fragment shader in it, whose view ray is 100 µm long in a scene measured
 *    in nanometres — so a world-units material without our patch draws the arbour until you zoom
 *    out and then loses it whole. Deriving the flag from the buffer rather than from the mode is
 *    what makes that unreachable.
 *  - **`uniform` is in the same space as `widths`.** It is not decorative: `LineSegments2.raycast`
 *    measures its pick corridor from it, so a multiplier of 1 handed to a world-units material
 *    makes a scene 10^5 nm across pickable only within a nanometre.
 */
export function skeletonWidthPlan(
  built: SkeletonSegments,
  mode: SkeletonWidthMode,
  scale: { uniform: number; radius: number; world: number },
): SkeletonWidthPlan {
  const widths =
    mode === 'radius'
      ? skeletonSegmentWidths(built, scale.radius)
      : mode === 'world'
        ? skeletonSegmentWorldWidths(built, scale.world)
        : undefined

  // `widths &&` and not `mode === 'world'`: a source that published no radii falls back to the
  // screen-space path, and a pixel width interpreted as nanometres is an invisible line.
  const worldUnits = mode === 'world' && widths !== undefined

  const uniform = worldUnits
    ? worldPickWidth(built, scale.world)
    : widths
      ? scale.radius
      : scale.uniform

  /*
   * A uniform width of 1 stays on the hairline path: a fat line of width 1 everywhere is the
   * same picture at four times the vertex data. Any per-vertex buffer earns the fat path by
   * definition, since it is the taper that the hairline cannot draw.
   */
  return { widths, uniform, worldUnits, fat: widths !== undefined || uniform > 1 }
}

/** The neuron a segment belongs to, or undefined when the index names none. */
export function neuronAtSegment(
  built: SkeletonSegments,
  skeletons: SkeletonsValue,
  segment: number | undefined,
): string | undefined {
  if (segment === undefined) return undefined
  const itemIndex = built.segmentItem[segment]
  if (itemIndex === undefined) return undefined
  return skeletons.items[itemIndex]?.id || undefined
}

/**
 * The same, from a hit *vertex* rather than a hit segment.
 *
 * Two entry points because the two line renderers report a hit differently: a plain
 * `LineSegments` gives the vertex index, of which there are two per segment, and
 * `LineSegments2` gives the segment as a `faceIndex`. Converting at the call site is how the
 * hairline path and the fat path end up disagreeing by a factor of two.
 */
export function neuronAtVertex(
  built: SkeletonSegments,
  skeletons: SkeletonsValue,
  vertexIndex: number | undefined,
): string | undefined {
  if (vertexIndex === undefined) return undefined
  return neuronAtSegment(built, skeletons, Math.floor(vertexIndex / 2))
}

/** Click semantics: a click toggles its neuron in and out of the selection. */
export function toggleSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]
}

// ---------------------------------------------------------------------------
// Points

export interface PointBuffers {
  positions: Float32Array
  colors: Float32Array
  count: number
}

/**
 * Positions and colours for the points still visible.
 *
 * Both arrays are rebuilt together, because dropping a point has to drop its colour with it —
 * they are index-aligned buffers on one geometry, and a filtered position array beside an
 * unfiltered colour array paints every remaining synapse the colour of a different one.
 *
 * The unfiltered case still copies rather than aliasing `points.positions`. That is deliberate
 * symmetry: one shape of return value, and no caller that has to know whether the array it was
 * handed belongs to the value it came from.
 */
export function buildPoints(
  points: PointsValue,
  colorAt: (index: number) => string,
  visible: (rowIndex: number) => boolean = () => true,
): PointBuffers {
  const total = points.attributes.length
  let count = 0
  for (let i = 0; i < total; i++) if (visible(i)) count++

  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  /*
   * Parsed hexes, memoised by the string — the same trick `skeletonSegmentColors` documents
   * twenty lines up, and needed more here than there: points is the channel with the most rows.
   * A synapse cloud is 10^5 points and a handful of distinct colours, so without this it is 10^5
   * `replace`/`parseInt` passes to produce four answers.
   */
  const parsed = new Map<string, readonly [number, number, number]>()
  let out = 0
  for (let i = 0; i < total; i++) {
    if (!visible(i)) continue
    positions[out * 3] = points.positions[i * 3]!
    positions[out * 3 + 1] = points.positions[i * 3 + 1]!
    positions[out * 3 + 2] = points.positions[i * 3 + 2]!
    const hex = colorAt(i)
    let rgb = parsed.get(hex)
    if (!rgb) {
      rgb = hexToRgbFloat(hex)
      parsed.set(hex, rgb)
    }
    colors[out * 3] = rgb[0]
    colors[out * 3 + 1] = rgb[1]
    colors[out * 3 + 2] = rgb[2]
    out++
  }
  return { positions, colors, count }
}

/**
 * The two sizes a split synapse cloud is drawn at, relative to the caller's `pointSize`.
 *
 * **Both halves are scaled, and the dim one is the half that matters** — which was measured, not
 * reasoned. Fading alone does not work on a dense cloud, because normal blending *accumulates*:
 * k overlapping dots at alpha `a` composite to `1 - (1 - a)^k`, so at the shipped default of 0.2
 * and a local overlap of twenty the "faded" sea reaches 99% coverage. Rendered at 20,000 points
 * in a real browser (headless Chrome, SwiftShader) the panels for alpha 0.2, 0.5 and 1.0 were
 * indistinguishable slabs of white with the lit dots invisible inside them — which is exactly the
 * reported symptom, three times over: "fully opaque, and the slider has no effect".
 *
 * The plumbing was right every time. What was wrong is that alpha saturates and area is what
 * feeds it, so the lever has to be size. At 0.6 the dim half covers 36% of the area, the
 * accumulation drops by the same factor, and the same four alphas render as four visibly
 * different pictures with the lit dots findable in all of them.
 *
 * Here rather than in `Viewer3D.tsx` because this is arithmetic and that file needs WebGL: jsdom
 * can assert the numbers, and only a browser can assert the picture. `EMPHASIS_SCALE` moved for
 * the same reason — the two are one decision and belong under one test.
 */
export const EMPHASIS_SCALE = 1.5
export const DIM_SCALE = 0.6

export function emphasisSizes(size: number): { lit: number; dim: number } {
  return { lit: size * EMPHASIS_SCALE, dim: size * DIM_SCALE }
}

// ---------------------------------------------------------------------------
// The interactive legend

/**
 * A predicate saying whether a row is still drawn, given the keys the user has hidden.
 *
 * Returns the constant `true` when nothing is hidden — worth the branch, because it is the
 * state every scene is in until somebody clicks an eye, and it lets the geometry builders skip
 * a call per point.
 *
 * A row whose encoding has no keys (`labelAt` undefined — constant, sequential, literal) is
 * always visible. Hiding is expressed in the vocabulary of the legend, so an encoding with no
 * legend has nothing to hide by; refusing to draw it would be hiding by a name nobody chose.
 */
export function visibilityFor(
  labelAt: ((rowIndex: number) => string | undefined) | undefined,
  hidden: ReadonlySet<string>,
): (rowIndex: number) => boolean {
  if (hidden.size === 0 || !labelAt) return () => true
  return (rowIndex) => {
    const label = labelAt(rowIndex)
    return label === undefined || !hidden.has(label)
  }
}

/** How many of `count` rows the hidden set removes, for the caption to admit. */
export function hiddenCount(count: number, visible: (rowIndex: number) => boolean): number {
  let n = 0
  for (let i = 0; i < count; i++) if (!visible(i)) n++
  return n
}

/**
 * The geometry ids belonging to one legend key.
 *
 * Text ids, read off the geometry rather than re-derived from the attribute table — invariant 8
 * again, and `SkeletonGeometry.id` is the field the selection is compared by everywhere else.
 */
export function idsForLabel(
  items: readonly { id: string }[],
  labelAt: ((rowIndex: number) => string | undefined) | undefined,
  label: string,
): string[] {
  return labelIndex(items, labelAt).get(label) ?? []
}

/**
 * Every key's ids, in one pass.
 *
 * `idsForLabel` walks the whole item list per label, which is fine for a question asked once and
 * quadratic for the legend, which asks it for every key it draws — and under the `hash` encoding
 * a "key" is a *neuron*, so twelve keys over five hundred skeletons was six thousand `labelAt`
 * calls, each allocating a string, on every render. Built once and memoised by the caller.
 *
 * An item with no id is skipped rather than keyed under an empty string: it cannot be selected,
 * so a key that claimed it would report a selection that never arrives.
 */
export function labelIndex(
  items: readonly { id: string }[],
  labelAt: ((rowIndex: number) => string | undefined) | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!labelAt) return out
  items.forEach((item, index) => {
    const label = labelAt(index)
    if (label === undefined || !item.id) return
    const held = out.get(label)
    if (held) held.push(item.id)
    else out.set(label, [item.id])
  })
  return out
}

/**
 * Clicking a key selects everything under it; clicking it again lets it go.
 *
 * "Again" means *all of them are already selected* rather than "any of them are", so a key
 * whose neurons were half-picked by hand fills the rest in on the first click instead of
 * throwing that work away. Order is preserved so the ids param does not churn.
 */
export function toggleLabelSelection(
  selection: readonly string[],
  ids: readonly string[],
): string[] {
  if (ids.length === 0) return [...selection]
  const chosen = new Set(selection)
  if (ids.every((id) => chosen.has(id))) {
    const dropped = new Set(ids)
    return selection.filter((id) => !dropped.has(id))
  }
  return [...selection, ...ids.filter((id) => !chosen.has(id))]
}

/**
 * What the eye toggle does: hide one key, or isolate it.
 *
 * `solo` is the gesture worth having in a 3D scene — twelve cell types in one arbour is a mess
 * that no amount of colour separates, and "show me only this one" is three clicks otherwise.
 * Soloing an already-soloed key restores everything, so the gesture is its own undo.
 */
export function toggleHiddenLabel(
  hidden: readonly string[],
  allLabels: readonly string[],
  label: string,
  solo: boolean,
): string[] {
  if (solo) {
    const others = allLabels.filter((other) => other !== label)
    const isSoloed =
      hidden.length === others.length && others.every((other) => hidden.includes(other))
    return isSoloed ? [] : others
  }
  return hidden.includes(label) ? hidden.filter((other) => other !== label) : [...hidden, label]
}

// ---------------------------------------------------------------------------
// Meshes

export interface SurfaceStyle {
  color: string
  opacity: number
  transparent: boolean
  depthWrite: boolean
}

/**
 * What a mesh surface is made of, given its colour, the opacity setting and whether it is
 * dimmed by somebody else's selection.
 *
 * **`depthWrite` follows opacity, and getting that wrong is what made meshes look broken.**
 * A translucent surface must not write depth, or whichever triangle draws first hides the
 * ones behind it and a neuron turns into a jumble of facets. An *opaque* surface must, or it
 * never occludes anything — including the skeleton running through the middle of it, which
 * is precisely what an opaque mesh is for.
 */
export function surfaceStyle(color: string, opacity: number, dimmed: boolean): SurfaceStyle {
  const effective = dimmed ? Math.min(opacity, 0.35) : opacity
  return {
    color: dimmed ? DIMMED_HEX : color,
    opacity: effective,
    transparent: !isOpaqueSurface(effective),
    depthWrite: isOpaqueSurface(effective),
  }
}

/**
 * Whether a surface at this opacity is drawn as a solid one.
 *
 * One definition because three things now turn on it and two of them are far apart:
 * `transparent` and `depthWrite` above, and whether a mesh is allowed to cast ambient
 * occlusion. A shell you can see through must not darken what is behind it, and a second
 * spelling of "opaque" is how that stops being true of one of the three.
 */
export function isOpaqueSurface(opacity: number): boolean {
  return opacity >= 1
}

// ---------------------------------------------------------------------------
// Ambient occlusion

/**
 * How far the AO estimator looks for an occluder, as a fraction of the scene's extent.
 *
 * octarine's number, and it is the one AO parameter that has to match the scene at all:
 * everything else is a quality-versus-cost dial and this one decides whether the effect is
 * visible. Ported rather than re-derived, since the scenes are the same scenes.
 */
export const AO_RADIUS_FRACTION = 0.04

/**
 * The AO radius for a scene of this extent, in world units.
 *
 * **A constant would be the bug here.** `GTAOPass` defaults to `radius: 0.25`, which is a
 * sensible number in a scene measured in metres and is a quarter of a nanometre in this one —
 * an occlusion search that never leaves the pixel it started in, i.e. an effect that renders
 * and does nothing. It is the same class of mistake as three's 1-world-unit raycast threshold
 * that made skeletons unclickable, and it fails the same way: silently, and looking like the
 * feature was not switched on.
 *
 * `framingFor`'s `size` is the input because it is already the scene's own extent, and
 * skeletons-first in the bounds chain — so a neuron inside a whole-brain shell gets a radius
 * scaled to the neuron rather than to the room.
 */
/**
 * How thick an occluder is assumed to be, as a multiple of the search radius.
 *
 * three's own ratio: `GTAOShader` ships `radius: 0.25` beside `thickness: 1`. Both are world
 * units, so scaling one and not the other is what broke this the first time — see
 * `aoThicknessFor`.
 */
export const AO_THICKNESS_RATIO = 4

/**
 * The occluder-thickness cutoff for this radius, in world units.
 *
 * **The second uniform that has to follow the scene, and the one that made the effect look
 * switched off.** `GTAOShader` rejects a sample outright with `if (abs(viewDelta.z) < thickness)`
 * — it is how the estimator declines to be occluded by a thin object it can see past. At the
 * default of 1 that cutoff is *one nanometre*, so in a scene where the search radius is 555 nm
 * every sample failed the test, the horizon never moved from its starting value, and the pass
 * blended a uniform white. Rendering `GTAOPass.OUTPUT.Denoise` is what showed it: an almost
 * entirely white buffer with a few scattered specks, where the same scene with a scaled
 * thickness draws every tube.
 *
 * Measured across a sweep at radius 555 nm, as the share of the frame carrying any occlusion:
 * 0.1% at thickness 1 and 50, 0.2% at 200, 0.7% at 555, **6.3% at 2200**, 11.2% at 10,000. The
 * ratio kept here is three's own, which lands on the 2200.
 *
 * The lesson generalises past this one number: a screen-space effect ported into a scene
 * measured in nanometres has to have *every* world-unit uniform rescaled, and a library's
 * defaults are a set that agree with each other. `aoRadiusFor` alone was half a port.
 */
export function aoThicknessFor(radius: number): number {
  return radius * AO_THICKNESS_RATIO
}

export function aoRadiusFor(sceneSize: number): number {
  // `framingFor(undefined)` answers 1 for a scene with nothing in it yet; a radius derived
  // from that placeholder is meaningless but harmless, because there is nothing to occlude.
  return Math.max(sceneSize, 1) * AO_RADIUS_FRACTION
}

/**
 * Whether there is anything in this scene for ambient occlusion to do.
 *
 * **Not a cost optimisation — the pass genuinely cannot see most of Coda's scenes.**
 * `GTAOPass._overrideVisibility` hides every `Points`, `Line` and `LineSegments2` before it
 * renders its normal buffer, with the comment "points and lines do not contribute to AO". A
 * skeleton scene is entirely lines, so the estimator would run over an empty g-buffer and
 * blend a uniform white result: three render targets and four passes to multiply the image by
 * 1. octarine records the same finding from the other side, recommending `edl` for lines.
 *
 * Translucent surfaces are excluded for a different reason, and it is about correctness rather
 * than cost. A neuropil shell ships at 0.12 and is *context*; letting it darken the arbour
 * inside it would put occlusion on a surface you can see through, which reads as dirt on the
 * picture rather than as shading. The per-object half of this is in `SurfaceGtaoPass` and
 * catches dimming too; this half decides whether the composer is mounted at all.
 */
export function wantsAmbientOcclusion(args: {
  /**
   * `GTAOPass.blendIntensity`, and 0 is the off state rather than a weak one.
   *
   * One number instead of a toggle plus a strength, because the toggle would have been a
   * second spelling of `strength === 0`: the blend is `mix(vec3(1.), ao, intensity)`, so at 0
   * the pass composites the image with itself. Two controls that can disagree about whether
   * the effect is on is the kind of pair that ends up with a scene showing no occlusion and a
   * checkbox insisting it is enabled.
   */
  strength: number
  meshes: number
  meshOpacity: number
  volumes: number
  volumeOpacity: number
}): boolean {
  if (!(args.strength > 0)) return false
  const opaqueMeshes = isOpaqueSurface(args.meshOpacity) ? args.meshes : 0
  const opaqueVolumes = isOpaqueSurface(args.volumeOpacity) ? args.volumes : 0
  return opaqueMeshes + opaqueVolumes > 0
}

// ---------------------------------------------------------------------------
// Camera

export interface Framing {
  /** Where the scene actually is, in the source's own coordinates. The viewer draws at −this. */
  center: [number, number, number]
  /** Longest edge of the bounding box; the unit every camera distance is expressed in. */
  size: number
  /**
   * Camera position **in the recentred scene**, not in source coordinates.
   *
   * The viewer translates its geometry by −`center` so the scene sits on the origin, which is
   * what lets the camera orbit (0, 0, 0). A camera placed in absolute nanometres instead would
   * be right only for the first frame and wrong for everything that measures a distance to the
   * origin afterwards — the compass being the one that shows it.
   */
  position: [number, number, number]
  near: number
  far: number
}

/**
 * Where to put the camera for a scene of this extent.
 *
 * `near` scales with the scene rather than being a constant: at brain scale (10^5 nm) a
 * near plane of 0.1 spends the whole depth buffer on the first millimetre and the surfaces
 * z-fight. `far` at 40× leaves room to pull back a long way before anything clips.
 */
export function framingFor(bounds: Bounds3 | undefined): Framing {
  const center = bounds ? boundsCenter(bounds) : ([0, 0, 0] as [number, number, number])
  const size = bounds ? boundsSize(bounds) : 1
  return {
    center,
    size,
    position: [0, 0, size * 1.9],
    near: Math.max(0.1, size / 1000),
    far: size * 40,
  }
}

// ---------------------------------------------------------------------------
// Compass

export interface CompassLayout {
  /** Arm length in pixels; drei's own default is 40. */
  scale: number
  /** Inset from the bottom-right corner to the gizmo's *centre*. */
  margin: [number, number]
}

/**
 * How big the orientation gizmo is, and how far in from the corner.
 *
 * **The gizmo is drawn in pixels, not as a fraction of the canvas**, which is the whole reason
 * this function exists. drei's arm is 40px whatever it is drawn into, so one compass sized for
 * a 750px overlay is a third of the height of a 185px card preview — the same object, the same
 * size, in a picture a quarter as big. Card previews get half.
 *
 * The inset then follows the scale at one end and the canvas at the other: it has to clear the
 * arms, or the gizmo hangs off the corner, and it has to stay off the middle of a short preview,
 * which is what drei's fixed 80px default does not.
 */
export function compassLayout(
  compact: boolean,
  size: { width: number; height: number },
): CompassLayout {
  const scale = compact ? 20 : 40
  return {
    scale,
    margin: [
      Math.max(scale * 0.7, Math.min(scale + 8, size.width * 0.14)),
      Math.max(scale * 0.7, Math.min(scale + 8, size.height * 0.22)),
    ],
  }
}

// ---------------------------------------------------------------------------
// Caption

/**
 * Where a scene's skeletons came from, for the caption.
 *
 * `detailNote`'s sibling, and it exists for the same reason: a viewer that draws two very
 * different products identically is one that looks like a broken renderer rather than a
 * deliberate trade. The difference here is bigger than a level of detail — a chunk-graph
 * skeleton is a few hundred nodes where a traced one is thousands, and only some routes carry
 * radii, which is what `to scale` line widths read.
 *
 * Absent for a value with no `provenance`, which is every skeleton set built before the routes
 * existed and anything a test hand-assembles.
 */
export function skeletonNote(
  skeletons: SkeletonsValue | undefined,
): { label: string; title: string } | undefined {
  const provenance = skeletons?.provenance
  if (!provenance) return undefined
  return {
    label: provenance.label,
    title: `${provenance.detail ?? provenance.label} Change it with Source on the Skeletons node.`,
  }
}

/**
 * What a mesh set's level of detail should say, or undefined when the source published none.
 *
 * Two ways a mesh set can be coarser than what the source holds, and they need different
 * words. A multi-resolution source *picked a level*, so the useful number is which of how
 * many; a source with none *simplified what it fetched*, where naming a level would report
 * "0 of 0" while most of the triangles have gone. Both admit the trade and both name the
 * control that changes it.
 */
export function detailNote(
  meshes: MeshesValue | undefined,
): { label: string; title: string } | undefined {
  const detail = meshes?.detail
  if (!detail) return undefined
  const triangles = detail.triangles.toLocaleString()
  const tail = ' Raise Detail on the Meshes node, or fetch fewer neurons, for a finer surface.'
  return detail.decimated
    ? {
        label: 'meshes simplified',
        title:
          `This source publishes one level of detail, so meshes are simplified on arrival ` +
          `to fit the triangle budget — ${triangles} triangles here.` +
          tail,
      }
    : {
        label: `mesh LOD ${detail.lod}/${detail.levels - 1}`,
        title:
          `Meshes drawn at level ${detail.lod} of ${detail.levels - 1} (0 is finest), ` +
          `${triangles} triangles.` +
          tail,
      }
}
