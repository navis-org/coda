/**
 * A score matrix in, a merge tree out — and everything about that tree that is not Python.
 *
 * Headless and pure, for `nblastOps.ts`'s reason: vitest has no Pyodide and jsdom has no
 * `Worker`, so anything left on the far side of the bridge is covered by nobody. What crosses
 * is one call; the guards, the transform decision, the reordering and the cut are all here,
 * where a test can see them.
 */

import type { Warner } from '../../core/limits'
import { CRASH_FLOOR_CELLS, refuseIfOverCrashFloor, warnOverThreshold } from '../../core/limits'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, LinkageValue, MatrixValue, TableValue } from '../../core/values'
import { linkageMergeCount, makeLinkage, tableFromRows } from '../../core/values'
import type {
  LinkageRequest,
  LinkageResult,
  LinkageSymmetry,
  LinkageTransform,
} from '../../pyodide/linkage'
import type { MatrixAxis } from './matrixShape'
import { labelsOf, takeMatrix } from './matrixShape'
import { SYMMETRY_OPTIONS } from './nblastOps'

/**
 * The linkage methods Coda offers, and — as much to the point — the two it does not.
 *
 * `centroid` and `median` are missing deliberately, and the reason is not taste. Both are
 * defined on *squared Euclidean* distances, which `1 - NBLAST score` is not, and both produce
 * **non-monotonic** trees: a merge whose height is below one of its own children's, which a
 * dendrogram cannot honestly draw. Measured against scipy on random NBLAST-shaped matrices,
 * 25 observations, 40 trials each: `centroid` inverted in 39 of 40 and `median` in 40 of 40,
 * while `ward`, `average`, `complete`, `single` and `weighted` inverted in none.
 *
 * That is what makes the cut below sound. On a monotonic tree, row order *is* ascending height
 * order, so "undo the last k - 1 merges" and "cut above height t" are both a prefix of the
 * rows — which is why `cutByCount` agreed with `scipy.cluster.hierarchy.cut_tree` on all 300
 * comparisons across these five methods, and disagreed on 45 of 120 across the other two.
 * Offering them would mean carrying a second, top-down cut for two methods that are invalid on
 * this data anyway.
 */
export const LINKAGE_METHODS = [
  { value: 'ward', label: 'ward (minimum variance)' },
  { value: 'average', label: 'average (UPGMA)' },
  { value: 'complete', label: 'complete (furthest neighbour)' },
  { value: 'single', label: 'single (nearest neighbour)' },
  { value: 'weighted', label: 'weighted (WPGMA / McQuitty)' },
]

/**
 * How the two directions of a pair are combined.
 *
 * Derived from NBLAST's list rather than restated: both are passed straight through to the same
 * fastcore `symmetry=` argument, so the *values* must stay identical. Only the `none` label
 * differs — there it means "query against target only", and here there is no target, just a
 * matrix whose lower triangle goes unread.
 */
export const LINKAGE_SYMMETRY_OPTIONS = SYMMETRY_OPTIONS.map((option) =>
  option.value === 'none' ? { ...option, label: 'use the matrix as it is' } : option,
)

/**
 * Where clustering starts saying what it is about to do.
 *
 * The linkage itself is `O(n^2)` in the condensed vector and single-threaded in wasm; what this
 * number was really about is the *drawing*, because a dendrogram of a few thousand leaves is a
 * grey smear with no label on it. That was a poor reason to refuse the **tree**: the Cut Tree
 * node takes the same linkage and hands back cluster numbers, which is a table, and a table of
 * twenty thousand rows is perfectly readable. Refusing the clustering because one of its two
 * consumers cannot draw it was the viewer's opinion arriving three nodes upstream.
 *
 * So it warns, and the dendrogram says its own piece about labels (`MAX_LEAVES_DRAWN`).
 */
export const LINKAGE_OBSERVATIONS_WARN = 5000

/**
 * The observation count at which the condensed distance vector — `n(n-1)/2` float64s, in one
 * allocation — reaches `CRASH_FLOOR_BYTES`. About 11,585.
 *
 * Derived rather than written down. It was `MAX_LINKAGE_OBSERVATIONS = 11_000`, "rounded down
 * to a number that reads as a decision rather than as arithmetic", and rounding is exactly what
 * made it a second, quietly wrong spelling of the floor: the check that used it refused at
 * 11,000 while `refuseIfOverCrashFloor` — the thing that decides — did not fire until 11,586.
 * The floor is arithmetic, so it should read as arithmetic.
 */
export const MAX_LINKAGE_OBSERVATIONS = Math.floor(Math.sqrt(2 * CRASH_FLOOR_CELLS))

/** Cluster numbers and the leaf order, one row per observation. */
export function clusterSchema(): TableSchema {
  return tableSchema(
    column('label', 'str'),
    column('cluster', 'i64'),
    column('order', 'i64'),
    column('size', 'i64'),
  )
}

/**
 * Refuse a matrix that cannot be clustered, naming which of the three reasons applies.
 *
 * **The row and column labels must be the same list**, and that is the check worth having.
 * NBLAST with a Target set of the same size returns a perfectly square matrix over *two
 * different populations* — clustering it would treat row 3 and column 3 as one observation
 * because they share an index, which is a confident wrong tree with nothing anywhere to say
 * so. Everything else here is arithmetic; this one is about meaning.
 */
export function checkLinkageInput(ctx: Warner, matrix: MatrixValue): void {
  const n = matrix.rowLabels.length
  if (n !== matrix.colLabels.length) {
    throw new Error(
      `Clustering needs a square matrix; this one is ${n} x ${matrix.colLabels.length}. ` +
        `An NBLAST with a Target wired compares two different sets, which has no tree.`,
    )
  }
  if (matrix.rowLabels.some((label, i) => label !== matrix.colLabels[i])) {
    throw new Error(
      `This matrix is square but its rows and columns are different things, so a tree over ` +
        `both would be meaningless. Clustering needs one population compared with itself — ` +
        `an NBLAST with nothing wired to Target, or an Adjacency of a set against itself.`,
    )
  }
  if (n < 2) {
    throw new Error(`Clustering needs at least 2 observations, got ${n}`)
  }
  // The one refusal about size left here: the condensed vector is a single allocation, and
  // past the floor there is no tree on the other side of it to warn about.
  refuseIfOverCrashFloor(
    `A linkage over ${n.toLocaleString()} observations`,
    ((n * (n - 1)) / 2) * 8,
  )
  if (n > LINKAGE_OBSERVATIONS_WARN) {
    warnOverThreshold(ctx, {
      count: n,
      threshold: LINKAGE_OBSERVATIONS_WARN,
      unit: 'observations',
      control: "this node's warn-above",
      cost: 'Linkage is single-threaded and grows with the square of that number.',
    })
  }
}

/**
 * Whether the cells have to be turned into distances, and how.
 *
 * `auto` reads `MatrixValue.measure`, which exists for exactly this: clustering needs
 * distances, so somebody has to know to invert a similarity, and the alternative is a special
 * case per producer in every consumer. A matrix that says nothing — Pivot genuinely cannot,
 * since its cells are whatever aggregation was picked — is treated as a **similarity**, which
 * is what every matrix a clustering is reached for here actually is.
 *
 * **The wrong guess is caught rather than drawn**, and that guard is not optional — see
 * `checkLinkageDistances`, which exists because this was got wrong first and the symptom was
 * not what the comment here used to predict.
 */
export function transformFor(measure: MatrixValue['measure'], param: string): LinkageTransform {
  if (param === 'one_minus' || param === 'none') return param
  return measure === 'distance' ? 'none' : 'one_minus'
}

/**
 * Refuse cells that do not become distances, naming what to do about it.
 *
 * **This was found in a browser and could not have been found anywhere else.** An Adjacency
 * matrix carries raw synapse counts, so `1 - 77` is `-76`; fastcore clusters negative
 * distances without complaint, and the tree that comes back has merge heights below zero. The
 * viewer then normalises against a maximum it is nowhere near, and the brackets project to
 * x = 42,423 on a 550-pixel card — the drawing is simply not there. Nothing throws, nothing
 * logs, and every count in the caption is correct.
 *
 * So the guess `transformFor` makes is checked before anything is marshalled, the same rule
 * `pivotTable` follows about its label cardinalities. The two ways in are named because they
 * want opposite fixes: counts want a Normalize upstream, and un-normalised NBLAST scores want
 * the switch on the node that produced them.
 */
export function checkLinkageDistances(matrix: MatrixValue, transform: LinkageTransform): void {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of matrix.values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min)) throw new Error('This matrix has no usable values to cluster')

  // `one_minus` inverts, so the largest cell gives the smallest distance.
  const lowest = transform === 'one_minus' ? 1 - max : min
  if (lowest >= 0) return

  const range = `${formatCell(min)} to ${formatCell(max)}`
  throw new Error(
    transform === 'one_minus'
      ? `These cells run ${range}, so treating them as similarities gives distances as low as ` +
          `${formatCell(lowest)} — and a distance cannot be negative. A matrix of synapse counts ` +
          `needs a Normalize in front of it to bring the cells into 0–1; un-normalised NBLAST ` +
          `scores need Normalise turned back on at the NBLAST node. If the cells already are ` +
          `distances, say so with the Distance setting.`
      : `These cells run ${range}, and a distance cannot be negative. Set Distance back to ` +
          `auto if they are similarities rather than distances.`,
  )
}

/** Enough precision to recognise the number, without printing a float's whole tail. */
function formatCell(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3)
}

/** What a merge height means, for the axis and the caption. */
export function distanceLabelFor(matrix: MatrixValue, transform: LinkageTransform): string {
  const cells = matrix.valueLabel ?? (matrix.measure === 'distance' ? 'distance' : 'score')
  return transform === 'one_minus' ? `1 − ${cells}` : cells
}

/**
 * The matrix as the bridge takes it.
 *
 * **The buffer is copied, and that is not defensive.** `callPython` *transfers* every typed
 * array in a call's arguments rather than cloning them — which is right for the point buffers
 * NBLAST builds for one call and drops — and this one is the upstream node's own cached
 * result. Transferred, it would be detached: the Heatmap an inch away redraws empty, the
 * scheduler's cache holds a zero-length array, and nothing connects either to the node that
 * was run. 500 x 500 is 2 MB, which is what a copy costs here.
 */
export function linkageRequestFrom(
  matrix: MatrixValue,
  options: { method: string; symmetry: LinkageSymmetry; transform: LinkageTransform },
): LinkageRequest {
  return {
    scores: new Float64Array(matrix.values),
    n: matrix.rowLabels.length,
    method: options.method,
    symmetry: options.symmetry,
    transform: options.transform,
  }
}

/** The tree, as the value a Dendrogram and a Cut both take. */
export function linkageValueFrom(
  result: LinkageResult,
  labels: string[],
  extra: { method?: string; distanceLabel?: string } = {},
): LinkageValue {
  // Through `makeLinkage` rather than a literal: it is the one place the three arrays are
  // checked against each other, and a leaf order that had drifted from the labels would
  // otherwise reach the viewer as a tree drawn over the wrong names.
  return makeLinkage(result.merges, labels, result.order, extra)
}

/**
 * The same matrix with its rows and columns in leaf order.
 *
 * The cheap 80% of a clustermap: wired to the existing Heatmap this is the block-diagonal
 * picture, with no second drawing and no new colour scale to keep in step with the first. It
 * is the *scores* reordered, never the distances the tree was built from — what somebody
 * wants to look at is the matrix they have, arranged so its structure shows.
 */
export function orderedMatrix(matrix: MatrixValue, order: Int32Array): MatrixValue {
  // The same order down both axes — `matrixShape.ts` owns the permutation, and carrying a
  // second copy of that loop here is how the two come to disagree about labels or NaNs.
  return takeMatrix(matrix, order, order)
}

/**
 * Undo the last `k - 1` merges, giving exactly `k` clusters.
 *
 * **Exactly k, which is not what `fcluster(..., 'maxclust')` promises.** That one finds the
 * lowest height leaving at most k clusters and cuts there, so a tie hands back fewer than
 * asked — measured on six observations in three tied pairs, `maxclust` answers 3 clusters for
 * k = 2, 4 and 5 alike. A spinner marked "Clusters: 4" that yields 3 with nothing saying why
 * is the silent surprise this codebase exists to avoid, so the count is honoured. SciPy has
 * the same function under another name: `cut_tree(Z, n_clusters=k)` agreed with this on every
 * one of 300 comparisons across the five methods offered, the tie case included, which is what
 * the notebook emits.
 */
export function cutByCount(linkage: LinkageValue, k: number): Int32Array {
  const n = linkage.labels.length
  const wanted = Math.max(1, Math.min(k, n))
  return assign(linkage, n - wanted)
}

/**
 * Cut across the tree at a height, keeping every merge at or below it.
 *
 * A prefix of the rows, because the five methods offered all produce ascending heights — see
 * `LINKAGE_METHODS` for the two that do not and why they are absent.
 */
export function cutByHeight(linkage: LinkageValue, height: number): Int32Array {
  let kept = 0
  const merges = linkageMergeCount(linkage)
  while (kept < merges && linkage.merges[kept * 4 + 2]! <= height) kept++
  return assign(linkage, kept)
}

/**
 * Where each observation sits in the drawing, i.e. the leaf order inverted.
 *
 * Here rather than in each caller because two `order` columns depend on it agreeing with
 * itself — a Cut Tree's and a Dendrogram's `Selected` — and those two are routinely joined.
 */
export function leafPositions(linkage: LinkageValue): Int32Array {
  const position = new Int32Array(linkage.labels.length)
  linkage.order.forEach((leaf, at) => {
    position[leaf] = at
  })
  return position
}

/**
 * Apply the first `kept` merges and number what is left.
 *
 * **Clusters are numbered in leaf order**, so cluster 1 is the leftmost group on the
 * dendrogram and adjacent numbers are adjacent groups. That is a divergence from SciPy and a
 * deliberate one: its two cut functions do not agree with *each other* on numbering, so there
 * was never a convention to match — only a partition, which does match exactly. Numbering by
 * where a group sits is what makes the cluster column read against the picture, and what makes
 * a `Sort by order` reproduce the drawing.
 */
function assign(linkage: LinkageValue, kept: number): Int32Array {
  const n = linkage.labels.length
  // Union-find over `2n - 1` nodes: `0..n-1` are observations and `n + i` is the cluster
  // formed by merge `i`, which is SciPy's numbering and therefore fastcore's.
  const parent = new Int32Array(2 * n - 1)
  for (let i = 0; i < parent.length; i++) parent[i] = i
  const find = (a: number): number => {
    let node = a
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]!]!
      node = parent[node]!
    }
    return node
  }
  for (let i = 0; i < kept; i++) {
    parent[find(linkage.merges[i * 4]!)] = n + i
    parent[find(linkage.merges[i * 4 + 1]!)] = n + i
  }

  return numberInLeafOrder(linkage, find)
}

/**
 * Number the groups 1..k in leaf order, given whatever decides which group a leaf is in.
 *
 * **Clusters are numbered in leaf order**, so cluster 1 is the leftmost group on the dendrogram
 * and adjacent numbers are adjacent groups. That is a divergence from SciPy and a deliberate one
 * — its two cut functions do not agree with *each other* on numbering, so there was never a
 * convention to match, only a partition, which does match exactly.
 *
 * Here rather than inside `assign` because all three cut modes must share it: a convention that
 * the docstring calls deliberate is exactly the kind that must have one implementation, and
 * `cutHomogeneous` had copied these nine lines.
 */
function numberInLeafOrder(
  linkage: LinkageValue,
  rootOf: (leaf: number) => number,
): Int32Array {
  const numbers = new Map<number, number>()
  const out = new Int32Array(linkage.labels.length)
  for (const leaf of linkage.order) {
    const root = rootOf(leaf)
    let number = numbers.get(root)
    if (number === undefined) {
      number = numbers.size + 1
      numbers.set(root, number)
    }
    out[leaf] = number
  }
  return out
}

/** One row per observation: what it is called, which group it fell in, and where it sits. */
export function clusterTable(linkage: LinkageValue, clusters: Int32Array): TableValue {
  const sizes = new Map<number, number>()
  for (const c of clusters) sizes.set(c, (sizes.get(c) ?? 0) + 1)

  const position = leafPositions(linkage)

  const rows: Record<string, CellValue>[] = linkage.labels.map((label, i) => ({
    label,
    cluster: clusters[i]!,
    order: position[i]!,
    size: sizes.get(clusters[i]!) ?? 0,
  }))
  return tableFromRows(clusterSchema(), rows)
}

/** The tree with a cut recorded on it, so a Dendrogram downstream can colour by it. */
export function withClusters(linkage: LinkageValue, clusters: Int32Array): LinkageValue {
  return makeLinkage(linkage.merges, linkage.labels, linkage.order, {
    clusters,
    ...(linkage.method ? { method: linkage.method } : {}),
    ...(linkage.distanceLabel ? { distanceLabel: linkage.distanceLabel } : {}),
  })
}

/** The tallest merge, i.e. the top of the tree. What a height cut is bounded by. */
export function linkageMaxHeight(linkage: LinkageValue): number {
  let max = 0
  for (let i = 0; i < linkage.merges.length; i += 4) max = Math.max(max, linkage.merges[i + 2]!)
  return max
}

/**
 * Cut so that each group draws from more than one dataset — cocoa's `extract_homogeneous_clusters`.
 *
 * **Not a port.** cocoa's function is the reference for the *goal*; its source was not in hand
 * when this was written, so what follows is the stated goal implemented directly rather than a
 * transcription, and the criterion is spelled out here so a later reader can compare rather than
 * assume. If they turn out to disagree, this is the one to change.
 *
 * ## What it is for
 *
 * A count cut asks "give me twenty groups" and a height cut asks "cut at this distance"; both
 * are blind to *which brain* each neuron came from, so both cheerfully return a group that is
 * forty FlyWire neurons and nothing else. That group is not a correspondence — it is the
 * clustering telling you it found forty similar neurons in one dataset, which was never the
 * question. This cuts by the property the question is actually about.
 *
 * ## The criterion
 *
 * A cluster is **mixed** when every dataset is present in it and no dataset holds more than
 * `maxShare` of it. What the walk looks for is the *deepest* mixed clusters, not the first:
 *
 * ```
 * split(node):
 *   leaf                        -> emit it
 *   either child is mixed       -> split both, there are tighter groups below
 *   node is mixed               -> emit it, splitting further would break it
 *   otherwise                   -> split both, and let the parts fall where they may
 * ```
 *
 * **The middle line is the whole algorithm**, and getting it wrong is not subtle: descending
 * only until a cluster is mixed emits the *root* almost every time, because a tree over two
 * connectomes is mixed at the top by construction. That returns one cluster containing
 * everything and looks like a working node. The first draft here did exactly that and a test
 * caught it.
 *
 * The last line is what handles a branch that is all one dataset: it cannot be emitted whole, so
 * it decomposes until its leaves fall out as singletons — the honest answer for a neuron with no
 * counterpart, and what makes the singleton count worth reading rather than a defect to tune
 * away.
 *
 * `maxShare` is a share of the cluster, not of the dataset, because that is the number somebody
 * can reason about at the card: `0.8` means "no group may be more than four-fifths one brain".
 * The alternative — a deviation from the expected proportion — needs the dataset sizes to be
 * comparable to mean anything, and two connectomes proofread to different depths are exactly the
 * case where they are not.
 *
 * Clusters are numbered in **leaf order**, `assign`'s convention, so the numbering reads against
 * the dendrogram whichever mode produced it.
 */
export function cutHomogeneous(
  linkage: LinkageValue,
  datasetOf: (label: string) => string | undefined,
  maxShare: number,
): { clusters: Int32Array; datasets: number; singletons: number } {
  const n = linkage.labels.length
  const merges = linkageMergeCount(linkage)

  // Per node, how many observations of each dataset it holds. Built bottom-up over the merge
  // rows, which are in ascending order by construction, so a child is always already counted.
  const names: string[] = []
  const indexOf = new Map<string, number>()
  const leafDataset = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const name = datasetOf(linkage.labels[i]!) ?? ''
    let at = indexOf.get(name)
    if (at === undefined) {
      at = names.length
      names.push(name)
      indexOf.set(name, at)
    }
    leafDataset[i] = at
  }
  const width = names.length
  const counts = new Int32Array((2 * n - 1) * width)
  for (let i = 0; i < n; i++) counts[i * width + leafDataset[i]!] = 1
  for (let i = 0; i < merges; i++) {
    const node = n + i
    // Unrolled rather than iterating a two-element literal: this runs on a slider drag, and the
    // per-merge array was measured at 0.17 ms of the walk's 1.34 ms on an 11,585-leaf tree.
    const left = linkage.merges[i * 4]!
    const right = linkage.merges[i * 4 + 1]!
    for (let d = 0; d < width; d++) {
      counts[node * width + d]! += counts[left * width + d]! + counts[right * width + d]!
    }
  }

  const homogeneous = (node: number): boolean => {
    let total = 0
    let largest = 0
    for (let d = 0; d < width; d++) {
      const c = counts[node * width + d]!
      // Every dataset present — a group missing one is not a correspondence between them.
      if (c === 0) return false
      total += c
      if (c > largest) largest = c
    }
    return largest <= total * maxShare
  }

  // Iterative rather than recursive: a degenerate tree over eleven thousand leaves is eleven
  // thousand deep, and this is `cheap` — it runs on a slider drag.
  const roots: number[] = []
  const stack: number[] = merges > 0 ? [n + merges - 1] : n > 0 ? [0] : []
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node < n) {
      roots.push(node)
      continue
    }
    const i = node - n
    const left = linkage.merges[i * 4]!
    const right = linkage.merges[i * 4 + 1]!
    // A mixed child means there are tighter mixed groups below, so this node is not the answer
    // even when it is itself mixed. Without this line the root is emitted and the whole tree
    // comes back as one cluster.
    if (homogeneous(left) || homogeneous(right)) {
      stack.push(left, right)
      continue
    }
    if (homogeneous(node)) {
      roots.push(node)
      continue
    }
    stack.push(left, right)
  }

  // Which kept root each observation belongs to. No sentinel: the kept roots partition the
  // leaves by construction — a node is either emitted or has its children pushed, never both —
  // so every leaf is written exactly once.
  const owner = new Int32Array(n)
  for (const root of roots) {
    const walk: number[] = [root]
    while (walk.length > 0) {
      const node = walk.pop()!
      if (node < n) {
        owner[node] = root
        continue
      }
      const i = node - n
      walk.push(linkage.merges[i * 4]!, linkage.merges[i * 4 + 1]!)
    }
  }
  const clusters = numberInLeafOrder(linkage, (leaf) => owner[leaf]!)

  const singletons = roots.filter((root) => root < n).length
  return { clusters, datasets: width, singletons }
}

// ---------------------------------------------------------------------------
// The Heatmap node's clustering
// ---------------------------------------------------------------------------

/**
 * Say what clustering one axis of a matrix will cost, and refuse only what cannot be allocated.
 *
 * Here rather than in `matrixShape.ts` because it is the third of this module's "before you
 * cluster" guards — `checkLinkageInput` and `checkLinkageDistances` are the other two — and
 * because the threshold it reads is this module's own. The distance matrix is `n x n` float64
 * in one allocation on the far side, so that is the floor, and above
 * `LINKAGE_OBSERVATIONS_WARN` the warning is the Linkage node's, since it is the same
 * single-threaded clustering.
 */
export function checkClusterInput(ctx: Warner, matrix: MatrixValue, axis: MatrixAxis): void {
  const n = labelsOf(matrix, axis).length
  refuseIfOverCrashFloor(`Clustering ${n.toLocaleString()} ${axis}`, n * n * 8)
  if (n > LINKAGE_OBSERVATIONS_WARN) {
    warnOverThreshold(ctx, {
      count: n,
      threshold: LINKAGE_OBSERVATIONS_WARN,
      unit: axis,
      control: 'the clustering warn-above',
      cost:
        'Clustering is single-threaded and grows with the square of that; the distances ' +
        'between the vectors are computed first and grow with the other axis too.',
    })
  }
}

/**
 * Say how many cells the clustering will read as zero.
 *
 * Once per run rather than once per axis, which is what makes it its own function: it walks
 * every cell, and the answer does not depend on which axis is being clustered — asked from
 * inside the per-axis guard it scanned a four-million-cell matrix twice to say the same
 * sentence twice. The Python side substitutes zero, and a silent substitution is the thing
 * this codebase exists to avoid.
 */
export function warnUnrecordedCells(ctx: Warner, matrix: MatrixValue): void {
  let unrecorded = 0
  for (const v of matrix.values) if (!Number.isFinite(v)) unrecorded++
  if (unrecorded === 0) return
  ctx.warn(
    `${unrecorded.toLocaleString()} cells are empty or not a number and are read as 0 for ` +
      `the clustering — a cell nobody recorded is not a partner. The cells themselves are ` +
      `left as they are.`,
  )
}
