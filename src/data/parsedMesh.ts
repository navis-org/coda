/**
 * What a mesh read out of a file looks like, and nothing else.
 *
 * A leaf on purpose: `obj.ts`, `stl.ts` and `ply.ts` all need this shape, and `meshFile.ts` needs
 * all three of them. Declared in the dispatcher it would close a cycle — every reader importing
 * the module that imports it — which is safe only while nothing is read at module scope, and is
 * exactly the arrangement `precomputed`'s `sorting.ts` records as having produced a silently
 * `undefined` path under the ordinary import order. So the shared shape sits where it can import
 * nothing at all.
 */

/**
 * A mesh in the file's own units, with no normals.
 *
 * One type for the three readers, so a caller written against OBJ takes an STL with no change —
 * and, more to the point, so `polygons` and `dropped` mean the same thing in three places. Both
 * counters exist because a file can be read successfully and still be worth a sentence: a
 * quadrilateral mesh is fanned, and a face naming a vertex that was never declared is skipped.
 */
export interface ParsedMesh {
  /** xyz interleaved, in the file's own units. */
  positions: Float32Array
  /** Triangle indices into `positions`. */
  indices: Uint32Array
  /** How many source faces had more than three corners and were fanned. */
  polygons: number
  /** Face corners that named a vertex the file never declared. */
  dropped: number
}

/** Nothing read. Shared so the three readers cannot disagree about what empty looks like. */
export const EMPTY_MESH: ParsedMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  polygons: 0,
  dropped: 0,
}
