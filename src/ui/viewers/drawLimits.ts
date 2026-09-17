/**
 * What one draw call may ask for, and which channels can reach it.
 *
 * Its own module rather than a corner of `meshPicking.ts`, where it first landed: that file is
 * about `MeshBVH` and raycast cost, and a renderer limit filed under it is discoverable only by
 * somebody already reading about picking — which is nobody who is about to add a fourth geometry
 * channel.
 */

/**
 * The most index values one draw call may ask for.
 *
 * **Firefox refuses a draw past 30,000,000** — `webgl.max-vert-ids-per-draw`, reported as
 * `drawElementsInstanced: Context's max indexCount is 30000000, but 39429663 requested` and then
 * the geometry is simply not drawn. An aedes neuron at full resolution is 13.1 M triangles, which
 * is 39.4 M index values, so a scene of two of them drew nothing at all while every buffer
 * uploaded successfully — measured at 627 MB on an M3 Max, so it is not memory and never was.
 *
 * It is a limit on **one draw call**, not on a mesh, which is why neuroglancer shows dozens of
 * the same neurons: it draws each of the ~471 supervoxel fragments separately. Coda merges them
 * for everything downstream — `decimateParts` exists to make that merge cheap — so the split
 * belongs at the last moment, where it costs one extra draw call and no extra memory.
 *
 * There is no `gl.getParameter` for it: it is a browser pref rather than a WebGL limit, and
 * probing it means provoking a refused draw and detecting an *absence*, which JS cannot see. So
 * it is a constant pinned against the real number by `drawLimits.test.ts`. 24 M rather than
 * 29,999,997 for headroom, and divisible by three so a split never lands inside a triangle.
 * Chrome enforces no such cap; splitting there costs a second `drawElements` on a mesh that is
 * already expensive, which is not measurable against what it is drawing.
 *
 * ## Which channels can reach it
 *
 * **Indexed meshes can** — neuron meshes and region shells, which share `MeshItem`, so one split
 * covers both. **Fat skeleton lines might**: `LineSegmentsGeometry` is instanced with 18 index
 * values per instance and one instance per segment, so ~1.7 M segments would reach 30 M *if*
 * Firefox multiplies its count by `instanceCount`. That is not verified, and a scene of that size
 * has not been reported; the analysis is here so the next reader starts from it rather than from
 * the symptom. **Thin lines and point sprites cannot**: `drawArrays` at two vertices a segment
 * and one a point, where 30 M points is 360 MB of positions and memory bites first.
 */
export const MAX_INDICES_PER_DRAW = 24_000_000

/**
 * Index ranges that each fit one draw call, as `[start, count]` pairs.
 *
 * One range for anything under the cap, so the ordinary mesh takes exactly the path it always did
 * and pays nothing for this.
 */
export function drawRanges(indexCount: number): Array<[number, number]> {
  if (indexCount <= MAX_INDICES_PER_DRAW) return [[0, indexCount]]
  const ranges: Array<[number, number]> = []
  for (let at = 0; at < indexCount; at += MAX_INDICES_PER_DRAW) {
    ranges.push([at, Math.min(MAX_INDICES_PER_DRAW, indexCount - at)])
  }
  return ranges
}

/**
 * Per-vertex normals, straight over the two typed arrays.
 *
 * `BufferGeometry.computeVertexNormals()` does the same arithmetic through `getX/getY/getZ` and a
 * `Vector3` per corner, and measures **693 ms against 105 ms** on a 13.2 M-triangle neuron — 6.6×,
 * for byte-identical output. It runs inside `MeshItem`'s `useMemo`, which is React's render phase,
 * so that was 1.3 s of blocked main thread before a two-neuron aedes scene painted anything.
 *
 * Taking the arrays rather than a geometry is what lets the split path skip building a
 * full-resolution `BufferGeometry` purely to throw it away — three has no standalone normal pass,
 * so that throwaway was the only way to get whole-mesh normals before.
 */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3
    const b = indices[t + 1]! * 3
    const c = indices[t + 2]! * 3
    const abx = positions[b]! - positions[a]!
    const aby = positions[b + 1]! - positions[a + 1]!
    const abz = positions[b + 2]! - positions[a + 2]!
    const acx = positions[c]! - positions[a]!
    const acy = positions[c + 1]! - positions[a + 1]!
    const acz = positions[c + 2]! - positions[a + 2]!
    // The unnormalised cross product, which weights each face by its own area — three's own
    // rule, and what keeps a large triangle from counting the same as a sliver.
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    for (const at of [a, b, c]) {
      normals[at] = normals[at]! + nx
      normals[at + 1] = normals[at + 1]! + ny
      normals[at + 2] = normals[at + 2]! + nz
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i]!
    const y = normals[i + 1]!
    const z = normals[i + 2]!
    const length = Math.sqrt(x * x + y * y + z * z)
    if (length === 0) continue
    normals[i] = x / length
    normals[i + 1] = y / length
    normals[i + 2] = z / length
  }
  return normals
}
