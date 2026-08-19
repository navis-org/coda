/**
 * Making a mesh smaller before it is stored.
 *
 * neuPrint serves region meshes at full reconstruction resolution — hemibrain's `LO(R)` is
 * 51,748 vertices — and the ROIs widget rasterises them to a 256-pixel grid, where a couple of
 * thousand would be indistinguishable. Holding the difference costs about 32 MB of typed arrays
 * on hemibrain and 75 MB on male-CNS, for detail no projection of them can express.
 *
 * So the fetched mesh is reduced once, on arrival, and the reduced form is what gets cached.
 *
 * ## Vertex clustering, not quadric error
 *
 * Snap every vertex to a coarse 3D grid, merge the ones sharing a cell, drop the triangles that
 * collapse. It is the crude decimator, and it is the right one here for three reasons: it is
 * deterministic (so a cached mesh is reproducible and a provenance key over it is stable), it is
 * one linear pass rather than a priority queue over every edge, and what it preserves best is
 * exactly what this consumer needs — the **silhouette**. Quadric error simplification preserves
 * sharp features, which a neuropil shell does not have and a decimated display surface never had
 * in the first place.
 *
 * A cell's representative is the **average** of the vertices in it rather than the first one
 * found. The first-found rule is a pixel cheaper and makes the surface visibly faceted, because
 * the representative sits wherever the file happened to list a vertex rather than in the middle
 * of the material it stands for.
 *
 * ## What this is not
 *
 * Not a measurement-preserving operation. neuPrint says these meshes are for visualization only
 * and unsuitable for quantitative analysis, so the volume computed off one is already an
 * approximation of a decimated display surface; this makes it slightly more so. Anything
 * reporting a number from it has to say where the number came from.
 */

export interface DecimatedMesh {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * Cells along the longest axis of the mesh's own bounding box.
 *
 * A grid resolution rather than a vertex target, because the useful property is a consistent
 * *feature size*: every region is simplified to the same spatial resolution, so a small neuropil
 * keeps proportionally as much shape as a large one. A vertex target does the opposite — it
 * flattens the small ones to hit a number.
 *
 * **32 is arithmetic rather than taste.** Only surface cells are ever occupied, and for a
 * roughly convex shell that count is about `π · grid²` — so 32 lands near 3,200 vertices and 64
 * near 12,800. The tracer rasterises to a 256-pixel grid, where a few thousand vertices is
 * already more surface than the picture can express; 64 was the first guess and reduced
 * hemibrain's `LO(R)` by only about four times, because it is *finer* than the vertex spacing of
 * several regions and merges almost nothing.
 */
export const DEFAULT_DECIMATE_GRID = 32

/**
 * Reduce a mesh to roughly one vertex per grid cell it occupies.
 *
 * Returns the input untouched when it is already at or below the target resolution, so a small
 * region costs no copy and a source that already publishes coarse meshes is not degraded.
 */
export function decimateMesh(
  positions: Float32Array,
  indices: Uint32Array,
  grid = DEFAULT_DECIMATE_GRID,
): DecimatedMesh {
  const vertexCount = positions.length / 3
  if (vertexCount === 0 || indices.length === 0 || grid < 2) return { positions, indices }

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!
    const y = positions[i + 1]!
    const z = positions[i + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
  // A degenerate mesh — one point, or a perfectly flat axis in every direction — has nothing to
  // cluster and would divide by zero.
  if (!Number.isFinite(span) || span <= 0) return { positions, indices }

  const cell = span / grid

  /*
   * A cell key packed into one number rather than a string.
   *
   * `${cx},${cy},${cz}` is the obvious spelling and allocates a string per vertex — half a
   * million of them for one dataset's regions, all of them garbage immediately. The grid is
   * bounded by `grid + 1` per axis, so three indices fit in a single float exactly as long as
   * the multiplier exceeds the axis extent.
   */
  const stride = grid + 2
  const cellOf = (v: number): number => {
    const cx = Math.min(stride - 1, Math.floor((positions[v * 3]! - minX) / cell))
    const cy = Math.min(stride - 1, Math.floor((positions[v * 3 + 1]! - minY) / cell))
    const cz = Math.min(stride - 1, Math.floor((positions[v * 3 + 2]! - minZ) / cell))
    return (cx * stride + cy) * stride + cz
  }

  // cell key -> index into the output vertex list
  const slot = new Map<number, number>()
  const remap = new Int32Array(vertexCount)
  const sums: number[] = []
  const counts: number[] = []

  for (let v = 0; v < vertexCount; v++) {
    const key = cellOf(v)
    let at = slot.get(key)
    if (at === undefined) {
      at = counts.length
      slot.set(key, at)
      sums.push(0, 0, 0)
      counts.push(0)
    }
    remap[v] = at
    sums[at * 3] = sums[at * 3]! + positions[v * 3]!
    sums[at * 3 + 1] = sums[at * 3 + 1]! + positions[v * 3 + 1]!
    sums[at * 3 + 2] = sums[at * 3 + 2]! + positions[v * 3 + 2]!
    counts[at] = counts[at]! + 1
  }

  // Nothing merged, so there is nothing to gain and a copy to avoid.
  if (counts.length >= vertexCount) return { positions, indices }

  const out = new Float32Array(counts.length * 3)
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i]!
    out[i * 3] = sums[i * 3]! / n
    out[i * 3 + 1] = sums[i * 3 + 1]! / n
    out[i * 3 + 2] = sums[i * 3 + 2]! / n
  }

  const kept: number[] = []
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t]!]!
    const b = remap[indices[t + 1]!]!
    const c = remap[indices[t + 2]!]!
    // Two corners in one cell leaves a degenerate triangle: zero area, no contribution to any
    // raster, and a nuisance to every consumer that later asks for a normal.
    if (a === b || b === c || a === c) continue
    kept.push(a, b, c)
  }

  return { positions: out, indices: Uint32Array.from(kept) }
}
