/**
 * Whether a point is inside a mesh, asked a hundred thousand times.
 *
 * `Points in Volumes` is the only caller, and everything here is about making its inner loop
 * affordable rather than about what the answer means — that argument lives in
 * `pointsInMeshes.ts`, which owns the schema, the column and the partition.
 *
 * ## Why the library is dynamically imported
 *
 * `three` and `three-mesh-bvh` are already in the tree — `ui/viewers/meshPicking.ts` builds the
 * same trees so a click on a neuron does not cost a frame — but they are in the tree *for the
 * UI*. A static import from here would put three in `nodes.html`'s bundle, which is a static
 * page with no React and no renderer in it, for a node guide entry that draws a glyph. So the
 * import is inside the function, which is `src/umap/run.ts`' shape and its reason: the node
 * statically imports a thin module, the thin module reaches for the library only when somebody
 * presses Run.
 *
 * **The MCP bundle needed a second move**, and the numbers are why it is worth knowing about:
 * `vite.mcp.config.ts` sets `inlineDynamicImports: true`, so a dynamic import in the node pack
 * is *inlined* into the one file the MCP server downloads — measured at **2,482 kB → 4,345 kB**,
 * 75% more for a library that bundle can never reach. `three` is external there now, with the
 * argument beside the option: nothing `src/mcp/index.ts` exports runs a node. That took the
 * cost to **+12 kB**.
 *
 * ## `indirect: true`, for `meshPicking.ts`' reason
 *
 * `MeshBVH` builds by **reordering the geometry's index array in place**, and the array handed
 * to it here is `MeshGeometry.indices` — the `Uint32Array` that belongs to the `MeshesValue` on
 * the wire, which the 3D viewer, the OBJ export and every other reader of that value hold too.
 * A reordered index draws the identical surface, which is exactly why it would go unnoticed.
 * `pointsInMeshes.test.ts` pins the array untouched, as `meshPicking.test.ts` does.
 *
 * ## The ray is deliberately not axis-aligned
 *
 * Containment is one ray plus the sign of the face normal it first meets, which is
 * three-mesh-bvh's own recipe and is exact for a closed, consistently wound surface. Its
 * failure mode is a ray that grazes an edge shared by two triangles, and region meshes are
 * marching-cubes surfaces over voxel masks — walls of axis-aligned faces, met by synapse
 * coordinates that are themselves integers on the voxel grid. An axis-aligned probe ray would
 * hit those shared edges constantly. `PROBE` is a fixed oblique direction instead: fixed
 * because invariant 4 needs `evaluate` deterministic, oblique because no plane of a voxel
 * surface is parallel to it.
 */

import type { MeshBVHOptions } from 'three-mesh-bvh'
import type { Slicer } from '../../core/slice'
import { sliced } from '../../core/slice'
import type { MeshGeometry } from '../../core/values'
import { boundsOf } from '../../core/values'

/**
 * Which meshes of a set enclose a point.
 *
 * Built once per run and asked per point, so the *interface* allocates nothing: `containing`
 * appends into an array the caller reuses rather than returning one, which at a hundred
 * thousand points is the difference between a hundred thousand short-lived arrays and none.
 * `raycastFirst` itself still mints an intersection object per **hit** — misses return `null` —
 * so the allocation left is bounded by the points that are inside something rather than by the
 * rays, which is negligible beside 0.7 µs a ray but is not nothing.
 */
export interface InsideTests {
  /**
   * Every mesh whose surface encloses `(x, y, z)`, appended to `out` **in item order**.
   *
   * The caller clears `out`. In item order because that order is what decides which region
   * names an overlapping point, and the decision has to be the same one every run.
   */
  containing(x: number, y: number, z: number, out: number[]): void
}

/**
 * The bounding boxes alone — what a point costs before anything has been built.
 *
 * Separate from `buildInsideTests`, and **synchronous**, which is the whole point: the cost
 * warning has to be raised before the work, and neither the boxes nor the count needs the
 * library. Asked for the trees first, the warning arrived after a second of tree building that
 * the reader was never told about and could not cancel. `networkMetrics`' `TRIANGLE_WORK_WARN`
 * is the same shape — count the inner loop in one cheap pass, then run it.
 */
export interface VolumeBoxes {
  /**
   * How many meshes have `(x, y, z)` in their bounding box — the rays this point will cost.
   *
   * A box test is three comparisons where a ray is a tree descent, so the sweep is cheap enough
   * to spend on knowing: 200,000 points against 63 volumes is 12.6 M tests in ~44 ms, against
   * the fourteen seconds the warning exists to announce.
   */
  candidateCount(x: number, y: number, z: number): number
}

/** Per-mesh axis-aligned box, six entries each: min xyz then max xyz. */
type Boxes = Float64Array

/**
 * The trees, held weakly against the mesh items they describe.
 *
 * Keyed on `MeshGeometry` identity, which is sound for `groupIndexes`' reason in
 * `iterables.ts`: geometry buffers here are immutable by convention — every node builds new
 * arrays rather than writing into one — so an item that is the same object is the same surface.
 * What it buys is the second Run: a tree over a dataset's primary set is the better part of a
 * second to build, and a graph re-run after an edit downstream would otherwise pay it again.
 *
 * `unknown` rather than `MeshBVH` because the type comes from a module this one only imports
 * dynamically; the cast is confined to `treeFor` below.
 */
const trees = new WeakMap<MeshGeometry, unknown>()

/**
 * A fixed oblique probe direction. Normalised at build, never at use.
 *
 * The components are arbitrary and only have to avoid every plane a voxel surface can present,
 * which the three axis planes and the six diagonals between them cover; nothing here is near
 * any of them.
 */
const PROBE = [0.113, 0.271, 0.956] as const

/**
 * The build options, typed wider than the package declares them.
 *
 * `meshPicking.ts`' workaround at a second call site, and the same note: 0.8.3's `MeshBVHOptions`
 * omits `indirect` although its own runtime defaults carry it, so a bare literal fails the
 * excess-property check. Not a version bump — drei asks for `^0.8.3`, so 0.9 would put a second
 * copy of the package in the tree. The type import is erased at build, so naming it here costs
 * `nodes.html` and the MCP bundle nothing, which is why this is a typed constant rather than the
 * `ConstructorParameters<typeof MeshBVH>[1]` cast it was written as.
 */
const TREE_OPTIONS: MeshBVHOptions & { indirect: boolean } = { indirect: true }

/** The prefilter, with no library behind it. Hand the same boxes to `buildInsideTests`. */
export function volumeBoxes(items: readonly MeshGeometry[]): VolumeBoxes & { boxes: Boxes } {
  const boxes = boxesOf(items)
  return {
    boxes,
    candidateCount(x, y, z) {
      let n = 0
      for (let i = 0; i < items.length; i++) if (inBox(boxes, i, x, y, z)) n++
      return n
    },
  }
}

/**
 * The trees, built one at a time with a turn for the browser between them.
 *
 * **Sliced for the reason the walk below it is**, and this is the stretch that was left out of
 * the first version while a comment one file over called it "the one stretch of this run with no
 * abort check in it". At the probe's measured 192 ms per million triangles a dataset's primary
 * set is a fifth of a second of frozen tab and a `Meshes` wire of full-resolution neuron surfaces
 * is seconds of it, with no way to cancel and nothing on the bar. `three-mesh-bvh` ships a worker
 * builder that would move it off-thread entirely; that is a real option and it costs worker
 * bundling in `vite.mcp.config.ts`' already careful externalisation, so the yield is the trade
 * taken here.
 */
export async function buildInsideTests(
  items: readonly MeshGeometry[],
  prefilter: { boxes: Boxes } = volumeBoxes(items),
  hooks: Slicer = {},
): Promise<InsideTests> {
  const [three, bvh] = await Promise.all([import('three'), import('three-mesh-bvh')])
  const { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } = three
  const { MeshBVH } = bvh

  const { boxes } = prefilter
  const built: InstanceType<typeof MeshBVH>[] = []
  await sliced(items.length, hooks, (i) => {
    const item = items[i]!
    const held = trees.get(item)
    if (held) {
      built.push(held as InstanceType<typeof MeshBVH>)
      return
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(item.positions, 3))
    geometry.setIndex(new BufferAttribute(item.indices, 1))
    const tree = new MeshBVH(geometry, TREE_OPTIONS)
    trees.set(item, tree)
    built.push(tree)
  })

  // One ray and one direction for the whole run: `raycastFirst` reads them and keeps nothing.
  const direction = new Vector3(PROBE[0], PROBE[1], PROBE[2]).normalize()
  const ray = new Ray(new Vector3(), direction)

  const encloses = (index: number, x: number, y: number, z: number): boolean => {
    ray.origin.set(x, y, z)
    const hit = built[index]!.raycastFirst(ray, DoubleSide)
    /*
     * A hit whose normal points *along* the ray is a face being left, so the origin was inside
     * it. `DoubleSide` is what makes the back faces visible to the cast at all; with the
     * default the first hit from inside is the far wall's outside and every point reads as out.
     */
    return !!hit && !!hit.face && hit.face.normal.dot(direction) > 0
  }

  return {
    containing(x, y, z, out) {
      for (let i = 0; i < items.length; i++) {
        if (!inBox(boxes, i, x, y, z)) continue
        if (encloses(i, x, y, z)) out.push(i)
      }
    },
  }
}

/**
 * Each mesh's own bounding box, which is what makes the whole thing affordable.
 *
 * A dataset's primary set tiles the volume, so a point is in one region and its box is in two
 * or three. Without the prefilter every point costs a ray per region — sixty-three on
 * hemibrain, a hundred and forty-four on male-CNS — and every one of them misses.
 *
 * `boundsOf` rather than a sweep of our own, which is not merely the same twenty lines: it
 * **memoises each buffer's box** in a `WeakMap`, and every `MeshesValue` on the wire was
 * constructed by calling it (`iterables.ts`, `transformOps.ts`, every source), so in the
 * ordinary case the answer is already computed and this is a lookup. Written out here it was a
 * second full pass over every vertex of every volume — ~4.3 ms per million vertices, and 100%
 * of a second Run's cost, since the trees the `WeakMap` below holds are free by then.
 *
 * `Float64Array` rather than `Float32Array`: a box grown from float32 vertex coordinates and
 * then rounded *down* at the maximum would exclude the vertex it was built from, and the points
 * this is asked about sit on the same grid as those vertices. `Bounds3` holds plain doubles
 * widened from the same float32 reads, so nothing is lost on the way through.
 *
 * Not `MeshBVH.getBoundingBox()`, for three reasons: it allocates a `Box3` per call, it needs
 * the tree — which is exactly what the prefilter runs *before* — and `computeBoundsUtils.js`
 * pads triangle bounds by `FLOAT32_EPSILON`, so the root box is conservatively larger and would
 * hand back strictly more ray candidates.
 */
function boxesOf(items: readonly MeshGeometry[]): Boxes {
  const boxes = new Float64Array(items.length * 6)
  items.forEach((item, i) => {
    if (item.positions.length === 0) {
      /*
       * An inverted box, which no point is in. `boundsOf` answers `EMPTY_BOUNDS` — a zero box at
       * the origin — for a buffer with no vertices, and taken literally that would make an empty
       * volume claim the one point at (0, 0, 0). It is the right answer for a *scene's* extent
       * and the wrong one for a containment prefilter.
       */
      boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6)
      return
    }
    const box = boundsOf([item.positions])
    boxes.set([...box.min, ...box.max], i * 6)
  })
  return boxes
}

function inBox(boxes: Boxes, i: number, x: number, y: number, z: number): boolean {
  const at = i * 6
  return (
    x >= boxes[at]! &&
    y >= boxes[at + 1]! &&
    z >= boxes[at + 2]! &&
    x <= boxes[at + 3]! &&
    y <= boxes[at + 4]! &&
    z <= boxes[at + 5]!
  )
}
