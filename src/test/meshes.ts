/**
 * Geometry fixtures for the upload tests.
 *
 * One tetrahedron, written three times before this — in `data/uploads.test.ts`,
 * `nodes/query/uploadMesh.test.ts` and `ui/nodes/uploadMeshBody.test.tsx`, with the same four
 * positions and the same twelve indices, differing only in whether the filename was a parameter.
 * Here for `test/graph.ts`' reason: three copies of a fixture are three chances for one of them to
 * stop describing the same shape as the other two.
 */

import type { StoredMesh } from '../data/uploads'

/** A unit tetrahedron — small enough to compare by value, closed enough to be a real mesh. */
export function tetra(name: string, file = `${name}.obj`): StoredMesh {
  return {
    name,
    file,
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]),
  }
}
