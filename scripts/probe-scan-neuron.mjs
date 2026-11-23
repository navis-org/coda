/**
 * Experimental: scan a whole neuron for weak joins (`weakJoins`), no points — what it costs, and,
 * on past splits, whether the proofreader's cut is among the weakest joins. **Reads only.**
 *
 *   pnpm probe:scan-neuron -- --datastack fanc_production_mar2021 --operation 14134[,7858,…]
 *   pnpm probe:scan-neuron -- --datastack fanc_production_mar2021 --root ID
 *
 * With `--operation`, the neuron is the root before the split and each join is graded against the
 * proofreader's cut, as `probe-split-sites.mjs` grades its candidates.
 *
 *   --max N         joins to report (default 20)
 *   --min-piece N   smallest region a join may join, supervoxels (default 20)
 *   --near UM       a join this close to the proofreader's cut is NEAR (default 1.5)
 *   --concurrency N subgraph requests in flight (default 4)
 */

import { cellBox, chunkOf } from '../src/data/cave/graphLayout.ts'
import { readLevelTwoGraph } from '../src/data/cave/l2.ts'
import { rootTimestamps } from '../src/data/cave/rootIds.ts'
import { readSubgraphBoxes } from '../src/data/cave/subgraph.ts'
import { findSupervoxels } from '../src/data/cave/volumes.ts'
import { weakJoins } from '../src/packs/seam/splitSites.ts'
import { placeCuts, SITE_RADIUS_NM } from '../src/packs/seam/splitSitesRun.ts'
import { probeArgs, requireCaveToken } from './lib/browserProbe.mjs'
import { gradeSites, splitCase } from './lib/splitOperation.mjs'

const args = probeArgs()
const datastack = args.value('--datastack')
const operations = args.value('--operation')?.split(',') ?? []
const rootArg = args.value('--root')
const max = Number(args.value('--max') ?? 20)
const minPiece = Number(args.value('--min-piece') ?? 20)
const nearNm = Number(args.value('--near') ?? 1.5) * 1000
if (!datastack || (operations.length === 0 && !rootArg)) {
  console.error('usage: --datastack NAME (--operation ID[,ID…] | --root ID)')
  process.exit(2)
}
const options = {
  deployment: args.value('--deployment') ?? 'https://global.daf-apis.com',
  token: requireCaveToken(),
}
const source = await findSupervoxels(datastack, options)
const { graphene, layout } = source
if (!layout?.chunkSize || !layout.voxelOffset) {
  console.error(`${datastack}'s chunkedgraph publishes no chunk grid in its info, so it cannot be boxed.`)
  process.exit(2)
}
const concurrency = Number(args.value('--concurrency') ?? 4)

const jobs = rootArg ? [{ root: rootArg }] : operations.map((operation) => ({ operation }))
for (const job of jobs) {
  let root = job.root
  let testCase
  if (job.operation) {
    // Graded only, so the test points (two whole-neuron position reads) are not asked for.
    testCase = await splitCase(graphene, source.layout.baseResolutionNm, job.operation, 15000, options, { points: false })
    root = testCase.root
  }
  console.log(`\n### ${job.operation ? `operation ${job.operation}, ` : ''}root ${root}`)

  /*
   * The whole neuron in one `subgraph` request is a 502 on a 2,800-chunk FANC neuron. So it is
   * read in boxes 3 chunks wide every 2 chunks: edges only cross between neighbouring chunks, and
   * `subgraph` keeps only edges inside its box, so every neighbouring pair must share a box.
   */
  let t = performance.now()
  const [[at], levelTwo] = await Promise.all([
    rootTimestamps(graphene, [root], options),
    readLevelTwoGraph(graphene, root, options),
  ])
  const { chunks } = levelTwo
  const cells = new Map()
  for (const chunk of chunks) {
    const c = chunkOf(layout, BigInt(chunk))
    if (c) cells.set(c.join(','), c)
  }
  const windows = new Map()
  for (const c of cells.values()) {
    const starts = c.map((v) => (v % 2 === 0 && v > 0 ? [v - 2, v] : [v - (v % 2)]))
    for (const x of starts[0]) for (const y of starts[1]) for (const z of starts[2]) {
      const key = `${x},${y},${z}`
      const w = windows.get(key) ?? { lo: [Infinity, Infinity, Infinity], hi: [-1, -1, -1] }
      for (let a = 0; a < 3; a++) {
        w.lo[a] = Math.min(w.lo[a], c[a])
        w.hi[a] = Math.max(w.hi[a], c[a])
      }
      windows.set(key, w)
    }
  }
  const boxes = [...windows.values()].map((w) => cellBox(layout, w.lo, w.hi))
  const graph = await readSubgraphBoxes(graphene, root, boxes, concurrency, options)
  const readS = (performance.now() - t) / 1000
  const svs = new Set([...graph.a, ...graph.b]).size
  console.log(`${chunks.length} level-2 chunks in ${cells.size} chunk cells, read in ${boxes.length} boxes`)

  t = performance.now()
  const joins = weakJoins(graph, { minPiece, max })
  const scanS = (performance.now() - t) / 1000

  t = performance.now()
  const placed = await placeCuts(graphene, joins.map((j) => j.cut), at, SITE_RADIUS_NM, options)
  const placeS = (performance.now() - t) / 1000

  console.log(
    `read in ${readS.toFixed(1)} s: ${graph.a.length} edges, ${svs} supervoxels. ` +
      `scan ${scanS.toFixed(2)} s, placing ${placeS.toFixed(1)} s`,
  )
  let firstHit
  joins.forEach((join, i) => {
    const where = placed[i]
    const main = where.find((s) => !s.unplaced)
    let grade = ''
    if (testCase) {
      const { kind, nearestNm } = gradeSites(testCase, where, nearNm)
      if (kind !== 'miss' && firstHit === undefined) firstHit = i + 1
      grade = ` — ${kind.toUpperCase()} (${(nearestNm / 1000).toFixed(1)} µm)`
    }
    console.log(
      `  #${i + 1} mean ${join.score.toFixed(2)}, ${join.sizes[0]} + ${join.sizes[1]} supervoxels, ` +
        `${join.cut.length} edges` +
        (main ? ` at ${main.at.map((v) => (v / 1000).toFixed(1)).join(', ')} µm` : '') +
        grade,
    )
  })
  if (testCase) console.log(firstHit ? `SCAN HIT at rank ${firstHit}` : `SCAN MISS in the top ${max}`)
}
