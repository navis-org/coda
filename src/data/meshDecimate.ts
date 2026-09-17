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
 * It also works over a mesh that arrives in pieces without joining them first — see
 * `decimateParts`, which is what a graphene neuron's several hundred fragments go through.
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

import { concatMeshes, type MeshArrays } from './meshParts'

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
 * Triangles a decimated mesh comes out at, per grid step.
 *
 * `decimateMesh` clusters to roughly one vertex per occupied cell, so the count follows the
 * grid's square. Measured on one FlyWire neuron, down from 1,276,736 triangles: grid 96 gives
 * 6,308, grid 192 gives 25,548, grid 256 gives 44,091 — all three within 2% of
 * `0.68 * grid²`, which is what makes the inverse below sound rather than a guess.
 */
const TRIANGLES_PER_CELL = 0.68

/** Below this a neuron stops being an arbor and becomes a smear. */
const MIN_DECIMATE_GRID = 48

/**
 * The grid that lands a set of `count` neurons on the caller's triangle budget.
 *
 * This is what `GeometryRequest.triangleBudget` means for a source with **no** levels of detail.
 * It lives here rather than beside its one caller for the reason `concatMeshes` moved: it is
 * arithmetic about this decimator's own behaviour, and `cave/meshes.ts` is a module that fetches
 * over the network — which also put it out of reach of `probe-mesh-decimate.ts`, whose grids were
 * transcribed and had drifted to one no budget produces.
 * The seam says a source with one level ignores it, and that is written for a publisher whose
 * levels are fixed — graphene is the other case: one level, but a continuous knob, so it is the
 * only source in the tree that can hit an arbitrary budget exactly instead of snapping to a
 * published one. Ignoring it would leave the Meshes node's `Detail` control — non-advanced, on
 * the card, reading "Triangle budget for the whole set" — doing nothing at all here.
 *
 * The floor is what stops "low — many neurons" against twenty neurons erasing the arbor; the
 * caption admits the decimation either way.
 */
export function decimateGridFor(triangleBudget: number, count: number): number {
  const perNeuron = Math.max(1, triangleBudget) / Math.max(1, count)
  return Math.max(MIN_DECIMATE_GRID, Math.round(Math.sqrt(perNeuron / TRIANGLES_PER_CELL)))
}

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
): MeshArrays {
  return decimateParts([{ positions, indices }], grid)
}

/**
 * The same reduction over a mesh that arrives **in pieces**, without joining them first.
 *
 * This is the shape graphene has: a CAVE neuron is hundreds of Draco supervoxel fragments, and
 * the obvious spelling — concatenate, then decimate — allocates a second full-resolution copy of
 * a mesh that is about to be thrown away, 8.0 MB of positions plus 15.3 MB of indices for one
 * FlyWire neuron, with `MESH_CONCURRENCY` of them in flight. It also costs an index rebase pass,
 * one add and one write per index, whose entire purpose is to renumber vertices that the very
 * next pass renumbers again.
 *
 * Nothing about the clustering needs the pieces to be adjacent in memory: the cell a vertex lands
 * in depends on the **global** bounding box and the cell size, and the slot each cell takes
 * depends only on the order vertices are visited in. Walking the parts in order visits exactly
 * the sequence the joined array would have held, so the result is byte-identical to
 * `decimateMesh(concatMeshes(parts))` — which `meshDecimate.test.ts` asserts directly rather than
 * taking on trust, and which was checked once against a real mosquito neuron's 471 fragments.
 *
 * Where there is nothing to merge it joins and hands that back, so a caller never has to tell the
 * two apart.
 *
 * `pnpm probe:mesh-decimate` is the measurement, on that neuron's shape at the three grids a
 * triangle budget actually asks for: at twenty neurons **31 ms and 47.5 MB against 16 ms and
 * 23.9 MB**, the difference being the joined copy plus the rebase loop. Read in `arrayBuffers`
 * rather than `heapUsed`, for the reason that probe's header gives.
 */
export function decimateParts(
  parts: readonly MeshArrays[],
  grid = DEFAULT_DECIMATE_GRID,
): MeshArrays {
  const box = partsBounds(parts)
  if (box.indexCount === 0 || grid < 2) return concatMeshes(parts)

  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ)
  // A degenerate mesh — one point, or a perfectly flat axis in every direction — has nothing to
  // cluster and would divide by zero.
  if (!Number.isFinite(span) || span <= 0) return concatMeshes(parts)

  const { minX, minY, minZ, vertexCount, indexCount } = box
  const cell = span / grid

  /*
   * A cell key packed into one number rather than a string.
   *
   * `${cx},${cy},${cz}` is the obvious spelling and allocates a string per vertex — half a
   * million of them for one dataset's regions, all of them garbage immediately.
   *
   * The multipliers are **per axis**, from each extent, rather than one cubic `grid + 1`. A
   * cubic stride is correct and was what this did first, but it makes the key as large as the
   * longest axis cubed whatever the shape actually is: at the grid a single-neuron budget asks
   * for (1485) that is 3.3e9, past 2^31, so every `Map` key leaves small-integer range — which
   * costs 53 ms per 680k inserts against 43 ms. A neuron is long and thin, so sizing each axis to
   * its own extent brings the key back under the limit; where it does not — a mesh whose box
   * really is a cube, which the probe's fixture is — the result is unchanged, only slower.
   *
   * Two multipliers rather than three, and no clamp on the indices. `cell` divides the *longest*
   * extent, so `floor((x - minX) / cell)` is at most `floor(extent / cell)` — within the axis's
   * own count by construction — which makes the `Math.min` this used to carry unable to bind, and
   * with it gone the x count has no reader: a positional numbering needs a stride per axis after
   * the first, not for it.
   */
  const cellsY = Math.floor((box.maxY - minY) / cell) + 1
  const cellsZ = Math.floor((box.maxZ - minZ) / cell) + 1

  // cell key -> index into the output vertex list
  const slot = new Map<number, number>()
  // Indexed by *global* vertex number, the position each part's vertices would have had in the
  // joined array — which is what lets the index pass below add a part's base and nothing else.
  const remap = new Int32Array(vertexCount)
  /*
   * Typed, and grown by doubling rather than sized once.
   *
   * Occupied cells are bounded by `min(vertexCount, cellsX * cellsY * cellsZ)`, and that bound is
   * loose exactly where being wrong is expensive: at grid 96 it reserves 680,124 slots for the
   * 14,112 that are used. Sizing once from it measured *worse at every grid* — 21 ms and 37.7 MB
   * against 17 ms and 19.5 MB at grid 96 — because the zeroing costs more than the doubling's
   * copies, which come to 1-2 ms of a 71 ms call at the finest grid.
   */
  let cells = 0
  let sums = new Float64Array(1024 * 3)
  let counts = new Uint32Array(1024)

  let v = 0
  for (const part of parts) {
    const p = part.positions
    for (let i = 0; i < p.length; i += 3, v++) {
      const x = p[i]!
      const y = p[i + 1]!
      const z = p[i + 2]!
      const cx = Math.floor((x - minX) / cell)
      const cy = Math.floor((y - minY) / cell)
      const cz = Math.floor((z - minZ) / cell)
      const key = (cx * cellsY + cy) * cellsZ + cz
      const at = slot.get(key)
      if (at === undefined) {
        if (cells === counts.length) {
          const widerSums = new Float64Array(counts.length * 6)
          widerSums.set(sums)
          sums = widerSums
          const widerCounts = new Uint32Array(counts.length * 2)
          widerCounts.set(counts)
          counts = widerCounts
        }
        slot.set(key, cells)
        remap[v] = cells
        // Seeded rather than zeroed and then accumulated: a new cell's first vertex is its sum.
        sums[cells * 3] = x
        sums[cells * 3 + 1] = y
        sums[cells * 3 + 2] = z
        counts[cells] = 1
        cells++
      } else {
        remap[v] = at
        sums[at * 3] = sums[at * 3]! + x
        sums[at * 3 + 1] = sums[at * 3 + 1]! + y
        sums[at * 3 + 2] = sums[at * 3 + 2]! + z
        counts[at] = counts[at]! + 1
      }
    }
  }

  // Nothing merged, so there is nothing to gain and a copy to avoid.
  if (cells >= vertexCount) return concatMeshes(parts)

  return {
    positions: averageCells(sums, counts, cells),
    indices: emitIndices(parts, remap, indexCount),
  }
}

/** Every part's extents and totals, in the one pass that has to finish before any clustering. */
function partsBounds(parts: readonly MeshArrays[]): {
  vertexCount: number
  indexCount: number
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
} {
  let vertexCount = 0
  let indexCount = 0
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const part of parts) {
    vertexCount += part.positions.length / 3
    indexCount += part.indices.length
    const p = part.positions
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!
      const y = p[i + 1]!
      const z = p[i + 2]!
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  return { vertexCount, indexCount, minX, minY, minZ, maxX, maxY, maxZ }
}

/** Each cell's representative: the mean of the vertices that landed in it. */
function averageCells(sums: Float64Array, counts: Uint32Array, cells: number): Float32Array {
  const out = new Float32Array(cells * 3)
  for (let i = 0; i < cells; i++) {
    const n = counts[i]!
    out[i * 3] = sums[i * 3]! / n
    out[i * 3 + 1] = sums[i * 3 + 1]! / n
    out[i * 3 + 2] = sums[i * 3 + 2]! / n
  }
  return out
}

/**
 * The surviving triangles, renumbered onto the cells.
 *
 * Written into a typed array sized by the index count already in hand, rather than pushed onto a
 * `number[]` and copied at the end: at the default single-neuron budget the output approaches
 * 1.5 M triangles, where the JS array is 4.5 M boxed doubles — measured at 51 ms and 66 MB
 * against 25 ms and 3 MB at grid 96, more than skipping the join saves. The trailing `slice` is
 * what keeps a cached mesh small; `subarray` would share the full buffer and pin 15.5 MB behind a
 * 283 kB result.
 */
function emitIndices(
  parts: readonly MeshArrays[],
  remap: Int32Array,
  indexCount: number,
): Uint32Array {
  const kept = new Uint32Array(indexCount)
  let w = 0
  let base = 0
  for (const part of parts) {
    const idx = part.indices
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = remap[base + idx[t]!]!
      const b = remap[base + idx[t + 1]!]!
      const c = remap[base + idx[t + 2]!]!
      // Two corners in one cell leaves a degenerate triangle: zero area, no contribution to any
      // raster, and a nuisance to every consumer that later asks for a normal.
      if (a === b || b === c || a === c) continue
      kept[w++] = a
      kept[w++] = b
      kept[w++] = c
    }
    /*
     * A part whose index count is not a multiple of three leaves its last one or two indices
     * unread, where the joined array would have made a triangle spanning two fragments. That is
     * the one place these two walks can differ, and this is the right answer of the two: a
     * triangle does not straddle a fragment boundary. Every reader that feeds this already
     * refuses such a fragment outright — `parseLegacyFragment` throws on trailing bytes — so it
     * is unreachable rather than merely unlikely.
     */
    base += part.positions.length / 3
  }
  return w === kept.length ? kept : kept.slice(0, w)
}
