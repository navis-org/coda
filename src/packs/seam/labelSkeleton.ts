/**
 * Point labels back onto skeleton nodes.
 *
 * The model answers about the points it was *drawn*, and that is not the skeleton: points are
 * drawn with replacement, so one node can be drawn several times and receive two different
 * labels, while most nodes are never drawn at all. The cluster column on the `Skeletons` output
 * and the colours in the 3D view come from this fold, so it is a named op with its own tests
 * rather than a few lines inside `evaluate`. (The Neuroglancer layer draws the *sampled* points,
 * not these — `scene.ts` says why.)
 *
 * **This is the pack's rule, not the model's.** Nothing upstream specifies it, so the parity probe
 * cannot check it and the choices are ours to defend:
 *
 *  - **A drawn node takes the majority label of its own draws**, ties going to the lower label so
 *    the answer does not depend on draw order. Averaging confidences and taking the best would let
 *    one lucky draw outvote three agreeing ones.
 *  - **An undrawn node takes the label of the nearest drawn node, by Euclidean distance.** Not
 *    along cable: the merge this is looking for is exactly where cable distance is wrong — two
 *    neurons wrongly joined are adjacent in space and far apart along the true arbour, and a
 *    cable metric would carry a label across the very junction in question.
 *  - **Background does not spread.** A node whose nearest drawn neighbour fell to background is
 *    background too; it is not promoted to the nearest real cluster, because "the model saw
 *    nothing it was confident about here" is a finding and not a gap to fill.
 *
 * ## Why a grid, measured
 *
 * The nearest-neighbour search is over **drawn** points (≤ a couple of thousand) for every
 * skeleton node, and skeletons are big: `limits.md`'s `FLAT_SKELETON_WARN` records published
 * FlyWire mip-1 skeletons at **14,559 to 338,087 nodes**. Measured here, against the brute-force
 * version this replaced, with 0 differing labels at every size:
 *
 * | skeleton nodes | points | brute force | grid |
 * | --- | --- | --- | --- |
 * | 14,559 | 1024 / 2048 | 32 / 50 ms | **7 / 6 ms** |
 * | 100,000 | 1024 / 2048 | 191 / 375 ms | **37 / 34 ms** |
 * | 338,087 | 1024 / 2048 | 631 / 1305 ms | **156 / 133 ms** |
 *
 * So a typical skeleton folds in tens of milliseconds and the largest published one in ~150 ms,
 * against ~12 s for the affinities that preceded it. The brute force was over the 100 ms bar by
 * an order of magnitude on real data while its own comment reasoned from "~10,000 nodes" — which
 * is why the sizes above come from `limits.md` rather than from a guess.
 *
 * `src/nodes/lib/kdTree.ts` is the repo's k-d tree and is deliberately **not** used: its whole
 * public surface is `nearest(x,y,z,maxDist) → distance` and `hasWithin(...) → boolean`, neither of
 * which returns *which* point, and this needs the nearest point's label. Adding an
 * index-returning query to a shared, hot, deliberately-closed file is a bigger change than a grid
 * built over at most a couple of thousand points.
 */

/** A cluster per skeleton node, 0 for background. */
export function labelSkeleton(
  positions: Float32Array,
  sourceIndex: Int32Array,
  pointLabels: Int32Array,
): Int32Array {
  const nodes = positions.length / 3
  const labels = new Int32Array(nodes).fill(-1)
  const drawn = gatherDrawn(positions, sourceIndex, pointLabels, labels)
  if (drawn.count === 0) return labels.fill(0)

  const grid = buildGrid(drawn)
  for (let node = 0; node < nodes; node++) {
    if (labels[node] !== -1) continue
    labels[node] = drawn.label[nearestDrawn(grid, drawn, positions, node)]!
  }
  return labels
}

interface Drawn {
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly label: Int32Array
  readonly count: number
}

/**
 * One entry per *distinct* drawn node, carrying its majority label, with `labels` stamped.
 *
 * `sourceIndex` arrives sorted (`pointCloud` sorts it), so a node's draws are contiguous and the
 * tally is a linear scan over runs — no map per node. The sortedness is not assumed silently: an
 * unsorted input simply yields several runs for one node, and the last run wins, which is why the
 * caller is the one that sorts.
 */
function gatherDrawn(
  positions: Float32Array,
  sourceIndex: Int32Array,
  pointLabels: Int32Array,
  labels: Int32Array,
): Drawn {
  const total = sourceIndex.length
  const x = new Float32Array(total)
  const y = new Float32Array(total)
  const z = new Float32Array(total)
  const label = new Int32Array(total)
  let count = 0

  let at = 0
  while (at < total) {
    const node = sourceIndex[at]!
    let end = at
    while (end < total && sourceIndex[end] === node) end += 1

    // Majority over this node's run. Ties to the lower label, so the answer cannot depend on the
    // order the draws arrived in.
    let best = pointLabels[at]!
    let bestVotes = 0
    for (let i = at; i < end; i++) {
      const candidate = pointLabels[i]!
      let votes = 0
      for (let j = at; j < end; j++) if (pointLabels[j] === candidate) votes += 1
      if (votes > bestVotes || (votes === bestVotes && candidate < best)) {
        best = candidate
        bestVotes = votes
      }
    }

    labels[node] = best
    x[count] = positions[node * 3]!
    y[count] = positions[node * 3 + 1]!
    z[count] = positions[node * 3 + 2]!
    label[count] = best
    count += 1
    at = end
  }
  return { x, y, z, label, count }
}

interface Grid {
  readonly start: Int32Array
  readonly list: Int32Array
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly cell: number
  readonly nx: number
  readonly ny: number
  readonly nz: number
}

/** A uniform grid over the drawn points, about one point per cell. */
function buildGrid(drawn: Drawn): Grid {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < drawn.count; i++) {
    if (drawn.x[i]! < minX) minX = drawn.x[i]!
    if (drawn.y[i]! < minY) minY = drawn.y[i]!
    if (drawn.z[i]! < minZ) minZ = drawn.z[i]!
    if (drawn.x[i]! > maxX) maxX = drawn.x[i]!
    if (drawn.y[i]! > maxY) maxY = drawn.y[i]!
    if (drawn.z[i]! > maxZ) maxZ = drawn.z[i]!
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1)
  // About one point per cell: the cube root of the count over the longest side.
  const perSide = Math.max(1, Math.round(Math.cbrt(drawn.count)))
  const cell = span / perSide || 1
  const nx = Math.max(1, Math.floor((maxX - minX) / cell) + 1)
  const ny = Math.max(1, Math.floor((maxY - minY) / cell) + 1)
  const nz = Math.max(1, Math.floor((maxZ - minZ) / cell) + 1)

  // Counting sort into CSR, the same shape `core/stats.ts`' `csr` uses.
  const cells = nx * ny * nz
  const start = new Int32Array(cells + 1)
  const of = (i: number) => {
    const cx = Math.min(nx - 1, Math.floor((drawn.x[i]! - minX) / cell))
    const cy = Math.min(ny - 1, Math.floor((drawn.y[i]! - minY) / cell))
    const cz = Math.min(nz - 1, Math.floor((drawn.z[i]! - minZ) / cell))
    return (cz * ny + cy) * nx + cx
  }
  for (let i = 0; i < drawn.count; i++) start[of(i) + 1]! += 1
  for (let c = 0; c < cells; c++) start[c + 1]! += start[c]!
  const cursor = start.slice(0, cells)
  const list = new Int32Array(drawn.count)
  for (let i = 0; i < drawn.count; i++) list[cursor[of(i)]!++] = i
  return { start, list, minX, minY, minZ, cell, nx, ny, nz }
}

/**
 * The drawn point nearest a skeleton node, as an index into `Drawn`.
 *
 * Rings of cells outward from the node's own, stopping once the best distance found is inside the
 * ring already searched — so a far-away node still terminates after the first ring that contains
 * anything plus one.
 */
function nearestDrawn(grid: Grid, drawn: Drawn, positions: Float32Array, node: number): number {
  const px = positions[node * 3]!
  const py = positions[node * 3 + 1]!
  const pz = positions[node * 3 + 2]!
  const cx = Math.min(grid.nx - 1, Math.max(0, Math.floor((px - grid.minX) / grid.cell)))
  const cy = Math.min(grid.ny - 1, Math.max(0, Math.floor((py - grid.minY) / grid.cell)))
  const cz = Math.min(grid.nz - 1, Math.max(0, Math.floor((pz - grid.minZ) / grid.cell)))

  let best = Infinity
  let nearest = 0
  const reach = Math.max(grid.nx, grid.ny, grid.nz)
  for (let r = 0; r <= reach; r++) {
    // Everything within r cells is now searched, so a hit closer than that is final. `r > 0` is
    // load-bearing: at r = 0 the inner radius is -cell, whose square is cell², so without it the
    // first ring would stop on any hit at all. Dead while `best` starts at Infinity, which is
    // exactly the kind of guard that comes back the day somebody seeds it.
    const inner = (r - 1) * grid.cell
    if (r > 0 && best <= inner * inner) break
    for (let z = Math.max(0, cz - r); z <= Math.min(grid.nz - 1, cz + r); z++) {
      for (let y = Math.max(0, cy - r); y <= Math.min(grid.ny - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(grid.nx - 1, cx + r); x++) {
          // Only the shell: the interior was searched on an earlier ring.
          if (
            r > 0 &&
            Math.abs(x - cx) !== r &&
            Math.abs(y - cy) !== r &&
            Math.abs(z - cz) !== r
          ) {
            continue
          }
          const c = (z * grid.ny + y) * grid.nx + x
          for (let k = grid.start[c]!; k < grid.start[c + 1]!; k++) {
            const i = grid.list[k]!
            const dx = drawn.x[i]! - px
            const dy = drawn.y[i]! - py
            const dz = drawn.z[i]! - pz
            const d = dx * dx + dy * dy + dz * dz
            if (d < best) {
              best = d
              nearest = i
            }
          }
        }
      }
    }
  }
  return nearest
}
