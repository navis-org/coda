/**
 * Affinities to labels: the model's second half, and the half a reimplementation gets wrong.
 *
 * `scripts/affinity_reference.py`'s `cluster` is the reference and `pnpm probe:affinity-parity`
 * checks this against it, label for label, at thresholds that straddle the cut. Three things it
 * encodes, each of which has already caught somebody:
 *
 *  - **The threshold is a *distance*, not an affinity.** Upstream computes `1 - affinity` and
 *    hands `t` to average-linkage clustering, so the paper's `t = 0.8` links points whose average
 *    affinity exceeds **0.2**. Reading it the other way round silently over-fragments every
 *    answer, and nothing about the output says so.
 *  - **The model is not symmetric.** `a(i,j)` and `a(j,i)` differ, so a pair's distance is taken
 *    from the mean of both directions rather than either triangle being believed.
 *  - **Small clusters are background, not neurons.** Anything under `minClusterSize` becomes
 *    label 0 — upstream's `remove_small_clusters` — because the training data deliberately
 *    contained fragments belonging to no complete neuron.
 *
 * ## Why this is not `runLinkage`
 *
 * Coda already clusters this way: `pyodide/linkage.ts`' `runLinkage` is fastcluster's average
 * linkage with `symmetry: 'mean'` and `transform: 'one_minus'`, and `linkageOps.ts`' `cutByHeight`
 * cuts it. That would be the reuse — and it was measured and declined. This runs **per neuron**
 * immediately after an inference the same node already waited on; a Pyodide boot and two crossings
 * of that bridge cost more than the clustering does, and the node would carry a second heavy
 * runtime beside a 406 MB model. What is taken from there instead is the parts that cost nothing:
 * the union-find, and a cut whose inclusivity is stated rather than assumed.
 *
 * ## Cost, measured
 *
 * The closest pair is found from a **cached minimum per live row**, rescanning only the rows whose
 * cached best pointed at one of the two just merged. Measured on Node 26 over a blocky matrix:
 * **6 ms at n = 512, 22 ms at n = 1024, 81 ms at n = 2048**, against 401 ms and 3,217 ms at the
 * last two for the full rescan this replaced. That is what keeps it off `core/slice.ts`'
 * `sliced`: the rule is that a long loop in `evaluate` cannot see Cancel, and the honest way to
 * satisfy it is to not be long. Re-measure before trusting these if the loop changes.
 */

import type { AffinityClustering } from './affinityConfig'

/** Labels, 0 for background. Index-aligned with the points the affinities were computed over. */
export interface Clustering {
  readonly labels: Int32Array
  /** How many real clusters came back, background excluded. */
  readonly clusters: number
  /** How many points fell to background. */
  readonly background: number
}

/**
 * What the clustering actually reads, by the manifest's own field names.
 *
 * `Pick`, not the whole `AffinityClustering`: `linkage` is refused in `parseAffinityConfig` and
 * never read here, and carrying it would make every caller supply a field that changes nothing —
 * a decoy that a test fixture then exists to feed.
 */
export type ClusterOptions = Pick<AffinityClustering, 'threshold' | 'minClusterSize'>

/**
 * A pair's distance: one minus the mean of the two directions, never below zero.
 *
 * One spelling, because "the model is not symmetric and this is how we resolve it" is one fact
 * and two copies of it can disagree.
 */
function pairDistance(affinity: Float32Array, n: number, i: number, j: number): number {
  const mean = 1 - (affinity[i * n + j]! + affinity[j * n + i]!) / 2
  return mean > 0 ? mean : 0
}

/**
 * Average-linkage agglomerative clustering on `1 - affinity`, cut at `threshold`.
 *
 * `affinity` is row-major `n × n`. It is read, never written.
 */
export function clusterAffinities(
  affinity: Float32Array,
  n: number,
  options: ClusterOptions,
): Clustering {
  // The working distance matrix. Square rather than triangular so an index is a multiply, and
  // 4 MB at n = 1024 is noise beside the model that produced the affinities.
  const distance = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = pairDistance(affinity, n, i, j)
      distance[i * n + j] = d
      distance[j * n + i] = d
    }
  }

  // Union-find: one representative per cluster, with `size` the member count. `parent[i] === i`
  // is what "still a cluster" means, so there is no second `alive` array to disagree with it.
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const size = new Int32Array(n).fill(1)

  // The cached closest live partner of each live row, and its distance. This is what makes the
  // loop O(n²) rather than O(n³) -- see the header.
  const nearest = new Int32Array(n).fill(-1)
  const nearestAt = new Float64Array(n).fill(Infinity)
  const rescan = (i: number) => {
    let best = Infinity
    let at = -1
    for (let j = 0; j < n; j++) {
      if (j === i || parent[j] !== j) continue
      const d = distance[i * n + j]!
      if (d < best) {
        best = d
        at = j
      }
    }
    nearest[i] = at
    nearestAt[i] = best
  }
  for (let i = 0; i < n; i++) rescan(i)

  for (;;) {
    let bestI = -1
    let best = Infinity
    for (let i = 0; i < n; i++) {
      if (parent[i] !== i) continue
      const at = nearestAt[i]!
      if (at < best) {
        best = at
        bestI = i
      }
    }
    // `>=`, not `>`: scikit-learn stops when the next merge would be *at or above*
    // `distance_threshold`, so a pair exactly at the threshold is not linked. `cutByHeight`
    // keeps merges at `<= t`, which differs here only at exact equality -- stated rather than
    // left for someone to discover.
    if (bestI < 0 || best >= options.threshold) break
    const bestJ = nearest[bestI]!

    // Lance-Williams for average linkage: the merged cluster's distance to k is the
    // size-weighted mean of the two. Exact, and what makes an update O(n) rather than O(n²).
    const sizeI = size[bestI]!
    const sizeJ = size[bestJ]!
    const total = sizeI + sizeJ
    for (let k = 0; k < n; k++) {
      if (parent[k] !== k || k === bestI || k === bestJ) continue
      const merged =
        (sizeI * distance[bestI * n + k]! + sizeJ * distance[bestJ * n + k]!) / total
      distance[bestI * n + k] = merged
      distance[k * n + bestI] = merged
    }
    parent[bestJ] = bestI
    size[bestI] = total

    // Only the rows whose cached best is now stale: the survivor, and anything that was pointing
    // at either of the two. Everything else is still valid, and the reason is load-bearing —
    // under Lance-Williams average linkage the merged distance is a size-weighted *mean* of the
    // two it replaces, so `d(k, merged) >= min(d(k, bestI), d(k, bestJ))`. A row whose nearest
    // was some third cluster was already at or below both, and a merge cannot have beaten it.
    // Without that, this looks like an unsafe optimisation and someone restores the full rescan.
    rescan(bestI)
    for (let i = 0; i < n; i++) {
      if (parent[i] !== i || i === bestI) continue
      if (nearest[i] === bestI || nearest[i] === bestJ) rescan(i)
    }
  }

  // Label largest first, so "cluster 1" means the same kind of thing from one neuron to the next.
  // That ordering is this pack's promise rather than the reference's, so `affinityOps.test.ts`
  // pins it -- a partition comparison cannot see numbering by construction.
  //
  // `size` is the count the merge loop already maintained, so nothing is re-derived here.
  const roots: number[] = []
  for (let i = 0; i < n; i++) if (parent[i] === i) roots.push(i)
  roots.sort((a, b) => size[b]! - size[a]! || a - b)

  const labelOfRoot = new Int32Array(n)
  let next = 1
  let background = 0
  for (const root of roots) {
    if (size[root]! < options.minClusterSize) background += size[root]!
    else labelOfRoot[root] = next++
  }
  const find = (i: number) => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    return root
  }
  const labels = new Int32Array(n)
  for (let i = 0; i < n; i++) labels[i] = labelOfRoot[find(i)]!
  return { labels, clusters: next - 1, background }
}

/**
 * How confident the model was that each point sits in the cluster it was given.
 *
 * The mean affinity from a point to the rest of its own cluster. A low value on a point the
 * clustering nonetheless placed is the honest signal that the boundary there is soft — which is
 * the thing a reader checking a suspected merge most wants to see, and the reason this is a
 * column rather than a single number per neuron.
 *
 * Background points (label 0) get null: they are not in a cluster to be confident about.
 */
export function clusterConfidence(
  affinity: Float32Array,
  n: number,
  labels: Int32Array,
): (number | null)[] {
  const confidence: (number | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const label = labels[i]!
    if (label === 0) continue
    let total = 0
    let count = 0
    for (let j = 0; j < n; j++) {
      if (j === i || labels[j] !== label) continue
      total += 1 - pairDistance(affinity, n, i, j)
      count += 1
    }
    confidence[i] = count > 0 ? total / count : null
  }
  return confidence
}

/**
 * What one neuron's result says, in one row of the node's summary table.
 *
 * Beside `clusterConfidence` rather than in `labelSkeleton.ts`, because it answers "what did the
 * affinities say" and touches no skeleton node at all.
 *
 * `confidence` is the **mean** of the per-point confidences over the points that have one. An
 * earlier draft of the plan said "the affinity to its own cluster's medoid"; the mean is what is
 * computed and what the help says, because a medoid is one point's opinion and the mean is the
 * cluster's.
 */
export interface NeuronSummary {
  readonly clusters: number
  readonly background: number
  readonly backgroundShare: number
  readonly confidence: number | null
  /** The weakest point the clustering nonetheless placed — where to look first. */
  readonly lowestConfidence: number | null
}

/**
 * Fold one neuron's clustering and confidences into a row.
 *
 * Takes the `Clustering` whole rather than its counts as loose arguments: three of the four
 * numbers come off one object, and separate parameters let a caller pass one neuron's background
 * beside another's cluster count with nothing to notice it.
 */
export function summarise(
  clustering: Clustering,
  confidence: readonly (number | null)[],
): NeuronSummary {
  let total = 0
  let placed = 0
  let lowest = Infinity
  for (const value of confidence) {
    if (value === null) continue
    total += value
    placed += 1
    if (value < lowest) lowest = value
  }
  const points = confidence.length
  return {
    clusters: clustering.clusters,
    background: clustering.background,
    backgroundShare: points > 0 ? clustering.background / points : 0,
    confidence: placed > 0 ? total / placed : null,
    lowestConfidence: placed > 0 ? lowest : null,
  }
}
