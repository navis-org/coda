/**
 * Turning coarse geometry into a small neuron silhouette.
 *
 * Pure arithmetic, no DOM: it takes triangles or a skeleton tree and returns an 8-bit coverage
 * mask, and the component paints that through a canvas. Keeping it separate is what makes the
 * geometry testable at all — there is no WebGL in jsdom and no browser automation in this repo,
 * so a renderer that only existed inside a component would have no coverage whatsoever.
 *
 * ## Why a mask rather than an image
 *
 * The mask is one byte per pixel — 9 kB at 96×96, against 36 kB for RGBA and a PNG that would
 * need decoding through an `Image` — and it carries no colour, so the *same* cached thumbnail
 * paints correctly in light and dark mode. Caching pixels with a theme baked in would mean
 * every thumbnail going stale on a theme switch.
 *
 * ## Two rasterisers, one projection
 *
 * Which one runs is decided by what the source could answer cheaply, not by preference:
 * `rasteriseSilhouette` fills the coarsest published mesh, and `rasteriseSkeleton` strokes a
 * tree. The second exists because a `graphene://` segmentation has no cheap mesh at any level —
 * one neuron is several hundred supervoxel fragments at full resolution — while its level-2
 * chunk graph is two small requests, so for those datastacks a skeleton is the *only* cheap
 * representation there is. See `DataSource.fetchCoarseGeometry`.
 *
 * They share `fitToTile`, and that sharing is the point rather than a tidiness. The fit is where
 * the visual identity lives — the padding, the one shared scale that keeps aspect ratio, the
 * image-space axes, the depth normalisation — and two copies would drift on one of those and
 * produce a list where mesh rows and skeleton rows are framed differently, which reads as a
 * broken renderer rather than as two code paths.
 *
 * ## Why triangles and not points
 *
 * A coarse level of detail has few vertices (a hemibrain neuron is ~10 kB at its coarsest), so
 * splatting vertices gives a sparse dotty cloud. Filling the triangles gives a continuous
 * shape, and shading each by depth makes a flat projection read as a 3D object rather than a
 * blob. The same reasoning is why the skeleton path strokes its *edges* rather than splatting
 * its nodes: an L2 skeleton is tens to a few thousand chunks, which as points is the dotty cloud
 * again.
 *
 * ## Orientation
 *
 * X across, Y down, Z as depth — image-space axes, unflipped, because that is the frame every
 * EM dataset here publishes and it puts the fly brain the right way up without a per-dataset
 * table of rotations. Each neuron is fit to its own tile, so a small fragment fills the frame
 * just as a giant descending neuron does; consistent scaling across a dataset would need the
 * volume bounds and is a later refinement.
 */

import type { Bounds3 } from '../../core/values'
import { boundsOf } from '../../core/values'
import { drawSegment, fillTriangle } from '../raster'
import { radiusReference } from '../viewers/viewer3dScene'

export interface Silhouette {
  /** Width and height in pixels. */
  size: number
  /** `size * size` bytes, row-major. 0 is empty, 255 is nearest-and-covered. */
  coverage: Uint8Array
}

/** Nearest surfaces at full strength, far ones dimmed to this floor, out of 255. */
const DEPTH_FLOOR = 70

/**
 * Stroke width as a fraction of the tile, so a skeleton drawn at two sizes is one drawing.
 *
 * The same rule `padding` follows and for the same reason. At the 304px raster behind a 76px
 * tile it is 6 pixels, which the browser downsamples to about 1.5 — the same drawing the 152px
 * raster made at 3, which is what makes `RASTER_SCALE` a free parameter here.
 *
 * Chosen by rasterising four real BANC L2 skeletons and printing the mask as ASCII, which is the
 * only way to look at one of these outside a browser — jsdom has no canvas. Coverage on a
 * 2,684-node descending neuron — widths as they were at the 152px raster it was chosen on, which
 * is the same fraction either way — and what the picture does:
 *
 *     1 px   3.3%   the axon is the faintest step of the ramp; it does not survive the down
 *     3 px   6.6%   arbor structure and axon both legible
 *     5 px   8.9%   the arbor fills in solid — the neuron is a blob with a tail
 *
 * So the failure is at both ends and neither is a matter of taste: too thin and the long thin
 * part of the neuron disappears, too thick and the dense part stops having any structure. Three
 * is the only one of the three that keeps both, and the same three drew a 310-node neuron and a
 * 19-node fragment legibly.
 *
 * **Re-checked on FAFB, which is thirteen times denser**, since one constant now serves a
 * chunk-graph skeleton of ~1,300 nodes and a traced CATMAID one of 16,840. It behaves the same
 * way: at 1 px skeleton 16's descending axon is the faintest step of the ramp again, at 3 px it
 * is solid, and its terminal tuft saturates at every width tried — so what saturates there is the
 * arbor being genuinely dense rather than the stroke being too wide, and no width recovers it.
 *
 * **Where a skeleton carries radii, this is the width of its p95 radius** and everything else is
 * drawn in proportion — see `strokeWidths`. It is not the radius *at scale*: measured on
 * minnie65 and BANC level-2 skeletons (p95 radii 317–428 nm against neurons spanning hundreds of
 * microns), a faithful width is under two raster pixels for nearly every segment, so the floor
 * decides the whole picture and it draws as hairlines with the taper flattened out of it. Scaled
 * to the p95, the trunk and soma keep the weight this constant always gave them and the twigs
 * thin out, which is the taper the radii carry.
 */
const STROKE_FRACTION = 0.02

/**
 * The thinnest and thickest a radius-scaled stroke may be, as fractions of the tile.
 *
 * The floor is 2 raster pixels at the 304px tile raster, half a CSS pixel after the downsample:
 * a twig below it stops landing on a pixel at all, which is the failure `RASTER_SCALE` exists to
 * prevent. The ceiling is twice the p95 width, because the tail above the p95 is somata and
 * mis-sized chunks — `max_dt_nm` reaches 6.2 µm on a minnie65 soma against a 317 nm p95 — and
 * one of those drawn at scale is a blot across the arbor. Both chosen by rendering real minnie65
 * and BANC level-2 skeletons at the tile raster and looking at them.
 */
const STROKE_MIN_FRACTION = 0.007
const STROKE_MAX_FRACTION = 2 * STROKE_FRACTION

/**
 * How many of the drawn endpoints must carry a radius before the widths follow the radii.
 *
 * A source may publish radii for only some nodes — CATMAID stores none unless a tracer set one,
 * and typically sets it on the soma alone. Scaled against that one node, every other segment
 * lands on the floor and the neuron draws as hairlines with a fat dot on it: worse than the
 * uniform stroke, and indistinguishable from a broken renderer. So a taper is drawn only where
 * the radii describe most of the arbor, and the uniform stroke otherwise.
 */
const RADII_MIN_SHARE = 0.5

/**
 * How much of the tile stays clear around the drawing.
 *
 * A fraction rather than pixels, the same rule `STROKE_FRACTION` follows, so a thumbnail rendered
 * at two sizes is the same drawing. One constant rather than a default on each rasteriser: it was
 * a literal on both, and two literals for one visual property is how mesh rows and skeleton rows
 * come to sit differently in the same list.
 */
const PADDING = 0.06

export function emptySilhouette(size: number): Silhouette {
  return { size, coverage: new Uint8Array(size * size) }
}

/**
 * Vertex index to `[x, y, depth]`; depth is 0 at the near plane and 1 at the far one.
 *
 * A function rather than an object with one method — there was a `TileFit` interface here whose
 * only member was this, and the `fit.project(i)` indirection at every call site bought nothing.
 */
type Project = (index: number) => [number, number, number]

/**
 * The projection both rasterisers share: model coordinates to mask pixels and a depth.
 *
 * Undefined for geometry with no extent — a single point, an empty array — which is a mask with
 * nothing in it either way, and saying so here means neither caller has to know that dividing by
 * a zero span is what would otherwise happen.
 *
 * The box comes from `core/values.ts`' `boundsOf` rather than a scan written out here. It is the
 * same arithmetic over the same interleaved buffer, it collapses an empty one to the origin
 * (which this reads as no extent), and it is memoised on the buffer's identity — so a neuron
 * whose bounds some viewer has already taken costs nothing here.
 */
function fitToTile(
  positions: Float32Array,
  size: number,
  bounds?: Bounds3,
): Project | undefined {
  const padding = PADDING
  /*
   * A supplied box is how a rotation frames every frame alike. Left to derive its own, this
   * re-frames each rotated copy to that copy's bounds, so the neuron pulses in size as it turns
   * and its depth ramp breathes with it — one box, and both go away. See `rotation.ts`.
   */
  const box = bounds ?? boundsOf([positions])
  const spanX = box.max[0] - box.min[0]
  const spanY = box.max[1] - box.min[1]
  // A single point or a perfectly flat axis would divide by zero; one shared scale keeps the
  // aspect ratio, so a neuron is never stretched to fill the tile.
  const span = Math.max(spanX, spanY)
  if (!Number.isFinite(span) || span <= 0) return undefined

  const inner = size * (1 - 2 * padding)
  const scale = inner / span
  const offsetX = size * padding + (inner - spanX * scale) / 2
  const offsetY = size * padding + (inner - spanY * scale) / 2
  const spanZ = box.max[2] - box.min[2]

  return (index: number) => {
    const at = index * 3
    return [
      (positions[at]! - box.min[0]) * scale + offsetX,
      (positions[at + 1]! - box.min[1]) * scale + offsetY,
      spanZ > 0 ? (positions[at + 2]! - box.min[2]) / spanZ : 0.5,
    ]
  }
}

/** Nearest is smallest z in image space, so invert for brightness. */
function shadeFor(depth: number): number {
  return Math.round(255 - (255 - DEPTH_FLOOR) * depth)
}

/**
 * Rasterise a projected, depth-shaded silhouette from triangles.
 *
 * `PADDING` keeps the shape off the tile edge; it is a fraction of the tile, not pixels, so a
 * thumbnail rendered at two sizes looks like the same drawing. Read from the constant rather than
 * taken as a parameter — no caller in the repo ever passed one, and its own note says two literals
 * for one visual property is how mesh rows and skeleton rows come to sit differently in one list.
 */
export function rasteriseSilhouette(
  positions: Float32Array,
  indices: Uint32Array,
  size: number,
  bounds?: Bounds3,
): Silhouette {
  const result = emptySilhouette(size)
  if (positions.length < 9 || indices.length < 3) return result
  const project = fitToTile(positions, size, bounds)
  if (!project) return result

  const coverage = result.coverage
  const triangles = Math.floor(indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    const a = project(indices[t * 3]!)
    const b = project(indices[t * 3 + 1]!)
    const c = project(indices[t * 3 + 2]!)
    const shade = shadeFor((a[2] + b[2] + c[2]) / 3)
    fillTriangle(coverage, size, size, [a[0], a[1]], [b[0], b[1]], [c[0], c[1]], shade)
  }

  return result
}

/**
 * Rasterise a projected, depth-shaded silhouette from a skeleton tree.
 *
 * `parents` is `SkeletonGeometry`'s: one entry per point, holding the index of its parent, and
 * `-1` for a root. Every non-root point contributes one stroked segment, which is the same walk
 * the SWC writer and the 3D viewer make — so a tree with several roots draws as several
 * components rather than being joined through a fabricated edge.
 *
 * **A parent index is not trusted, and that is deliberate rather than defensive.** `parents`
 * comes off a `DataSource`, and a stale or truncated one referring past the end of `positions`
 * would project `undefined` into `NaN` and stroke a segment from the neuron to the tile's
 * corner — a picture that is wrong rather than absent, which is the failure this whole file is
 * shaped to avoid.
 *
 * The mesh path gets there by a different road, which is worth knowing before anyone "tidies"
 * this into a shared rule: `rasteriseSilhouette` validates nothing, and a face indexing past its
 * vertex list is harmless only because every comparison against the resulting `NaN` is false, so
 * `fillTriangle` fills no pixels. A stroke has no such accident available to it — `drawSegment`
 * walks from a rounded endpoint — so the check is here rather than in `fitToTile`, where it
 * would cost a branch per vertex on the mesh path to restate an invariant that already holds.
 *
 * `widths` is `strokeWidths`' answer, one per child point, and the uniform stroke without it.
 * Taken ready-made rather than as radii because it is a property of the tree and not of where the
 * points are: a rotation draws seventeen frames of one skeleton and computes it once.
 */
export function rasteriseSkeleton(
  positions: Float32Array,
  parents: Int32Array,
  size: number,
  { bounds, widths }: { bounds?: Bounds3; widths?: Float32Array } = {},
): Silhouette {
  const result = emptySilhouette(size)
  const points = Math.floor(positions.length / 3)
  // No emptiness guard: `fitToTile` already answers undefined for nothing and for a single point,
  // and a `parents` of length zero runs the loop zero times to the same empty mask.
  const project = fitToTile(positions, size, bounds)
  if (!project) return result

  const coverage = result.coverage
  // Rounded and floored by `drawSegment`, which is what promises what a thickness means.
  const uniform = size * STROKE_FRACTION
  for (let i = 0; i < parents.length && i < points; i++) {
    const parent = parents[i]!
    if (parent < 0 || parent >= points) continue
    const a = project(i)
    const b = project(parent)
    const shade = shadeFor((a[2] + b[2]) / 2)
    const thickness = widths ? widths[i]! : uniform
    // Order-independent: `markPixel` keeps the larger value, so a thin twig drawn after a thick
    // trunk cannot punch through it.
    drawSegment(coverage, size, size, [a[0], a[1]], [b[0], b[1]], shade, thickness)
  }

  return result
}

/**
 * Each segment's stroke width in raster pixels, indexed by its child point — or `undefined` where
 * the radii cannot carry a taper and the uniform stroke should be drawn instead.
 *
 * The 3D View's `radius` mode, for the same reason and in the same shape: widths are proportional
 * to radius and **normalised to the p95** — `radiusReference`, the same reference that mode
 * takes — so one soma or one mis-sized chunk cannot decide how wide everything else is drawn,
 * then clamped. The p95 lands on `STROKE_FRACTION`, which is what keeps a tapered thumbnail as
 * bold as the uniform one where the neuron is thick.
 *
 * `undefined` for a skeleton with no radii at all, which is the same answer as one with too few.
 *
 * A segment takes its endpoints' **mean** radius, and a missing radius counts as zero in it. On a
 * level-2 skeleton that is a chunk too small to have a `max_dt_nm`, and averaging it with its
 * neighbour draws it thin rather than dropping it or letting it inherit a trunk's width.
 */
export function strokeWidths(
  parents: Int32Array,
  radii: Float32Array | undefined,
  size: number,
): Float32Array | undefined {
  if (!radii) return undefined
  const points = parents.length
  const radius = (i: number) => Math.max(0, radii[i] ?? 0)
  // Each drawn segment's mean radius, clamped below once the reference is known; and its two
  // endpoints' radii — over the drawn segments rather than the points, so the reference describes
  // what is on the tile and a node is counted once per segment it ends, as the 3D View counts it.
  const widths = new Float32Array(points)
  const endpoints = new Float32Array(2 * points)
  let drawn = 0
  let measured = 0
  for (let i = 0; i < points; i++) {
    const parent = parents[i]!
    if (parent < 0 || parent >= points) continue
    const near = radius(i)
    const far = radius(parent)
    endpoints[drawn++] = near
    endpoints[drawn++] = far
    if (near > 0) measured++
    if (far > 0) measured++
    widths[i] = (near + far) / 2
  }
  if (drawn === 0 || measured < RADII_MIN_SHARE * drawn) return undefined
  const reference = radiusReference(endpoints.subarray(0, drawn))

  const target = size * STROKE_FRACTION
  const floor = size * STROKE_MIN_FRACTION
  const ceiling = size * STROKE_MAX_FRACTION
  for (let i = 0; i < points; i++) {
    widths[i] = Math.min(ceiling, Math.max(floor, (target * widths[i]!) / reference))
  }
  return widths
}

/**
 * How much of the tile the shape covers.
 *
 * `NeuronThumbnail` refuses a mask only when this is **zero** — nothing painted at all, which is
 * what no geometry, a collapsed triangle and a one-node skeleton all come to. It used to refuse
 * below 0.002 on the reading that "nothing legitimate is anywhere near it", taken from four BANC
 * skeletons at 3.3–11.7%. That held for skeletons, which carry a stroke, and failed for meshes of
 * long thin neurons: one fish2 body in ten landed under it. Because every shape is fitted to the
 * tile, a fraction here measures thinness rather than size — see `silhouetteOf`.
 */
export function coverageFraction(silhouette: Silhouette): number {
  let painted = 0
  for (const value of silhouette.coverage) if (value > 0) painted++
  return painted / silhouette.coverage.length
}

/**
 * Fill the colour channels of a paint buffer, leaving alpha alone.
 *
 * Split from the coverage write because the two change at different rates: the ink moves only
 * when the theme does, where the coverage moves on every frame of the rocking preview. Measured
 * at 640², writing all four channels is 0.695 ms against 0.303 ms for alpha alone — at the
 * rock's 13 repaints a second that is 8.7 ms/s of main thread against 3.9.
 */
export function inkInto(
  out: Uint8ClampedArray,
  color: { r: number; g: number; b: number },
): void {
  for (let at = 0; at < out.length; at += 4) {
    out[at] = color.r
    out[at + 1] = color.g
    out[at + 2] = color.b
  }
}

/**
 * Write a mask's coverage into a paint buffer's alpha channel.
 *
 * Every pixel, unconditionally. A reused buffer still holds the previous frame, so skipping the
 * empty ones — which is what a freshly allocated buffer could afford — would leave the last
 * frame's neuron behind wherever this one has nothing. Writing through is also what lets the
 * caller drop its `clearRect`: `putImageData` replaces destination pixels wholesale rather than
 * compositing, so a clear before it was never doing anything.
 *
 * The mask carries no colour, which is the property the whole cache rests on — one stored
 * thumbnail paints correctly in either theme, because the ink is applied at paint by `inkInto`.
 */
export function coverageInto(out: Uint8ClampedArray, silhouette: Silhouette): void {
  const { coverage } = silhouette
  for (let i = 0; i < coverage.length; i++) out[i * 4 + 3] = coverage[i]!
}

/** `#rrggbb` to channels. Falls back to mid-grey rather than throwing on a bad string. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return { r: 128, g: 128, b: 128 }
  const value = Number.parseInt(match[1]!, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
