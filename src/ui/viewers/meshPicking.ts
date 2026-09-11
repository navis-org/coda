/**
 * What makes a neuron mesh clickable without a click costing a frame — or several.
 *
 * three's own `Mesh.raycast` tests every triangle the ray's bounding-sphere check lets through,
 * and a neuron's bounding sphere covers most of the screen, so in practice it tests all of them.
 * Measured in Node on one mesh, a ray through its centre: **2.2 ms at 50k triangles, 49 ms at
 * 1.5M, linear throughout** — and 1.5M is the Meshes node's *default* budget for the set, with
 * `high` at 6M. React Three Fiber raycasts every interactive object on `pointerdown` as well as
 * on the click (it keeps the pointerdown hits to decide whether the click landed on the same
 * object), so the cost is paid twice per click and once at the start of *every trackball drag*
 * while picking is on: ~50 ms of stall per gesture at the default, ~200 ms at `high`.
 *
 * A bounding-volume hierarchy takes the ray to under 0.03 ms at every size measured, for a
 * one-off build of ~330 ms per 1.5M triangles. So the build is paid only where picking is on,
 * and a mesh per task rather than the set in one (see `MeshItem`); until a mesh's tree exists,
 * `pickRaycast` falls back to three's own raycast, so a click is never *wrong* while trees are
 * pending — only as slow as it used to be.
 *
 * **`indirect: true` is not a tuning option, it is what keeps the data intact.** By default
 * `MeshBVH` builds by *reordering the geometry's index array in place*, and the viewer's index
 * attribute wraps `MeshItem`'s `indices` without copying — the `Uint32Array` that belongs to the
 * `MeshesValue` on the wire, read again by every other consumer of that value. A reordered index
 * still draws the same surface, which is exactly why it would go unnoticed: nothing on screen
 * changes, and every other reader of the value gets its triangles in a different order.
 * `meshPicking.test.ts` pins the array untouched.
 */

import type { BufferGeometry } from 'three'
import type { MeshBVHOptions } from 'three-mesh-bvh'
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'

/**
 * The build options, typed wider than the package declares them.
 *
 * 0.8.3's `MeshBVHOptions` omits `indirect` although its runtime honours it (it is in
 * `MeshBVH.js`'s own defaults), and a literal would fail the excess-property check. Not a
 * version bump: drei asks for `^0.8.3`, so 0.9 would put a second copy in the tree. The test
 * that the index comes back untouched is what says the option really took effect.
 */
const TREE_OPTIONS: MeshBVHOptions & { indirect: boolean } = { indirect: true }

/**
 * A `Mesh.raycast` that uses the geometry's tree when it has one and three's own otherwise.
 *
 * Safe to hand to every mesh, pickable or not: with no `boundsTree` it is three's method.
 */
export const pickRaycast = acceleratedRaycast

/** Give a geometry its pick tree, once. The index array is left exactly as it was. */
export function buildPickTree(geometry: BufferGeometry): void {
  if (geometry.boundsTree) return
  geometry.boundsTree = new MeshBVH(geometry, TREE_OPTIONS)
}
