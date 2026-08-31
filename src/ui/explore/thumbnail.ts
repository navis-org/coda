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

import { boundsOf } from '../../core/values'
import { drawSegment, fillTriangle } from '../raster'

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
 * It is not a radius from the data. The L2 cache publishes `max_dt_nm` per chunk and it is the
 * right idea and the wrong scale — measured on BANC, 22 to 55 nm against a neuron spanning tens
 * of microns, so a faithful radius is a thousandth of the tile and every neuron draws as
 * hairlines. A morphologically honest width needs a tile far bigger than this one.
 */
const STROKE_FRACTION = 0.02

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
  padding: number,
): Project | undefined {
  const box = boundsOf([positions])
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
 * `padding` keeps the shape off the tile edge; it is a fraction of the tile, not pixels, so a
 * thumbnail rendered at two sizes looks like the same drawing.
 */
export function rasteriseSilhouette(
  positions: Float32Array,
  indices: Uint32Array,
  size: number,
  padding = PADDING,
): Silhouette {
  const result = emptySilhouette(size)
  if (positions.length < 9 || indices.length < 3) return result
  const project = fitToTile(positions, size, padding)
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
 */
export function rasteriseSkeleton(
  positions: Float32Array,
  parents: Int32Array,
  size: number,
  padding = PADDING,
): Silhouette {
  const result = emptySilhouette(size)
  const points = Math.floor(positions.length / 3)
  // No emptiness guard: `fitToTile` already answers undefined for nothing and for a single point,
  // and a `parents` of length zero runs the loop zero times to the same empty mask.
  const project = fitToTile(positions, size, padding)
  if (!project) return result

  const coverage = result.coverage
  // Rounded and floored by `drawSegment`, which is what promises what a thickness means.
  const thickness = size * STROKE_FRACTION
  for (let i = 0; i < parents.length && i < points; i++) {
    const parent = parents[i]!
    if (parent < 0 || parent >= points) continue
    const a = project(i)
    const b = project(parent)
    const shade = shadeFor((a[2] + b[2]) / 2)
    drawSegment(coverage, size, size, [a[0], a[1]], [b[0], b[1]], shade, thickness)
  }

  return result
}

/**
 * How much of the tile the shape covers.
 *
 * Used to reject a thumbnail that decoded to essentially nothing — a single stray fragment at the
 * coarsest level of detail, or a skeleton that turned out to be one node — so the row shows a
 * placeholder instead of a near-blank tile that looks like a rendering failure. The floor is
 * `NeuronThumbnail`'s, at 0.002; for scale, four real BANC skeletons came out between 3.3% and
 * 11.7%, so nothing legitimate is anywhere near it.
 */
export function coverageFraction(silhouette: Silhouette): number {
  let painted = 0
  for (const value of silhouette.coverage) if (value > 0) painted++
  return painted / silhouette.coverage.length
}

/** Paint a mask into RGBA bytes of one colour. The component hands these to a canvas. */
export function silhouetteToRgba(
  silhouette: Silhouette,
  color: { r: number; g: number; b: number },
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(silhouette.coverage.length * 4)
  for (let i = 0; i < silhouette.coverage.length; i++) {
    const alpha = silhouette.coverage[i]!
    if (alpha === 0) continue
    rgba[i * 4] = color.r
    rgba[i * 4 + 1] = color.g
    rgba[i * 4 + 2] = color.b
    rgba[i * 4 + 3] = alpha
  }
  return rgba
}

/** `#rrggbb` to channels. Falls back to mid-grey rather than throwing on a bad string. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return { r: 128, g: 128, b: 128 }
  const value = Number.parseInt(match[1]!, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
