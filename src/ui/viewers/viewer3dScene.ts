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

// ---------------------------------------------------------------------------
// Skeletons

export interface SkeletonSegments {
  /** Two endpoints per segment, xyz interleaved: `segments * 6` entries. */
  positions: Float32Array
  /** Which item each segment belongs to, for picking and for colouring. */
  segmentItem: Int32Array
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
  const segmentItem = new Int32Array(segments)
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
      segmentItem[segmentIndex++] = itemIndex
    }
  })

  return { positions, segmentItem, segments }
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
): Float32Array {
  const buffer = new Float32Array(built.segments * 6)
  const dimming = selected.size > 0
  /*
   * One `hexToRgbFloat` per *item*, not per segment. The parse is cheap and the segment count
   * is not: a hundred neurons is ~40k segments against ~100 distinct colours, so caching by
   * item turns 40k string parses per restyle into 100.
   */
  const cache = new Map<number, [number, number, number]>()

  for (let s = 0; s < built.segments; s++) {
    const itemIndex = built.segmentItem[s]!
    let rgb = cache.get(itemIndex)
    if (!rgb) {
      const neuronId = skeletons.items[itemIndex]?.id ?? ''
      rgb =
        dimming && !selected.has(neuronId) ? DIMMED_RGB : hexToRgbFloat(colorAt(itemIndex))
      cache.set(itemIndex, rgb)
    }
    for (let v = 0; v < 2; v++) {
      buffer[s * 6 + v * 3] = rgb[0]
      buffer[s * 6 + v * 3 + 1] = rgb[1]
      buffer[s * 6 + v * 3 + 2] = rgb[2]
    }
  }
  return buffer
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
export function hiddenCount(
  count: number,
  visible: (rowIndex: number) => boolean,
): number {
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
  return hidden.includes(label)
    ? hidden.filter((other) => other !== label)
    : [...hidden, label]
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
    transparent: effective < 1,
    depthWrite: effective >= 1,
  }
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
