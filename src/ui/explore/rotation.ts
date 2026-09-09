/**
 * The rocking preview: one neuron swept ±45° about the vertical screen axis.
 *
 * Pure arithmetic and no DOM, exactly as `thumbnail.ts` is and for the same reason — there is no
 * WebGL in jsdom and no browser automation in this repo, so anything that only existed inside a
 * component would have no coverage at all. This module turns one `CoarseGeometry` into a set of
 * coverage masks; the component flips through them.
 *
 * ## Why a rotation rather than a bigger picture
 *
 * A silhouette is a projection, and the one thing a projection cannot show is which of two
 * crossing neurites is in front. `DEPTH_FLOOR` shades for it, which reads as *some* depth but not
 * as structure. Motion parallax does: a ±45° rock about the vertical is the classic wiggle
 * stereo, and the horizontal component is the one the visual system actually uses for depth —
 * which is why this sweeps about the vertical axis and not the horizontal one.
 *
 * ## Three things the static path could ignore and this cannot
 *
 *  - **One fit for the whole sweep.** `fitToTile` derives its box from the positions handed to
 *    it, so a per-frame fit re-frames every frame to its own rotated bounds and the neuron
 *    *pulses* as it turns — and its depth ramp breathes with it, since the same box normalises z.
 *    `sweptBounds` computes one box over every angle that will be drawn, and every frame is
 *    rasterised through it. This is why both rasterisers take an optional box rather than this
 *    module owning a second projection: the fit is where the visual identity lives and two of
 *    them drift.
 *  - **Decimation, for the one route that needs it most.** A traced CATMAID arbor is 16,840
 *    nodes and rasterises at 74 ms a frame — 1.2 s for a sweep, on the main thread. It is also
 *    the route with no finer level of detail to fetch, so rotation is the only way to add
 *    anything to it at all. Most of those segments are sub-pixel at a 640px raster, so
 *    `decimateSkeleton` keeps the shape and drops the nodes that were never separately visible.
 *  - **A bounded ancestor walk.** Decimation reparents a kept node onto its nearest kept
 *    ancestor, which is the first thing in this file's neighbourhood to walk a parent *chain*.
 *    `rasteriseSkeleton` only ever draws `i → parents[i]`, one hop, so it is immune to what this
 *    is not: **`parents[i] < i` does not hold on every route.** `spanningForest` guarantees it
 *    for CAVE's L2 skeletons and for the precomputed ones, but CATMAID's `decodeCompactSkeleton`
 *    maps the server's own node order straight through, so a parent may appear *after* its child.
 *    The walk is therefore order-independent, and it is capped, because a malformed skeleton with
 *    a cycle is the failure `data/skeletonTree.ts` exists to prevent and it hangs the tab.
 */

import type { Bounds3 } from '../../core/values'
import { EMPTY_BOUNDS, boundsCenter, boundsOf } from '../../core/values'
import type { Silhouette } from './thumbnail'
import { rasteriseSilhouette, rasteriseSkeleton } from './thumbnail'

/** Half the sweep, in degrees: the neuron rocks from −45° to +45° and back. */
const SWEEP_DEGREES = 45

/**
 * Frames spanning the whole sweep.
 *
 * 17 across 90° is 5.6° a step, which at a ~1.2 s half-cycle is about 30 fps of apparent motion —
 * fast enough that the steps stop reading as steps. One set of masks covers the whole rock, since
 * the motion revisits every angle: a 360° turntable would need every frame stored, this needs one
 * sweep's worth played back and forth.
 *
 * **Odd, and that is load-bearing.** The rock starts and ends at the *thumbnail's* view — the
 * unrotated one the static mask shows — so there has to be a frame at exactly 0°, which an even
 * count does not have. At 16 the nearest frames sit at ±2.8°, so the crossfade from the static
 * picture would begin on a view that is visibly not the static picture.
 */
export const ROTATION_FRAMES = 17

/**
 * Above this many skeleton nodes, decimate before rasterising.
 *
 * 3,000 nodes into a 640px raster is about one node per 140 pixels of area, well past the point
 * where a node is separately visible.
 *
 * **It now buys almost nothing, and that is worth knowing before anyone tunes it.** When this cap
 * was chosen, decimating a 16,840-node arbor took a 640² frame from 76.5 ms to 28.0 — 2.7×, all of
 * it per-segment stamping overhead rather than fill. `drawSegment` has since stopped re-stamping
 * a full square at every pixel step, and with that gone the same measurement is **4.8 ms a frame
 * undecimated against 4.7 decimated**: the cost is the drawn path, which thinning a run conserves
 * by construction. What the cap still buys is allocation and the rotate pass, not the raster.
 *
 * It stays because the *drawing* it produces is the one the static mask is drawn from too, so
 * removing it would make the two disagree again — but a future reader should not expect a lower
 * cap to buy frame time, and the honest reason to revisit it is picture quality rather than speed.
 *
 * Meshes are never decimated: a coarse mesh is ~950 triangles and the finer body `detail: 'fine'`
 * fetches is ~28k, and a whole sweep of those is ~22 ms.
 */
export const DECIMATE_MAX_NODES = 3000

/** What `decimateSkeleton` takes and gives back: a skeleton's node arrays, radii optional. */
export interface DecimatableSkeleton {
  positions: Float32Array
  parents: Int32Array
  radii?: Float32Array
}

/** How far the ancestor walk may climb before deciding the tree is malformed. */
const MAX_ANCESTOR_STEPS = 64

/** The angles drawn, in radians, from −sweep to +sweep inclusive. */
export function frameAngles(frames = ROTATION_FRAMES, sweepDegrees = SWEEP_DEGREES): number[] {
  if (frames < 2) return [0]
  const sweep = (sweepDegrees * Math.PI) / 180
  return Array.from({ length: frames }, (_, i) => -sweep + (2 * sweep * i) / (frames - 1))
}

/**
 * The point a neuron turns about: the centre of its own bounding box.
 *
 * **Not the origin, which is what this had and what the sweep visibly did wrong.** Positions are
 * nanometres in *dataset* space, so a neuron sits hundreds of microns from the volume's origin —
 * rotating about that swings it round an enormous arc instead of turning it in place, and because
 * `sweptBounds` then has to cover the whole arc, the fit shrinks the neuron to a smudge sliding
 * across the tile. The symptom reads as "rocking about some other point", which is exactly what it
 * is.
 *
 * The bounding-box centre rather than the vertex centroid, of two defensible answers. A centroid
 * is mass-weighted, so it sits inside whichever part is most densely tessellated — the arbor on a
 * mesh, the traced tuft on a skeleton — and turning about it leaves that part still while the long
 * axon sweeps hardest, which is both asymmetric and wider through the sweep. The box centre keeps
 * the motion even and `sweptBounds` tightest, so the neuron is drawn as large as the tile allows.
 * Swapping it for a centroid is this function and nothing else.
 */
export function pivotOf(positions: Float32Array): [number, number, number] {
  // `boundsOf` is memoised per buffer, and `thumbnail.ts` asks it about this same one — so the
  // scan is shared rather than repeated. Its degenerate answer is `EMPTY_BOUNDS`, whose centre is
  // the origin, which is what this wants for empty geometry anyway.
  return boundsCenter(boundsOf([positions]))
}

/**
 * Rotate about the vertical screen axis, through `pivot`.
 *
 * Image-space axes as `thumbnail.ts` uses them — X across, Y down, Z depth — so the vertical
 * screen axis is Y and this leaves Y alone. A fresh buffer rather than an in-place rewrite,
 * because the caller holds the source geometry for every other frame.
 *
 * The pivot defaults to the origin, which is the identity-preserving choice for a caller that has
 * already centred its geometry — but no caller here has. See `pivotOf`.
 */
export function rotateY(
  positions: Float32Array,
  theta: number,
  pivot: readonly [number, number, number] = [0, 0, 0],
): Float32Array {
  return rotateYInto(new Float32Array(positions.length), positions, theta, pivot)
}

/**
 * The same rotation into a caller's buffer.
 *
 * `createRotation` reuses one scratch array for all 17 frames: `render` hands the rotated
 * positions straight to a rasteriser that reads them and returns a mask before it returns, so
 * nothing outside `render` ever sees the buffer. Measured over a sweep at 14k vertices, 0.552 ms
 * and 2.7 MiB of transient `Float32Array` becomes 0.382 ms and none. `rotateY` above stays the
 * allocating entry point, which is what the tests and any future caller want.
 */
export function rotateYInto(
  out: Float32Array,
  positions: Float32Array,
  theta: number,
  pivot: readonly [number, number, number] = [0, 0, 0],
): Float32Array {
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const [px, , pz] = pivot
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]! - px
    const z = positions[i + 2]! - pz
    out[i] = cos * x + sin * z + px
    out[i + 1] = positions[i + 1]!
    out[i + 2] = -sin * x + cos * z + pz
  }
  return out
}

/**
 * Which frame to draw at `phase` ∈ [0, 1) of the rock, over `frames` spanning −45°…+45°.
 *
 * **A sine from the middle, which is two decisions at once.** It starts at the centre frame —
 * the unrotated view, the one the static thumbnail already shows — so the animation begins on the
 * picture it is crossfading from and departs from it, rather than cutting to the −45° extreme and
 * travelling back. And a sine *is* an eased ping-pong: it slows at each turning point, where a
 * linear triangle reverses instantly and reads as a mechanical judder.
 *
 * `ROTATION_FRAMES` is odd so `centre` is a whole index and the first frame is exactly 0°.
 */
export function rockFrame(phase: number, frames: number): number {
  const centre = (frames - 1) / 2
  return Math.round(centre + centre * Math.sin(2 * Math.PI * phase))
}

/**
 * The order frames are rasterised in: the one the rock starts on, then the rest outward.
 *
 * Centre-first is what lets the preview show its final framing before the sweep is complete — a
 * sweep is framed by `sweptBounds` and the static mask by its own bounds, and a rotating body
 * needs more room than a still one, so the picture changes size once when the rock begins.
 * Building left to right would show −45° first: a change of framing *and* a jump to the far
 * extreme. Outward from the centre rather than in index order so that, on the slow route, the
 * frames nearest the resting view exist soonest; nothing depends on it, and it costs nothing.
 */
export function buildOrder(frames: number): number[] {
  const centre = Math.floor((frames - 1) / 2)
  const order = [centre]
  for (let step = 1; order.length < frames; step++) {
    if (centre - step >= 0) order.push(centre - step)
    if (centre + step < frames) order.push(centre + step)
  }
  return order
}

/**
 * One box covering every angle in the sweep.
 *
 * Evaluated at exactly the angles that will be drawn rather than solved analytically, so it is
 * tight for the frames that exist rather than for the continuous sweep — and it cannot disagree
 * with them. Without materialising the rotated buffers: this runs before any of them exist and
 * holding sixteen copies of a neuron's positions to compute a bounding box would be the peak
 * memory of the whole feature.
 *
 * Y is unrotated, so its extent is the geometry's own.
 */
export function sweptBounds(
  positions: Float32Array,
  angles: readonly number[],
  pivot: readonly [number, number, number] = [0, 0, 0],
): Bounds3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  // One buffer, folded over per angle. The rotation itself is `rotateYInto`'s and not written out
  // again here: two copies of it drift on the pivot sign, and that is a bug whose only symptom is
  // a neuron drawn slightly too small.
  const turned = new Float32Array(positions.length)
  for (const theta of angles) {
    rotateYInto(turned, positions, theta, pivot)
    for (let i = 0; i + 2 < turned.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = turned[i + a]!
        if (v < min[a]!) min[a] = v
        if (v > max[a]!) max[a] = v
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : EMPTY_BOUNDS
}

/**
 * Drop interior nodes from an over-detailed skeleton, keeping its shape.
 *
 * **Branch points, leaves and roots are always kept**, which is what makes this preserve the
 * drawing rather than merely shrink it: those are the nodes that define where the arbor goes, and
 * everything else is a point along a run between two of them. The runs are then thinned to bring
 * the total under `maxNodes`.
 *
 * **So `maxNodes` is a target and structure is the floor.** A bushy enough arbor has more branch
 * points and leaves than the cap allows, and it keeps all of them — a 16,840-node skeleton
 * branching every eleventh node has 3,062 structural nodes and comes back at 3,062 against a cap
 * of 3,000. Thinning into that would be dropping branch points, which is not decimating the
 * drawing but changing it, and the whole reason to decimate rather than subsample uniformly is
 * to avoid exactly that. The cost still falls with the count, which is what the cap is for: 5.5×
 * fewer nodes on that skeleton, so ~13 ms a frame against the 74 ms measured on the full one.
 *
 * Radii are subset alongside the nodes when the caller has them. Nothing in the thumbnail path
 * reads them — neither rasteriser takes them — but a `SkeletonGeometry` carries them, and handing
 * back one whose `radii` is still the *original* length is a value that lies about itself. The
 * index map is already built here, so subsetting is four lines; deriving it at a call site would
 * not be.
 *
 * Reparenting is where the ordering trap is. A dropped node's children must attach to the nearest
 * *kept* ancestor, which is a walk up the parent chain — and `parents[i] < i` does not hold on
 * CATMAID (see this file's header), so the walk cannot be a single forward pass and cannot assume
 * it terminates. `MAX_ANCESTOR_STEPS` is what stops a malformed skeleton from hanging the tab; a
 * node whose ancestry cannot be resolved becomes a root, which draws as a gap rather than as a
 * spurious edge across the arbor.
 */
export function decimateSkeleton<T extends DecimatableSkeleton>(
  skeleton: T,
  maxNodes = DECIMATE_MAX_NODES,
): DecimatableSkeleton {
  const { positions, parents, radii } = skeleton
  const count = Math.min(Math.floor(positions.length / 3), parents.length)
  // By identity under the cap, which is what makes a second call a free guard.
  if (count <= maxNodes) return skeleton

  const children = new Int32Array(count)
  for (let i = 0; i < count; i++) {
    const parent = parents[i]!
    if (parent >= 0 && parent < count && parent !== i) children[parent] = children[parent]! + 1
  }

  /*
   * Thin the *removable* nodes only. Branch points, leaves and roots are kept whatever happens,
   * so the thinning has to reach its target out of what is left — a stride computed against the
   * whole count overshoots on a bushy arbor and undershoots on a stringy one.
   *
   * Selected by an exact running quota rather than `i % stride`, because a stride is
   * `ceil(removable / budget)` and the rounding puts the result *over* the cap: measured on a
   * 16,840-node arbor at a 3,000 cap it returned 3,063. A cap that is nearly honoured is a cap
   * that has to be re-argued every time somebody reads it.
   */
  const removable = countRemovable(count, parents, children)
  const keepable = count - removable
  const budget = Math.max(0, maxNodes - keepable)

  const keep = new Uint8Array(count)
  let seen = 0
  let taken = 0
  for (let i = 0; i < count; i++) {
    if (isStructural(i, parents, children, count)) {
      keep[i] = 1
      continue
    }
    seen++
    if (removable > 0 && Math.floor((seen * budget) / removable) > taken) {
      keep[i] = 1
      taken++
    }
  }

  const index = new Int32Array(count).fill(-1)
  let next = 0
  for (let i = 0; i < count; i++) if (keep[i]) index[i] = next++

  const outPositions = new Float32Array(next * 3)
  const outParents = new Int32Array(next)
  const outRadii = radii ? new Float32Array(next) : undefined
  for (let i = 0; i < count; i++) {
    const at = index[i]!
    if (at < 0) continue
    outPositions[at * 3] = positions[i * 3]!
    outPositions[at * 3 + 1] = positions[i * 3 + 1]!
    outPositions[at * 3 + 2] = positions[i * 3 + 2]!
    if (outRadii && radii) outRadii[at] = radii[i] ?? 0
    outParents[at] = keptAncestor(i, parents, keep, index, count)
  }
  // `radii` carried only when there was one. A zero-length array beside 3,000 positions lies
  // about itself exactly as much as an over-long one — which is the failure this subsets to avoid.
  return outRadii
    ? { positions: outPositions, parents: outParents, radii: outRadii }
    : { positions: outPositions, parents: outParents }
}

/** A root, a leaf or a branch point — the nodes that say where the arbor goes. */
function isStructural(
  i: number,
  parents: Int32Array,
  children: Int32Array,
  count: number,
): boolean {
  const parent = parents[i]!
  return parent < 0 || parent >= count || children[i]! !== 1
}

function countRemovable(count: number, parents: Int32Array, children: Int32Array): number {
  let n = 0
  for (let i = 0; i < count; i++) if (!isStructural(i, parents, children, count)) n++
  return n
}

/**
 * The nearest kept ancestor's new index, or −1.
 *
 * Bounded rather than trusting the tree, and order-independent — see the header.
 */
function keptAncestor(
  from: number,
  parents: Int32Array,
  keep: Uint8Array,
  index: Int32Array,
  count: number,
): number {
  let at = parents[from]!
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step++) {
    if (at < 0 || at >= count) return -1
    if (keep[at]) return index[at]!
    at = parents[at]!
  }
  return -1
}

/** What the component flips through, plus the means to build one frame at a time. */
export interface Rotation {
  /** How many masks the sweep has. Played there and back. */
  frames: number
  /** Rasterise frame `i`. Deterministic, so a caller may build them across several ticks. */
  render: (i: number) => Silhouette
}

/**
 * Prepare a sweep. Nothing is rasterised here — `render` does one frame at a time.
 *
 * The split is what lets the component spend a frame budget rather than a frame count: a mesh
 * builds all sixteen in ~22 ms and a decimated arbor takes ten times that, and neither should
 * decide how long the main thread is held. What *is* done up front is the part that must be
 * shared — the decimation and the swept box — because doing either per frame is one of the two
 * failures in this file's header.
 */
export function createRotation(
  geometry:
    | { kind: 'mesh'; positions: Float32Array; indices: Uint32Array }
    | { kind: 'skeleton'; positions: Float32Array; parents: Int32Array },
  size: number,
  frames = ROTATION_FRAMES,
): Rotation {
  const angles = frameAngles(frames)
  const source =
    geometry.kind === 'skeleton'
      ? {
          kind: 'skeleton' as const,
          // A no-op on anything `loadFineGeometry` hands over — it decimates once, there — but
          // this module is callable with a raw body and must not depend on that.
          ...decimateSkeleton(geometry),
        }
      : geometry
  // Once, for every frame: the neuron turns about itself rather than about the volume's origin.
  const pivot = pivotOf(source.positions)
  const box = sweptBounds(source.positions, angles, pivot)

  // One buffer for all 17 frames — see `rotateYInto`.
  const scratch = new Float32Array(source.positions.length)

  return {
    frames: angles.length,
    render: (i: number): Silhouette => {
      const theta = angles[Math.min(Math.max(i, 0), angles.length - 1)] ?? 0
      const positions = rotateYInto(scratch, source.positions, theta, pivot)
      return source.kind === 'skeleton'
        ? rasteriseSkeleton(positions, source.parents, size, box)
        : rasteriseSilhouette(positions, source.indices, size, box)
    },
  }
}
