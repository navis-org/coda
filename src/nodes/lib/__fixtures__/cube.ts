/**
 * The one cube both Points in Volumes suites test against.
 *
 * A fixture module rather than a builder in each file, which is `networkx.ts`' arrangement next
 * door and here has a sharper reason than tidiness: **the winding decides whether the answer
 * exists at all.** `meshInside.ts` reads the sign of the first face normal a ray meets, so an
 * index array wound the other way reports every point as outside — and copied into two files,
 * one copy drifting fails in a way that looks exactly like a bug in the module under test.
 *
 * **What the two export probes share is the solid, not this buffer**, and the first version of
 * this comment claimed otherwise. `probe-r-helpers.R` does hand-build a cube, in `expand.grid`
 * corner order with its own face list — a *different* order from the ring order below, wound to
 * match. `probe-py-helpers.py` builds none: it asks `trimesh.creation.box` for one, so its vertex
 * order is trimesh's and is written down nowhere. What all three agree on is the shape being
 * asked about — an axis-aligned cube of side `2 * half`, at the same centres — which is all the
 * three rules those probes check (first on the wire wins, a miss is `None`/`NA`, the overlap
 * count is real) actually need. A shared JSON, which is what `probe:netexport` does for numeric
 * agreement, would be a heavier mechanism than a property about *ordering* requires.
 */

import type { MeshGeometry } from '../../../core/values'

/**
 * The eight corners as two rings, `-z` then `+z`, each counter-clockwise seen from `+z`.
 *
 * A table rather than eight spread expressions, because `FACES` below indexes these by position:
 * the order is load-bearing and belongs where it can be read against the faces that depend on it.
 */
const CORNERS = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
] as const

/** Twelve triangles, two per face, wound outwards. */
const FACES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1,
  2, 6, 1, 6, 5,
]

/** An axis-aligned cube of side `2 * half`, centred on `centre`. */
export function cube(
  id: string,
  centre: readonly [number, number, number],
  half = 1,
): MeshGeometry {
  return {
    id,
    positions: new Float32Array(
      CORNERS.flatMap((corner) => corner.map((sign, axis) => centre[axis]! + sign * half)),
    ),
    indices: new Uint32Array(FACES),
  }
}
