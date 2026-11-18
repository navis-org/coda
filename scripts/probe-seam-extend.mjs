#!/usr/bin/env node
/**
 * Phase 0 of `docs/seam-extend-plan.md`: can a neuron be grown piece by piece, and what does a
 * step cost?
 *
 *   pnpm dev --port 5178          # in another terminal
 *   pnpm probe:seam-extend        # needs a CAVE token, and caveclient for the truth file
 *
 * ## What it does
 *
 * It rewinds a proofread neuron to a moment before most of its merges, starts from several of
 * the pieces it was then in, and grows each the way the plan describes — with an **oracle** in
 * place of the reader. The oracle accepts a candidate only where that piece was later merged
 * into the neuron, and then extends it.
 *
 * Each step runs the real things:
 *
 * - **the chain above `Tips`** — Meshes, Clean Meshes twice and Find Open Ends, with the
 *   on-demand workflow's own settings — on a `Scheduler` of its own, over a graph with the piece
 *   typed into `Input IDs`. (The workflow's Sort and Sample are done in the page, after the soma
 *   mask; `chain` below says why.) That is the mechanism the plan's `ctx.rerunInput` proposes, so
 *   this also answers whether a private scheduler can run the chain at all;
 * - **the search** — `searchEnds`, with the app's own volume, bridge and forest — with the roots
 *   of the path from the start to the piece read as the start's root, so the search sees one
 *   neuron.
 *
 * ## The three answers the plan asked for
 *
 * 1. what the chain above `Tips` costs for one piece, by the piece's size;
 * 2. how many of a piece's tips fall within the own-tip radius of the contact it was accepted at,
 *    and how near the nearest one is;
 * 3. whether the search puts a real continuation first at a piece's ends — against the same
 *    figure at a start's ends, under the same truth.
 *
 * ## What it does not measure
 *
 * No assessor: the ranking is the forest's, so "first" is geometric rank 1. And the truth is a
 * lower bound (`scripts/lib/seam_extend_truth.py`), which is why the starts' own hit rate is
 * printed beside the pieces'. A piece reached from two starts is printed twice;
 * `docs/seam-extend-plan.md` counts each once.
 *
 * Reads only. Nothing here writes to CAVE.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  AEDES_DEPLOYMENT,
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  probeReport,
  requireCaveToken,
} from './lib/browserProbe.mjs'
import { extendChain, extendWorkDir, truthFileFor } from './lib/seamExtendChain.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
/** The fixture neuron with a real history: 166 merges, 153 of them after the default `--t0`. */
const neuron = args.value('--neuron') ?? '648518347622603652'
const t0 = args.value('--t0') ?? '2026-01-01T00:00:00+00:00'
/** The fixture's snapshot, less a second: the neuron's root id above is its root then. */
const t1 = args.value('--t1') ?? '2026-11-04T16:44:59+00:00'
/** How many accepted pieces to extend from each start. */
const maxPieces = Number(args.value('--pieces') ?? 4)
/** How far down a tip's list the oracle looks for a piece that belongs. */
const look = Number(args.value('--look') ?? 3)
/** The ends searched per piece, best `e_tip` first — the workflow's Sort and Sample. */
const ends = Number(args.value('--ends') ?? 12)

const WORK = extendWorkDir()

// ── The truth: the pieces the neuron was in at t0 ───────────────────────────────────────────────
const truthFile = truthFileFor(neuron, t0, t1)
if (!existsSync(truthFile)) {
  const venv = join(homedir(), 'Github/SEAM/.venv/bin/python')
  const python = process.env.CODA_PYTHON ?? (existsSync(venv) ? venv : 'python3')
  execFileSync(python, ['-I', 'scripts/lib/seam_extend_truth.py', neuron, t0, t1, truthFile], {
    stdio: 'inherit',
  })
}
const truth = JSON.parse(readFileSync(truthFile, 'utf8'))
const sized = Object.entries(truth.pieces).filter(([, count]) => count !== null)
sized.sort((a, b) => b[1] - a[1])
if (sized.length === 0) {
  console.error('the truth file names no piece with a size')
  process.exit(2)
}
/*
 * **Where to start from: several mid-sized pieces, not the largest.**
 *
 * The first version took the largest piece as the one seed, and its twelve best ends listed
 * nothing that belongs. That was the choice of seed, not the search: the largest rewound piece
 * (2,704 level-2 chunks, 2,537 tips, no nucleus within 10 µm) has a few true neighbours among
 * thousands of ends, and its 150 s chain was most of every run. The merges this neuron's history
 * holds are mostly small fragments joined in chains, which is the step the plan is about — so the
 * oracle starts on pieces of that kind and grows from each.
 *
 * `--starts a,b,c` names them; otherwise the largest `--trees` pieces no bigger than
 * `--max-chunks`. A piece above that size is still accepted when the search finds it, and
 * counted, but it is not extended.
 */
const maxChunks = Number(args.value('--max-chunks') ?? 700)
const trees = Number(args.value('--trees') ?? 4)
const starts = args.value('--starts')
  ? args.value('--starts').split(',')
  : sized.filter(([, count]) => count <= maxChunks).slice(0, trees).map(([id]) => id)
console.log(
  `${neuron} at ${t0}: ${Object.keys(truth.pieces).length} pieces, the median ` +
    `${sized[Math.floor(sized.length / 2)][1]} level-2 chunks. Starting from ` +
    starts.map((id) => `${id} (${truth.pieces[id]})`).join(', ') + '.',
)

const chain = extendChain(starts[0])

/** Its own, and deleted on the way out: `handCaveToken` persists into this profile. */
const PROFILE = '/tmp/coda-seam-extend-profile'
const token = requireCaveToken()

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9361, profile: PROFILE })
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
  const [
    builtins, registry, graphMod, schedMod, models, rankerConfig, searchVolume, searchRun,
    searchTips, cutout, rootIds,
  ] = await Promise.all([
    load('/src/data/builtins.ts'),
    load('/src/data/source.ts'),
    load('/src/core/graph.ts'),
    load('/src/core/scheduler.ts'),
    load('/src/packs/seam/models.ts'),
    load('/src/packs/seam/rankerConfig.ts'),
    load('/src/packs/seam/searchVolume.ts'),
    load('/src/packs/seam/searchRun.ts'),
    load('/src/packs/seam/searchTips.ts'),
    load('/src/pyodide/cutoutSummary.ts'),
    load('/src/data/cave/rootIds.ts'),
  ])
  await load('/src/nodes/index.ts')
  builtins.registerBuiltinSources()

  const STARTS = ${JSON.stringify(starts)}
  const MAX_CHUNKS = ${maxChunks}
  // The start the tree being grown began from: the id its whole path is read as.
  let START
  const SIZES = ${JSON.stringify(truth.pieces)}
  const TRUTH = new Set(Object.keys(SIZES))
  const LOOK = ${look}
  const ENDS = ${ends}
  const SOMA = ${JSON.stringify(truth.somaNm ?? null)}
  // The radius Find Open Ends itself was given, so the mask here is the one it would have made.
  const SOMA_UM = ${chain.nodes.find((node) => node.id === 'ends').params.somaMask}
  const MAX_PIECES = ${maxPieces}
  const T0_MS = ${Date.parse(t0)}
  const options = { deployment: ${JSON.stringify(AEDES_DEPLOYMENT)} }

  const loaded = graphMod.deserializeGraph(${JSON.stringify(JSON.stringify(chain))})
  const CHAIN = loaded.graph.nodes.map((node) => node.id)

  // ── The chain above Tips, for one piece, on a scheduler of its own ──────────────────────────
  const scheduler = new schedMod.Scheduler({ resolveSource: (id) => registry.getSource(id) })
  async function chainFor(root) {
    const graph = {
      ...loaded.graph,
      nodes: loaded.graph.nodes.map((node) =>
        node.id === 'ids' ? { ...node, params: { ...node.params, ids: root } } : node,
      ),
    }
    const started = performance.now()
    const summary = await scheduler.run(graph, { mode: 'full', targets: ['ends'] })
    const seconds = (performance.now() - started) / 1000
    const info = Object.fromEntries(CHAIN.map((id) => [id, scheduler.info(id)]))
    const mesh = scheduler.output('meshes', 'meshes')?.items?.[0]
    const cleaned = scheduler.output('clean2', 'out')?.items?.[0]
    return {
      seconds,
      // Which nodes ran: a node answered from the scheduler's cache did no work for this piece.
      executed: summary.executed,
      nodeSeconds: Object.fromEntries(
        CHAIN.filter((id) => summary.executed.includes(id)).map((id) => [
          id,
          (info[id].durationMs ?? 0) / 1000,
        ]),
      ),
      errors: CHAIN.flatMap((id) =>
        info[id].state === 'ok' ? [] : [id + ' is ' + info[id].state + ': ' + (info[id].error ?? '')],
      ),
      warnings: CHAIN.flatMap((id) => (scheduler.warning(id) ? [id + ': ' + scheduler.warning(id)] : [])),
      faces: mesh ? mesh.indices.length / 3 : 0,
      cleanedFaces: cleaned ? cleaned.indices.length / 3 : 0,
      tips: scheduler.output('ends', 'tips'),
    }
  }

  // ── The search, with the path's roots read as the start's ───────────────────────────────────
  const opened = await rankerConfig.openTreeRanker(models.MERGE_RANKER_MODELS[0])
  const plan = opened.config
  const halfWidthNm = plan.halfWidthUm * 1000
  const volume = await searchVolume.openSearchVolume(
    'wclee_aedes_brain', plan.xyNm, T0_MS, options, { chunkBytes: 512 * 1024 * 1024 },
  )
  /*
   * The plan's "one object in the box", done where the plan says to do it: the map every box's
   * roots are read from. Stored as the chunkedgraph answered and renamed on the way out, so the
   * path can change between pieces without a lookup being asked again.
   */
  const alias = new Map()
  const held = new Map()
  volume.roots = {
    has: (key) => held.has(key),
    get: (key) => { const root = held.get(key); return alias.get(root) ?? root },
    set: (key, root) => { held.set(key, root) },
    clear: () => held.clear(),
  }
  let pathChunks = 0
  const steps = {
    measure: (request) => cutout.runCandidatePool(request, {}),
    sizes: (request) => cutout.runPoolSizes(request, {}),
    // The neuron's size is the path's, summed: it is what the neuron will be once merged.
    counts: async (roots) => {
      const counts = new Map(await rootIds.l2ChunkCounts(volume.graphene, roots, options))
      if (roots.includes(START)) counts.set(START, pathChunks)
      return counts
    },
  }
  const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  const pieces = []
  let waiting = 0

  for (START of STARTS) {
  held.clear()
  const inTree = new Set([START])
  const queue = [{ id: START, parent: null, depth: 0, path: [START], contactNm: null, pathTips: [] }]
  let grown = 0

  while (queue.length > 0 && grown < MAX_PIECES + 1) {
    const piece = queue.shift()
    const record = {
      start: START, id: piece.id, parent: piece.parent, depth: piece.depth,
      chunks: SIZES[piece.id] ?? null,
    }
    // Accepted and counted, but a piece this big is another neuron's worth of ends.
    if ((SIZES[piece.id] ?? 0) > MAX_CHUNKS) {
      pieces.push({ ...record, skipped: 'bigger than --max-chunks' })
      continue
    }
    grown += 1
    pieces.push(record)
    let ran
    try {
      ran = await chainFor(piece.id)
    } catch (error) {
      record.error = 'chain: ' + String(error?.message ?? error)
      continue
    }
    Object.assign(record, {
      chainSeconds: ran.seconds, nodeSeconds: ran.nodeSeconds, executed: ran.executed,
      faces: ran.faces, cleanedFaces: ran.cleanedFaces, allTips: ran.tips?.length ?? 0,
      warnings: ran.warnings,
    })
    if (ran.errors.length > 0 || !ran.tips) {
      record.error = ran.errors.join(' | ') || 'no tips table'
      continue
    }

    let rows
    try {
      rows = searchTips.tipsFromTable(ran.tips, false).rows
    } catch (error) {
      record.error = 'tips: ' + String(error?.message ?? error)
      continue
    }
    // The soma mask Find Open Ends could not apply, then the workflow's Sort and Sample.
    const masked = SOMA ? rows.filter((row) => apart(row.nm, SOMA) > SOMA_UM * 1000) : rows
    record.nearSoma = rows.length - masked.length
    masked.sort((a, b) => (b.eTip ?? -Infinity) - (a.eTip ?? -Infinity))
    // The search asks about the neuron so far, which goes by the start's id.
    rows = masked.slice(0, ENDS).map((row) => ({ ...row, neuronId: START }))
    record.tips = rows.length

    alias.clear()
    for (const id of piece.path) if (id !== START) alias.set(BigInt(id), BigInt(START))
    pathChunks = piece.path.reduce((sum, id) => sum + (SIZES[id] ?? 0), 0)

    /*
     * The end where the piece joins: the one tip nearest the contact it was accepted at, where
     * that is within the own-tip radius. The first version dropped every tip within the radius,
     * and a piece of one level-2 chunk is shorter than the radius — both of its ends went, and
     * there was nothing left to search. How many tips the wider rule would have taken is kept,
     * as nearContact.
     */
    const reach = plan.ownUm * 1000
    const near = piece.contactNm ? rows.filter((row) => apart(row.nm, piece.contactNm) <= reach) : []
    near.sort((a, b) => apart(a.nm, piece.contactNm) - apart(b.nm, piece.contactNm))
    const junction = near[0]
    record.junctionTips = junction ? 1 : 0
    record.nearContact = near.length
    record.nearestTipToContactUm = piece.contactNm && rows.length > 0
      ? Math.min(...rows.map((row) => apart(row.nm, piece.contactNm))) / 1000
      : null

    // Every tip of the piece and of its path competes under the own-tip rule; only the piece's
    // own, less the junction, are searched.
    const competing = [...rows, ...piece.pathTips]
    const toSearch = []
    for (const [at, row] of rows.entries()) {
      if (row === junction || !searchVolume.boxFits(volume, row, halfWidthNm)) continue
      toSearch.push(searchVolume.endToSearch(volume, row, at, halfWidthNm, options))
    }
    record.ends = []
    const started = performance.now()
    try {
      for await (const end of searchRun.searchEnds(
        searchTips.tipPositions(competing),
        toSearch,
        { ranker: opened.ranker, topK: plan.topK, ownUm: plan.ownUm },
        steps,
        {},
      )) {
        const ranked = [...end.candRoot].map(String)
        const belongs = ranked.flatMap((id, at) => (TRUTH.has(id) && !inTree.has(id) ? [at + 1] : []))
        const already = ranked.flatMap((id, at) => (inTree.has(id) ? [at + 1] : []))
        record.ends.push({
          listed: ranked.length, pooled: end.pooled, belongs, already,
          refusal: end.refusal ?? null,
        })
        const first = belongs[0]
        if (first === undefined || first > LOOK) continue
        // The oracle accepts it, and it joins the queue to be extended in its turn.
        const id = ranked[first - 1]
        const column = (name) => end.columns[name]?.[first - 1]
        inTree.add(id)
        queue.push({
          id,
          parent: piece.id,
          depth: piece.depth + 1,
          path: [...piece.path, id],
          contactNm: [column('contact_x_nm'), column('contact_y_nm'), column('contact_z_nm')],
          pathTips: competing,
        })
      }
    } catch (error) {
      record.error = 'search: ' + String(error?.message ?? error)
    }
    record.searchSeconds = (performance.now() - started) / 1000
  }
  waiting += queue.length
  }

  return {
    pieces, waiting, ownUm: plan.ownUm, topK: plan.topK,
    chunkCache: { asked: volume.chunks.asked, hits: volume.chunks.hits },
  }
})()`

const got = await evaluate(script, 3 * 3_600_000)
await close()

writeFileSync(join(WORK, 'last-run.json'), JSON.stringify(got, null, 2))
if (!got) {
  console.error('the page returned nothing')
  process.exit(2)
}

// ── What came back ──────────────────────────────────────────────────────────────────────────────
const fixed = (value, digits = 1) => (typeof value === 'number' ? value.toFixed(digits) : '–')

/** Of these ends: how many list a piece that belongs first, within `look`, or at all. */
function hits(list) {
  const searched = list.filter((end) => !end.refusal)
  const at = (limit) =>
    searched.filter((end) => end.belongs[0] !== undefined && end.belongs[0] <= limit).length
  return { ends: searched.length, first: at(1), within: at(look), any: at(Infinity) }
}
const rate = (n, of) => `${n} of ${of}` + (of > 0 ? ` (${Math.round((100 * n) / of)}%)` : '')

console.log('\nPiece by piece, in the order the oracle reached them (depth 0 is a start):\n')
console.log(
  ['piece', 'depth', 'L2', 'faces', 'chain s', 'tips', 'kept', 'junction', 'ends', 'first', `≤${look}`, 'search s']
    .map((head) => head.padStart(9))
    .join(''),
)
for (const piece of got.pieces) {
  const found = hits(piece.ends ?? [])
  console.log(
    [
      piece.id.slice(-8),
      piece.depth,
      piece.chunks ?? '?',
      piece.faces ?? '–',
      fixed(piece.chainSeconds),
      piece.allTips ?? '–',
      piece.tips ?? '–',
      piece.junctionTips ?? '–',
      found.ends,
      found.first,
      found.within,
      fixed(piece.searchSeconds),
    ]
      .map((cell) => String(cell).padStart(9))
      .join(''),
  )
  if (piece.skipped) console.log(`${' '.repeat(9)}↳ not extended: ${piece.skipped}`)
  if (piece.error) console.log(`${' '.repeat(9)}↳ ${piece.error}`)
  for (const warning of piece.warnings ?? []) console.log(`${' '.repeat(9)}↳ ${warning}`)
}

const worked = got.pieces.filter((piece) => !piece.skipped)
const first = worked.filter((piece) => piece.depth === 0)
const rest = worked.filter((piece) => piece.depth > 0)
const startHits = hits(first.flatMap((piece) => piece.ends ?? []))
const pieceHits = hits(rest.flatMap((piece) => piece.ends ?? []))
const ran = rest.filter((piece) => !piece.error)

console.log(`\nEnds of a start: first ${rate(startHits.first, startHits.ends)}, ` +
  `within ${look} ${rate(startHits.within, startHits.ends)}, anywhere ${rate(startHits.any, startHits.ends)}`)
console.log(`Ends of an accepted piece: first ${rate(pieceHits.first, pieceHits.ends)}, ` +
  `within ${look} ${rate(pieceHits.within, pieceHits.ends)}, anywhere ${rate(pieceHits.any, pieceHits.ends)}`)
// A piece can be the end of the line, so "found nothing" is a real answer for some of them.
const continued = ran.filter((piece) => hits(piece.ends ?? []).within > 0).length
console.log(`Accepted pieces with a further piece within ${look}: ${rate(continued, ran.length)}`)

const chainTimes = ran.map((piece) => piece.chainSeconds).sort((a, b) => a - b)
if (chainTimes.length > 0) {
  console.log(
    `\nThe chain above Tips, per piece: median ${fixed(chainTimes[Math.floor(chainTimes.length / 2)])} s, ` +
      `longest ${fixed(chainTimes.at(-1))} s; the starts took ` +
      first.map((piece) => `${fixed(piece.chainSeconds)} s`).join(', ') + '.',
  )
  const byNode = {}
  for (const piece of ran) {
    for (const [id, seconds] of Object.entries(piece.nodeSeconds ?? {})) {
      byNode[id] = (byNode[id] ?? 0) + seconds
    }
  }
  console.log(
    '  by node, summed over pieces: ' +
      Object.entries(byNode).map(([id, seconds]) => `${id} ${fixed(seconds)} s`).join(', '),
  )
}
console.log(
  `\nTips within ${got.ownUm} µm of the contact a piece was accepted at: ` +
    ran.map((piece) => piece.nearContact).join(', ') +
    `\n  of ${ran.length} pieces, ` +
    `${ran.filter((piece) => piece.nearContact >= piece.tips).length} have every tip that near` +
    `\n  nearest tip to the contact, µm: ` +
    ran.map((piece) => fixed(piece.nearestTipToContactUm, 2)).join(', '),
)
console.log(
  `\n${rest.length} accepted pieces extended from ${first.length} starts, ` +
    `${got.waiting} more accepted and waiting. ` +
    `Full record: ${join(WORK, 'last-run.json')}`,
)

report.check(
  first.some((piece) => !piece.error),
  'the chain ran for a start on a scheduler of its own',
)
report.check(ran.length > 0, `the chain ran for ${ran.length} of ${rest.length} accepted pieces`)
report.check(startHits.ends > 0, `${startHits.ends} ends of the starts were searched`)
report.check(pieceHits.ends > 0, `${pieceHits.ends} ends of accepted pieces were searched`)
report.check(
  pieceHits.any > 0,
  `a piece's ends list something that belongs (${rate(pieceHits.any, pieceHits.ends)})`,
)
report.finish('is `pnpm dev --port 5178` running?')
