#!/usr/bin/env node
/**
 * The test `docs/seam-extend-plan.md` asks for before "continuing through a small piece" is
 * built: where should the end of a small accepted piece be, and should the tip it was accepted
 * on go on competing?
 *
 *   pnpm dev --port 5178          # in another terminal
 *   pnpm probe:seam-flake         # needs a CAVE token; the truth file is `probe:seam-extend`'s
 *
 * ## The ground, and the oracle
 *
 * `probe-seam-extend.mjs`' own: a proofread neuron rewound to before most of its merges, when it
 * was 287 separate roots, median 2 level-2 chunks. A candidate is right when it is one of them.
 * The oracle starts from several mid-sized pieces, searches their ends, and takes every **small**
 * true piece an end lists as a *case*: a flake a reader would have accepted there, with the tip it
 * was accepted on and where the two touch. Cases found from a case are cases too.
 *
 * ## What is compared, for each case
 *
 * Everything reads the start and the pieces between as one object, as the app does.
 *
 * - **A — today.** The chain above `Tips` finds the flake's open ends; the one nearest the
 *   contact is the join and is not searched.
 * - **B — A, but the consumed tips stop competing.** The tip the flake was accepted on, and the
 *   join, are left out of the own-tip rule: both are inside the neuron now.
 * - **C — a made-up end.** No mesh: the flake's voxel farthest from the contact, read from the
 *   segmentation box around the contact, is the end. `C0` leaves the old tip competing, `C1`
 *   does not.
 *
 * Counted per case: whether anything was searched at all, and the best place a true piece **not
 * yet in the tree** takes on any of the case's lists — first, within three, anywhere.
 *
 * ## What it cannot say
 *
 * No assessor, so "first" is the forest's first. The truth is a lower bound: a flake at the end
 * of its chain has no true piece beyond it, and reads as a miss for every variant alike — which
 * is why the variants are compared on the same cases rather than read as rates.
 *
 * ## What it found (2026-11-16)
 *
 * 96 cases. Today's ends put a true piece first on 37 and somewhere on 69; B changed 9 cases, 7
 * of them for the worse; C was level with A on the pieces that fit in the box and far behind on
 * the rest. Neither was built — `docs/seam-extend-plan.md` has the table.
 *
 * Reads only. Nothing here writes to CAVE.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AEDES_DEPLOYMENT,
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  requireCaveToken,
} from './lib/browserProbe.mjs'
import { extendChain, extendWorkDir, truthFileFor } from './lib/seamExtendChain.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
const neuron = args.value('--neuron') ?? '648518347622603652'
const t0 = args.value('--t0') ?? '2026-01-01T00:00:00+00:00'
const t1 = args.value('--t1') ?? '2026-11-04T16:44:59+00:00'
/** A case is a true piece of at most this many level-2 chunks. */
const small = Number(args.value('--small') ?? 8)
/**
 * Cases per start, and which pieces to start from: every true piece bigger than a case and no
 * bigger than `--max-chunks`, largest first. The first version started from the eight largest
 * and found no case at all — their best ends meet other large pieces. The flakes hang off the
 * mid-sized ones, of which this neuron has thirty-odd.
 */
const perStart = Number(args.value('--cases') ?? 6)
const trees = Number(args.value('--trees') ?? 40)
const maxChunks = Number(args.value('--max-chunks') ?? 200)
/** The ends searched per start and per flake, best `e_tip` first. */
const ends = Number(args.value('--ends') ?? 16)

const WORK = extendWorkDir()
const truthFile = truthFileFor(neuron, t0, t1)
if (!existsSync(truthFile)) {
  console.error(`no truth file at ${truthFile}: run \`pnpm probe:seam-extend\` once to write it`)
  process.exit(2)
}
const truth = JSON.parse(readFileSync(truthFile, 'utf8'))
const sized = Object.entries(truth.pieces).filter(([, count]) => count !== null)
sized.sort((a, b) => b[1] - a[1])
const starts = args.value('--starts')
  ? args.value('--starts').split(',')
  : sized
      .filter(([, count]) => count > small && count <= maxChunks)
      .slice(0, trees)
      .map(([id]) => id)
const chain = extendChain(starts[0])
console.log(
  `${neuron} at ${t0}: ${sized.length} pieces. Starting from ` +
    starts.map((id) => `${id} (${truth.pieces[id]})`).join(', ') + '.',
)

const PROFILE = '/tmp/coda-seam-flake-profile'
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

/** Set up once in the page, and kept on `window` so each start is its own short call. */
const setup = `(async () => {
  const load = ${APP_MODULE}
  const [
    builtins, registry, graphMod, schedMod, models, rankerConfig, searchVolume, searchRun,
    searchTips, cutout, rootIds, rootedBox, volumeMod, pieces,
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
    load('/src/packs/seam/rootedBox.ts'),
    load('/src/data/precomputed/volume.ts'),
    load('/src/packs/seam/pieces.ts'),
  ])
  await load('/src/nodes/index.ts')
  builtins.registerBuiltinSources()

  const SIZES = ${JSON.stringify(truth.pieces)}
  const TRUTH = new Set(Object.keys(SIZES))
  const SMALL = ${small}
  const ENDS = ${ends}
  const PER_START = ${perStart}
  const SOMA = ${JSON.stringify(truth.somaNm ?? null)}
  const SOMA_UM = ${chain.nodes.find((node) => node.id === 'ends').params.somaMask}
  const options = { deployment: ${JSON.stringify(AEDES_DEPLOYMENT)} }
  const loaded = graphMod.deserializeGraph(${JSON.stringify(JSON.stringify(chain))})
  const scheduler = new schedMod.Scheduler({ resolveSource: (id) => registry.getSource(id) })

  /** The chain above Tips for one root: its tips, soma-masked, best e_tip first, the first ENDS. */
  async function tipsOf(root) {
    const graph = {
      ...loaded.graph,
      nodes: loaded.graph.nodes.map((node) =>
        node.id === 'ids' ? { ...node, params: { ...node.params, ids: root } } : node,
      ),
    }
    const started = performance.now()
    await scheduler.run(graph, { mode: 'full', targets: ['ends'] })
    const seconds = (performance.now() - started) / 1000
    const info = scheduler.info('ends')
    if (info.state !== 'ok') throw new Error('chain: ' + (info.error ?? info.state))
    const table = scheduler.output('ends', 'tips')
    let rows = table && table.length > 0 ? searchTips.tipsFromTable(table, false).rows : []
    const found = rows.length
    if (SOMA) rows = rows.filter((row) => apart(row.nm, SOMA) > SOMA_UM * 1000)
    rows = [...rows].sort((a, b) => (b.eTip ?? -Infinity) - (a.eTip ?? -Infinity)).slice(0, ENDS)
    return { rows, found, seconds }
  }

  const opened = await rankerConfig.openTreeRanker(models.MERGE_RANKER_MODELS[0])
  const plan = opened.config
  const halfWidthNm = plan.halfWidthUm * 1000
  const volume = await searchVolume.openSearchVolume(
    'wclee_aedes_brain', plan.xyNm, { boundary: ${Date.parse(t0)} }, options,
    { chunkBytes: 768 * 1024 * 1024 },
  )
  const steps = {
    measure: (request) => cutout.runCandidatePool(request, {}),
    sizes: (request) => cutout.runPoolSizes(request, {}),
    counts: (roots) => rootIds.l2ChunkCounts(volume.graphene, roots, options),
  }
  /** Every flake that has been a case, across starts: one reached from two trees counts once. */
  const cased = new Set()
  const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

  /**
   * Search some ends of one root. \`at\` are the positions searched, \`others\` the further tips
   * the own-tip rule measures against; \`alias\` reads the path as the start.
   */
  async function search(root, start, at, others, alias) {
    const searchable = at.filter((nm) => searchVolume.boxFits(volume, { nm }, halfWidthNm))
    if (searchable.length === 0) return []
    const tipsNm = searchTips.tipPositions([...searchable, ...others].map((nm) => ({ nm })))
    const toSearch = searchable.map((nm, i) =>
      searchVolume.endToSearch(
        volume,
        { neuronId: root, seed: start, endUid: i, nm, eTip: undefined, row: i },
        i, halfWidthNm, options, alias,
      ),
    )
    const out = []
    for await (const end of searchRun.searchEnds(
      tipsNm, toSearch, { ranker: opened.ranker, topK: plan.topK, ownUm: plan.ownUm }, steps, {},
    )) {
      const ids = [...end.candRoot].map(String)
      const column = (name, i) => end.columns[name]?.[i]
      out.push({
        nm: searchable[end.tip],
        refusal: end.refusal ?? null,
        ids,
        contacts: ids.map((_, i) => [
          column('contact_x_nm', i), column('contact_y_nm', i), column('contact_z_nm', i),
        ]),
      })
    }
    return out
  }

  /** The flake's voxel farthest from the contact, in the box around the contact. */
  async function farEnd(flake, contactNm) {
    const scale = volume.scale
    const box = volumeMod.boxAround(scale, [...contactNm], halfWidthNm)
    const read = await rootedBox.labelledBox(volume, scale, box, options, undefined)
    const [sx, sy, sz] = read.size
    const res = read.resolutionNm
    const mine = new Uint8Array(read.roots.length)
    const want = BigInt(flake)
    for (let i = 0; i < read.roots.length; i++) if (read.roots[i] === want) mine[i] = 1
    let voxels = 0
    let onWall = 0
    let best = -1
    let far = null
    for (let z = 0, i = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++, i++) {
          if (!mine[read.index[i]]) continue
          voxels++
          if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) onWall++
          const nm = [
            (read.loVoxels[0] + x + 0.5) * res[0],
            (read.loVoxels[1] + y + 0.5) * res[1],
            (read.loVoxels[2] + z + 0.5) * res[2],
          ]
          const d = apart(nm, contactNm)
          if (d > best) { best = d; far = nm }
        }
      }
    }
    return { far, voxels, fits: voxels > 0 && onWall === 0, farUm: best / 1000 }
  }

  /** What a variant's lists hold of the truth: ends searched, and every new true piece's place. */
  function tally(lists, path, inTree) {
    const found = []
    for (const [at, list] of lists.entries()) {
      list.ids.forEach((id, i) => {
        if (!TRUTH.has(id) || path.includes(id)) return
        found.push({ id, place: i + 1, end: at, isNew: !inTree.has(id), chunks: SIZES[id] ?? null })
      })
    }
    const places = found.filter((one) => one.isNew).map((one) => one.place)
    return {
      ends: lists.length,
      listed: lists.map((list) => list.ids.length),
      refused: lists.filter((list) => list.refusal).length,
      best: places.length > 0 ? Math.min(...places) : null,
      found,
    }
  }

  async function grow(START) {
    const record = { start: START, chunks: SIZES[START] ?? null, cases: [] }
    const own = await tipsOf(START)
    record.tips = own.rows.length
    record.chainSeconds = own.seconds
    const startTips = own.rows.map((row) => row.nm)
    const lists = await search(START, undefined, startTips, [], undefined)
    const inTree = new Set([START])
    const queue = []
    const take = (lists, parent, path, pathTips) => {
      for (const list of lists) {
        list.ids.forEach((id, i) => {
          if (!TRUTH.has(id) || inTree.has(id)) return
          inTree.add(id)
          if ((SIZES[id] ?? Infinity) > SMALL || cased.has(id)) return
          cased.add(id)
          queue.push({
            id, parent, path: [...path, id], place: i + 1, parentTip: list.nm,
            contactNm: list.contacts[i], pathTips,
          })
        })
      }
    }
    take(lists, START, [START], startTips)
    record.trueAtStart = inTree.size - 1

    while (queue.length > 0 && record.cases.length < PER_START) {
      const piece = queue.shift()
      const one = {
        id: piece.id, parent: piece.parent, depth: piece.path.length - 1,
        chunks: SIZES[piece.id] ?? null, acceptedAt: piece.place,
      }
      record.cases.push(one)
      const before = new Set(inTree)
      // The app's own reading of "the path is the start" (aliasOf), not a copy of it.
      const alias = pieces.aliasOf({ seed: START, path: piece.path })
      const others = piece.pathTips
      const withoutOld = others.filter((nm) => !same(nm, piece.parentTip))
      try {
        // A and B: the chain's tips, the one nearest the contact being the join.
        let chainTips = []
        let chainRows = []
        try {
          const got = await tipsOf(piece.id)
          chainRows = got.rows
          chainTips = got.rows.map((row) => row.nm)
          one.chainTips = got.found
          one.chainSeconds = got.seconds
        } catch (error) {
          one.chainError = String(error?.message ?? error)
        }
        // The app's own rule for which end a piece joins by (junctionOf).
        const join = pieces.junctionOf(chainRows, piece.contactNm, plan.ownUm) ?? -1
        const open = chainTips.filter((_, i) => i !== join)
        one.openTips = open.length
        one.openToContactUm = open.map((nm) => Math.round(apart(nm, piece.contactNm) / 10) / 100)
        const joinTip = join < 0 ? [] : [chainTips[join]]
        const listsA = await search(piece.id, START, open, [...joinTip, ...others], alias)
        const listsB = await search(piece.id, START, open, withoutOld, alias)
        one.A = tally(listsA, piece.path, before)
        one.B = tally(listsB, piece.path, before)

        // C: the voxel farthest from the contact.
        const started = performance.now()
        const made = await farEnd(piece.id, piece.contactNm)
        one.farMs = Math.round(performance.now() - started)
        one.voxels = made.voxels
        one.fits = made.fits
        one.farUm = Math.round(made.farUm * 100) / 100
        const at = made.far ? [made.far] : []
        const listsC0 = await search(piece.id, START, at, others, alias)
        const listsC1 = await search(piece.id, START, at, withoutOld, alias)
        one.C0 = tally(listsC0, piece.path, before)
        one.C1 = tally(listsC1, piece.path, before)

        // Whatever any of them found goes on to be a case of its own.
        const next = [...others, ...chainTips, ...at]
        for (const found of [listsC1, listsB, listsC0, listsA]) take(found, piece.id, piece.path, next)
      } catch (error) {
        one.error = String(error?.message ?? error)
      }
    }
    record.waiting = queue.length
    return record
  }
  window.__flake = { grow }
  return { ownUm: plan.ownUm, halfWidthUm: plan.halfWidthUm, topK: plan.topK }
})()`

const out = join(WORK, 'flake-run.json')
const run = { neuron, t0, small, ends, rules: await evaluate(setup, 600_000), starts: [] }
for (const start of starts) {
  const began = Date.now()
  try {
    const got = await evaluate(`window.__flake.grow(${JSON.stringify(start)})`, 3_600_000)
    run.starts.push(got)
    console.log(
      `${start}: ${got.tips} tips, ${got.trueAtStart} true pieces at its ends, ` +
        `${got.cases.length} cases (${got.waiting} more waiting), ` +
        `${Math.round((Date.now() - began) / 1000)} s`,
    )
  } catch (error) {
    run.starts.push({ start, error: String(error?.message ?? error) })
    console.log(`${start}: failed — ${String(error?.message ?? error).slice(0, 200)}`)
  }
  // After every start, so a run that is stopped keeps what it has.
  writeFileSync(out, JSON.stringify(run, null, 1))
}
await close()

// ── The table ─────────────────────────────────────────────────────────────────────────────────
const cases = run.starts.flatMap((start) => (start.cases ?? []).filter((one) => !one.error))
const variants = ['A', 'B', 'C0', 'C1']
const count = (list, test) => list.filter(test).length
const line = (name, list) =>
  `${name.padEnd(4)} ` +
  [
    count(list, (v) => v.ends === 0),
    count(list, (v) => v.best === 1),
    count(list, (v) => v.best !== null && v.best <= 3),
    count(list, (v) => v.best !== null),
  ]
    .map((n) => String(n).padStart(9))
    .join('')
console.log(`\n${cases.length} cases (true pieces of at most ${small} chunks).`)
console.log('      nothing    first   within 3  anywhere   — cases, by the best place of a new true piece')
for (const name of variants) console.log(line(name, cases.map((one) => one[name])))
const either = cases.map((one) => {
  const places = [one.A.best, one.C1.best].filter((place) => place !== null)
  return { ends: one.A.ends + one.C1.ends, best: places.length ? Math.min(...places) : null }
})
console.log(line('A+C1', either))
console.log(`\nFull record: ${out}`)
