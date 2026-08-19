/**
 * Turning a coarse mesh into a small neuron silhouette.
 *
 * Pure arithmetic, no DOM: it takes triangles and returns an 8-bit coverage mask, and the
 * component paints that through a canvas. Keeping it separate is what makes the geometry
 * testable at all — there is no WebGL in jsdom and no browser automation in this repo, so a
 * renderer that only existed inside a component would have no coverage whatsoever.
 *
 * ## Why a mask rather than an image
 *
 * The mask is one byte per pixel — 9 kB at 96×96, against 36 kB for RGBA and a PNG that would
 * need decoding through an `Image` — and it carries no colour, so the *same* cached thumbnail
 * paints correctly in light and dark mode. Caching pixels with a theme baked in would mean
 * every thumbnail going stale on a theme switch.
 *
 * ## Why triangles and not points
 *
 * A coarse level of detail has few vertices (a hemibrain neuron is ~10 kB at its coarsest), so
 * splatting vertices gives a sparse dotty cloud. Filling the triangles gives a continuous
 * shape, and shading each by depth makes a flat projection read as a 3D object rather than a
 * blob.
 *
 * ## Orientation
 *
 * X across, Y down, Z as depth — image-space axes, unflipped, because that is the frame every
 * EM dataset here publishes and it puts the fly brain the right way up without a per-dataset
 * table of rotations. Each neuron is fit to its own tile, so a small fragment fills the frame
 * just as a giant descending neuron does; consistent scaling across a dataset would need the
 * volume bounds and is a later refinement.
 */

export interface Silhouette {
  /** Width and height in pixels. */
  size: number
  /** `size * size` bytes, row-major. 0 is empty, 255 is nearest-and-covered. */
  coverage: Uint8Array
}

/** Nearest surfaces at full strength, far ones dimmed to this floor, out of 255. */
const DEPTH_FLOOR = 70

export function emptySilhouette(size: number): Silhouette {
  return { size, coverage: new Uint8Array(size * size) }
}

/**
 * Rasterise a projected, depth-shaded silhouette.
 *
 * `padding` keeps the shape off the tile edge; it is a fraction of the tile, not pixels, so a
 * thumbnail rendered at two sizes looks like the same drawing.
 */
export function rasteriseSilhouette(
  positions: Float32Array,
  indices: Uint32Array,
  size: number,
  padding = 0.06,
): Silhouette {
  const result = emptySilhouette(size)
  if (positions.length < 9 || indices.length < 3) return result

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!
    const y = positions[i + 1]!
    const z = positions[i + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  const spanX = maxX - minX
  const spanY = maxY - minY
  // A single point or a perfectly flat axis would divide by zero; one shared scale keeps the
  // aspect ratio, so a neuron is never stretched to fill the tile.
  const span = Math.max(spanX, spanY)
  if (!Number.isFinite(span) || span <= 0) return result

  const inner = size * (1 - 2 * padding)
  const scale = inner / span
  const offsetX = size * padding + (inner - spanX * scale) / 2
  const offsetY = size * padding + (inner - spanY * scale) / 2
  const spanZ = maxZ - minZ

  const project = (index: number): [number, number, number] => {
    const at = index * 3
    return [
      (positions[at]! - minX) * scale + offsetX,
      (positions[at + 1]! - minY) * scale + offsetY,
      spanZ > 0 ? (positions[at + 2]! - minZ) / spanZ : 0.5,
    ]
  }

  const coverage = result.coverage
  const triangles = Math.floor(indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    const a = project(indices[t * 3]!)
    const b = project(indices[t * 3 + 1]!)
    const c = project(indices[t * 3 + 2]!)
    // Nearest is smallest z in image space, so invert for brightness.
    const depth = (a[2] + b[2] + c[2]) / 3
    const shade = Math.round(255 - (255 - DEPTH_FLOOR) * depth)
    fillTriangle(coverage, size, a, b, c, shade)
  }

  return result
}

/**
 * Scanline-free triangle fill: bounding box plus a barycentric inside test.
 *
 * Brightest-wins rather than accumulating, so overlapping branches do not saturate into a
 * white blob — the result reads as a surface, and a thin process crossing a thick one stays
 * visible.
 */
function fillTriangle(
  coverage: Uint8Array,
  size: number,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  shade: number,
): void {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])))
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])))
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
  if (minX > maxX || minY > maxY) return

  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
  if (area === 0) {
    // Degenerate after projection — an edge-on triangle. Still worth a mark, or a neuron
    // viewed along a flat axis would lose whole branches.
    markPixel(coverage, size, Math.round(a[0]), Math.round(a[1]), shade)
    return
  }

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area
      const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area
      const w2 = 1 - w0 - w1
      if (w0 < 0 || w1 < 0 || w2 < 0) continue
      markPixel(coverage, size, x, y, shade)
    }
  }
}

function markPixel(coverage: Uint8Array, size: number, x: number, y: number, shade: number): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return
  const at = y * size + x
  if (coverage[at]! < shade) coverage[at] = shade
}

/**
 * How much of the tile the shape covers.
 *
 * Used to reject a thumbnail that decoded to essentially nothing — a single stray fragment at
 * the coarsest level of detail — so the row shows a placeholder instead of a near-blank tile
 * that looks like a rendering failure.
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
