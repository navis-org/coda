#!/usr/bin/env node
/**
 * Where the chain above `Tips` spends its time for an extended piece, node by node — and what
 * the nucleus lookup inside Find Open Ends costs on its own (user, 2026-11-20: most pieces are
 * small, one or two tips, so the chain's fixed cost is most of what extending them costs).
 *
 *   pnpm dev --port 5178                   # in another terminal
 *   pnpm probe:seam-piece-chain            # needs a CAVE token
 *   pnpm probe:seam-piece-chain -- --pieces 648518346846408976,648518346889630846
 *
 * Each piece runs the chain on a `Scheduler` of its own, then Find Open Ends alone again on it with
 * `Nucleus table` the other way — named first on every other piece. Find Open Ends awaits the
 * lookup before it builds a single window (`nucleiFor`), so the difference in that node's own
 * time is the lookup's. The chain's own time is the first, cold run's, and its share of it is
 * read on the pieces whose first run had the table.
 *
 * The chain is the Aedes on-demand workflow's own (`seamExtendChain.mjs`, with its Clean Meshes
 * settings), and the pieces default to the ones extended on `648518347603854112` there.
 *
 * Reads only. Nothing here writes to CAVE.
 */

import {
  AEDES_DEPLOYMENT,
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  requireCaveToken,
} from './lib/browserProbe.mjs'
import { extendChain } from './lib/seamExtendChain.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
const PIECES = (
  args.value('--pieces') ??
  '648518346492208853,648518346846408976,648518346889630846,648518347011030299,' +
    '648518347048894954,648518347389295244,648518347392076404,648518347425962057,' +
    '648518347440787928,648518347440952536,648518347441157946,648518347454061352,' +
    '648518347478138921,648518347481026712,648518347482767644,648518347484355542,' +
    '648518347494952058,648518347496526219,648518347505055363,648518347510097989,' +
    '648518347515842600,648518347534457443,648518347566714452,648518347567238821,' +
    '648518347569428052,648518347571047863,648518347572808427,648518347577660500,' +
    '648518347578665426,648518347582724818,648518347584559244,648518347587199208,' +
    '648518347587290856,648518347604830532,648518347606796864,648518347614949320,' +
    '648518347616319036,648518347621876798,648518347645159634'
)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)

const chain = extendChain(PIECES[0])
// The on-demand workflow smooths nothing in its first Clean Meshes.
chain.nodes.find((node) => node.id === 'clean1').params.smooth = 0
const TABLE = chain.nodes.find((node) => node.id === 'ends').params.nucleusTable

const PROFILE = '/tmp/coda-seam-piece-chain-profile'
const token = requireCaveToken()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9362, profile: PROFILE })
deleteProfileOnExit(PROFILE, close)
await send('Page.navigate', { url })
await waitFor('Boolean(document.querySelector("#root"))', 'the app')
if (!(await handCaveToken(send, token))) {
  console.error('the page did not take the CAVE token')
  process.exit(2)
}
await send('Page.reload')
await waitFor('Boolean(document.querySelector("#root"))', 'the app')

const script = `(async () => {
  const load = ${APP_MODULE}
  const [builtins, registry, graphMod, schedMod, rootIds, values] = await Promise.all([
    load('/src/data/builtins.ts'),
    load('/src/data/source.ts'),
    load('/src/core/graph.ts'),
    load('/src/core/scheduler.ts'),
    load('/src/data/cave/rootIds.ts'),
    load('/src/core/values.ts'),
  ])
  await load('/src/nodes/index.ts')
  builtins.registerBuiltinSources()
  const options = { deployment: ${JSON.stringify(AEDES_DEPLOYMENT)} }
  const PIECES = ${JSON.stringify(PIECES)}
  const loaded = graphMod.deserializeGraph(${JSON.stringify(JSON.stringify(chain))})
  const CHAIN = loaded.graph.nodes.map((node) => node.id)

  const graphene = await rootIds.grapheneFor('wclee_aedes_brain', options)
  const sizes = await rootIds.l2ChunkCounts(graphene, PIECES, options)

  async function chainFor(scheduler, root, table) {
    const graph = {
      ...loaded.graph,
      nodes: loaded.graph.nodes.map((node) =>
        node.id === 'ids'
          ? { ...node, params: { ...node.params, ids: root } }
          : node.id === 'ends'
            ? { ...node, params: { ...node.params, nucleusTable: table } }
            : node,
      ),
    }
    const started = performance.now()
    const summary = await scheduler.run(graph, { mode: 'full', targets: ['ends'] })
    const seconds = (performance.now() - started) / 1000
    const errors = CHAIN.flatMap((id) => {
      const info = scheduler.info(id)
      return info.state === 'ok' ? [] : [id + ': ' + info.state + ' ' + (info.error ?? '')]
    })
    const node = Object.fromEntries(
      CHAIN.filter((id) => summary.executed.includes(id)).map((id) => [
        id,
        (scheduler.info(id).durationMs ?? 0) / 1000,
      ]),
    )
    const tips = scheduler.output('ends', 'tips')
    // Faces as fetched and as Find Open Ends receives them, after the chain's clean-up.
    const faces = (port) =>
      (port?.items ?? []).reduce((sum, item) => sum + item.indices.length / 3, 0)
    // Surface area, µm², by Find Open Ends' own function — what decimation leaves nearly alone.
    const area = (port) =>
      (port?.items ?? []).reduce(
        (sum, item) => sum + values.meshSurfaceArea(item.positions, item.indices),
        0,
      ) / 1e6
    return {
      seconds,
      node,
      errors,
      tips: tips?.length ?? 0,
      faces: faces(scheduler.output('meshes', 'meshes')),
      cleaned: faces(scheduler.output('clean2', 'out')),
      area: area(scheduler.output('meshes', 'meshes')),
      cleanedArea: area(scheduler.output('clean2', 'out')),
    }
  }

  const rows = []
  for (const [i, id] of PIECES.entries()) {
    const withFirst = i % 2 === 0
    // One scheduler per piece, nothing shared with another piece's: the second run changes Find
    // Open Ends' param alone, so only it runs again, on the very same meshes.
    const scheduler = new schedMod.Scheduler({ resolveSource: (rid) => registry.getSource(rid) })
    const first = await chainFor(scheduler, id, withFirst ? ${JSON.stringify(TABLE)} : '')
    const second = await chainFor(scheduler, id, withFirst ? '' : ${JSON.stringify(TABLE)})
    const [withTable, without] = withFirst ? [first, second] : [second, first]
    rows.push({
      id,
      l2: sizes.get(id) ?? null,
      tips: withTable.tips,
      faces: first.faces,
      cleaned: first.cleaned,
      area: first.area,
      cleanedArea: first.cleanedArea,
      cold: first.node,
      endsWith: withTable.node.ends ?? null,
      endsWithout: without.node.ends ?? null,
      // The cold chain with the lookup in it, where the first run had the table.
      chainWith: withFirst ? first.seconds : null,
      errors: [...first.errors, ...second.errors],
    })
  }
  return rows
})()`

const rows = await evaluate(script, 30 * 60 * 1000)
close()

const f = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d))
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}
console.log('piece                L2   tips    faces  cleaned  µm² fetched  µm² cleaned  meshes  clean1  clean2  ends+nuc  ends-nuc  nucleus  chain')
for (const r of rows) {
  const delta = r.endsWith !== null && r.endsWithout !== null ? r.endsWith - r.endsWithout : null
  console.log(
    `${r.id}  ${String(r.l2 ?? '—').padStart(4)}  ${String(r.tips).padStart(4)}  ` +
      `${String(r.faces).padStart(7)}  ${String(r.cleaned).padStart(7)}  ` +
      `${f(r.area, 1).padStart(11)}  ${f(r.cleanedArea, 1).padStart(11)}  ` +
      `${f(r.cold.meshes).padStart(6)}  ${f(r.cold.clean1).padStart(6)}  ${f(r.cold.clean2).padStart(6)}  ` +
      `${f(r.endsWith).padStart(8)}  ${f(r.endsWithout).padStart(8)}  ${f(delta).padStart(7)}  ${f(r.chainWith).padStart(5)}` +
      (r.errors.length ? `   ${r.errors.join('; ')}` : ''),
  )
}
const groups = [
  ['1 chunk', (n) => n === 1],
  ['2 chunks', (n) => n === 2],
  ['3-8', (n) => n >= 3 && n <= 8],
  ['9+', (n) => n >= 9],
]
console.log('\nmedians by size (s):')
for (const [name, test] of groups) {
  const g = rows.filter((r) => r.l2 !== null && test(r.l2) && r.errors.length === 0)
  if (g.length === 0) continue
  const nucleus = median(g.map((r) => r.endsWith - r.endsWithout))
  const chainS = median(g.map((r) => r.chainWith))
  console.log(
    `  ${name.padEnd(9)} n=${String(g.length).padStart(2)}  chain ${f(chainS)}  ` +
      `meshes ${f(median(g.map((r) => r.cold.meshes)))}  clean1 ${f(median(g.map((r) => r.cold.clean1)))}  ` +
      `clean2 ${f(median(g.map((r) => r.cold.clean2)))}  ends ${f(median(g.map((r) => r.endsWithout)))}  ` +
      `nucleus ${f(nucleus)} (${f((100 * nucleus) / chainS, 0)}% of the chain)`,
  )
}
