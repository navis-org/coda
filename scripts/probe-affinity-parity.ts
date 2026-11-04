/**
 * Does the pack compute what the reference computes?
 *
 * Preprocessing and clustering exist three times — upstream's Python, `affinity_reference.py`,
 * and the pack's TypeScript — and only one of them is checked against the checkpoint. This is the
 * link between the other two. It writes what the TypeScript produced; `probe-affinity-parity.py`
 * recomputes the same things from the reference and compares, point for point and label for
 * label.
 *
 * **Not a golden file**, for the reason `probe-skeletonize.py` gives about itself: a fixture pins
 * whatever the implementation happened to produce. Both halves are computed fresh each run.
 *
 * **The constants come from `affinity-checkpoints.json`**, through `parseAffinityConfig`, and the
 * same block is handed to Python. Four literals on each side would be the very duplication the
 * manifest seam exists to prevent, in the one file whose job is to prove the two agree — and it
 * would leave the parse, the code most likely to be written as a cast, unchecked.
 *
 * What is compared, and what deliberately is not:
 *
 *  - **The transform is compared**, over the *same* drawn points: centring on the centroid and
 *    dividing by `globalScale`. That is `prepare_cloud`, and it is what a wrong answer looks like.
 *  - **The draw is not.** The TypeScript uses `seededRandom` so an unchanged graph gives an
 *    unchanged answer (invariant 4); Python's is numpy's. What matters is that both draw node
 *    indices uniformly with replacement, which is a property of the code and not of a seed.
 *  - **Clusterings are compared at thresholds that straddle the cut.** Well-separated blocks
 *    agree under any implementation; what differs between Lance-Williams here and scikit-learn
 *    is tie-breaking and the `>=`-vs-`>` boundary. So the across-block affinities sit around
 *    0.2, putting merge distances either side of 0.8, and several cuts are swept.
 *  - **The noise term is load-bearing.** Exact ties would let two correct implementations reach
 *    genuinely different partitions, which would make this flaky rather than wrong.
 *
 * `pnpm probe:affinity-parity`
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { seededRandom } from '../src/nodes/lib/tableOps'
import { parseAffinityConfig } from '../src/packs/seam/affinityConfig'
import { clusterAffinities, clusterConfidence } from '../src/packs/seam/affinityOps'
import { DEFAULT_SEED, pointCloud } from '../src/packs/seam/pointCloud'

const OUT = process.argv[2] ?? '/tmp/coda-affinity-parity.json'
const POINTS = 96

const checkpoints = JSON.parse(readFileSync('scripts/affinity-checkpoints.json', 'utf8')) as {
  checkpoints: Record<string, { config: unknown }>
}
const config = parseAffinityConfig(checkpoints.checkpoints['affinity-flywire']!.config, 'parity')

/** A different seed from the one under test: the independence that matters is the stream. */
const random = seededRandom(0x9e3779b9)

/** A synthetic skeleton, in nanometres, over a plausible extent. */
const nodes = 400
const positions = new Float32Array(nodes * 3)
for (let i = 0; i < nodes * 3; i++) positions[i] = (random() * 2 - 1) * 150_000

const cloud = pointCloud(
  { positions },
  { globalScale: config.preprocessing.globalScale, points: POINTS, seed: DEFAULT_SEED },
)

/** The points as drawn, in nm, before centring — what Python re-centres and re-scales. */
const drawnNm: number[] = []
for (let i = 0; i < POINTS; i++) {
  const at = cloud.sourceIndex[i]! * 3
  drawnNm.push(positions[at]!, positions[at + 1]!, positions[at + 2]!)
}

/**
 * Affinities with structure *near the cut*: three blocks plus stragglers, with across-block
 * values around 0.2 so merge distances land either side of the 0.8 threshold.
 */
const n = POINTS
const affinity = new Float32Array(n * n)
const owner = Array.from({ length: n }, (_, i) => (i < 36 ? 0 : i < 70 ? 1 : i < 90 ? 2 : 3 + (i % 3)))
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    const base = i === j ? 1 : owner[i] === owner[j] ? 0.74 : 0.2
    affinity[i * n + j] = Math.max(0, Math.min(1, base + (random() * 2 - 1) * 0.08))
  }
}

/** Several cuts, so the boundary is exercised rather than a single comfortable separation. */
const cuts = [
  config.clustering,
  { threshold: 0.8, minClusterSize: 4 },
  { threshold: 0.78, minClusterSize: 4 },
  { threshold: 0.82, minClusterSize: 4 },
  { threshold: 0.5, minClusterSize: 2 },
]

const runs = cuts.map(({ threshold, minClusterSize }) => {
  const clustering = clusterAffinities(affinity, n, { threshold, minClusterSize })
  return {
    threshold,
    minClusterSize,
    labels: [...clustering.labels],
    clusters: clustering.clusters,
    background: clustering.background,
    confidence: clusterConfidence(affinity, n, clustering.labels),
  }
})

writeFileSync(
  OUT,
  JSON.stringify({
    preprocessing: config.preprocessing,
    linkage: config.clustering.linkage,
    points: POINTS,
    nodes,
    drawnNm,
    positions: [...cloud.positions],
    sourceIndex: [...cloud.sourceIndex],
    affinity: [...affinity],
    runs,
  }),
)
console.error(`wrote ${OUT}: ${runs.length} cuts, ${runs.map((r) => r.clusters).join('/')} clusters`)
