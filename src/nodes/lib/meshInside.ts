/**
 * Whether a point is inside a mesh, asked a hundred thousand times.
 *
 * `Points in Volumes` is the only caller, and everything here is about making its inner loop
 * affordable rather than about what the answer means — that argument lives in
 * `pointsInMeshes.ts`, which owns the schema, the column and the partition.
 *
 * ## The tree is `meshTrees.ts`', not this file's
 *
 * The dynamic import, the `indirect: true` option and the `WeakMap` that holds a tree against
 * its mesh all moved there when `Distance between` became a second caller — one wire feeding both nodes
 * would otherwise build every tree twice. The arguments behind all three are recorded there, and
 * `pointsInMeshes.test.ts` still pins the index array untouched, as `meshPicking.test.ts` does.
 *
 * ## The ray is deliberately not axis-aligned
 *
 * Containment is one ray plus the sign of the face normal it first meets, which is
 * three-mesh-bvh's own recipe and is exact for a closed, consistently wound surface — wound
 * **either way**: the facing only means "leaving" for outward normals, so each mesh's winding is
 * read once from its signed volume and the comparison flipped for one wound inward. Without that
 * an inside-out mesh answers every point backwards, which is how the synthetic regions once found
 * their own centres outside them; winding is whoever exported the mesh's choice. Its
 * failure mode is a ray that grazes an edge shared by two triangles, and region meshes are
 * marching-cubes surfaces over voxel masks — walls of axis-aligned faces, met by synapse
 * coordinates that are themselves integers on the voxel grid. An axis-aligned probe ray would
 * hit those shared edges constantly. `PROBE` is a fixed oblique direction instead: fixed
 * because invariant 4 needs `evaluate` deterministic, oblique because no plane of a voxel
 * surface is parallel to it.
 */

import type { Slicer } from '../../core/slice'
import type { Boxes, MeshGeometry } from '../../core/values'
import { boxesOf, signedVolume } from '../../core/values'
import { buildMeshTrees } from './meshTrees'

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

/**
 * A fixed oblique probe direction. Normalised at build, never at use.
 *
 * The components are arbitrary and only have to avoid every plane a voxel surface can present,
 * which the three axis planes and the six diagonals between them cover; nothing here is near
 * any of them.
 */
const PROBE = [0.113, 0.271, 0.956] as const

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

/** The containment tests, over trees `meshTrees.ts` builds and caches. */
export async function buildInsideTests(
  items: readonly MeshGeometry[],
  prefilter: { boxes: Boxes } = volumeBoxes(items),
  hooks: Slicer = {},
): Promise<InsideTests> {
  const { three, trees: built } = await buildMeshTrees(items, hooks)
  const { DoubleSide, Ray, Vector3 } = three

  const { boxes } = prefilter
  // Per mesh, once: does a face's normal point out of it? See the module note.
  const outward = items.map((mesh) => signedVolume(mesh.positions, mesh.indices) >= 0)

  // One ray and one direction for the whole run: `raycastFirst` reads them and keeps nothing.
  const direction = new Vector3(PROBE[0], PROBE[1], PROBE[2]).normalize()
  const ray = new Ray(new Vector3(), direction)

  const encloses = (index: number, x: number, y: number, z: number): boolean => {
    ray.origin.set(x, y, z)
    const hit = built[index]!.raycastFirst(ray, DoubleSide)
    /*
     * A hit whose normal points *along* the ray is a face being left, so the origin was inside
     * it — for an outward-wound mesh; `outward` turns it round for the other kind. `DoubleSide`
     * is what makes the back faces visible to the cast at all; with the default the first hit
     * from inside is the far wall's outside and every point reads as out.
     */
    if (!hit?.face) return false
    const leaving = hit.face.normal.dot(direction) > 0
    return outward[index] ? leaving : !leaving
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
