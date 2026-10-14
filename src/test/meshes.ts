/**
 * Geometry fixtures for the upload tests.
 *
 * One tetrahedron, written three times before this — in `data/uploads.test.ts`,
 * `nodes/query/uploadMesh.test.ts` and `ui/nodes/uploadMeshBody.test.tsx`, with the same four
 * positions and the same twelve indices, differing only in whether the filename was a parameter.
 * Here for `test/graph.ts`' reason: three copies of a fixture are three chances for one of them to
 * stop describing the same shape as the other two.
 */

import { column, tableSchema } from '../core/types'
import type { MeshesValue, TemplateSpaceId } from '../core/values'
import { makeTable } from '../core/values'
import type { StoredMesh } from '../data/uploads'

/** A unit tetrahedron's corners, xyz interleaved, and its four faces. The one copy. */
const TETRA_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
const TETRA_INDICES = [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]

/** A unit tetrahedron — small enough to compare by value, closed enough to be a real mesh. */
export function tetra(name: string, file = `${name}.obj`): StoredMesh {
  return {
    name,
    file,
    positions: Float32Array.from(TETRA_POSITIONS),
    indices: Uint32Array.from(TETRA_INDICES),
  }
}

/**
 * Two tetrahedra side by side and an empty mesh, as a mesh set — the third being the case every
 * mesh node's item-count rule is about. Shared by Clean Meshes' and Skeletonize Meshes' tests.
 * `detail` adds a level-of-detail caption, `space` a template space, for the tests about whether
 * each survives.
 */
export function meshesFixture({
  detail = false,
  space,
}: { detail?: boolean; space?: TemplateSpaceId } = {}): MeshesValue {
  // The unit tetrahedron at a micrometre, shifted along x so the two do not overlap.
  const shifted = (offset: number) =>
    Float32Array.from(TETRA_POSITIONS, (v, i) => v * 1000 + (i % 3 === 0 ? offset : 0))
  const faces = Uint32Array.from(TETRA_INDICES)
  return {
    kind: 'meshes',
    items: [
      { id: '11', positions: shifted(0), indices: faces },
      { id: '22', positions: shifted(5000), indices: faces },
      { id: '33', positions: new Float32Array([]), indices: new Uint32Array([]) },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'i64'), column('type', 'str')), {
      neuronId: [11, 22, 33],
      type: ['LC4', 'LC6', 'LC10'],
    }),
    bounds: { min: [0, 0, 0], max: [6000, 1000, 1000] },
    units: 'nm',
    ...(space ? { space } : {}),
    ...(detail ? { detail: { lod: 1, levels: 4, triangles: 8 } } : {}),
  }
}
