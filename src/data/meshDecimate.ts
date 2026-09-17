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
 * Whether a factor asks for any reduction at all. 0 and 1 both mean full resolution.
 *
 * One predicate because seven places ask — the node that sends the factor, the three sources that
 * forward it, the two that honour it, and the caption — and "is this on" is exactly the kind of
 * thing that comes to be spelled `> 1` in some of them and `>= 1` in the rest. It shipped that way
 * for a round: the node said `> 1` by hand and the three forwards used bare truthiness, which let
 * a `downsample: 1` through to a `down1` geometry cache key — a second entry holding meshes
 * byte-identical to the `down0` ones beside it, and a full re-fetch to build them.
 *
 * A type predicate, so a guarded `factor` needs no `!` at the four sites that then use it.
 */
export function downsamples(factor: number | undefined): factor is number {
  return factor !== undefined && factor > 1
}

/**
 * What a fetch was asked to do about size, resolved once from the request.
 *
 * Three answers, and the middle one is the reason this is not just a number. `'auto'` is the
 * default and means *as much detail as a scene can draw*, which no factor can express: one aedes
 * neuron is **13.1 M triangles** where one FlyWire neuron is 1.3 M, so the factor that makes the
 * first drawable erases the second. A bare factor is somebody overriding that, and `undefined` is
 * full resolution — asked for explicitly, or by a caller that is not drawing a scene at all.
 *
 * The ceiling is `DEFAULT_TRIANGLE_BUDGET`, which is the same number the multi-resolution path
 * already spends among published levels. Not a coincidence worth removing: it is one policy —
 * *a 3D scene targets about this many triangles* — arrived at from two directions, and using the
 * same figure is what makes a graphene scene and a neuPrint scene comparable in weight.
 */
export type Reduction = { targetTriangles: number } | { factor: number }

export function reductionFor(
  downsample: number | 'auto' | undefined,
  neuronCount: number,
  ceiling: number,
): Reduction | undefined {
  if (downsample === 'auto') return { targetTriangles: ceiling / Math.max(1, neuronCount) }
  return downsamples(downsample) ? { factor: downsample } : undefined
}

/**
 * A reduction's share of a geometry cache key — **quantised**, which is the whole point.
 *
 * An automatic target is `ceiling / neuronCount`, so it moves whenever the set does: keyed
 * exactly, a twenty-neuron set caches under `t75000` and adding a twenty-first makes it `t71429`
 * — a miss on all twenty-one. `CaveSource`'s own comment beside the key says what that costs:
 * *"one graphene mesh is several hundred Range requests and about a megabyte, so re-fetching
 * twenty because a twenty-first was added is thousands of round trips for nothing."* And it is
 * the **default** path, since `Downsample`'s `absentMeans: 0` puts every previously-saved
 * workflow in automatic.
 *
 * Rounded to a power of two, so the key moves only when the target roughly halves. That costs
 * nothing in fidelity: the fitted grid is accurate to about 30% anyway, so a target of 75,000 and
 * one of 71,429 are the same request in everything but arithmetic. `triangleBudget` never had
 * this shape because `lod` is a four-to-eight rung ladder that one extra neuron rarely moves.
 */
export function reductionKey(reduction: Reduction | undefined): string {
  if (!reduction) return 'full'
  if ('factor' in reduction) return `f${reduction.factor}`
  const rung = 2 ** Math.round(Math.log2(Math.max(1, reduction.targetTriangles)))
  return `t${rung}`
}

/**
 * The factor a reduction actually achieved, or undefined where nothing shrank.
 *
 * One home because it is the feature's one user-visible output — the `meshes ÷N` chip — and it
 * was written twice, once at the seam and once on the graphene route, each with its own floor and
 * its own rounding. Two copies of the number on the screen can disagree by route for one mesh.
 *
 * The factor **achieved**, not the one asked for: automatic has no asked-for factor at all, and
 * an explicit one is approximate because the grid that hits it is fitted. Floored at 2, since a
 * chip reading `÷1` claims a reduction that did not happen.
 */
export function achievedDownsample(before: number, after: number): number | undefined {
  if (after <= 0 || after >= before) return undefined
  return Math.max(2, Math.round(before / after))
}

/** Apply whatever `reductionFor` decided, or join where it decided nothing. */
export function applyReduction(
  parts: readonly MeshArrays[],
  reduction: Reduction | undefined,
): MeshArrays {
  if (!reduction) return concatMeshes(parts)
  return 'factor' in reduction
    ? downsampleParts(parts, reduction.factor)
    : reduceToTriangles(parts, reduction.targetTriangles)
}

/**
 * The grid that reduces a mesh of `triangles` to roughly `1 / factor` of them.
 *
 * `decimateMesh` clusters to about `TRIANGLES_PER_CELL * grid²`, so this is that inverted — and
 * it is taken from **the mesh's own triangle count**, which is what makes the factor mean the
 * same thing for every neuron in a set. Its predecessor divided one triangle *budget* across the
 * set instead (`GeometryRequest.triangleBudget`), which reduced a large neuron harder than a
 * small one and, worse, meant the Meshes node's `Detail` control did something different on a
 * source with levels of detail than on a source without: pick a published level there, silently
 * recompute the geometry here. `downsample` is the second thing, said out loud.
 *
 * The floor is what stops a large factor erasing the arbor rather than thinning it; past it the
 * control saturates, and the caption's triangle count is what says so.
 */
export function gridForFactor(triangles: number, factor: number): number {
  const target = Math.max(1, triangles) / Math.max(1, factor)
  return Math.max(MIN_DECIMATE_GRID, Math.round(Math.sqrt(target / TRIANGLES_PER_CELL)))
}

/**
 * The cell size and the two packing strides a grid implies, or nothing for a mesh with no extent.
 *
 * Shared by the probe and the real pass, and that sharing is structural rather than tidy: the fit
 * measures a clustering at one grid to predict the clustering at another, so if the two walks
 * disagreed about a stride the prediction would describe a partition nobody computes. It also
 * gives `countCells` the degenerate-span guard it was missing on its own — a flat or single-point
 * mesh divides by a zero cell and hashes `Infinity`, which collapses to one cell and reads as a
 * mesh that clusters perfectly.
 *
 * Returned as a small object, computed once per pass: the per-vertex arithmetic stays inline in
 * each loop, which is where the cost is.
 */
function cellLattice(
  box: PartsBounds,
  grid: number,
): { cell: number; cellsY: number; cellsZ: number } | undefined {
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ)
  if (!Number.isFinite(span) || span <= 0 || grid < 2) return undefined
  const cell = span / grid
  return {
    cell,
    cellsY: Math.floor((box.maxY - box.minY) / cell) + 1,
    cellsZ: Math.floor((box.maxZ - box.minZ) / cell) + 1,
  }
}

/** Close enough to stop refining: within half a factor of two either way. */
const TOLERANCE = 1.5

/**
 * How many cells a grid puts the vertices in — the clustering pass with everything but the map.
 *
 * It exists because **the grid that hits a target cannot be computed, only measured.**
 * `gridForFactor`'s `0.68 · grid²` models a surface filling its box, which is what a neuropil
 * shell is; an arbor is a thin tree in a large box and its occupied cells grow more slowly.
 * Measured on four real mosquito neurons the exponent runs **1.6 to 2.0**, and it is a property
 * of the individual neuron — so a fixed model asked for half the triangles of the sparsest and
 * delivered **a twenty-seventh** of them. That figure is the one this whole arrangement is
 * justified by; everything below cites it rather than restating it, the first round having
 * written it out three times and drifted to two different numbers.
 */
function countCells(parts: readonly MeshArrays[], box: PartsBounds, grid: number): number {
  const lattice = cellLattice(box, grid)
  if (!lattice) return 0
  const { cell, cellsY, cellsZ } = lattice
  const seen = new Set<number>()
  for (const part of parts) {
    const p = part.positions
    for (let i = 0; i < p.length; i += 3) {
      const cx = Math.floor((p[i]! - box.minX) / cell)
      const cy = Math.floor((p[i + 1]! - box.minY) / cell)
      const cz = Math.floor((p[i + 2]! - box.minZ) / cell)
      seen.add((cx * cellsY + cy) * cellsZ + cz)
    }
  }
  return seen.size
}

/*
 * Two things measured here and *not* done, so the next reader does not re-derive them.
 *
 * **Fusing the two probes into one walk saves nothing.** The walk over positions is 3-4 ms of a
 * 54 ms probe; the rest is hashing. One walk inserting into two sets measured 54.6 ms against
 * 53.7 ms — within noise, for a second stride pair and a shift-derivation argument.
 *
 * **Subsampling the probe destroys the slope**, which is the one thing it exists to measure. The
 * probe grids are deliberately fine — at factor 2 the fine grid holds 668,773 cells for 680,124
 * vertices, occupancy ≈ 1 — so a stride-k sample divides both counts by about k and the ratio
 * collapses towards 1: measured slope 0.86 at full, 0.33 at k=2, 0.02 at k=4. A slope near zero
 * goes into `Math.pow(target / guess, 1 / slope)` and comes out as an unbounded grid.
 *
 * What *would* pay is the container: a `Set` of 668k packed keys is ~31 MB of JS heap and 33 ms,
 * where a bitset over the cell space is 3 ms and an open-addressed `Float64Array` 9 ms — and both
 * sidestep the small-integer cliff `decimateParts` documents, which this inherits at grids twice
 * as fine. Left alone as forty lines of hand-rolled hash table against ~45 ms on a path whose
 * fetch is 1.3 s a neuron; the measurement is here so the trade can be re-taken rather than
 * re-discovered.
 */

/**
 * A mesh's fragments, reduced to roughly `1 / factor` of their triangles.
 *
 * The shape every source honouring `GeometryRequest.downsample` wants: it clusters **over the
 * fragments** rather than over a joined copy of them, and a factor asking for nothing joins and
 * hands that back so a caller never has to branch.
 *
 * ## The grid is fitted, not calculated
 *
 * `gridForFactor` alone is a good guess for a large dense neuron and a bad one for a sparse
 * neuron — its `grid²` is a surface's law and an arbor is closer to `grid^1.6`. So the exponent
 * is **measured on this mesh**: two counting passes at grids a factor of two apart give the local
 * slope, and the grid that lands on the target follows from it. One full pass then does the work.
 *
 * Two probes rather than one because a single point fixes no slope, and rather than three because
 * the third buys less than it costs — a probe is a walk over every vertex. Measured over four
 * real neurons spanning 111k to 23.8M triangles, asking for ÷2, ÷4 and ÷16: the fitted grid lands
 * within about 30% of the factor asked for, against `countCells`' figure for the model alone.
 * It is still an approximation, which is why `MeshDetail.downsample` reports the factor
 * *achieved* rather than the one asked for.
 */
export function downsampleParts(parts: readonly MeshArrays[], factor: number): MeshArrays {
  if (!downsamples(factor)) return concatMeshes(parts)
  const box = partsBounds(parts)
  return fitToTriangles(parts, box, box.indexCount / 3 / factor)
}

/**
 * The same reduction, aimed at **a triangle count** rather than at a ratio.
 *
 * What `Downsample`'s automatic setting needs: a scene has a size it can draw, and what that
 * costs a given neuron is a fact about the neuron, not a ratio — see `Reduction` for the
 * measurement that settles it.
 *
 * Hands the parts back joined where they already fit, which is what makes the automatic setting
 * free on a source whose meshes are small and on a pyramid whose level was already chosen against
 * the same budget.
 */
export function reduceToTriangles(
  parts: readonly MeshArrays[],
  targetTriangles: number,
): MeshArrays {
  /*
   * The triangle count first, which is a sum over *parts*; `partsBounds` walks every vertex and
   * costs 26 ms on an aedes neuron. Automatic asks this of every mesh on every fetch and the
   * answer is usually "it already fits" — on a pyramid always, the level having been chosen
   * against the same budget — so the cheap question has to come first for that to be free.
   */
  let triangles = 0
  for (const part of parts) triangles += part.indices.length / 3
  if (triangles <= targetTriangles) return concatMeshes(parts)
  return fitToTriangles(parts, partsBounds(parts), targetTriangles)
}

function fitToTriangles(
  parts: readonly MeshArrays[],
  box: PartsBounds,
  targetTriangles: number,
): MeshArrays {
  if (box.vertexCount === 0 || box.indexCount === 0) return concatMeshes(parts)

  const triangles = box.indexCount / 3
  /*
   * The target is **triangles**, which is what the factor means and what the caller sees. The
   * probes below count *cells*, which is what clustering controls — so they are converted through
   * this mesh's own triangles-per-vertex to make a first guess, and every step after that is
   * measured in triangles directly. Targeting cells and hoping the ratio survives was the first
   * shape and it stopped early on a tube: the vertex count landed on target while the triangle
   * count had barely moved, because how many faces a merge collapses is not a constant.
   */
  const target = Math.max(1, targetTriangles)
  const perVertex = triangles / Math.max(1, box.vertexCount)
  const coarse = gridForFactor(triangles, triangles / target)
  const fine = coarse * 2
  const atCoarse = countCells(parts, box, coarse)
  const atFine = countCells(parts, box, fine)

  /*
   * The slope, in logs. Guarded because a mesh can be flat in this window — every vertex already
   * in its own cell at both grids, so the two counts agree and there is no slope to take. The
   * model's own exponent is the fallback, which is where this started.
   */
  const slope =
    atFine > atCoarse && atCoarse > 0
      ? Math.log(atFine / atCoarse) / Math.log(fine / coarse)
      : 2

  /*
   * Bounded below by `decimateMesh`'s floor and **not bounded above**, which was tried and was
   * wrong: any ceiling expressible here is derived from the area model, and that model being
   * wrong on sparse meshes is the entire reason this function exists — capping the fitted grid at
   * `gridForFactor(triangles, 1)` took the sparsest real neuron straight back to the answer the
   * model alone gives. An over-fine grid is harmless: `decimateParts` merges nothing and hands
   * back the join.
   */
  const guess = Math.max(1, atCoarse) * perVertex
  const first = Math.max(
    MIN_DECIMATE_GRID,
    Math.round(coarse * Math.pow(target / guess, 1 / slope)),
  )
  const attempt = decimateParts(parts, first, box)
  /** How far a result is from the target, in logs — one metric for both questions below. */
  const missBy = (got: number): number => Math.abs(Math.log(Math.max(1, got) / target))
  const got = attempt.indices.length / 3
  if (missBy(got) < Math.log(TOLERANCE)) return attempt

  /*
   * One correction, from the **result** rather than from a model.
   *
   * Two probes fit a power law, and a mesh need not be one: a thin tube has a plateau where every
   * ring collapses to a point at any usable grid, and a fit that steps across it lands the far
   * side. The attempt and the probe now bracket the target in a way the two probes did not, so
   * the slope between them is the one that matters.
   *
   * It keeps whichever of the two came closer, so a second pass can never make the answer worse —
   * and it is capped at one, because each is a walk over every vertex and the measured case needs
   * none: on four real neurons the first attempt lands within 30% and this never runs.
   */
  const slopeNow =
    got > 0 && got !== guess && first !== coarse
      ? Math.log(got / guess) / Math.log(first / coarse)
      : slope
  const second = Math.max(
    MIN_DECIMATE_GRID,
    Math.round(first * Math.pow(target / Math.max(1, got), 1 / slopeNow)),
  )
  if (second === first) return attempt
  const retry = decimateParts(parts, second, box)
  return missBy(retry.indices.length / 3) < missBy(got) ? retry : attempt
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
  /**
   * The extents, where the caller has already walked them.
   *
   * `downsampleParts` computes them to size its probes and then calls this once or twice; without
   * this each call re-walked every vertex, three times over for a corrected fit — 1.1-1.9 ms a
   * walk, so 2-4% of the call for nothing.
   */
  measured?: PartsBounds,
): MeshArrays {
  const box = measured ?? partsBounds(parts)
  if (box.indexCount === 0 || grid < 2) return concatMeshes(parts)

  // A degenerate mesh — one point, or a perfectly flat axis in every direction — has nothing to
  // cluster and would divide by zero; `cellLattice` is where that is decided, once, for this pass
  // and for the probes that predict it.
  const lattice = cellLattice(box, grid)
  if (!lattice) return concatMeshes(parts)

  const { minX, minY, minZ, vertexCount, indexCount } = box
  const { cell, cellsY, cellsZ } = lattice

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
   * the first, not for it. `cellLattice` derives the pair, above, so the probes that predict this
   * clustering cannot disagree with it about a stride.
   */

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
interface PartsBounds {
  vertexCount: number
  indexCount: number
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

function partsBounds(parts: readonly MeshArrays[]): PartsBounds {
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
