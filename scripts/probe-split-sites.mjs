/**
 * Where to split a neuron so two points come apart — `splitSites` on a live chunkedgraph, beside
 * CAVE's own split preview, with a neuroglancer link to look at both. **Reads only**: `subgraph`,
 * `roots_binary`, the L2 cache, the supervoxel bucket, and `split_preview`, which computes a cut
 * and writes nothing (pychunkedgraph `handle_split_preview`; view permission).
 *
 *   pnpm probe:split-sites -- --datastack fanc_production_mar2021 --root 6485… \
 *     --source 246648,400640,180630 --sink 218337,417513,132930
 *
 * Points are nm unless `--voxels X,Y,Z` gives the voxel size they are written in (neuroglancer's
 * coordinates are in the viewer's voxels). Several points per side are `;`-separated.
 *
 *   --policy trust|distrust|both   proofreader merges (default both)
 *   --pad-chunks N                 chunks read around the level-2 path between the points (default 0)
 *   --min-piece N                  smallest region a candidate step may join, supervoxels (default 20)
 *   --path-scan N                  experimental: also cut every window of 2N+1 chunks along the path
 *   --radius NM                    cut edges this close are one site (default 2000)
 *   --no-cave                      skip CAVE's split preview (it is seconds of server time)
 *   --viewer URL                   neuroglancer to link (default spelunker)
 *   --json FILE                    also write the run as data (results, sites, the scene)
 *
 * **`--operation ID`** takes a proofreader's past split as the test instead of `--root`/`--source`/
 * `--sink` (`lib/splitOperation.mjs`): the root before it, a point `--distance` µm (default 15)
 * from their cut on each root it made, and a score — whether our cut shares an edge with theirs,
 * and how far each site is from it. No CAVE preview in this mode (it cannot ask about a past root).
 *
 *   pnpm probe:split-sites -- --datastack fanc_production_mar2021 --operation 347721
 *
 * Graded EXACT (a site shares a removed edge), NEAR (a site within `--near` µm, default 1.5 — site
 * positions are level-2 chunk points, so a site at the right contact can sit a micrometre off) or
 * MISS.
 *
 * Needs pychunkedgraph 2.x (FANC, MICrONS, H01) — FlyWire's 1.27 has no affinities. CAVE refuses
 * a preview on a public datastack ("No edits allowed on virtual tables"); the comparison is then
 * skipped with that sentence.
 */

import { cavePostRaw } from '../src/data/cave/client.ts'
import { datastackRecord } from '../src/data/cave/datastack.ts'
import { tableUrl } from '../src/data/cave/graphene.ts'
import { caveScene } from '../src/data/cave/scene.ts'
import { findSupervoxels } from '../src/data/cave/volumes.ts'
import { sceneUrl } from '../src/data/neuroglancer/scene.ts'
import { cutAcross } from '../src/packs/seam/splitSites.ts'
import { cutSplitGraph, placeCuts, readSplitGraph } from '../src/packs/seam/splitSitesRun.ts'
import { probeArgs, requireCaveToken } from './lib/browserProbe.mjs'
import { gradeSites, splitCase } from './lib/splitOperation.mjs'

const args = probeArgs()
const datastack = args.value('--datastack')
const operation = args.value('--operation')
let root = args.value('--root')
const scale = (args.value('--voxels') ?? '1,1,1').split(',').map(Number)
const parsePoints = (text) =>
  (text ?? '')
    .split(';')
    .filter((p) => p.trim())
    .map((p) => p.split(',').map((v, axis) => Number(v) * scale[axis]))
let sources = parsePoints(args.value('--source'))
let sinks = parsePoints(args.value('--sink'))
const byHand = /^\d+$/.test(root ?? '') && sources.length > 0 && sinks.length > 0
if (!datastack || (!byHand && !/^\d+$/.test(operation ?? ''))) {
  console.error(
    'usage: --datastack NAME (--root ID --source X,Y,Z[;…] --sink X,Y,Z[;…] | --operation ID)',
  )
  process.exit(2)
}
const policyArg = args.value('--policy') ?? 'both'
const policies = policyArg === 'both' ? ['trust', 'distrust'] : [policyArg]
const padChunks = Number(args.value('--pad-chunks') ?? 0)
const minPiece = Number(args.value('--min-piece') ?? 20)
const pathScanArg = args.value('--path-scan')
const pathScan = pathScanArg === undefined ? undefined : Number(pathScanArg)
const radius = Number(args.value('--radius') ?? 2000)
const nearNm = Number(args.value('--near') ?? 1.5) * 1000
const options = {
  deployment: args.value('--deployment') ?? 'https://global.daf-apis.com',
  token: requireCaveToken(),
}

// A past split as the test: its root before, points far from its cut, and the cut to score against.
let testCase
if (operation) {
  const supervoxels = await findSupervoxels(datastack, options)
  const resolution = supervoxels.layout?.baseResolutionNm
  if (!resolution) throw new Error(`${datastack} publishes no base resolution.`)
  const distanceNm = Number(args.value('--distance') ?? 15) * 1000
  testCase = await splitCase(supervoxels.graphene, resolution, operation, distanceNm, options)
  root = testCase.root
  sources = testCase.sources
  sinks = testCase.sinks
  console.log(
    `operation ${operation} (${new Date(testCase.at).toISOString()}): root ${root} → ` +
      `${testCase.after.source} + ${testCase.after.sink}; removed ${testCase.removed.length} edges ` +
      `at ${testCase.cutAt.map((v) => (v / 1000).toFixed(1)).join(', ')} µm`,
  )
  console.log(
    `sides of the split: ${testCase.sizes.source} and ${testCase.sizes.sink} level-2 chunks` +
      (Math.min(testCase.sizes.source, testCase.sizes.sink) < 20 ? ' — a trim, not two objects' : ''),
  )
  console.log(
    `test points ${(testCase.distances.source / 1000).toFixed(1)} µm and ` +
      `${(testCase.distances.sink / 1000).toFixed(1)} µm from the cut`,
  )
}

const fmt = (v, d = 2) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d))
const um = (p) => p.map((v) => (v / 1000).toFixed(1)).join(', ')

const grade = (sites) => gradeSites(testCase, sites, nearNm)
const gradeLine = (g) =>
  g.kind === 'exact'
    ? `EXACT (shares ${g.shared} of ${g.truth} removed edges)`
    : `${g.kind.toUpperCase()} (${fmt(g.nearestNm / 1000, 1)} µm)`
const siteLine = (site, i) =>
  `  site ${i + 1}: at ${site.unplaced ? 'unplaced' : um(site.at) + ' µm'} — ${site.edges.length} edges, ` +
  `mean affinity ${fmt(site.meanAffinity)}, area ${site.area}` +
  (site.userMerges ? `, ${site.userMerges} proofreader merges` : '')

// One read, cut once per policy: the policy is the pure step's, so the server is asked once.
const read = await readSplitGraph({ datastack, root, sources, sinks, padChunks }, options)
console.log(
  `\npath ${read.chunks.path} chunks, read ${read.chunks.read} in ${read.chunks.boxes} boxes: ` +
    `${read.graph.a.length} edges, ${read.supervoxelCount} supervoxels; seeds ` +
    `${read.seeds.sources.length} source, ${read.seeds.sinks.length} sink supervoxels. ` +
    `path ${(read.ms.path / 1000).toFixed(1)} s, subgraph ${(read.ms.subgraph / 1000).toFixed(1)} s`,
)
const runs = []
for (const policy of policies) {
  const report = await cutSplitGraph(
    read,
    {
      userMerges: policy,
      minPiece,
      siteRadiusNm: radius,
      ...(pathScan !== undefined ? { pathScan } : {}),
    },
    options,
  )
  runs.push({ policy, report })
  const { result, sites, ms } = report
  console.log(`\n== proofreader merges: ${policy} ==`)
  console.log(`cut ${ms.cut.toFixed(0)} ms, placing ${(ms.place / 1000).toFixed(1)} s`)
  if (!result.ok) {
    console.log(`refused (${result.reason}): ${result.message}`)
    continue
  }
  if (result.affinityIsArea) console.log('! affinity here is contact area: mean affinity is 1 everywhere')
  console.log(
    `constrained cut: ${result.counts.source} source, ${result.counts.sink} sink, ` +
      `${result.counts.neither} neither; ${result.cut.length} edges ` +
      `(${result.cut.filter((e) => e.userMerge).length} proofreader merges)` +
      (testCase ? ` — ${gradeLine(grade(sites))}` : ''),
  )
  sites.slice(0, 3).forEach((site, i) => console.log(siteLine(site, i)))
  console.log(`candidates (plain agglomeration, steps joining ≥ ${minPiece} supervoxels each side, weakest first):`)
  report.candidates.forEach(({ candidate, sites: where }, i) => {
    const main = where[0]
    console.log(
      `  #${i + 1} ${candidate.point} side, mean ${fmt(candidate.score)}, ` +
        `${candidate.sizes[0]} + ${candidate.sizes[1]} supervoxels, ${candidate.cut.length} edges` +
        (main && !main.unplaced ? ` at ${um(main.at)} µm` : '') +
        (where.length > 1 ? ` (+${where.length - 1} more sites)` : '') +
        (testCase ? ` — ${gradeLine(grade(where))}` : ''),
    )
  })
  if (testCase) {
    const hit = report.candidates.findIndex(({ sites: where }) => {
      return grade(where).kind !== 'miss'
    })
    console.log(hit >= 0 ? `CANDIDATE HIT at rank ${hit + 1}` : 'CANDIDATE MISS')
  }
  if (report.pathCuts.length) {
    // Experimental: the window cuts along the path, weakest first (`pathCuts`).
    console.log(`path cuts (windows of ${2 * pathScan + 1} chunks), weakest first:`)
    const byMean = [...report.pathCuts].sort(
      (x, y) => (x.pathCut.meanAffinity ?? 9) - (y.pathCut.meanAffinity ?? 9),
    )
    byMean.forEach(({ pathCut, sites: where }, i) => {
      const main = where[0]
      const { source, sink } = pathCut.contact
      console.log(
        `  #${i + 1} mean ${fmt(pathCut.meanAffinity)}, ${pathCut.cut.length} edges, area ` +
          `${pathCut.area}, contact ratio ${fmt(source)} / ${fmt(sink)}` +
          (main && !main.unplaced ? ` at ${um(main.at)} µm` : '') +
          (testCase ? ` — ${gradeLine(grade(where))}` : ''),
      )
    })
  }
}

// CAVE's own cut, for comparison: its two sides, classified over the graph read above. CAVE cuts
// inside its own padded box, so a cut it makes off the path is not in this graph and reads as
// fewer edges than it removed.
let cave
if (!args.all.includes('--no-cave') && !testCase) {
  const point = (p) => `[${root},${p.join(',')}]`
  const body = `{"sources":[${sources.map(point).join(',')}],"sinks":[${sinks.map(point).join(',')}]}`
  const t = performance.now()
  try {
    const reply = await cavePostRaw(tableUrl(read.graphene, 'graph/split_preview'), body, options)
    const [sourceSide, sinkSide] = reply.supervoxel_connected_components.map(
      (cc) => new Set(cc.map(String)),
    )
    const cut = cutAcross(read.graph, sourceSide, sinkSide)
    const [sites] = await placeCuts(read.graphene, [cut], read.at, radius, options)
    cave = { sites, cut }
    console.log(
      `\n== CAVE split preview (${((performance.now() - t) / 1000).toFixed(1)} s, illegal=${reply.illegal_split}) ==`,
    )
    console.log(
      `sides: ${sourceSide.size} source, ${sinkSide.size} sink; cut ${cut.length} edges ` +
        `(${cut.filter((e) => e.userMerge).length} proofreader merges)`,
    )
    sites.forEach((site, i) => console.log(siteLine(site, i)))
  } catch (error) {
    console.log(`\n== CAVE split preview: not available — ${error.message.split('\n')[0]} ==`)
  }
}

// A neuroglancer scene: the neuron, the points, and each run's sites and cut edges.
const record = await datastackRecord(datastack, options)
const scene = caveScene(datastack, record)
const res = [record.viewer_resolution_x, record.viewer_resolution_y, record.viewer_resolution_z]
const toViewer = (nm) => nm.map((v, axis) => v / (res[axis] || 1))
let id = 0
const pointLayer = (name, color, points) => ({
  type: 'annotation',
  name,
  source: 'local://annotations',
  annotationColor: color,
  annotations: points.map(({ at, description }) => ({
    type: 'point',
    id: String(++id),
    point: toViewer(at),
    ...(description ? { description } : {}),
  })),
})
const siteLayer = (name, color, sites) =>
  pointLayer(
    name,
    color,
    sites
      .filter((s) => !s.unplaced)
      .map((s, i) => ({
        at: s.at,
        description:
          `#${i + 1}: ${s.edges.length} edges, mean ${fmt(s.meanAffinity)}, area ${s.area}` +
          (s.userMerges ? `, ${s.userMerges} proofreader merges` : ''),
      })),
  )
const layers = [...scene.layers]
const seg = layers.find((l) => l.type === 'segmentation')
seg.segments = testCase ? [testCase.after.source, testCase.after.sink] : [root]
layers.push(
  pointLayer('sources', '#ff4040', sources.map((at) => ({ at }))),
  pointLayer('sinks', '#4080ff', sinks.map((at) => ({ at }))),
)
if (testCase) {
  layers.push(
    pointLayer('proofreader sources', '#ff9090', testCase.proofreaderPoints.sources.map((at) => ({ at }))),
    pointLayer('proofreader sinks', '#90b0ff', testCase.proofreaderPoints.sinks.map((at) => ({ at }))),
    pointLayer('proofreader cut', '#00e0a0', [{ at: testCase.cutAt, description: `operation ${operation}` }]),
  )
}
for (const { policy, report } of runs) {
  if (!report.result.ok) continue
  layers.push(siteLayer(`cut (${policy})`, policy === 'trust' ? '#ffd000' : '#ff8c00', report.sites))
  layers.push(
    pointLayer(
      `candidates (${policy})`,
      policy === 'trust' ? '#00ffff' : '#00a0ff',
      report.candidates.flatMap(({ candidate, sites: where }, rank) =>
        where
          .filter((site) => !site.unplaced)
          .map((site) => ({
            at: site.at,
            description:
              `#${rank + 1} ${candidate.point}: mean ${fmt(candidate.score)}, ` +
              `${candidate.sizes.join(' + ')} supervoxels; this site ${site.edges.length} edges`,
          })),
      ),
    ),
  )
}
if (cave) layers.push(siteLayer('sites (CAVE min-cut)', '#e040ff', cave.sites))
const first =
  runs.find((r) => r.report.candidates.length)?.report.candidates[0].sites[0] ??
  runs.find((r) => r.report.sites.length)?.report.sites[0]
const url = sceneUrl(args.value('--viewer') ?? 'https://spelunker.cave-explorer.org', {
  ...scene,
  layers,
  ...(first && !first.unplaced ? { position: toViewer(first.at) } : {}),
  layout: 'xy-3d',
})
console.log(`\nneuroglancer (${url.length} chars):\n${url}`)

// `--json FILE`: the run as data, for a page to draw (the inspection page reads one per case).
const jsonPath = args.value('--json')
if (jsonPath) {
  const { writeFileSync } = await import('node:fs')
  const siteData = (site) => ({
    at: site.unplaced ? null : site.at.map((v) => Math.round(v)),
    edges: site.edges.length,
    meanAffinity: site.meanAffinity ?? null,
    area: site.area,
    userMerges: site.userMerges,
  })
  const gradeData = (sites) => {
    if (!testCase) return null
    const g = grade(sites)
    return {
      kind: g.kind,
      shared: g.shared,
      nearestNm: Number.isFinite(g.nearestNm) ? Math.round(g.nearestNm) : null,
    }
  }
  const [viewerBase, fragment] = url.split('#!')
  const out = {
    datastack,
    operation: operation ?? null,
    root,
    sources: sources.map((p) => p.map((v) => Math.round(v))),
    sinks: sinks.map((p) => p.map((v) => Math.round(v))),
    split: testCase
      ? {
          at: testCase.at,
          after: testCase.after,
          cutAt: testCase.cutAt.map((v) => Math.round(v)),
          removed: testCase.removed.length,
          sizes: testCase.sizes,
          distances: {
            source: Math.round(testCase.distances.source),
            sink: Math.round(testCase.distances.sink),
          },
        }
      : null,
    nearNm,
    minPiece,
    runs: runs.map(({ policy, report }) => ({
      policy,
      ok: report.result.ok,
      refusal: report.result.ok ? null : report.result.message,
      seeds: { sources: read.seeds.sources.length, sinks: read.seeds.sinks.length },
      chunks: read.chunks,
      graph: { edges: read.graph.a.length, supervoxels: read.supervoxelCount },
      seconds: Object.fromEntries(
        Object.entries({ ...read.ms, ...report.ms }).map(([k, v]) => [k, Math.round(v / 100) / 10]),
      ),
      affinityIsArea: report.result.ok ? report.result.affinityIsArea : null,
      constrained: report.result.ok
        ? {
            counts: report.result.counts,
            edges: report.result.cut.length,
            userMerges: report.result.cut.filter((e) => e.userMerge).length,
            sites: report.sites.map(siteData),
            grade: gradeData(report.sites),
          }
        : null,
      candidates: report.candidates.map(({ candidate, sites: where }, i) => ({
        rank: i + 1,
        point: candidate.point,
        score: Number.isFinite(candidate.score) ? candidate.score : null,
        sizes: candidate.sizes,
        edges: candidate.cut.length,
        sites: where.map(siteData),
        grade: gradeData(where),
      })),
    })),
    viewer: { base: viewerBase, resolutionNm: res, state: JSON.parse(decodeURIComponent(fragment)) },
  }
  writeFileSync(jsonPath, JSON.stringify(out))
  console.log(`wrote ${jsonPath}`)
}
