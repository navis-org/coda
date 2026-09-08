/**
 * Turning region meshes into a flat map of a brain.
 *
 * Everything geometric the ROIs widget does lives here, and none of it touches the DOM. That is
 * the same call `scatterPlot.ts` and `networkLayout.ts` record, for the same reason: jsdom has no
 * canvas and no WebGL, so anything left inside the component is covered by nothing at all.
 *
 * ## Three planes, and what having exactly three buys
 *
 * x/y, x/z and y/z — frontal, dorsal, lateral. There is no free camera, and that is not a
 * limitation worked around but the decision the rest of this design rests on.
 *
 * With an arbitrary camera the geometry has to be *kept*, because any angle can be asked for at
 * any moment: 29–62 MB of region mesh per dataset in the cache and tens of megabytes live. With
 * exactly three projections there are exactly three answers, so a region is fetched once,
 * flattened into all three, measured, and **discarded**. What survives is a few hundred kilobytes
 * of polyline — about three orders of magnitude less — and drawing becomes one transform over
 * cached points rather than a re-projection per frame.
 *
 * Two further consequences worth naming. The trace grid can be *larger* than an interactive
 * budget would allow, because it is paid once, so the outlines are crisper than a camera would
 * ever have permitted. And every view is reproducible: "frontal" is a claim anyone can check
 * against the picture, where a camera that happens to be pointing that way is a pair of angles
 * nobody can read off one.
 *
 * ## Outlines, not silhouettes
 *
 * Sixty overlapping neuropils painted solid lose the back half of the brain to the front half.
 * Stroking the boundary and filling it faintly keeps every region readable, and it is what makes
 * the picture exportable as real vector rather than as a bitmap.
 *
 * The boundary comes from a *raster* — fill the projected triangles, then walk the edge — rather
 * than from a sweep of angles about the centroid. That distinction is load-bearing and was got
 * wrong in the design mock: a radial sweep can only describe a star-shaped region, and neuropils
 * are not. The mushroom body lobes wrap around the peduncle and the gnathal ganglia are plainly
 * concave, so a swept outline silently fills in its own notches and draws each region larger than
 * it is.
 */

import type { MeshGeometry } from '../../core/values'
import type { XY } from '../raster'
import { fillTriangle, simplifyClosed, traceOutlines } from '../raster'

export type RoiView = 'frontal' | 'dorsal' | 'lateral'

/** Every view there is, in the order the controls offer them. */
export const ROI_VIEWS: readonly RoiView[] = ['frontal', 'dorsal', 'lateral']

/**
 * What the projection says a region is on screen.
 *
 * `rings` are closed polygons in *projection units* — the mesh's own coordinates flattened, not
 * pixels — so the viewer applies one transform at draw time and the geometry survives a resize
 * without being recomputed.
 */
export interface ProjectedRegion {
  /** Index into the mesh list it came from, so attribute rows line up. */
  index: number
  label: string
  /**
   * Closed rings, x,y interleaved, in projection units.
   *
   * Flat rather than an array of pairs because this *is* the stored form — `roiOutlines.ts`
   * caches it verbatim and IndexedDB structured-clones a `Float32Array` whole, where a few
   * thousand two-element arrays would be a few thousand objects. Keeping one representation also
   * removes a conversion that existed only to cross between them.
   */
  rings: Float32Array[]
  centre: XY
  /** Mean projected depth. Larger is further from the viewer. */
  depth: number
  /** The disc radius the explode solver treats this region as having. */
  radius: number
}

/**
 * How finely the boundary is traced, as pixels across the whole projected scene.
 *
 * Every region shares this scale rather than being fitted to a tile of its own, so the outline of
 * a small neuropil is no coarser than a large one's and two neighbours cannot disagree about
 * where their shared edge is by half a pixel each.
 *
 * **512 because this is paid once**, and that is the whole dividend of having three planes rather
 * than a camera. Measured over all three planes of a synthetic dataset, including the relaxation:
 *
 * | regions | grid | time  | cached |
 * |---------|------|-------|--------|
 * | 63      | 256  | 63ms  | 30 kB  |
 * | 63      | 512  | 108ms | 42 kB  |
 * | 144     | 256  | 166ms | 68 kB  |
 * | 144     | 512  | 291ms | 95 kB  |
 * | 144     | 768  | 472ms | 118 kB |
 *
 * A third of a second once, against a 29–62 MB download it happens after, is nothing; 768 buys
 * a quarter more points for another 60% of the time and stops being visible on screen. Note what
 * the last column is: the cache is *kilobytes* of polyline, where retaining the meshes to serve
 * an arbitrary camera would be tens of megabytes.
 */
export const TRACE_GRID = 512

/** Below this, a projected blob is a speck of a mesh seen edge-on rather than a region. */
const MIN_BLOB_PIXELS = 6

/** Douglas–Peucker tolerance, in trace pixels. Under a pixel, so only staircases collapse. */
const SIMPLIFY_PX = 0.75

/**
 * Project one vertex into the view plane.
 *
 * Returns `[screenX, screenY, depth]` with depth increasing away from the viewer, so a painter's
 * pass draws in descending depth order.
 *
 * The axes are anatomical: x runs medial to lateral, y dorsal to ventral, z anterior to
 * posterior. Frontal therefore looks down z, dorsal down y with anterior at the top, and lateral
 * down x with anterior to the left.
 */
export function projectPoint(
  x: number,
  y: number,
  z: number,
  view: RoiView,
): [number, number, number] {
  switch (view) {
    case 'frontal':
      return [x, y, z]
    case 'dorsal':
      return [x, z, y]
    case 'lateral':
      return [z, y, -x]
  }
}

/**
 * Flatten every region into outlines in the view plane.
 *
 * The expensive call in this module, and the one whose result is *the cached artefact*: it
 * rasterises and traces every region, so it is proportional to projected area. It depends on the
 * meshes and the plane and on nothing else — in particular not on the explode, which is applied
 * afterwards and only moves finished outlines.
 *
 * Called three times per dataset and never again. The meshes can be released the moment the
 * third call returns.
 */
export function projectRegions(
  meshes: readonly MeshGeometry[],
  view: RoiView,
  grid = TRACE_GRID,
): ProjectedRegion[] {
  const flat = meshes.map((mesh) => projectVertices(mesh, view))

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of flat) {
    if (item.minX < minX) minX = item.minX
    if (item.minY < minY) minY = item.minY
    if (item.maxX > maxX) maxX = item.maxX
    if (item.maxY > maxY) maxY = item.maxY
  }
  if (!Number.isFinite(minX)) return []

  const span = Math.max(maxX - minX, maxY - minY)
  // A scene with no extent at all — one degenerate mesh — would divide by zero here and produce
  // an infinite raster scale. Nothing to draw is a legitimate answer.
  if (!(span > 0)) return []
  const pixelsPerUnit = grid / span

  const regions: ProjectedRegion[] = []
  for (let index = 0; index < flat.length; index++) {
    const item = flat[index]!
    const mesh = meshes[index]!
    const rings = traceRegion(item, meshes[index]!, pixelsPerUnit)
    if (rings.length === 0) continue
    regions.push({
      index,
      label: mesh.id,
      rings,
      centre: [item.cx, item.cy],
      depth: item.depth,
      radius: item.radius,
    })
  }
  return regions
}

interface Flattened {
  /** Interleaved projected xy, one pair per vertex. */
  xy: Float64Array
  depth: number
  cx: number
  cy: number
  radius: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function projectVertices(mesh: MeshGeometry, view: RoiView): Flattened {
  const count = mesh.positions.length / 3
  const xy = new Float64Array(count * 2)
  let depth = 0
  let cx = 0
  let cy = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (let i = 0; i < count; i++) {
    const p = projectPoint(
      mesh.positions[i * 3]!,
      mesh.positions[i * 3 + 1]!,
      mesh.positions[i * 3 + 2]!,
      view,
    )
    xy[i * 2] = p[0]
    xy[i * 2 + 1] = p[1]
    depth += p[2]
    cx += p[0]
    cy += p[1]
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }

  if (count === 0) {
    return { xy, depth: 0, cx: 0, cy: 0, radius: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 }
  }
  cx /= count
  cy /= count

  /*
   * The disc radius the explode solver uses, as the 70th percentile vertex distance rather than
   * the maximum. A disc around the furthest vertex of an elongated neuropil — the peduncle is
   * three times longer than it is wide — claims far more room than the shape occupies, and every
   * neighbour pays for it in an arrangement that then needs a much larger frame.
   */
  const distances = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    distances[i] = Math.hypot(xy[i * 2]! - cx, xy[i * 2 + 1]! - cy)
  }
  distances.sort()
  const radius = distances[Math.min(count - 1, Math.floor(count * 0.7))] ?? 0

  return { xy, depth: depth / count, cx, cy, radius, minX, minY, maxX, maxY }
}

/** Rasterise one region's faces and walk the edges, returning rings in projection units. */
function traceRegion(
  item: Flattened,
  mesh: MeshGeometry,
  pixelsPerUnit: number,
): Float32Array[] {
  // One pixel of margin so a blob touching the mask edge still has an outside to walk along.
  const pad = 1
  const width = Math.max(1, Math.ceil((item.maxX - item.minX) * pixelsPerUnit) + pad * 2)
  const height = Math.max(1, Math.ceil((item.maxY - item.minY) * pixelsPerUnit) + pad * 2)
  const mask = new Uint8Array(width * height)

  const toPixelX = (x: number) => (x - item.minX) * pixelsPerUnit + pad
  const toPixelY = (y: number) => (y - item.minY) * pixelsPerUnit + pad

  const triangles = Math.floor(mesh.indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    const ia = mesh.indices[t * 3]!
    const ib = mesh.indices[t * 3 + 1]!
    const ic = mesh.indices[t * 3 + 2]!
    fillTriangle(
      mask,
      width,
      height,
      [toPixelX(item.xy[ia * 2]!), toPixelY(item.xy[ia * 2 + 1]!)],
      [toPixelX(item.xy[ib * 2]!), toPixelY(item.xy[ib * 2 + 1]!)],
      [toPixelX(item.xy[ic * 2]!), toPixelY(item.xy[ic * 2 + 1]!)],
    )
  }

  const rings: Float32Array[] = []
  for (const contour of traceOutlines(mask, width, height, MIN_BLOB_PIXELS)) {
    const simplified = simplifyClosed(contour, SIMPLIFY_PX)
    if (simplified.length < 3) continue
    const flat = new Float32Array(simplified.length * 2)
    for (let i = 0; i < simplified.length; i++) {
      flat[i * 2] = simplified[i]![0] / pixelsPerUnit + item.minX - pad / pixelsPerUnit
      flat[i * 2 + 1] = simplified[i]![1] / pixelsPerUnit + item.minY - pad / pixelsPerUnit
    }
    rings.push(flat)
  }
  return rings
}

// ---------------------------------------------------------------------------
// Left and right
// ---------------------------------------------------------------------------

export type RoiSide = 'left' | 'right'

/**
 * Which half a region is in, or undefined for one that spans the midline.
 *
 * The `(L)` / `(R)` suffix is the convention every dataset here follows for a lateralised
 * region — `ME(R)`, `a'L(L)` — and midline structures carry no suffix at all: `FB`, `EB`, `PB`,
 * `GNG`. So an absent side is a real answer rather than a parse failure, and a caller has to
 * read it as "spans the midline" rather than as "unknown".
 *
 * This lives beside the explode rather than with the colours because it stopped being a
 * presentation detail the moment the relaxation started pairing regions with it.
 */
export function regionSide(roi: string): RoiSide | undefined {
  const match = /\((L|R)\)(?![^(]*\((L|R)\))/.exec(roi)
  if (!match) return undefined
  return match[1] === 'L' ? 'left' : 'right'
}

/**
 * What two homologous regions have in common: their name with the side taken out.
 *
 * `ME(L)` and `ME(R)` both key on `ME()`, and `ME(R)_col_12` keys on `ME()_col_12`, so a
 * sub-region pairs with its own twin rather than with its parent. A region with no side keys on
 * itself and pairs with nothing.
 */
export function homologyKey(roi: string): string {
  return roi.replace(/\((L|R)\)(?![^(]*\((L|R)\))/, '()')
}

// ---------------------------------------------------------------------------
// Explode
// ---------------------------------------------------------------------------

/** How much clear air a separated pair keeps. */
const RELAX_PAD = 1.04
/** A weak pull back toward where the region really is. See below. */
const RELAX_ANCHOR = 0.05
/** Measured: the layout at this many passes is indistinguishable from one at 800. */
const RELAX_ITERS = 220

/**
 * How much an overlap prefers to resolve sideways.
 *
 * A screen is wider than it is tall and a brain is wider than it is tall, so vertical room is the
 * scarce kind — an arrangement that spreads evenly in both directions is fitted to the axis it
 * has least of, and every region ends up smaller than it needed to be. The push direction is
 * therefore rotated toward the horizontal before it is applied.
 *
 * A *bias*, not a constraint: a pair sitting exactly one above the other still separates
 * vertically, because there is no other way to separate it. What this changes is every diagonal
 * case, which is most of them.
 *
 * **1.7 is measured, and the useful metric is frame fill rather than aspect.** Share of a
 * 620×460 card the exploded arrangement covers, on a synthetic bilateral brain:
 *
 * | bias | frontal | dorsal | lateral |
 * |------|---------|--------|---------|
 * | 1.0  | 62%     | 99%    | 62%     |
 * | 1.7  | 97%     | 99%    | 98%     |
 * | 2.4  | 73%     | 69%    | 92%     |
 *
 * Unbiased, the frontal arrangement explodes into a *portrait* block (aspect 0.83) and wastes
 * nearly two fifths of a landscape card. Past 1.7 it over-corrects into a letterbox and the fill
 * falls again, so this is an optimum rather than "more is better". Overlaps at full explode are
 * unchanged across the range.
 */
const LATERAL_BIAS = 1.7

/**
 * What the slider's 100% means.
 *
 * The relaxation solves for *just* separated — no two discs overlapping, and nothing beyond
 * that — which on screen reads as a set of regions that have only barely stopped touching. The
 * gain is what makes full explode look like a decision rather than the minimum that satisfied
 * the solver. It scales the finished displacements, so it costs nothing and preserves the
 * symmetry constraint exactly.
 */
const EXPLODE_GAIN = 1.5

/**
 * Where each region slides to when the explode is at full.
 *
 * **The obvious rule does not work.** Sliding each region away from the scene's centroid, scaled
 * by a factor, is a *homothety* — scaling every centre about one point is a uniform scale of the
 * whole arrangement. The shapes do not scale with it, so once the frame is refitted the only
 * thing anyone perceives is the regions getting smaller. It reads as pulling the camera back,
 * which is the opposite of what an exploded view is for.
 *
 * So this is nat.ggplot's rule instead: treat each region as a disc *in the projected plane* and
 * let overlapping pairs nudge apart until none overlap. Non-uniform by construction — a densely
 * stacked group spreads and an already-isolated region barely moves — so the picture un-stacks
 * rather than scaling. Solving it in the view plane is the other half: separation is guaranteed
 * in the projection being looked at, which a push through 3D never promises, since two regions
 * far apart in depth can sit exactly on top of each other on screen.
 *
 * ## Homologous regions move as mirror images
 *
 * Left unconstrained, the solve treats `ME(L)` and `ME(R)` as two unrelated discs and gives them
 * whatever displacements the collision order happens to produce — so a bilaterally symmetric
 * brain explodes into a lopsided arrangement, which reads as a mistake because the anatomy it is
 * drawn from plainly is not lopsided. Each pass therefore projects the shifts onto the symmetric
 * subspace: a pair's screen-x displacements are averaged to opposites and its screen-y
 * displacements to a common value, and a midline structure is held on the midline.
 *
 * Enforced *inside* the loop rather than applied once at the end. Symmetrising a finished layout
 * moves regions after the last collision check and can push them back into each other; a
 * constraint projected every pass is one the separation is solved subject to.
 *
 * **Only in the two planes where the midline is on screen.** Frontal and dorsal both keep
 * anatomical x as their horizontal axis, so a mirror negates screen dx. Lateral projects *down*
 * x — the mirror axis is the depth axis — so homologous regions land on exactly the same point
 * and "mirrored" degenerates to "identical". Constraining them there would pin every twin
 * superimposed forever, which is the one thing the explode is there to fix in that view.
 *
 * Measured on a synthetic bilateral brain, worst pair mirror error against a shift scale of
 * ~7,700 units, and mean visible area at full explode:
 *
 * | plane   | mirror error   | visible        |
 * |---------|----------------|----------------|
 * | frontal | 11,283 → 0     | 95% → 94%      |
 * | dorsal  | 2,545 → 0      | 79% → 81%      |
 * | lateral | unconstrained  | 93%            |
 *
 * The free solve was putting pairs further out of step than the displacements themselves. The
 * constraint costs at most a point of visibility and dorsal *gains* two, because shrinking the
 * search space lands it on a better arrangement rather than a worse one.
 *
 * Returned as displacements at full explode. The caller scales them, so the slider costs no
 * solve — this depends on the projection and on nothing else.
 */
export function relaxShifts(
  regions: readonly ProjectedRegion[],
  view: RoiView = 'frontal',
): Float64Array {
  const n = regions.length
  const pos = new Float64Array(n * 2)
  const base = new Float64Array(n * 2)
  const rad = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const region = regions[i]!
    base[i * 2] = region.centre[0]
    base[i * 2 + 1] = region.centre[1]
    pos[i * 2] = region.centre[0]
    pos[i * 2 + 1] = region.centre[1]
    rad[i] = region.radius
  }

  // Lateral has no in-plane mirror; see above.
  const symmetry = view === 'lateral' ? undefined : bilateralGroups(regions)

  for (let pass = 0; pass < RELAX_ITERS; pass++) {
    let move = 0
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i * 2]! - pos[j * 2]!
        const dy = pos[i * 2 + 1]! - pos[j * 2 + 1]!
        let dd = Math.hypot(dx, dy)
        const need = (rad[i]! + rad[j]!) * RELAX_PAD
        if (dd >= need) continue
        let ux: number
        let uy: number
        /*
         * Exactly coincident centres have no separating direction, and this is not a
         * hypothetical: the lateral plane throws away the axis the two hemispheres differ along,
         * so on a whole brain every left/right twin projects onto the same point. The nudge is
         * keyed to the index rather than randomised, because two renders of one graph must not
         * disagree.
         */
        if (dd < 1e-6) {
          ux = Math.cos(i)
          uy = Math.sin(i)
          dd = 1e-6
        } else {
          ux = dx / dd
          uy = dy / dd
        }
        // Rotate the push toward the horizontal, then renormalise so the *amount* of separation
        // is unchanged — only its direction. A purely vertical overlap is left alone by this,
        // since scaling a zero x component still yields zero.
        const bx = ux * LATERAL_BIAS
        const by = uy / LATERAL_BIAS
        const blen = Math.hypot(bx, by) || 1
        ux = bx / blen
        uy = by / blen
        const push = (need - dd) / 2
        pos[i * 2] = pos[i * 2]! + ux * push
        pos[i * 2 + 1] = pos[i * 2 + 1]! + uy * push
        pos[j * 2] = pos[j * 2]! - ux * push
        pos[j * 2 + 1] = pos[j * 2 + 1]! - uy * push
        if (push > move) move = push
      }
    }
    /*
     * Pure separation has no restoring force, so a chain of pushes drifts outward and the frame
     * has to grow to hold it. The anchor bounds that and gives the loop a fixed point. It is
     * weak on purpose: measured against how much of each region is left visible, 0.05 buys the
     * compactness almost free, where 0.22 gives back a third of the visibility to save a tenth
     * of the growth.
     */
    for (let i = 0; i < n * 2; i++) pos[i] = pos[i]! + (base[i]! - pos[i]!) * RELAX_ANCHOR
    if (symmetry) symmetrise(pos, base, symmetry)
    // The anchor holds this at an equilibrium rather than a standstill, so the early exit is a
    // backstop and rarely fires; what settles it is the measured iteration count.
    if (move < 0.02) break
  }

  const shifts = new Float64Array(n * 2)
  for (let i = 0; i < n * 2; i++) shifts[i] = (pos[i]! - base[i]!) * EXPLODE_GAIN
  return shifts
}

interface Bilateral {
  /** Index pairs that are each other's mirror image. */
  pairs: Array<[number, number]>
  /** Regions with no side in their name, which must not drift off the midline. */
  midline: number[]
}

/**
 * Pair up the regions that are each other's reflection.
 *
 * A name that appears three times — which no dataset here produces — pairs the first two and
 * leaves the rest unconstrained rather than picking arbitrarily among them.
 *
 * Answers `undefined` when there is nothing bilateral to preserve. That is the hemibrain case
 * for most of its regions, and it matters: pinning a midline structure's sideways travel buys
 * symmetry that a half brain does not have, while still costing the solver a degree of freedom
 * it could have used to separate something.
 */
function bilateralGroups(regions: readonly ProjectedRegion[]): Bilateral | undefined {
  const bySide = new Map<string, { left?: number; right?: number }>()
  const midline: number[] = []

  for (let i = 0; i < regions.length; i++) {
    const label = regions[i]!.label
    const side = regionSide(label)
    if (!side) {
      midline.push(i)
      continue
    }
    const key = homologyKey(label)
    const slot = bySide.get(key) ?? {}
    if (slot[side] === undefined) slot[side] = i
    bySide.set(key, slot)
  }

  const pairs: Array<[number, number]> = []
  for (const slot of bySide.values()) {
    if (slot.left !== undefined && slot.right !== undefined) pairs.push([slot.right, slot.left])
  }
  if (pairs.length === 0) return undefined
  return { pairs, midline }
}

/**
 * Project the current displacements onto the symmetric subspace.
 *
 * A displacement mirrors as `(-dx, dy)` whatever the midline's position, so this needs no axis:
 * a pair's x components are averaged to opposites and its y components to a common value. That
 * is the nearest symmetric answer to what the collision pass just produced, rather than one of
 * the two being copied onto the other — copying would let whichever index happened to be first
 * dictate the arrangement.
 */
function symmetrise(pos: Float64Array, base: Float64Array, groups: Bilateral): void {
  for (const [right, left] of groups.pairs) {
    const dxr = pos[right * 2]! - base[right * 2]!
    const dyr = pos[right * 2 + 1]! - base[right * 2 + 1]!
    const dxl = pos[left * 2]! - base[left * 2]!
    const dyl = pos[left * 2 + 1]! - base[left * 2 + 1]!

    const dx = (dxr - dxl) / 2
    const dy = (dyr + dyl) / 2

    pos[right * 2] = base[right * 2]! + dx
    pos[right * 2 + 1] = base[right * 2 + 1]! + dy
    pos[left * 2] = base[left * 2]! - dx
    pos[left * 2 + 1] = base[left * 2 + 1]! + dy
  }
  // A midline structure that slid sideways would break the one axis the picture can be read
  // against. It may still move along the midline, which is where the room is anyway.
  for (const i of groups.midline) pos[i * 2] = base[i * 2]!
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export interface Frame {
  scale: number
  offsetX: number
  offsetY: number
  /**
   * The scene's extent in projection units, as drawn.
   *
   * What the fit was computed from, and therefore what a zoom window is clamped against — so
   * the pan bound and the framing cannot disagree about where the scene ends. Carried on the
   * frame rather than recomputed by the caller because it is the same sweep either way, and a
   * second one would be a second answer. It moves with the explode, which is what keeps a
   * manual zoom clamped to the arrangement actually on screen rather than to a larger one.
   *
   * On a frame `windowFrame` returned it is carried through unchanged, so it always means "the
   * scene this was fitted from" and never "what this frame shows" — which is what the clamp
   * wants, and the opposite of what the name suggests once a zoom is involved.
   */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * What part of the projection is on screen.
 *
 * `HeatmapWindow`'s idea in the units this viewer has: a magnification over the fitted frame
 * and the projection-unit point held at the centre of the box. **Not a transform over the
 * drawing** — that is the trap both the heatmap and the dendrogram record, and it bites harder
 * here: an SVG `transform` on the scene scales the stroke widths and carries every region name
 * with it, so zooming in would magnify the labels rather than reveal more of them.
 *
 * In projection units and not pixels, for `HeatmapWindow`'s reason: a resize then keeps what is
 * on screen on screen, where a pan stored in pixels would slide the picture whenever the card
 * changed size. The fitted state is `undefined` at the viewer, never `{ zoom: 1 }` — one
 * spelling of "not zoomed", so the ⤢ button's disabled state and the caption cannot disagree.
 *
 * Two axes and one magnification, `zoomWindow`'s rule one viewer over: these are real
 * coordinates in nanometres, so an axis zoomed alone would draw a neuropil the wrong shape.
 */
export interface RoiWindow {
  /** Magnification over the fitted frame. 1 is the fit; below it is clamped away. */
  zoom: number
  /** The projection-unit point held at the centre of the box. */
  cx: number
  cy: number
}

/**
 * How far in a zoom may go.
 *
 * A ceiling rather than a taste: what is drawn is a polyline traced on a `TRACE_GRID` raster
 * spanning the **whole scene**, so its vertices are at best `scene / 512` apart and no zoom can
 * recover detail finer than that. On a 620px card at magnification Z the spacing on screen is
 * about `620 · Z / 512` pixels — past 8 that is a visible staircase, and what a further zoom
 * adds is a larger picture of the tracer's own pixels rather than more of the region.
 */
export const MAX_ROI_ZOOM = 8

/**
 * Per-region bounding boxes and areas, from one pass over the vertices.
 *
 * Both are hoisted out of the per-frame work, and for the same reason a shift allows it: a
 * displacement is a **rigid translation**, so a region's box moves with it and never changes
 * shape, and its area does not move at all. That makes the whole-scene extent at any explode a
 * loop over `n` boxes rather than over every vertex, and makes the label ranking free of the
 * window entirely.
 *
 * One function rather than two because they are one traversal — identical iteration over the
 * same `ring[at]`/`ring[at + 1]` reads, and no caller has ever wanted one without the other. At
 * 5,619 regions that traversal is on the order of a million point visits, so doing it twice was
 * paying the whole cost the hoist was for.
 *
 * `bounds` is `minX, minY, maxX, maxY` per region; `areas` is one shoelace total per region.
 */
export function regionGeometry(regions: readonly ProjectedRegion[]): {
  bounds: Float64Array
  areas: Float64Array
} {
  const bounds = new Float64Array(regions.length * 4)
  const areas = new Float64Array(regions.length)
  for (let i = 0; i < regions.length; i++) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let area = 0
    for (const ring of regions[i]!.rings) {
      area += ringArea(ring)
      for (let at = 0; at < ring.length; at += 2) {
        const px = ring[at]!
        const py = ring[at + 1]!
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
      }
    }
    bounds[i * 4] = minX
    bounds[i * 4 + 1] = minY
    bounds[i * 4 + 2] = maxX
    bounds[i * 4 + 3] = maxY
    areas[i] = area
  }
  return { bounds, areas }
}

/**
 * The transform that puts the scene in a box: **the arrangement it is handed, not a future one.**
 *
 * This was the other way round, framing at *full* explode for every value of the slider, and the
 * argument for it does not survive contact with `relaxShifts`. It was a defence against the
 * **radial** explode, which is a homothety: scaling every centre about one point leaves the
 * arrangement identical and only larger, so a frame that chased it made size the one thing
 * changing on screen and the gesture read as pulling the camera back. `relaxShifts` is not a
 * homothety — regions move *relative to each other* — so refitting reveals separation rather
 * than hiding it, and the failure that reserved the space belonged to the mechanism that was
 * replaced.
 *
 * What holding it cost was the whole picture. At rest the scene was drawn at 71–81% of the
 * available scale on a half brain and 64–87% on a whole one — and those were measurements on
 * *primary* regions. With `Primary regions only` off, the relaxation separates every nested
 * sub-region as well, so hemibrain's 218 drawn regions reserve room for an arrangement several
 * times the brain and the resting map occupies a corner of the card.
 *
 * The caller passes the shifts it is actually drawing with (`explodedShifts`), so "what is on
 * screen" has one definition that the frame, the rings and the labels all read. It takes
 * `regionBounds`' boxes rather than the regions, because that sweep is now per slider step.
 */
export function fitFrame(
  bounds: Float64Array,
  shifts: Float64Array,
  width: number,
  height: number,
  padding = 10,
): Frame {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const count = bounds.length / 4
  for (let i = 0; i < count; i++) {
    const dx = shifts[i * 2] ?? 0
    const dy = shifts[i * 2 + 1] ?? 0
    const x0 = bounds[i * 4]! + dx
    const y0 = bounds[i * 4 + 1]! + dy
    const x1 = bounds[i * 4 + 2]! + dx
    const y1 = bounds[i * 4 + 3]! + dy
    if (x0 < minX) minX = x0
    if (x1 > maxX) maxX = x1
    if (y0 < minY) minY = y0
    if (y1 > maxY) maxY = y1
  }
  if (!Number.isFinite(minX))
    return { scale: 1, offsetX: 0, offsetY: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }

  const innerW = Math.max(1, width - padding * 2)
  const innerH = Math.max(1, height - padding * 2)
  const scale = Math.min(
    innerW / Math.max(1e-6, maxX - minX),
    innerH / Math.max(1e-6, maxY - minY),
  )
  return {
    scale,
    offsetX: padding + (innerW - (maxX - minX) * scale) / 2 - minX * scale,
    offsetY: padding + (innerH - (maxY - minY) * scale) / 2 - minY * scale,
    bounds: { minX, minY, maxX, maxY },
  }
}

/**
 * The projection point under a pixel of the box. `ringPath`'s arithmetic read backwards.
 */
export function pointToScene(frame: Frame, x: number, y: number): [number, number] {
  return [(x - frame.offsetX) / frame.scale, (y - frame.offsetY) / frame.scale]
}

/**
 * Keep a window over the scene and inside the magnification range.
 *
 * The centre is bounded per axis by what is left over: with the visible span wider than the
 * scene there is nothing to pan along, so the centre is *pinned* to the scene's — which is what
 * makes `zoom: 1` reproduce the fit exactly rather than approximately, and why the viewer needs
 * no separate "is this the fit" arithmetic. Clamped on the way out as well as in, since the
 * scene changes under a stored window whenever the region filters move.
 */
function clampRoiWindow(
  window: RoiWindow,
  fit: Frame,
  width: number,
  height: number,
): RoiWindow {
  const zoom = Math.min(MAX_ROI_ZOOM, Math.max(1, window.zoom))
  const scale = fit.scale * zoom
  const { minX, minY, maxX, maxY } = fit.bounds
  const halfW = width / 2 / Math.max(1e-9, scale)
  const halfH = height / 2 / Math.max(1e-9, scale)
  const axis = (lo: number, hi: number, half: number, want: number): number =>
    hi - lo <= half * 2 ? (lo + hi) / 2 : Math.min(Math.max(want, lo + half), hi - half)
  return {
    zoom,
    cx: axis(minX, maxX, halfW, window.cx),
    cy: axis(minY, maxY, halfH, window.cy),
  }
}

/** The frame a window draws through — the fit restated at its magnification and centre. */
export function windowFrame(
  fit: Frame,
  window: RoiWindow | undefined,
  width: number,
  height: number,
): Frame {
  if (!window || window.zoom <= 1) return fit
  const clamped = clampRoiWindow(window, fit, width, height)
  const scale = fit.scale * clamped.zoom
  return {
    scale,
    offsetX: width / 2 - clamped.cx * scale,
    offsetY: height / 2 - clamped.cy * scale,
    bounds: fit.bounds,
  }
}

/**
 * Zoom about a pixel of the box — the point of the scene under it is the one that must not move.
 *
 * `factor` above 1 zooms out, `useWheelZoom`'s convention.
 */
export function zoomRoiWindow(
  fit: Frame,
  window: RoiWindow | undefined,
  x: number,
  y: number,
  factor: number,
  width: number,
  height: number,
): RoiWindow {
  // `windowFrame` already answers `undefined` with the fit itself, so there is no fitted window
  // to construct here — at magnification 1 the clamp would only rediscover the fit's own centre.
  const [ax, ay] = pointToScene(windowFrame(fit, window, width, height), x, y)
  const zoom = Math.min(MAX_ROI_ZOOM, Math.max(1, (window?.zoom ?? 1) / factor))
  const scale = fit.scale * zoom
  return clampRoiWindow(
    { zoom, cx: ax + (width / 2 - x) / scale, cy: ay + (height / 2 - y) / scale },
    fit,
    width,
    height,
  )
}

/**
 * `relaxShifts`' displacements at the slider's setting.
 *
 * One definition of "where a region is drawn", because there are four readers — the frame, the
 * rings, the labels and the label thinning — and each of them multiplying by the fraction itself
 * is how the frame comes to be fitted to an arrangement nothing draws. Which is exactly what
 * this viewer did.
 *
 * Returns the input by identity at full explode. Everything else allocates once per (shifts,
 * slider value) — this is memoised at the caller, not called per frame.
 */
export function explodedShifts(shifts: Float64Array, fraction: number): Float64Array {
  if (fraction >= 1) return shifts
  const out = new Float64Array(shifts.length)
  if (fraction <= 0) return out
  for (let i = 0; i < shifts.length; i++) out[i] = shifts[i]! * fraction
  return out
}

/** Below this share of what is on screen, a region is too small to carry its own name. */
const MIN_LABEL_AREA = 0.004

/**
 * How many names the automatic mode draws before it starts thinning.
 *
 * Beside `MIN_LABEL_AREA` because they are one policy: how crowded a map may get. It lived in
 * the component and reached this function as an argument, which put half the rule in each of two
 * modules. Still a parameter, so a test can ask what the ranking does at other budgets.
 */
export const MAX_AUTO_LABELS = 18

/** Shoelace, for ranking which regions are big enough to carry a label. */
function ringArea(ring: Float32Array): number {
  let sum = 0
  const points = ring.length / 2
  for (let i = 0; i < points; i++) {
    const j = (i + 1) % points
    sum += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!
  }
  return Math.abs(sum) / 2
}

/**
 * Which regions get a name drawn on them: the biggest, capped, and **on screen**.
 *
 * The window half is what makes a zoom worth doing. Ranked over every region regardless, a
 * magnified card spends its whole label budget on neuropils that are no longer in the box — so
 * zooming in on a crowded corner showed *fewer* names than the fitted picture, which is the
 * opposite of the reason anyone zoomed. `visibleLeaves` is the same rule one viewer over.
 *
 * The threshold is a share of what is *visible* rather than of the scene, for the same reason:
 * a region that is a thousandth of a brain can be half of what is on screen at ×8.
 *
 * At the fit this is exactly what it always was — everything `fitFrame` framed is in the box by
 * construction, so the pool is every region and the denominator is the whole scene.
 *
 * Headless because jsdom performs no layout: inside the component none of this is covered.
 */
export function autoLabelled(
  centres: ReadonlyArray<{ centre: readonly [number, number] }>,
  /** `regionAreas`', which no gesture can change. */
  areas: Float64Array,
  /** As drawn — `explodedShifts`', so a label is judged where its region actually is. */
  shifts: Float64Array,
  frame: Frame,
  width: number,
  height: number,
  limit = MAX_AUTO_LABELS,
): number[] {
  const pool: number[] = []
  let visible = 0
  for (let i = 0; i < centres.length; i++) {
    const centre = centres[i]!.centre
    const px = (centre[0] + (shifts[i * 2] ?? 0)) * frame.scale + frame.offsetX
    const py = (centre[1] + (shifts[i * 2 + 1] ?? 0)) * frame.scale + frame.offsetY
    if (px < 0 || px > width || py < 0 || py > height) continue
    visible += areas[i]!
    pool.push(i)
  }
  /*
   * The floor first, then the ranking. That order is what keeps the sort cheap without needing a
   * bounded insertion in its place: a region under `MIN_LABEL_AREA` of what is on screen cannot
   * be in the top `limit` of it, so by the time anything is compared the list is the handful of
   * regions big enough to carry a name rather than the thousands that were projected.
   */
  const floor = (visible || 1) * MIN_LABEL_AREA
  return pool
    .filter((index) => areas[index]! >= floor)
    .sort((a, b) => areas[b]! - areas[a]!)
    .slice(0, limit)
}

/** Drag by pixels: the scene follows the pointer, so the centre moves against it. */
export function panRoiWindow(
  fit: Frame,
  window: RoiWindow | undefined,
  dx: number,
  dy: number,
  width: number,
  height: number,
): RoiWindow {
  // The clamp pins the centre at magnification 1, so an unzoomed window needs no centre here.
  const current = window ?? { zoom: 1, cx: 0, cy: 0 }
  const scale = fit.scale * current.zoom
  return clampRoiWindow(
    { zoom: current.zoom, cx: current.cx - dx / scale, cy: current.cy - dy / scale },
    fit,
    width,
    height,
  )
}

// ---------------------------------------------------------------------------
// What the mesh knows about itself
// ---------------------------------------------------------------------------

/**
 * Enclosed volume, by the divergence theorem.
 *
 * Free once the mesh has been downloaded, and nothing else in Coda can say it — which is what
 * makes it worth carrying: a region's synapse density is its synapse count over this, and that
 * is a comparison between regions that no published table offers.
 *
 * Absolute value, because winding order is a property of whoever exported the mesh and a
 * consistently inside-out one would otherwise report a negative volume. A mesh that is not
 * closed gives a number that is wrong rather than an error; there is no cheap test for closure,
 * and every source here publishes closed shells.
 */
export function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0
  const triangles = Math.floor(indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3]! * 3
    const b = indices[t * 3 + 1]! * 3
    const c = indices[t * 3 + 2]! * 3
    const ax = positions[a]!
    const ay = positions[a + 1]!
    const az = positions[a + 2]!
    const bx = positions[b]!
    const by = positions[b + 1]!
    const bz = positions[b + 2]!
    const cx = positions[c]!
    const cy = positions[c + 1]!
    const cz = positions[c + 2]!
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return Math.abs(sum) / 6
}

/** Total triangle area. Reported beside the volume, where a shell's roughness is worth seeing. */
export function meshSurfaceArea(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0
  const triangles = Math.floor(indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3]! * 3
    const b = indices[t * 3 + 1]! * 3
    const c = indices[t * 3 + 2]! * 3
    const ux = positions[b]! - positions[a]!
    const uy = positions[b + 1]! - positions[a + 1]!
    const uz = positions[b + 2]! - positions[a + 2]!
    const vx = positions[c]! - positions[a]!
    const vy = positions[c + 1]! - positions[a + 1]!
    const vz = positions[c + 2]! - positions[a + 2]!
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    sum += Math.hypot(nx, ny, nz) / 2
  }
  return sum
}
