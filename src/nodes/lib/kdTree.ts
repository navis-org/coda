/**
 * Nearest-point queries over a point set, for the one question a grid cannot answer cheaply:
 * how far is this point from a neuron it is nowhere near.
 *
 * **There is already a spatial index in this tree and it is deliberately not reused.**
 * `topologyOps.ts` hashes a skeleton's nodes into cells the size of the gap between them and
 * searches outward shell by shell, which is exactly right for its own question — a synapse sits
 * *on* the arbour it is being assigned to, so the first shell almost always answers. Every
 * question here is the opposite shape: two neurons that do not touch are tens of micrometres
 * apart, which at that cell size is hundreds of shells, and the ring loop there stops at 64 and
 * reports *nothing found*. A cell size chosen for the gap and a query distance chosen by the
 * data are not the same number and cannot be made into one.
 *
 * So: a median-split k-d tree, which is `scipy.spatial.cKDTree` and R's `nabor::knn` — the two
 * things the exported notebook and R Markdown call. The canvas and the export agree on the
 * structure as well as on the answer, rather than agreeing by coincidence.
 *
 * **Nothing here allocates per query.** A distance matrix is one query per query-point per
 * target neuron, which on an ordinary comparison is tens of millions; the traversal stacks are
 * built once with the tree and the accessors return numbers.
 *
 * ## Pruning is on each node's box, not on its split plane, and that was measured
 *
 * The textbook k-d tree prunes a branch when the query's distance to the *splitting plane* is
 * already worse than the best distance found. That is a correct bound and a weak one, because a
 * plane can pass close to a query whose nearest actual point is nowhere near it — and the case
 * where it collapses is precisely this node's ordinary one: a query point **outside** the
 * target's extent, which is what every pair of neurons that do not touch looks like. The best
 * distance is then about as large as the whole arbour is far away, every plane is nearer than
 * that, and nothing is pruned at all.
 *
 * `pnpm probe:distance` is where that showed up rather than in any test, and the gap is not
 * subtle: on a uniform cloud the plane version ran at **0.27–0.41 µs** a search at every size,
 * and on a branching arbour of the same point counts it went **2.1 µs → 15.2 µs → 62.3 µs** at
 * 1k, 10k and 100k nodes. A tree whose cost grows linearly in the target is not a tree. Storing
 * each node's own bounding box — six `Float32`s, 390 kB for a 100,000-node skeleton, computed
 * during the build anyway to choose the split axis — restores it.
 */

/**
 * Points per leaf, below which the tree stops splitting and the query brute-forces.
 *
 * The tree's one free parameter, and `buildKdTree` takes it so that `pnpm probe:distance` can
 * sweep it rather than this comment claiming a number nobody measured. The leaf scan is three
 * subtractions and three multiplications per point with no branching worth the name, against a
 * level that costs two box distances and a possible stack write — so a leaf a little larger than
 * the level it replaces wins, and the curve is flat around the answer rather than peaked.
 */
export const LEAF_SIZE = 16

/**
 * The traversal stack's depth.
 *
 * One entry per level is the bound — each descent pushes at most the one child it did not take —
 * so this is the tree's height plus slack. A median split halves the range, so a leaf of 16
 * reaches depth 20 at a million points and 27 at a hundred million, neither of which is a point
 * set this app can hold.
 */
const STACK_DEPTH = 64

/**
 * The flat arrays one tree is made of, so that **two** of them can be walked together.
 *
 * Reached through `INTERNALS` below rather than hung on the returned object: a dual-tree descent
 * has to read both trees' boxes and ranges in one loop, which the closures cannot do for a tree
 * they did not build, but that is an argument for `closestPair` seeing them — not for every
 * consumer of a `KdTree` being shown six typed arrays it must not touch. `geometryIndex.ts`
 * solves the same problem the same way.
 */
interface KdTreeData {
  readonly positions: Float32Array
  readonly order: Int32Array
  /** `-1` marks a leaf; a left child is always its parent's index plus one. */
  readonly right: Int32Array
  readonly start: Int32Array
  readonly end: Int32Array
  /** Six per node: min xyz then max xyz. */
  readonly box: Float32Array
  /**
   * The longest side of each node's box — which of two internal nodes `closestPair` splits.
   *
   * Stored rather than derived, because it is a fact about the tree that never changes and the
   * descent asks it of the same node once per *cell of the matrix*. Four bytes a node against the
   * boxes' twenty-four, and free at build time: the split axis is chosen by comparing the three
   * sides, so the longest one is already in hand.
   */
  readonly span: Float32Array
}

/** Each tree's arrays, keyed by the object handed back — see `KdTreeData`. */
const INTERNALS = new WeakMap<KdTree, KdTreeData>()

export interface KdTree {
  readonly count: number
  /**
   * Distance from `(x, y, z)` to the nearest point, or `Infinity` when none is nearer than
   * `maxDist`.
   *
   * Bounded rather than unbounded-then-compared because the bound is what prunes: a query
   * against a neuron on the other side of the brain descends one branch and rejects the tree.
   */
  nearest(x: number, y: number, z: number, maxDist?: number): number
  /**
   * Whether any point lies within `dist`. Early-exits on the first one.
   *
   * Separate from `nearest` rather than derived from it because *which* point is never asked —
   * `Cable within a distance` wants a yes or a no per sample, and stopping at the first hit is
   * most of what makes that method affordable on a neuron that genuinely overlaps another.
   */
  hasWithin(x: number, y: number, z: number, dist: number): boolean
}

/**
 * Build a tree over xyz-interleaved positions.
 *
 * The positions array is **read, never reordered** — the permutation lives in `order`. That is
 * the same rule `meshInside.ts` states for `three-mesh-bvh`'s `indirect: true` and for the same
 * reason: the buffer belongs to a `SkeletonsValue` on a wire that the 3D viewer, the SWC export
 * and every other reader hold too, and a reordered copy draws the identical neuron.
 */
export function buildKdTree(
  positions: Float32Array,
  count = Math.floor(positions.length / 3),
  leafSize = LEAF_SIZE,
): KdTree {
  const order = new Int32Array(count)
  for (let i = 0; i < count; i++) order[i] = i

  /*
   * The scratch the nodes are grown into, **handed to a top-level `addNode` rather than closed
   * over** — `Build` below is where that is argued, and it is a measured leak rather than a
   * matter of taste. Frozen into typed arrays underneath: a node holds between eight and sixteen
   * points, so the node count runs `count / 8` to `count / 5` depending on where the point count
   * falls between two powers of two — small beside the points either way, and a two-pass size
   * calculation would be a second spelling of the split rule.
   */
  const build: Build = {
    positions,
    order,
    leafSize,
    rights: [],
    starts: [],
    ends: [],
    boxes: [],
    spans: [],
  }
  if (count > 0) addNode(build, 0, count)

  const right = Int32Array.from(build.rights)
  const start = Int32Array.from(build.starts)
  const end = Int32Array.from(build.ends)
  /*
   * `Float32Array`, which is the precision the data already has: every bound is the min or max
   * of `Float32Array` coordinates, so widening on load is exact and the comparisons against the
   * double `x`/`y`/`z` are bit-identical. It halves the hottest read in the file — a 100,000-node
   * skeleton's boxes are 300 kB rather than 600, and a 20,000-node one stays inside L2.
   */
  const box = Float32Array.from(build.boxes)
  const span = Float32Array.from(build.spans)

  /** Squared distance from a point to a node's box; zero inside it. */
  const boxDistSq = (node: number, x: number, y: number, z: number): number => {
    const at = node * 6
    const dx = x < box[at]! ? box[at]! - x : x > box[at + 3]! ? x - box[at + 3]! : 0
    const dy = y < box[at + 1]! ? box[at + 1]! - y : y > box[at + 4]! ? y - box[at + 4]! : 0
    const dz = z < box[at + 2]! ? box[at + 2]! - z : z > box[at + 5]! ? z - box[at + 5]! : 0
    return dx * dx + dy * dy + dz * dz
  }

  const stackNode = new Int32Array(STACK_DEPTH)
  const stackDist = new Float64Array(STACK_DEPTH)

  const tree: KdTree = {
    count,
    nearest(x, y, z, maxDist = Infinity) {
      if (count === 0) return Infinity
      let bestSq = maxDist === Infinity ? Infinity : maxDist * maxDist
      let found = false
      let top = 1
      stackNode[0] = 0
      stackDist[0] = 0

      while (top > 0) {
        top--
        if (stackDist[top]! >= bestSq) continue
        let node = stackNode[top]!
        // Descend towards the nearer child, parking the other one where its *box* could still
        // hold something better. `left < 0` is the leaf marker.
        let dead = false
        while (right[node]! >= 0) {
          const l = node + 1
          const r = right[node]!
          const dl = boxDistSq(l, x, y, z)
          const dr = boxDistSq(r, x, y, z)
          const nearer = dl <= dr
          const nearSq = nearer ? dl : dr
          const farSq = nearer ? dr : dl
          if (nearSq >= bestSq) {
            dead = true
            break
          }
          if (farSq < bestSq && top < STACK_DEPTH) {
            stackNode[top] = nearer ? r : l
            stackDist[top] = farSq
            top++
          }
          node = nearer ? l : r
        }
        if (dead) continue
        for (let i = start[node]!; i < end[node]!; i++) {
          const at = order[i]! * 3
          const dx = positions[at]! - x
          const dy = positions[at + 1]! - y
          const dz = positions[at + 2]! - z
          const distSq = dx * dx + dy * dy + dz * dz
          if (distSq < bestSq) {
            bestSq = distSq
            found = true
          }
        }
      }
      return found ? Math.sqrt(bestSq) : Infinity
    },

    hasWithin(x, y, z, dist) {
      if (count === 0) return false
      const limitSq = dist * dist
      let top = 1
      stackNode[0] = 0
      stackDist[0] = 0

      while (top > 0) {
        top--
        if (stackDist[top]! > limitSq) continue
        let node = stackNode[top]!
        let dead = false
        while (right[node]! >= 0) {
          const l = node + 1
          const r = right[node]!
          const dl = boxDistSq(l, x, y, z)
          const dr = boxDistSq(r, x, y, z)
          const nearer = dl <= dr
          const nearSq = nearer ? dl : dr
          const farSq = nearer ? dr : dl
          if (nearSq > limitSq) {
            dead = true
            break
          }
          if (farSq <= limitSq && top < STACK_DEPTH) {
            stackNode[top] = nearer ? r : l
            stackDist[top] = farSq
            top++
          }
          node = nearer ? l : r
        }
        if (dead) continue
        for (let i = start[node]!; i < end[node]!; i++) {
          const at = order[i]! * 3
          const dx = positions[at]! - x
          const dy = positions[at + 1]! - y
          const dz = positions[at + 2]! - z
          if (dx * dx + dy * dy + dz * dz <= limitSq) return true
        }
      }
      return false
    },
  }
  INTERNALS.set(tree, { positions, order, right, start, end, box, span })
  return tree
}

/**
 * The growable arrays one build fills, and the reason they are a parameter rather than locals.
 *
 * **A closure over them was a leak, measured rather than reasoned about.** V8 context-allocates
 * every variable an inner function reads and gives **one** context to every closure in the
 * scope — so while `addNode` was an arrow function beside `nearest` and `hasWithin`, these five
 * `number[]`s stayed reachable from the returned tree for as long as the tree lived, which is as
 * long as its geometry does (`geometryIndex.ts` holds the tree in a `WeakMap` against the item).
 * They are pure scratch: everything in them is copied into typed arrays the moment the build
 * ends. At 500 skeletons of 20,000 nodes — 10 M points — that was **heap +168 MB against +0**,
 * and an index costing **29 bytes a point rather than 12.2**, which is 1.45x the geometry it
 * indexes (positions, radii and parents, 20 bytes a point) rather than 0.61x. Nothing refuses
 * that: `checkDistanceSize` guards the *matrix*, which is 8 MB at 1,000 x 1,000 and never the
 * constraint. `pnpm probe:distance` prints both columns, so the heap one reading anything but
 * zero is the symptom to look for.
 *
 * Releasing them by hand after the copy — `rights.length = 0` and so on — fixes the same number
 * and leaves the *sixth* array somebody adds to be forgotten, in a failure whose only symptom is
 * a tab that runs out of memory one comparison sooner. Passed in, nothing in `buildKdTree`'s
 * scope can capture them, so the question cannot be got wrong again.
 *
 * **There is no `left` array**, because a left child's index is always `self + 1`: `addNode`
 * pushes its own entry and then recurses left immediately. Stored, it would be one bit of
 * information — internal or leaf — in four bytes a node, which `rights` already carries as `-1`.
 */
interface Build {
  readonly positions: Float32Array
  readonly order: Int32Array
  readonly leafSize: number
  readonly rights: number[]
  readonly starts: number[]
  readonly ends: number[]
  /** Six per node: min xyz then max xyz. What the query prunes on. */
  readonly boxes: number[]
  /** The longest side of each node's box. Left at zero for a leaf, which never reads it. */
  readonly spans: number[]
}

/** Add one node over `order[start, end)`, splitting until a range fits in a leaf. */
function addNode(b: Build, start: number, end: number): number {
  const self = b.rights.length
  b.rights.push(-1)
  b.starts.push(start)
  b.ends.push(end)
  b.spans.push(0)
  /*
   * The box is written straight into `boxes` and the split axis read back out of it: one pass
   * over the range answering both of the build's questions, and no six-element array per node —
   * which at a hundred thousand points is twelve thousand throwaway allocations per neuron,
   * during the phase the node already spends a third of its progress bar on.
   */
  const at = self * 6
  b.boxes.length = at + 6
  boundsInto(b.positions, b.order, start, end, b.boxes, at)
  if (end - start <= b.leafSize) return self

  const spanX = b.boxes[at + 3]! - b.boxes[at]!
  const spanY = b.boxes[at + 4]! - b.boxes[at + 1]!
  const spanZ = b.boxes[at + 5]! - b.boxes[at + 2]!
  const axis = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2
  // The chosen axis *is* the longest side, so this is the max without recomputing it — and a
  // leaf keeps its zero, `closestPair` reading a span only where both nodes are internal.
  b.spans[self] = axis === 0 ? spanX : axis === 1 ? spanY : spanZ
  const mid = (start + end) >> 1
  selectNth(b.positions, b.order, start, end, mid, axis)
  // The left child is `self + 1` by construction — see `Build`.
  addNode(b, start, mid)
  b.rights[self] = addNode(b, mid, end)
  return self
}

/**
 * Write a range's bounding box into `out` at `at`, as min xyz then max xyz.
 *
 * Into the caller's array rather than returning one, for `InsideTests.containing`'s reason: this
 * runs once per tree node, and a tree over a dataset's neurons has hundreds of thousands of them.
 *
 * An empty range gets an **inverted** box, which nothing is ever near — the right answer for a
 * prune, where a zero box at the origin would claim every query.
 */
function boundsInto(
  positions: Float32Array,
  order: Int32Array,
  start: number,
  end: number,
  out: number[],
  at: number,
): void {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = start; i < end; i++) {
    const at = order[i]! * 3
    const x = positions[at]!
    const y = positions[at + 1]!
    const z = positions[at + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  out[at] = minX
  out[at + 1] = minY
  out[at + 2] = minZ
  out[at + 3] = maxX
  out[at + 4] = maxY
  out[at + 5] = maxZ
}

/**
 * Partition `order[start, end)` so that `order[nth]` is where it would be if the range were
 * sorted on `axis`, everything below it is no greater and everything above no less.
 *
 * Hoare's quickselect, **with a deterministic pivot**: a median of the range's first, middle and
 * last, never a random one. Invariant 4 asks `evaluate` to be deterministic, and a tree whose
 * shape depends on `Math.random()` gives the same distances by a different route — which is
 * fine until floating-point summation over `mean` puts a different last digit in a cache entry
 * that provenance says is unchanged.
 */
function selectNth(
  positions: Float32Array,
  order: Int32Array,
  start: number,
  end: number,
  nth: number,
  axis: number,
): void {
  // The coordinate read is written out rather than wrapped in an accessor: Hoare partitioning
  // calls it about `2 n log(n / leaf)` times per tree, which is millions on one large neuron,
  // and a closure per internal node is an allocation this loop has no other reason to make.
  let lo = start
  let hi = end - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const pivot = medianOfThree(
      positions[order[lo]! * 3 + axis]!,
      positions[order[mid]! * 3 + axis]!,
      positions[order[hi]! * 3 + axis]!,
    )
    let i = lo
    let j = hi
    while (i <= j) {
      while (positions[order[i]! * 3 + axis]! < pivot) i++
      while (positions[order[j]! * 3 + axis]! > pivot) j--
      if (i <= j) {
        const swap = order[i]!
        order[i] = order[j]!
        order[j] = swap
        i++
        j--
      }
    }
    if (nth <= j) hi = j
    else if (nth >= i) lo = i
    else return
  }
}

export function medianOfThree(a: number, b: number, c: number): number {
  return a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b
}

/* --------------------------------------------------------------------------------------------
 * The closest approach between two point sets
 * ----------------------------------------------------------------------------------------- */

/**
 * The stack the dual descent pushes onto, held at module scope and grown as needed.
 *
 * **One interleaved array** — node in `a`, node in `b`, box gap — rather than three parallel
 * ones: the three are always written and read together, so three arrays is three bounds checks
 * and three grow paths saying one thing. Node indices are integers well inside a double's exact
 * range, so a `Float64Array` holds all three without a second typed array.
 *
 * At module scope rather than per call, because a descent runs once per cell of the matrix —
 * millions of times — and an array per call is the allocation this whole file is written to
 * avoid. Safe because nothing here awaits or recurses: a call runs to completion before the next
 * begins, and `cellFor` asks exactly one of the two descents about a pair, never both at once.
 */
let stack = new Float64Array(3 * 256)

/** Squared distance between two nodes' boxes; zero where they overlap. */
function boxGapSq(a: Float32Array, pa: number, b: Float32Array, pb: number): number {
  /*
   * Written out rather than looped over the three axes, which is `boxDistSq`'s shape above and
   * for its reason: this is called twice per node visit and thousands of times per cell, and
   * TurboFan does not unroll a JS loop — so the rolled form pays an induction variable, a bound
   * check and two index additions per axis for six loads it could have done from constants.
   */
  const gx =
    a[pa]! > b[pb + 3]! ? a[pa]! - b[pb + 3]! : b[pb]! > a[pa + 3]! ? b[pb]! - a[pa + 3]! : 0
  const gy =
    a[pa + 1]! > b[pb + 4]!
      ? a[pa + 1]! - b[pb + 4]!
      : b[pb + 1]! > a[pa + 4]!
        ? b[pb + 1]! - a[pa + 4]!
        : 0
  const gz =
    a[pa + 2]! > b[pb + 5]!
      ? a[pa + 2]! - b[pb + 5]!
      : b[pb + 2]! > a[pa + 5]!
        ? b[pb + 2]! - a[pa + 5]!
        : 0
  return gx * gx + gy * gy + gz * gz
}

/**
 * The smallest distance between any point of `a` and any point of `b`.
 *
 * **A dual-tree descent, and the reason it exists is that the obvious version is the wrong
 * algorithm.** Asking each of A's points for its nearest neighbour in B answers this correctly
 * and costs one tree query per point — for a 2,000-node neuron against 2,600 targets, five
 * million queries a row and about eight minutes for an all-by-all, which is what was measured
 * before this. But the *closest approach* is a property of the two sets, not of any point in
 * them: walking both trees at once and dropping any pair of boxes already further apart than the
 * best distance found so far, two neurons in different neuropils are rejected at their roots and
 * cost a handful of box tests rather than two thousand queries. Measured at 2,600 x 2,600:
 * **8.2 minutes to about one**.
 *
 * It is exact — the pruning discards only pairs whose boxes bound them further away than a real
 * pair already found — so it answers precisely what the per-point loop answered.
 *
 * **The win is arrangement-dependent and the descent is used unconditionally, which is a choice
 * rather than an oversight.** Swept against the bounded per-point walk it replaces, µs a pair at
 * 2,000 / 10,000 / 40,000 nodes a neuron:
 *
 * | arrangement | dual-tree | per-point bounded |
 * | --- | --- | --- |
 * | scattered through a brain | 9.1 / 8.9 / 11.5 | 64.7 / 276.3 / 911.3 |
 * | sharing a neuropil, 40 µm | 12.9 / 32.8 / 97.9 | 69.6 / 305.4 / 1081.8 |
 * | co-located, fully interpenetrating | 86.9 / 403.0 / 1725.1 | **20.9 / 107.6 / 405.4** |
 *
 * Flat in the neuron's size wherever the two sets are apart, which is the whole point and is what
 * the 8.2 minutes to about one was measured on; linear and **four times slower** where every box
 * pair overlaps, because then nothing prunes and the descent visits leaf pairs the bounded walk
 * skips outright. The third row is also the arrangement `CLOSEST_PAIR_MICROS` is calibrated from,
 * so the constant describes the case the descent is worst at — conservative, and worth knowing
 * when reading it.
 *
 * No switch, because there is no cheap discriminator: a test on whether the two root boxes
 * overlap picks the walk for the second row too, where the descent is still five to eleven times
 * better. A real population sits between the first two rows; the third is a fixture with every
 * neuron rooted at one point.
 *
 * **Symmetric by construction**, which is the second saving: `min(A→B)` and `min(B→A)` are the
 * same number, so a `Symmetry` of `mean`, `min` or `max` over the two directions is the identity
 * and the reverse walk was always wasted work. `closestPairApplies` in `geometryDistance.ts` is
 * where that is stated for the node's benefit.
 *
 * Nearer pairs are pushed **last** so they are popped first: the sooner a real distance is found,
 * the more the rest of the descent can drop.
 *
 * Everything below reads the two trees' arrays through locals rather than through `ta.`/`tb.`.
 * Those are property loads inside the descent, and `tb.end[nb]` sits in a 256-iteration inner
 * loop's *condition*; a local is one load for the whole call.
 */
export function closestPair(a: KdTree, b: KdTree): number {
  if (a.count === 0 || b.count === 0) return Infinity
  const ta = INTERNALS.get(a)
  const tb = INTERNALS.get(b)
  if (!ta || !tb) return Infinity
  // `closestPair`'s locals, for its reason.
  const {
    right: rightA,
    start: startA,
    end: endA,
    order: orderA,
    positions: posA,
    box: boxA,
    span: spanA,
  } = ta
  const {
    right: rightB,
    start: startB,
    end: endB,
    order: orderB,
    positions: posB,
    box: boxB,
    span: spanB,
  } = tb

  /*
   * `Infinity`, deliberately. Seeding with a real pair first — one ordinary query of `a`'s first
   * point against `b`, which is a valid upper bound — was written, measured and removed: it made
   * no difference at any size, because pushing the nearer child last already walks the descent
   * straight to a close leaf pair, and it cost a query per cell of the matrix.
   */
  let bestSq = Infinity
  let top = 1
  let slots = stack
  slots[0] = 0
  slots[1] = 0
  slots[2] = 0

  while (top > 0) {
    top--
    const at = top * 3
    if (slots[at + 2]! >= bestSq) continue
    const na = slots[at]!
    const nb = slots[at + 1]!
    const leafA = rightA[na]! < 0
    const leafB = rightB[nb]! < 0

    if (leafA && leafB) {
      const iEnd = endA[na]!
      const jStart = startB[nb]!
      const jEnd = endB[nb]!
      for (let i = startA[na]!; i < iEnd; i++) {
        const pa = orderA[i]! * 3
        const ax = posA[pa]!
        const ay = posA[pa + 1]!
        const az = posA[pa + 2]!
        for (let j = jStart; j < jEnd; j++) {
          const pb = orderB[j]! * 3
          const dx = posB[pb]! - ax
          const dy = posB[pb + 1]! - ay
          const dz = posB[pb + 2]! - az
          const distSq = dx * dx + dy * dy + dz * dz
          if (distSq < bestSq) bestSq = distSq
        }
      }
      continue
    }

    /*
     * Split whichever side still has the larger box, so the two descend together rather than one
     * running ahead and pairing its leaves against the other's root. The two pushes are written
     * out rather than going through a closure: one that captured `top` and `bestSq` would put
     * both in a heap context, and `bestSq` is read and written by the leaf loop above.
     */
    // `at` is this pop's base, so room for two more triples is `at + 6` — an integer compare
    // rather than the `slots.length / 3` this was: three is not a power of two, so that is a real
    // division on the critical path of a branch that essentially never fires.
    if (at + 6 > slots.length) {
      const wider = new Float64Array(slots.length * 2)
      wider.set(slots)
      stack = wider
      slots = wider
    }
    const splitA = leafB || (!leafA && spanA[na]! >= spanB[nb]!)
    // Plain locals, never a destructured tuple: an array literal here is one allocation per node
    // visit, which is thousands per cell of the matrix.
    const leftNa = splitA ? na + 1 : na
    const leftNb = splitA ? nb : nb + 1
    const rightNa = splitA ? rightA[na]! : na
    const rightNb = splitA ? nb : rightB[nb]!
    const gapLeft = boxGapSq(boxA, leftNa * 6, boxB, leftNb * 6)
    const gapRight = boxGapSq(boxA, rightNa * 6, boxB, rightNb * 6)

    // Named once by how near they are, so the two pushes below are straight-line stores.
    let nearNa = leftNa
    let nearNb = leftNb
    let nearGap = gapLeft
    let farNa = rightNa
    let farNb = rightNb
    let farGap = gapRight
    if (gapRight < gapLeft) {
      nearNa = rightNa
      nearNb = rightNb
      nearGap = gapRight
      farNa = leftNa
      farNb = leftNb
      farGap = gapLeft
    }

    // The further of the two is pushed first, so the nearer is popped first.
    if (farGap < bestSq) {
      const to = top * 3
      slots[to] = farNa
      slots[to + 1] = farNb
      slots[to + 2] = farGap
      top++
    }
    if (nearGap < bestSq) {
      const to = top * 3
      slots[to] = nearNa
      slots[to + 1] = nearNb
      slots[to + 2] = nearGap
      top++
    }
  }
  return Math.sqrt(bestSq)
}

/**
 * Whether any point of `a` lies within `dist` of any point of `b`.
 *
 * `closestPair`'s question asked as a yes or a no, which is what `hasWithin` is to `nearest` one
 * level down — and it buys the same two things. `Cable or area within a distance` needs to know
 * only whether the two neurons come within `Within` of one another before it counts anything:
 * further apart than that, no sample of either can be inside it and the cell is zero without a
 * single query. Nearer, the answer arrives at the first pair of points inside the limit rather
 * than at the end of a traversal that was refining a minimum nobody asked for.
 *
 * **A second loop rather than an option on `closestPair`**, which is `nearest`/`hasWithin`'s
 * arrangement and `min`/`max`'s inside `directedNearest`. Both differences — a bound that is
 * constant where `closestPair`'s shrinks towards the answer, and a return from the middle of the
 * leaf scan — would be branches in the innermost loop of the hottest function in this file, taken
 * millions of times per matrix to serve one of the two methods.
 *
 * Bounds are inclusive (`<=`), as `hasWithin`'s are: a point exactly `dist` away is within it.
 */
export function anyPairWithin(a: KdTree, b: KdTree, dist: number): boolean {
  if (a.count === 0 || b.count === 0) return false
  const ta = INTERNALS.get(a)
  const tb = INTERNALS.get(b)
  if (!ta || !tb) return false
  // Destructured rather than fourteen assignments: the locals are the point — a property load
  // inside the descent, and `endB` sits in the leaf scan's condition — and one statement says so
  // without being the place a fifteenth field gets forgotten.
  const {
    right: rightA,
    start: startA,
    end: endA,
    order: orderA,
    positions: posA,
    box: boxA,
    span: spanA,
  } = ta
  const {
    right: rightB,
    start: startB,
    end: endB,
    order: orderB,
    positions: posB,
    box: boxB,
    span: spanB,
  } = tb

  const limitSq = dist * dist
  let top = 1
  let slots = stack
  slots[0] = 0
  slots[1] = 0
  slots[2] = 0

  while (top > 0) {
    top--
    const at = top * 3
    if (slots[at + 2]! > limitSq) continue
    const na = slots[at]!
    const nb = slots[at + 1]!
    const leafA = rightA[na]! < 0
    const leafB = rightB[nb]! < 0

    if (leafA && leafB) {
      const iEnd = endA[na]!
      const jStart = startB[nb]!
      const jEnd = endB[nb]!
      for (let i = startA[na]!; i < iEnd; i++) {
        const pa = orderA[i]! * 3
        const ax = posA[pa]!
        const ay = posA[pa + 1]!
        const az = posA[pa + 2]!
        for (let j = jStart; j < jEnd; j++) {
          const pb = orderB[j]! * 3
          const dx = posB[pb]! - ax
          const dy = posB[pb + 1]! - ay
          const dz = posB[pb + 2]! - az
          if (dx * dx + dy * dy + dz * dz <= limitSq) return true
        }
      }
      continue
    }

    // `closestPair`'s split, its growth check and its ordering, for its reasons.
    if (at + 6 > slots.length) {
      const wider = new Float64Array(slots.length * 2)
      wider.set(slots)
      stack = wider
      slots = wider
    }
    const splitA = leafB || (!leafA && spanA[na]! >= spanB[nb]!)
    const leftNa = splitA ? na + 1 : na
    const leftNb = splitA ? nb : nb + 1
    const rightNa = splitA ? rightA[na]! : na
    const rightNb = splitA ? nb : rightB[nb]!
    const gapLeft = boxGapSq(boxA, leftNa * 6, boxB, leftNb * 6)
    const gapRight = boxGapSq(boxA, rightNa * 6, boxB, rightNb * 6)

    let nearNa = leftNa
    let nearNb = leftNb
    let nearGap = gapLeft
    let farNa = rightNa
    let farNb = rightNb
    let farGap = gapRight
    if (gapRight < gapLeft) {
      nearNa = rightNa
      nearNb = rightNb
      nearGap = gapRight
      farNa = leftNa
      farNb = leftNb
      farGap = gapLeft
    }

    // The further of the two is pushed first, so the nearer is popped first — here that is what
    // makes the early return early: the first leaves visited are the ones most likely to hold a
    // pair inside the limit.
    if (farGap <= limitSq) {
      const to = top * 3
      slots[to] = farNa
      slots[to + 1] = farNb
      slots[to + 2] = farGap
      top++
    }
    if (nearGap <= limitSq) {
      const to = top * 3
      slots[to] = nearNa
      slots[to + 1] = nearNb
      slots[to + 2] = nearGap
      top++
    }
  }
  return false
}
