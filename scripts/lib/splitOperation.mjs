/**
 * A proofreader's past split as a test case for `splitSites` (`probe-split-sites.mjs --operation`).
 *
 * The record (`operation_details`) holds the points the proofreader placed — in **base voxels**,
 * since `handle_split` divides nm by the segmentation resolution before logging — the edges the
 * cut removed, the roots it made and when. From it:
 *
 * - **the root before the split**: the source supervoxel's root 1 ms before the edit;
 * - **where the proofreader cut**: the removed edges' level-2 positions, from their parents 1 ms
 *   before the edit (the chunks they were in when cut; the L2 cache keeps a retired chunk's
 *   position). With no position at all, the middle of the proofreader's points;
 * - **two test points far from that cut**: on each root the split made, the level-2 chunk whose
 *   distance from the cut is nearest `distanceNm`. Those roots may since have been edited; their
 *   ids still name their chunks, which is all this reads.
 *
 * Reads only. CAVE's own preview cannot be asked about a past root — it requires both points on
 * one *current* root — so this mode has no min-cut beside it.
 */

import { caveGet } from '../../src/data/cave/client.ts'
import { tableUrl } from '../../src/data/cave/graphene.ts'
import { readL2Positions, readLevelTwoGraph } from '../../src/data/cave/l2.ts'
import { levelTwoParents, supervoxelRoots } from '../../src/data/cave/rootIds.ts'

const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const mean = (points) => [0, 1, 2].map((a) => points.reduce((s, p) => s + p[a], 0) / points.length)

/** The record, checked to be a split that went through. */
async function readSplit(graphene, operationId, options) {
  const url = tableUrl(
    graphene,
    `operation_details?operation_ids=${encodeURIComponent(`[${operationId}]`)}`,
  )
  const record = (await caveGet(url, options))[operationId]
  if (!record) throw new Error(`The chunkedgraph has no operation ${operationId}.`)
  if (!Array.isArray(record.removed_edges) || !Array.isArray(record.sink_ids)) {
    throw new Error(`Operation ${operationId} is not a split (it removed no edges).`)
  }
  if (record.operation_status !== 0 && record.operation_status !== undefined) {
    throw new Error(`Operation ${operationId} did not go through (status ${record.operation_status}).`)
  }
  return record
}

/** A root's level-2 chunks with positions, from its chunk graph and the L2 cache. */
async function chunksOf(graphene, root, options) {
  const { chunks } = await readLevelTwoGraph(graphene, root, options)
  return readL2Positions(graphene, chunks, options)
}

/** The chunk whose distance from `from` is nearest `wanted`. */
function chunkAt(positions, from, wanted) {
  let best
  let gap = Infinity
  for (const at of positions.values()) {
    const d = Math.abs(distance(at, from) - wanted)
    if (d < gap) {
      gap = d
      best = at
    }
  }
  return best
}

/**
 * The test case: the pre-split root, what the proofreader did (for scoring and drawing), and —
 * unless `points: false`, for a caller that only grades — a source and a sink `distanceNm` from
 * the cut on the two roots the split made.
 */
export async function splitCase(
  graphene,
  resolutionNm,
  operationId,
  distanceNm,
  options,
  { points = true } = {},
) {
  const record = await readSplit(graphene, operationId, options)
  const at = Date.parse(record.timestamp ?? record.operation_ts)
  if (!Number.isFinite(at)) throw new Error(`Operation ${operationId} has no readable time.`)

  const sourceSv = String(record.source_ids[0])
  const sinkSv = String(record.sink_ids[0])
  const removed = record.removed_edges.map(([a, b]) => [String(a), String(b)])
  const ends = [...new Set(removed.flat())]
  // Before, after, and the removed edges' chunks are independent reads.
  const [[before, sinkBefore], [sourceAfter, sinkAfter], parents] = await Promise.all([
    supervoxelRoots(graphene, [sourceSv, sinkSv], at - 1, options),
    supervoxelRoots(graphene, [sourceSv, sinkSv], at + 1, options),
    levelTwoParents(graphene, ends, at - 1, options),
  ])
  if (before !== sinkBefore) {
    throw new Error(`Operation ${operationId}'s points were on different roots before it.`)
  }
  if (sourceAfter === sinkAfter) {
    throw new Error(`Operation ${operationId} left its points on one root (${sourceAfter}).`)
  }

  const [placed, sourceChunks, sinkChunks] = await Promise.all([
    readL2Positions(graphene, parents.filter((p) => p !== '0'), options),
    points ? chunksOf(graphene, sourceAfter, options) : new Map(),
    points ? chunksOf(graphene, sinkAfter, options) : new Map(),
  ])
  const endPositions = parents.map((p) => placed.get(p)).filter(Boolean)
  const toNm = (voxel) => voxel.map((v, a) => v * resolutionNm[a])
  const proofreaderPoints = {
    sources: record.source_coords.map(toNm),
    sinks: record.sink_coords.map(toNm),
  }
  // Where the cut was: its removed edges, else the middle of the proofreader's points.
  const cutAt = endPositions.length
    ? mean(endPositions)
    : mean([...proofreaderPoints.sources, ...proofreaderPoints.sinks])
  const source = chunkAt(sourceChunks, cutAt, distanceNm) ?? proofreaderPoints.sources[0]
  const sink = chunkAt(sinkChunks, cutAt, distanceNm) ?? proofreaderPoints.sinks[0]

  return {
    root: before,
    after: { source: sourceAfter, sink: sinkAfter },
    at,
    sources: [source],
    sinks: [sink],
    removed,
    cutAt,
    proofreaderPoints,
    distances: { source: distance(source, cutAt), sink: distance(sink, cutAt) },
    sizes: { source: Math.max(1, sourceChunks.size), sink: Math.max(1, sinkChunks.size) },
  }
}

/**
 * A cut's sites against the proofreader's cut — the one grading both probes use. EXACT where a
 * site shares a removed edge; NEAR where a placed site is within `nearNm`; else MISS. An unplaced
 * site has no distance and neither helps nor spoils the grade.
 */
export function gradeSites(testCase, sites, nearNm) {
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const truth = new Set(testCase.removed.map(([a, b]) => key(a, b)))
  let shared = 0
  let nearestNm = Infinity
  for (const site of sites) {
    shared += site.edges.filter((e) => truth.has(key(e.source, e.sink))).length
    if (!site.unplaced) nearestNm = Math.min(nearestNm, distance(site.at, testCase.cutAt))
  }
  const kind = shared > 0 ? 'exact' : nearestNm <= nearNm ? 'near' : 'miss'
  return { kind, shared, truth: truth.size, nearestNm }
}
