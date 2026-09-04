/**
 * Morphometrics on a skeleton: the measurements that come out of the tree itself.
 *
 * Headless and pure, `cleanOps.ts`'s arrangement — but where that file flattens geometry for
 * Python, this one does the arithmetic here. The split is deliberate and is the node's whole
 * cost model:
 *
 * - **Everything in this file is a tree walk**, exact and instant. Cable length, branch points,
 *   Strahler order, segment lengths and tortuosity are all O(n) over the node list, so the card
 *   can show them the moment a skeleton lands with no download and no worker.
 * - **The axon/dendrite split is not here.** It goes through `pyodide/topology.ts`, because
 *   matching navis's synapse flow centrality is what makes the number citable, and a
 *   re-derivation of it would be Coda's answer rather than navis's.
 *
 * ## Two things about the tree that are easy to assume and shouldn't be
 *
 * **A skeleton is a forest, not a tree.** Every backend can return a reconstruction that arrived
 * in fragments — `spanningForest` (`data/skeletonTree.ts`) guarantees each component is rooted
 * and acyclic, not that there is one of them. So every walk here starts from *all* roots, and
 * `fragments` is reported as a measurement rather than being quietly healed: a cable length
 * summed over four disconnected pieces is a fact about the reconstruction, and hiding it behind a
 * number that looks like one neuron is the failure this column exists to prevent.
 *
 * **Parent index is documented as coming before its child, and nothing here relies on it.**
 * `SkeletonGeometry.parents` is built in visit order, so `parents[i] < i` holds for every source
 * today and a single reverse pass would compute Strahler correctly. It is still done through an
 * explicit child list and a stack, because a backend that ever returned the SWC file's own
 * ordering would produce a Strahler index that is wrong rather than absent — every consumer would
 * draw it, and nothing would say which neurons were affected.
 *
 * ## Nanometres in, micrometres out, converted once
 *
 * Coda holds geometry in nanometres (`data/units.ts`); a neuroanatomist reads cable in
 * micrometres. The conversion happens at the boundary of this file — the raw walks work in the
 * skeleton's own units, `morphometrics` divides once — which is `cleanOps.ts`' rule: the side
 * that still knows what the numbers are is the side that should convert.
 */

import type { TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import type {
  ColumnData,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import type { SplitStatus } from '../../pyodide/topology'
import { cableLength, getColumn, makeTable } from '../../core/values'
import { NM_PER_UM } from './nblastOps'
import { packSkeletons } from './skeletonPacking'

/**
 * What a node is, in fastcore's own codes.
 *
 * The numbers are `navis_fastcore.classify_nodes`' and not an invention here: the split's Python
 * half returns arrays in this vocabulary, so a second numbering would mean two spellings of the
 * same fact meeting inside one card. Named rather than inlined for the reason `GROUP_COLORS`
 * records — a bare `2` in a comparison is unreadable and un-greppable.
 */
export const NODE_ROOT = 0
export const NODE_LEAF = 1
export const NODE_BRANCH = 2
export const NODE_SLAB = 3

/** Distance from each node to its parent, in the skeleton's own units. `0` at a root. */
export function parentDistances(skeleton: SkeletonGeometry): Float32Array {
  const { positions, parents } = skeleton
  const out = new Float32Array(parents.length)
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i]!
    if (parent < 0) continue
    out[i] = Math.hypot(
      positions[i * 3]! - positions[parent * 3]!,
      positions[i * 3 + 1]! - positions[parent * 3 + 1]!,
      positions[i * 3 + 2]! - positions[parent * 3 + 2]!,
    )
  }
  return out
}

/**
 * Children per node, plus the roots.
 *
 * Built once and handed to every walk below rather than recomputed per measurement: a hemibrain
 * skeleton is tens of thousands of nodes and this is the only allocation any of them needs.
 */
export interface SkeletonTree {
  /** `children[i]` holds the indices whose parent is `i`. */
  readonly children: readonly (readonly number[])[]
  readonly roots: readonly number[]
}

export function skeletonTree(skeleton: SkeletonGeometry): SkeletonTree {
  const { parents } = skeleton
  const children: number[][] = Array.from({ length: parents.length }, () => [])
  const roots: number[] = []
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i]!
    /*
     * An out-of-range parent is read as a root rather than trusted, which is the rule
     * `rasteriseSkeleton` already follows for the same array: indexing past the end gives
     * `undefined`, and the arithmetic on it yields `NaN` coordinates that stripe a tile and
     * corrupt every sum here. A node whose parent nobody can find genuinely is unattached.
     */
    if (parent < 0 || parent >= parents.length) roots.push(i)
    else children[parent]!.push(i)
  }
  return { children, roots }
}

/**
 * Node indices in post-order — every child before its parent.
 *
 * The one ordering Strahler needs, and it is worth naming because the obvious recursive
 * formulation is a stack overflow on real data: a CATMAID skeleton is routinely 16,000 nodes and
 * an unbranched primary neurite is a recursion 16,000 deep.
 */
function postOrder(tree: SkeletonTree, count: number): Int32Array {
  const out = new Int32Array(count)
  let cursor = count
  const stack = [...tree.roots]
  // A reverse pre-order *is* a post-order for a tree: filling `out` from the back means a node
  // is written after every one of its descendants has been.
  while (stack.length > 0) {
    const i = stack.pop()!
    out[--cursor] = i
    for (const child of tree.children[i]!) stack.push(child)
  }
  // A forest whose components do not cover every node — nothing produces one today, but a
  // partially-filled array would silently make node 0 a leaf of every tree.
  return cursor === 0 ? out : out.slice(cursor)
}

/**
 * Strahler order per node, `navis_fastcore.strahler_index`'s `'standard'` method.
 *
 * A leaf is 1; a node whose highest-ordered children tie takes that order plus one, and otherwise
 * inherits the highest. Note the tie is on *two or more* children at the maximum, not on all of
 * them being equal — a trifurcation whose branches are 3, 3 and 1 is a 4, which is the case a
 * `children.every(...)` formulation gets wrong and which no fixture with only bifurcations can
 * see. `topologyOps.test.ts` uses fastcore's own docstring example.
 */
export function strahlerOrders(
  skeleton: SkeletonGeometry,
  tree = skeletonTree(skeleton),
): Int32Array {
  const count = skeleton.parents.length
  const order = new Int32Array(count)
  for (const i of postOrder(tree, count)) {
    const kids = tree.children[i]!
    if (kids.length === 0) {
      order[i] = 1
      continue
    }
    let best = 0
    let atBest = 0
    for (const child of kids) {
      const s = order[child]!
      if (s > best) {
        best = s
        atBest = 1
      } else if (s === best) atBest++
    }
    order[i] = atBest > 1 ? best + 1 : best
  }
  return order
}

/** Root / leaf / branch / slab per node, in `classify_nodes`' codes. */
export function classifyNodes(
  skeleton: SkeletonGeometry,
  tree = skeletonTree(skeleton),
): Uint8Array {
  const out = new Uint8Array(skeleton.parents.length)
  for (let i = 0; i < out.length; i++) {
    const kids = tree.children[i]!.length
    const parent = skeleton.parents[i]!
    if (parent < 0 || parent >= skeleton.parents.length) out[i] = NODE_ROOT
    else if (kids === 0) out[i] = NODE_LEAF
    else if (kids > 1) out[i] = NODE_BRANCH
    else out[i] = NODE_SLAB
  }
  return out
}

/** One unbranched run, between a root/branch point and the next branch point or leaf. */
export interface SegmentStat {
  /** Along the neurite, in the skeleton's own units. */
  readonly length: number
  /**
   * Path length over straight-line distance between the run's two ends. Never below 1.
   *
   * `null` where the two ends are the same point, which is not "straight" — it is unmeasurable,
   * and a 1 there would report perfect straightness for a run that doubled back on itself.
   * `meanTortuosity` skips those rather than counting them as 1, for the reason `Group By`'s
   * `mean` answers null rather than 0 over an all-absent group: a manufactured measurement among
   * real ones is worse than a smaller sample.
   */
  readonly tortuosity: number | null
}

/**
 * The arbour broken into unbranched runs.
 *
 * A segment starts at a root or at the child of a branch point and ends at the next branch point
 * or leaf, which is `break_segments`' definition — and the branch point itself belongs to *both*
 * the run arriving at it and each run leaving it, because the edge into it is what carries the
 * length. Counting it once would lose one edge per branch, which on a bushy arbour is several
 * percent of the cable and reads as a units problem rather than an off-by-one.
 */
export function segmentStats(
  skeleton: SkeletonGeometry,
  tree = skeletonTree(skeleton),
  distances = parentDistances(skeleton),
): SegmentStat[] {
  const { positions } = skeleton
  const out: SegmentStat[] = []

  const straight = (a: number, b: number): number =>
    Math.hypot(
      positions[a * 3]! - positions[b * 3]!,
      positions[a * 3 + 1]! - positions[b * 3 + 1]!,
      positions[a * 3 + 2]! - positions[b * 3 + 2]!,
    )

  // Every run starts at a child of a branching node (or of a root), so the starts are exactly
  // the nodes whose parent has more than one child, plus the roots' own children.
  const starts: number[] = []
  for (const root of tree.roots) for (const child of tree.children[root]!) starts.push(child)
  for (let i = 0; i < skeleton.parents.length; i++) {
    if (tree.children[i]!.length > 1) for (const child of tree.children[i]!) starts.push(child)
  }

  for (const start of starts) {
    const from = skeleton.parents[start]!
    let length = 0
    let at = start
    for (;;) {
      length += distances[at]!
      const kids = tree.children[at]!
      if (kids.length !== 1) break
      at = kids[0]!
    }
    const span = straight(from, at)
    out.push({ length, tortuosity: span > 0 ? length / span : null })
  }
  return out
}

/**
 * The longest root-to-tip path, in the skeleton's own units.
 *
 * Deliberately *not* fastcore's `longest_path`, which is the longest path between any two nodes
 * and therefore crosses the root — for a neuron that means "widest tip to widest tip", where what
 * a morphometrics table is asked for is how far the cell reaches from its soma. The two agree
 * only on an unbranched cell.
 */
export function maxRootDistance(
  skeleton: SkeletonGeometry,
  tree = skeletonTree(skeleton),
  distances = parentDistances(skeleton),
): number {
  const depth = new Float64Array(skeleton.parents.length)
  let max = 0
  // Pre-order: a parent's depth is always resolved before its children are read.
  const stack = [...tree.roots]
  while (stack.length > 0) {
    const i = stack.pop()!
    for (const child of tree.children[i]!) {
      const d = depth[i]! + distances[child]!
      depth[child] = d
      if (d > max) max = d
      stack.push(child)
    }
  }
  return max
}

/** Everything the Morphology tab reports about one neuron. Lengths are micrometres. */
export interface Morphometrics {
  readonly neuronId: string
  /** Total cable, µm. */
  readonly cableLength: number
  readonly nodes: number
  readonly branchPoints: number
  readonly endPoints: number
  readonly segments: number
  /**
   * Rooted components. `1` is a single connected reconstruction; more means it arrived in
   * pieces, and every length above is a sum across them.
   */
  readonly fragments: number
  readonly maxStrahler: number
  /** Mean over segments that have a measurable one; `null` when none do. */
  readonly meanTortuosity: number | null
  /** Longest soma-to-tip path, µm. */
  readonly longestNeurite: number
  /**
   * Mean node radius, µm, or `null` where the source publishes none.
   *
   * Absent rather than zero, and the distinction is load-bearing: male-CNS declares no vertex
   * attributes so its radii are genuinely all `0`, and a mean of 0 µm is a measurement claiming
   * the neuron has no thickness. `radii` is filled by all three skeleton backends and is
   * meaningful in only some of them — see `flexLineMaterial.ts` for the other consumer that has
   * to know this.
   */
  readonly meanRadius: number | null
  /** Cable per Strahler order, µm, indexed by order — `[0]` is unused and always 0. */
  readonly cableByStrahler: readonly number[]
}

export function morphometrics(skeleton: SkeletonGeometry): Morphometrics {
  const tree = skeletonTree(skeleton)
  const distances = parentDistances(skeleton)
  const orders = strahlerOrders(skeleton, tree)
  const kinds = classifyNodes(skeleton, tree)
  const runs = segmentStats(skeleton, tree, distances)

  let branchPoints = 0
  let endPoints = 0
  let maxStrahler = 0
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === NODE_BRANCH) branchPoints++
    else if (kinds[i] === NODE_LEAF) endPoints++
    if (orders[i]! > maxStrahler) maxStrahler = orders[i]!
  }

  const cableByStrahler = new Array<number>(maxStrahler + 1).fill(0)
  for (let i = 0; i < distances.length; i++) {
    if (skeleton.parents[i]! < 0) continue
    cableByStrahler[orders[i]!] = (cableByStrahler[orders[i]!] ?? 0) + distances[i]! / NM_PER_UM
  }

  const measured = runs.filter((r) => r.tortuosity !== null)
  const meanTortuosity = measured.length
    ? measured.reduce((sum, r) => sum + r.tortuosity!, 0) / measured.length
    : null

  // A source publishing no radii fills the array with zeroes, so "are any of them non-zero" is
  // the only available test — see `meanRadius`' own note.
  let radiusSum = 0
  let radiusCount = 0
  for (let i = 0; i < skeleton.radii.length; i++) {
    const r = skeleton.radii[i]!
    if (r > 0) {
      radiusSum += r
      radiusCount++
    }
  }

  return {
    neuronId: skeleton.id,
    cableLength: cableLength(skeleton) / NM_PER_UM,
    nodes: skeleton.parents.length,
    branchPoints,
    endPoints,
    segments: runs.length,
    fragments: tree.roots.length,
    maxStrahler,
    meanTortuosity,
    longestNeurite: maxRootDistance(skeleton, tree, distances) / NM_PER_UM,
    meanRadius: radiusCount > 0 ? radiusSum / radiusCount / NM_PER_UM : null,
    cableByStrahler,
  }
}

/*
 * The schema half and the value half, side by side — invariant 3. The two lists below are the
 * same list in the same order, and `topologyOps.test.ts` walks the schema to build the row so a
 * column added to one and not the other is a test failure rather than a downstream column picker
 * that goes empty only after a Run.
 *
 * `cableByStrahler` and `segmentLengths` are deliberately *not* columns: they are per-neuron
 * arrays, and a table is one row per neuron. The card reads them off `Morphometrics` directly.
 */
export function morphometricsSchema(): TableSchema {
  return tableSchema(
    column('neuronId', 'str'),
    column('cableLength', 'f64', 'µm'),
    column('nodes', 'i64'),
    column('branchPoints', 'i64'),
    column('endPoints', 'i64'),
    column('segments', 'i64'),
    column('fragments', 'i64'),
    column('maxStrahler', 'i64'),
    column('meanTortuosity', 'f64'),
    column('longestNeurite', 'f64', 'µm'),
    column('meanRadius', 'f64', 'µm'),
  )
}

export function morphometricsTable(rows: readonly Morphometrics[]): TableValue {
  const data: Record<string, ColumnData> = {
    /*
     * Text, and this is invariant 8's seam for this table: an 18-digit CAVE root id held as a
     * float64 is a different neuron with nothing to say so. `SkeletonGeometry.id` is already text
     * for exactly this reason, so the value is passed through rather than converted.
     */
    neuronId: rows.map((r) => r.neuronId),
    cableLength: rows.map((r) => r.cableLength),
    nodes: rows.map((r) => r.nodes),
    branchPoints: rows.map((r) => r.branchPoints),
    endPoints: rows.map((r) => r.endPoints),
    segments: rows.map((r) => r.segments),
    fragments: rows.map((r) => r.fragments),
    maxStrahler: rows.map((r) => r.maxStrahler),
    meanTortuosity: rows.map((r) => r.meanTortuosity),
    longestNeurite: rows.map((r) => r.longestNeurite),
    meanRadius: rows.map((r) => r.meanRadius),
  }
  return makeTable(morphometricsSchema(), data)
}

/**
 * Which skeleton node each synapse sits on.
 *
 * navis works from a connector table that already carries a `node_id`; Coda's synapses arrive as
 * loose coordinates in a `PointsValue`, because that is what every backend actually publishes and
 * what the 3D viewer draws. So the association has to be made here, and it is the one step in the
 * split that is Coda's rather than navis's — hence a pure function with its own tests rather than
 * a few lines inside the fetch.
 *
 * **A uniform grid, not brute force.** The obvious double loop is fine for a 2,000-node optic-lobe
 * cell (4M distance tests, single-digit milliseconds) and is not fine for the case that actually
 * matters: a traced CATMAID skeleton is ~16,800 nodes against ~10,000 connectors, which is 168M
 * tests every time somebody pages to a new neuron. The grid makes it linear in the synapse count
 * for any realistic density.
 *
 * **The cell size is the median parent distance, not a constant.** A fixed grid in nanometres is
 * either far too fine for a chunk-graph skeleton whose nodes are microns apart, or far too coarse
 * for a traced one sampled every 50 nm — and "too coarse" is the expensive direction, since every
 * lookup then scans a cell holding most of the neuron. Deriving it from the skeleton's own node
 * spacing makes one implementation right for both.
 */
export interface SynapseAssignment {
  /** Node index per synapse, in the order the points were given. `-1` if the skeleton is empty. */
  readonly nodeOf: Int32Array
  /** Presynaptic sites landing on each node. */
  readonly pre: Uint32Array
  /** Postsynaptic sites landing on each node. */
  readonly post: Uint32Array
}

/** One synapse, as this module needs it: a position and which side of the connection it is. */
export interface SynapseSite {
  readonly x: number
  readonly y: number
  readonly z: number
  /** Anything that is not `'pre'` counts as postsynaptic — see `assignSynapses`. */
  readonly polarity: string
}

/**
 * The polarity column of a cloud, resolved once.
 *
 * Hoisted out of `siteAt`, which resolved it per row: `findColumn` is a linear scan that
 * allocates a closure and `getColumn` is a second lookup, and both ran once *per synapse*. On
 * body 10003's 57,034-row cloud that is ~114,000 redundant lookups per conversion, and the node
 * converts a whole-set cloud rather than one neuron's.
 */
export function polarityColumn(points: PointsValue): ColumnData | undefined {
  return findColumn(points.attributes.schema, 'polarity')
    ? getColumn(points.attributes, 'polarity')
    : undefined
}

/**
 * One synapse row of a point cloud, in the shape the ops want.
 *
 * Exported because the node and the widget both convert the same cloud — written twice, the two
 * differed on whether the id went through `idText`. `polarity` is passed in rather than looked
 * up so a caller in a loop resolves it once; see `polarityColumn`.
 */
export function siteAt(
  points: PointsValue,
  i: number,
  polarity = polarityColumn(points),
): SynapseSite {
  return {
    x: points.positions[i * 3] ?? 0,
    y: points.positions[i * 3 + 1] ?? 0,
    z: points.positions[i * 3 + 2] ?? 0,
    polarity: String(polarity?.[i] ?? ''),
  }
}

/** Every synapse row of a cloud, in order. */
export function sitesFrom(points: PointsValue | undefined): SynapseSite[] {
  if (!points) return []
  const polarity = polarityColumn(points)
  const out: SynapseSite[] = new Array<SynapseSite>(points.attributes.length)
  for (let i = 0; i < points.attributes.length; i++) out[i] = siteAt(points, i, polarity)
  return out
}

export function assignSynapses(
  skeleton: SkeletonGeometry,
  sites: readonly SynapseSite[],
  distances = parentDistances(skeleton),
): SynapseAssignment {
  const count = skeleton.parents.length
  const nodeOf = new Int32Array(sites.length).fill(-1)
  const pre = new Uint32Array(count)
  const post = new Uint32Array(count)
  if (count === 0 || sites.length === 0) return { nodeOf, pre, post }

  const cell = gridCell(distances)
  const grid = new Map<number, number[]>()

  for (let i = 0; i < count; i++) {
    const k = cellKeyAt(
      skeleton.positions[i * 3]!,
      skeleton.positions[i * 3 + 1]!,
      skeleton.positions[i * 3 + 2]!,
      cell,
    )
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  }

  sites.forEach((site, s) => {
    const best = nearest(skeleton, grid, cell, site.x, site.y, site.z)
    nodeOf[s] = best
    if (best < 0) return
    /*
     * Anything not spelled `pre` is counted as postsynaptic, which is deliberate rather than
     * lax: the three backends spell polarity differently and the *pre* side is the one they
     * agree on, so an unrecognised value landing in `post` overcounts the input side rather
     * than silently vanishing from both. A synapse counted nowhere would move the flow
     * centrality without appearing in any total that could explain it.
     */
    if (site.polarity === 'pre') pre[best]!++
    else post[best]!++
  })

  return { nodeOf, pre, post }
}

/**
 * A grid cell about the size of the gap between neighbouring nodes.
 *
 * The median rather than the mean: a healed skeleton carries a handful of bridging edges spanning
 * microns, and a mean dragged up by those gives cells big enough to hold a whole arbour.
 */
function gridCell(distances: Float32Array): number {
  // A typed copy sorted in place: the boxed `number[]` this replaced allocated one object per
  // node and sorted them through a comparator, on a walk that is otherwise all typed arrays.
  let count = 0
  for (let i = 0; i < distances.length; i++) if (distances[i]! > 0) count++
  if (count === 0) return 1000
  const real = new Float32Array(count)
  let at = 0
  for (let i = 0; i < distances.length; i++) if (distances[i]! > 0) real[at++] = distances[i]!
  real.sort()
  const median = real[Math.floor(count / 2)]!
  // Floored well below any real node spacing: a degenerate skeleton whose nodes nearly coincide
  // would otherwise give a cell size of ~0 and a key per node, which is a hash lookup per node.
  return Math.max(median, 50)
}

/**
 * A grid cell's key, as a number.
 *
 * Numeric rather than `` `${x},${y},${z}` ``, which is what this was. A template literal allocates
 * a string per call and hashes it per lookup, and the call count here is not small: one per
 * skeleton node while the grid is built (17,000 on a traced cell) and up to 27 per synapse during
 * the search, because ring 0 can never satisfy the early exit and the ring-1 shell is always
 * scanned. On a dense neuron that is a few hundred thousand throwaway strings per split.
 *
 * `SPREAD` is half the addressable range per axis, and it is bounded by float64's integer range
 * rather than chosen for headroom: the key is a base-`2 * SPREAD` packing of three values, so the
 * largest it can produce is `(2 * SPREAD)^3` and that has to stay under `Number.MAX_SAFE_INTEGER`.
 * At 50,000 the ceiling is 1e15 against 9.007e15; a million — the number that looks generous —
 * overflows it by three orders of magnitude and silently aliases cells. `keyBound` in the test
 * suite is what stops that being reintroduced.
 *
 * 50,000 cells per axis is 2.5 mm each way at the 50 nm cell floor, which is a scene far larger
 * than any brain here. A coordinate past the range folds onto another cell, and that costs a
 * longer search rather than a wrong answer: `nearest` measures real distances, so a node from a
 * bucket it should not have looked in is simply rejected.
 */
export const GRID_SPREAD = 50_000

export function cellKey(cx: number, cy: number, cz: number): number {
  const span = 2 * GRID_SPREAD
  return ((cx + GRID_SPREAD) * span + (cy + GRID_SPREAD)) * span + (cz + GRID_SPREAD)
}

function cellKeyAt(x: number, y: number, z: number, cell: number): number {
  return cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell))
}

/** Nearest node to a point, searching outward from its own cell until one is found. */
function nearest(
  skeleton: SkeletonGeometry,
  grid: ReadonlyMap<number, number[]>,
  cell: number,
  x: number,
  y: number,
  z: number,
): number {
  const cx = Math.floor(x / cell)
  const cy = Math.floor(y / cell)
  const cz = Math.floor(z / cell)
  let best = -1
  let bestDist = Infinity

  for (let ring = 0; ring < 64; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dz = -ring; dz <= ring; dz++) {
          // Only the shell of this ring; the interior was searched on the previous pass.
          if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue
          const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz))
          if (!bucket) continue
          for (const i of bucket) {
            const d =
              (skeleton.positions[i * 3]! - x) ** 2 +
              (skeleton.positions[i * 3 + 1]! - y) ** 2 +
              (skeleton.positions[i * 3 + 2]! - z) ** 2
            if (d < bestDist) {
              bestDist = d
              best = i
            }
          }
        }
      }
    }
    /*
     * One ring past the first hit, never at it. A node found in the corner of the current shell
     * can be further away than one sitting just inside the next — the classic grid-search
     * off-by-one, and it produces a plausible wrong answer rather than a visible failure.
     */
    if (best >= 0 && bestDist <= (ring * cell) ** 2) return best
  }
  return best
}

/* ------------------------------------------------------------------------------------------
 * The compartment half.
 *
 * The labels themselves come from Python (`pyodide/topology.ts`) because they are navis's; what
 * is here is the arithmetic over them, which is the same tree walk as everything else in this
 * file and has no business crossing the bridge twice.
 * ---------------------------------------------------------------------------------------- */

/** Per-compartment totals for one neuron. Cable is µm. */
export interface CompartmentStats {
  readonly status: SplitStatus
  readonly cableAxon: number
  readonly cableDendrite: number
  readonly cableLinker: number
  readonly preAxon: number
  readonly postAxon: number
  readonly preDendrite: number
  readonly postDendrite: number
}

const NO_SPLIT: CompartmentStats = {
  status: 'not split',
  cableAxon: 0,
  cableDendrite: 0,
  cableLinker: 0,
  preAxon: 0,
  postAxon: 0,
  preDendrite: 0,
  postDendrite: 0,
}

/*
 * The compartment codes, restated rather than imported.
 *
 * `src/nodes` importing from `src/pyodide` is not forbidden by the lint rule — both are headless
 * — but importing the *values* would put a worker-shaped module in the dependency graph of every
 * table op. (The `SplitStatus` import above is `import type`, which is erased.)
 *
 * That trade is only sound while something checks the two agree, and for a while nothing did:
 * `pyodide/topology.test.ts` tied `COMPARTMENT_*` to the Python and said nothing about these, so
 * a consistent renumbering of both would have left every test green while axon cable was filed
 * under the dendrite column. That test now pins all three spellings together.
 */
export const CODE_DENDRITE = 1
export const CODE_AXON = 2
export const CODE_LINKER = 3

/**
 * Cable and synapses per compartment.
 *
 * An edge belongs to the compartment of its **child**, which is the choice worth naming: the
 * alternative — counting an edge only when both ends agree — silently loses every boundary edge,
 * and the boundary is where the linker is, so a neuron's three compartments would not sum to its
 * cable. Attributing to the child makes the three totals add up to the whole exactly.
 */
export function compartmentStats(
  skeleton: SkeletonGeometry,
  compartment: Int32Array | undefined,
  synapses: SynapseAssignment | undefined,
  status: SplitStatus,
  distances = parentDistances(skeleton),
): CompartmentStats {
  if (!compartment || status !== 'ok') return { ...NO_SPLIT, status }
  let cableAxon = 0
  let cableDendrite = 0
  let cableLinker = 0
  for (let i = 0; i < distances.length; i++) {
    if (skeleton.parents[i]! < 0) continue
    const code = compartment[i]
    if (code === CODE_AXON) cableAxon += distances[i]!
    else if (code === CODE_DENDRITE) cableDendrite += distances[i]!
    else if (code === CODE_LINKER) cableLinker += distances[i]!
  }

  let preAxon = 0
  let postAxon = 0
  let preDendrite = 0
  let postDendrite = 0
  if (synapses) {
    for (let i = 0; i < compartment.length; i++) {
      const code = compartment[i]
      if (code === CODE_AXON) {
        preAxon += synapses.pre[i]!
        postAxon += synapses.post[i]!
      } else if (code === CODE_DENDRITE) {
        preDendrite += synapses.pre[i]!
        postDendrite += synapses.post[i]!
      }
    }
  }

  return {
    status,
    cableAxon: cableAxon / NM_PER_UM,
    cableDendrite: cableDendrite / NM_PER_UM,
    cableLinker: cableLinker / NM_PER_UM,
    preAxon,
    postAxon,
    preDendrite,
    postDendrite,
  }
}

/**
 * One neuron's row: the tree measurements, and the split's if it ran.
 *
 * Two objects rather than one flattened interface, because the split half is genuinely optional
 * and a `cableAxon: 0` on a neuron nobody split is the manufactured measurement `meanRadius`
 * already refuses to produce.
 */
export interface TopologyRow {
  readonly metrics: Morphometrics
  readonly split?: CompartmentStats
}

/*
 * The schema half and the value half of the split columns, side by side with their own, and
 * *conditional on the same flag* — which is the whole of invariant 3's risk here. A schema that
 * declared the compartment columns whenever the param was on while the table emitted them only
 * when the split actually succeeded would give a downstream picker four columns that are not
 * there, and only after a Run.
 */
export function topologySchema(withSplit: boolean): TableSchema {
  const base = morphometricsSchema()
  if (!withSplit) return base
  return tableSchema(
    ...base.columns,
    column('splitStatus', 'str'),
    column('cableAxon', 'f64', 'µm'),
    column('cableDendrite', 'f64', 'µm'),
    column('cableLinker', 'f64', 'µm'),
    column('preAxon', 'i64'),
    column('postAxon', 'i64'),
    column('preDendrite', 'i64'),
    column('postDendrite', 'i64'),
  )
}

export function topologyTable(rows: readonly TopologyRow[], withSplit: boolean): TableValue {
  const base = morphometricsTable(rows.map((r) => r.metrics))
  if (!withSplit) return base

  const data: Record<string, ColumnData> = { ...base.data }
  const split = rows.map((r) => r.split ?? NO_SPLIT)
  data['splitStatus'] = split.map((s) => s.status)
  /*
   * Null, not zero, wherever the split did not run for this neuron. A multi-rooted
   * reconstruction has an axon; what it does not have is an answer, and a 0 µm axon beside real
   * ones is a measurement claiming otherwise — `Group By`'s rule about a mean over an all-absent
   * group, applied one layer up.
   */
  const measured = <T>(pick: (s: CompartmentStats) => T): ColumnData =>
    split.map((s) => (s.status === 'ok' ? (pick(s) as never) : null))
  data['cableAxon'] = measured((s) => s.cableAxon)
  data['cableDendrite'] = measured((s) => s.cableDendrite)
  data['cableLinker'] = measured((s) => s.cableLinker)
  data['preAxon'] = measured((s) => s.preAxon)
  data['postAxon'] = measured((s) => s.postAxon)
  data['preDendrite'] = measured((s) => s.preDendrite)
  data['postDendrite'] = measured((s) => s.postDendrite)

  return makeTable(topologySchema(true), data)
}

/**
 * A whole set flattened for the split, as one crossing of the bridge.
 *
 * `packSkeletons` for the two arrays every Pyodide skeleton call sends, plus the per-node synapse
 * counts this one adds. Here rather than in `nodes/output/topology.ts` because it is arithmetic
 * over the flat layout, which is the kind of thing that fails by producing a plausible answer for
 * the wrong neuron — and in a node file nothing in this module's test suite could reach it.
 */
export function flattenForSplit(
  skeletons: SkeletonsValue,
  assignments: readonly SynapseAssignment[],
): {
  parents: Int32Array
  offsets: Int32Array
  presynapses: Uint32Array
  postsynapses: Uint32Array
} {
  const { parents, offsets, total } = packSkeletons(skeletons)
  const presynapses = new Uint32Array(total)
  const postsynapses = new Uint32Array(total)

  for (let i = 0; i < skeletons.items.length; i++) {
    const assignment = assignments[i]
    if (!assignment) continue
    presynapses.set(assignment.pre, offsets[i]!)
    postsynapses.set(assignment.post, offsets[i]!)
  }

  return { parents, offsets, presynapses, postsynapses }
}
