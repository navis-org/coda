/**
 * Triangles and lines to masks, and masks to outlines.
 *
 * Three things live here, and they are together because the last only ever consumes what the
 * first two produce. None of them knows what it is drawing: `thumbnail.ts` fills a neuron into a
 * 96px tile and shades it by depth, `roiProjection.ts` fills a neuropil into a shared frame and
 * traces its boundary, and the arithmetic underneath is the same barycentric fill either way.
 *
 * It was extracted from `thumbnail.ts` rather than copied into the second caller. A second copy
 * of a scanline fill is not expensive to write and is expensive to own: the two would drift on
 * exactly one thing — whether a pixel whose centre sits on an edge is inside — and the symptom
 * would be a one-pixel seam between two regions in one viewer and not the other, which nobody
 * would ever trace back to here.
 *
 * ## Why an outline at all
 *
 * A projected neuropil could be drawn as its triangles, and sixty of them at four hundred
 * triangles each is twenty-five thousand SVG paths. The boundary is one path, it strokes, and it
 * is the thing that makes overlapping regions readable. Getting it from the *mask* rather than
 * from the mesh is what makes concavity survive: a neuropil is not star-shaped — the mushroom
 * body lobes wrap the peduncle — so anything that walks angles around a centroid draws a region
 * larger than it is, filling in its own notches.
 */

/** A point in mask coordinates. */
export type XY = readonly [number, number]

/**
 * Fill one triangle into an 8-bit mask, brightest-wins.
 *
 * Brightest-wins rather than accumulating, so overlapping faces do not saturate: a thin process
 * crossing a thick one stays visible, and a depth-shaded surface reads as a surface rather than
 * as a white blob. For a binary coverage mask the caller passes 255 and the rule is moot.
 */
export function fillTriangle(
  mask: Uint8Array,
  width: number,
  height: number,
  a: XY,
  b: XY,
  c: XY,
  value = 255,
): void {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])))
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])))
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])))
  if (minX > maxX || minY > maxY) return

  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
  if (area === 0) {
    // Degenerate after projection — a face seen exactly edge-on. Still worth a mark, or a
    // shape viewed along a flat axis loses whole bands of its surface.
    markPixel(mask, width, height, Math.round(a[0]), Math.round(a[1]), value)
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
      markPixel(mask, width, height, x, y, value)
    }
  }
}

/**
 * Draw one thick segment into an 8-bit mask, brightest-wins.
 *
 * `fillTriangle`'s companion, for the geometry that has no faces: a skeleton is a set of edges,
 * and a mesh silhouette's fill has nothing to work with there.
 *
 * **Stamped along the major axis rather than filled as a quad**, which is not the obvious choice
 * — a segment of a given width *is* a rectangle, and `fillTriangle` would take two of them. The
 * problem is that the rectangle is two or three pixels wide: barycentric coverage tests a pixel
 * centre, so a thin diagonal quad drops pixels wherever no centre lands inside it, and a neurite
 * comes out as a dotted line. Walking the segment guarantees a connected mark, which for a
 * drawing whose whole content is thin lines matters more than exact edges do.
 *
 * `thickness` is the side of the square stamp in pixels, so it is a *diameter* and even values
 * are honest — the offsets run `-floor((n-1)/2)` to `+floor(n/2)`, which is 2×2 for 2 rather
 * than collapsing to a single pixel the way a radius would.
 */
export function drawSegment(
  mask: Uint8Array,
  width: number,
  height: number,
  a: XY,
  b: XY,
  value = 255,
  thickness = 1,
): void {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  // One step per pixel of the longer axis. `ceil` rather than `round`, so a sub-pixel segment
  // still marks both ends: an L2 chunk graph has plenty of those where the arbor is dense.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
  const stamp = Math.max(1, Math.round(thickness))
  const from = -Math.floor((stamp - 1) / 2)
  const to = Math.floor(stamp / 2)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = Math.round(a[0] + dx * t)
    const y = Math.round(a[1] + dy * t)
    for (let oy = from; oy <= to; oy++) {
      for (let ox = from; ox <= to; ox++) markPixel(mask, width, height, x + ox, y + oy, value)
    }
  }
}

function markPixel(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  value: number,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const at = y * width + x
  if (mask[at]! < value) mask[at] = value
}

/**
 * The ordered boundary of every filled blob in a mask.
 *
 * Moore-neighbour tracing: from the first filled pixel, walk clockwise around the blob always
 * turning back toward where you came from. It follows the boundary literally, so a notch is
 * walked into and out of — which is the entire reason this exists rather than a radial sweep.
 *
 * **Every connected blob gets its own contour**, and that is not defensive coding: a region can
 * genuinely project to two pieces. A U-shaped neuropil seen edge-on separates, and so does
 * anything the explode has pulled apart from a neighbour it was fused with in the projection.
 * Returning one contour would join two blobs with a line through empty space.
 *
 * Holes are not traced. A neuropil with a tunnel through it would draw as solid, which is what
 * an outline-and-fill picture says anyway; tracing inner boundaries would need even-odd fill and
 * a rule for which contour is which, for a case no dataset here has produced.
 *
 * Contours are in *pixel-centre* coordinates, so a pixel at index `(x, y)` contributes the point
 * `(x + 0.5, y + 0.5)` — a contour of a one-pixel blob is a point rather than a zero-size box.
 */
export function traceOutlines(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea = 4,
): XY[][] {
  const seen = new Uint8Array(mask.length)
  const contours: XY[][] = []

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x
      if (mask[at] === 0 || seen[at] === 1) continue
      const area = floodFill(mask, seen, width, height, x, y)
      if (area < minArea) continue
      const contour = traceFrom(mask, width, height, x, y)
      if (contour.length >= 3) contours.push(contour)
    }
  }
  return contours
}

/** Mark one blob as visited and report its area, so specks can be dropped before tracing. */
function floodFill(
  mask: Uint8Array,
  seen: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
): number {
  const stack = [startY * width + startX]
  seen[startY * width + startX] = 1
  let area = 0
  while (stack.length > 0) {
    const at = stack.pop()!
    area++
    const x = at % width
    const y = (at - x) / width
    // Four-connected, matching the tracer's notion of one blob: an eight-connected fill would
    // count two shapes touching at a corner as one and then trace only the first.
    if (x > 0) push(at - 1)
    if (x < width - 1) push(at + 1)
    if (y > 0) push(at - width)
    if (y < height - 1) push(at + width)
  }
  return area

  function push(next: number): void {
    if (mask[next] === 0 || seen[next] === 1) return
    seen[next] = 1
    stack.push(next)
  }
}

/** Clockwise Moore neighbourhood, starting east. */
const MOORE: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

function traceFrom(
  mask: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
): XY[] {
  const filled = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0

  const contour: XY[] = [[startX + 0.5, startY + 0.5]]
  let cx = startX
  let cy = startY
  /*
   * The scan reaches a blob at its topmost-leftmost pixel, so west is necessarily empty and is
   * where we came from. Sweeping clockwise from the backtrack — rather than restarting the
   * neighbour scan each step — is what keeps the walk on the boundary instead of cutting across
   * a one-pixel isthmus.
   */
  let from = 4
  /*
   * Jacob's stopping criterion: the walk is finished when it stands on the start pixel and is
   * about to leave it in the direction it first left. Testing only "am I back at the start"
   * stops early on a shape the boundary passes through twice, and testing nothing at all sends
   * the walk round and round — which is not a hang, it is a contour listing the same perimeter
   * four times over, whose winding number then reads as *inside-out* to every point-in-polygon
   * test downstream. That is the bug this criterion exists to prevent, and it looks like a
   * correct outline right up until something asks whether a point is in it.
   */
  let firstDir = -1
  // A boundary cannot be longer than the grid's perimeter times a constant; the bound is a
  // backstop against a malformed mask rather than an expected exit.
  const budget = 4 * (width + height) + 16

  for (let step = 0; step < budget; step++) {
    let dir = -1
    for (let i = 1; i <= MOORE.length; i++) {
      const candidate = (from + i) % MOORE.length
      const [dx, dy] = MOORE[candidate]!
      if (filled(cx + dx, cy + dy)) {
        dir = candidate
        break
      }
    }
    // An isolated pixel has no filled neighbour at all.
    if (dir < 0) break

    if (cx === startX && cy === startY) {
      if (firstDir < 0) firstDir = dir
      else if (dir === firstDir) break
    }

    const [dx, dy] = MOORE[dir]!
    cx += dx
    cy += dy
    // We arrived from the neighbour opposite the step we took, and resume sweeping past it.
    from = (dir + 4) % MOORE.length
    contour.push([cx + 0.5, cy + 0.5])
  }

  // The walk ends standing on the start pixel, which is already the first point.
  if (contour.length > 1) {
    const last = contour[contour.length - 1]!
    if (last[0] === startX + 0.5 && last[1] === startY + 0.5) contour.pop()
  }

  return contour
}

/**
 * Douglas–Peucker, on a closed ring.
 *
 * A traced boundary is a staircase with one point per boundary pixel — a few hundred for a
 * region, all of them collinear in runs. Simplifying before the caller smooths is what keeps the
 * emitted path short enough to put sixty of them in one SVG, and it is also what stops a
 * Catmull-Rom through every pixel from rippling along each step.
 *
 * The ring is split at its two extreme points rather than at index zero, so the result does not
 * depend on where the raster scan happened to enter the blob.
 */
export function simplifyClosed(points: readonly XY[], tolerance: number): XY[] {
  if (points.length < 4) return points.slice()

  let far = 0
  let best = -1
  for (let i = 1; i < points.length; i++) {
    const d = distanceSquared(points[0]!, points[i]!)
    if (d > best) {
      best = d
      far = i
    }
  }

  const first = simplifyOpen(points.slice(0, far + 1), tolerance)
  const second = simplifyOpen(points.slice(far), tolerance)
  // Both halves carry the shared joint; drop the duplicates.
  return first.slice(0, -1).concat(second.slice(0, -1))
}

function simplifyOpen(points: readonly XY[], tolerance: number): XY[] {
  if (points.length < 3) return points.slice()
  const first = points[0]!
  const last = points[points.length - 1]!

  let index = -1
  let worst = tolerance * tolerance
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistanceSquared(points[i]!, first, last)
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (index < 0) return [first, last]

  const left = simplifyOpen(points.slice(0, index + 1), tolerance)
  const right = simplifyOpen(points.slice(index), tolerance)
  return left.slice(0, -1).concat(right)
}

function distanceSquared(a: XY, b: XY): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function segmentDistanceSquared(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return distanceSquared(p, a)
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  const px = a[0] + t * dx
  const py = a[1] + t * dy
  const ex = p[0] - px
  const ey = p[1] - py
  return ex * ex + ey * ey
}
