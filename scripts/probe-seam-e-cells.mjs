/**
 * Does Coda's Model E answer what SEAM's pipeline answered, on the same neuron?
 *
 * The check the plan puts **before** anything is wired to this model, because the last time a
 * SEAM model went into a node it was built end to end against a checkpoint nobody had measured
 * on the task, and the measurement that retired it was available on day one. Model E is the
 * open-end detector: stage 3 of the merge-candidate pipeline, and the first stage of the
 * streaming node that replaces the hosted suggestion sets.
 *
 * ## The two things it measures, which fail differently
 *
 * **The cells.** SEAM's `e_cells/<neuron>.npz` is the whole neuron scanned, pooled to the best
 * point in each 0.5 µm cell — `scripts/pilots/e_cells.py` through `replay_scan.score_neuron`.
 * Coda runs the same vendored `scan.py`, the same seeded draws and the same checkpoint, so the
 * *windows* should be identical and the only honest difference is the GPU's arithmetic. A cell
 * SEAM has and Coda does not is the failure that matters: it means the sampling drifted, and a
 * window built slightly differently still scores plausibly.
 *
 * **`e_tip`**, which is what the pipeline actually reads — the best cell within 1 µm of a tip.
 * The handoff names the bar: p_tip weighs E at 0.959, so an `e_tip` off by 0.1 moves p_tip's
 * logit by about that, and parity is judged by **whether the shown set changes**, not by raw
 * error. The numpy half (`scripts/lib/seam_e_cells.py`) does that comparison, where the npz and
 * the fixture's `tips.parquet` can be read by the library that wrote them.
 *
 * ## And the claim the streaming node rests on
 *
 * The node will not scan whole neurons — it scores a tip's own neighbourhood, which is the
 * difference between streaming and one long wait. That is exact rather than approximate, and the
 * argument is geometric: `Scan` draws its centres once over the whole surface and builds window
 * `i` from its own stream, so selecting is not re-sampling; and a window's points lie inside its
 * 15 µm crop, so a point within 1 µm of a tip can only come from a centre within 16 µm of it.
 * This probe does not take that on trust. It computes `e_tip` from the 16 µm selection and from
 * the whole neuron and asserts the difference is **zero**.
 *
 * ## Read, never written
 *
 * One neuron's mesh from the Aedes datastack through Coda's own `CaveSource`, with the token
 * from `~/.cloudvolume/secrets`. Nothing is written anywhere: SEAM's invariant 7 is that it
 * never writes to a chunkedgraph, and this repo's standing rule is the same about every live
 * server.
 *
 * Usage: `pnpm dev --port 5178` in another terminal, then `pnpm probe:seam-e-cells`.
 * `--neuron` picks another of the fixture's five, `--limit` caps the windows for a smoke run
 * (which makes the cell comparison meaningless and is only for checking the plumbing).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  probeReport,
  readCaveToken,
} from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
const neuron = args.value('--neuron') ?? '648518347558097460'
const datastack = args.value('--datastack') ?? 'wclee_aedes_brain'
const fixture =
  args.value('--fixture') ?? join(homedir(), 'Github/SEAM/data/fixtures/coda_rv2')
const manifestUrl =
  args.value('--manifest') ??
  'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-e-oe3-all-s0/manifest.json'
/** Windows built, scored and pooled before the next page. See `offset` in `seamWindows.ts`. */
const page = Number(args.value('--page') ?? 32)
const limit = Number(args.value('--limit') ?? 0)
/** How many of the neuron's tips the local-selection check is run on. All of them is slow. */
const tipSample = Number(args.value('--tips') ?? 12)
if (![page, limit, tipSample].every(Number.isFinite)) {
  console.error('--page, --limit and --tips are numbers')
  process.exit(2)
}

const work = join(
  process.env.CODA_PROBE_DIR ?? '/tmp',
  `coda-seam-e-cells-${process.pid}`,
)
mkdirSync(work, { recursive: true })
const tipsJson = join(work, 'tips.json')

/*
 * SEAM's own numbers first, and out of process: `-I` so the interpreter ignores the current
 * directory and the environment, which is this repo's rule for anything reading files it did not
 * write. A failure here is a missing fixture, which is worth saying before Chrome is launched.
 */
try {
  execFileSync(
    'python3',
    ['-I', 'scripts/lib/seam_e_cells.py', 'tips', fixture, neuron, tipsJson],
    { stdio: 'inherit' },
  )
} catch {
  console.error(`could not read ${fixture}/tips.parquet — is --fixture right?`)
  process.exit(2)
}
const tips = JSON.parse(readFileSync(tipsJson, 'utf8'))

/*
 * `--mesh <npz>`: put SEAM's *own* cached mesh through Coda's pipeline instead of fetching one.
 *
 * Not a convenience. The first full run matched SEAM's cells to 0.04% and its logits to a mean of
 * 0.29, which is five orders past what this graph measures against PyTorch — so the model is not
 * the difference and the input is. CAVE answered with the same 3,707,915 faces and 14,149 more
 * vertices, i.e. the same surface with its chunk boundaries merged differently, and the one way
 * to tell whether that reaches the sampling is to remove it as a variable.
 */
let meshBase64 = ''
const meshNpz = args.value('--mesh')
if (meshNpz) {
  const meshBin = join(work, 'mesh.bin')
  execFileSync('python3', ['-I', 'scripts/lib/seam_e_cells.py', 'mesh', meshNpz, meshBin], {
    stdio: 'inherit',
  })
  meshBase64 = readFileSync(meshBin).toString('base64')
}

/** Its own, and deleted on the way out: `handCaveToken` persists into this profile. */
const PROFILE = '/tmp/coda-seam-e-cells-profile'
const token = readCaveToken()
if (!token) {
  console.error('no CAVE token: set CAVE_TOKEN or put one in ~/.cloudvolume/secrets/cave-secret.json')
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9355, profile: PROFILE })
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
    builtins,
    registry,
    windowsMod,
    manifestMod,
    configMod,
    sessionMod,
    runMod,
    opsMod,
    specMod,
    stackMod,
  ] = await Promise.all([
    load('/src/data/builtins.ts'),
    load('/src/data/source.ts'),
    load('/src/pyodide/seamWindows.ts'),
    load('/src/ml/manifest.ts'),
    load('/src/packs/seam/windowConfig.ts'),
    load('/src/ml/session.ts'),
    load('/src/packs/seam/windowRun.ts'),
    load('/src/packs/seam/openEndsOps.ts'),
    load('/src/data/cave/spec.ts'),
    load('/src/data/cave/datastack.ts'),
  ])
  builtins.registerBuiltinSources()

  const loaded = await manifestMod.loadManifest(${JSON.stringify(manifestUrl)})
  // Through the node's own parser, so the probe refuses a manifest the node would refuse rather
  // than scoring it with whatever the JSON happened to hold.
  const config = configMod.parseWindowConfig(loaded.manifest.config, loaded.manifest.id)
  const pre = config.preprocessing
  if (!config.scan) return { error: loaded.manifest.id + ' publishes no scan block' }
  const scan = { reduce_um: config.scan.reduceUm }
  const source = registry.getSource('cave')

  const name = ${JSON.stringify(datastack)}
  if (!specMod.shippedSpecFor(undefined, name)) {
    specMod.registerDatastackSpec({ datastack: name, label: name, description: 'probe' })
  }
  const versions = await stackMod.materializationsFor(name, {})
  if (versions.length === 0) return { error: 'no materializations for ' + name }
  const datasetId = specMod.datasetIdFor(name, Math.max(...versions))

  const given = ${JSON.stringify(meshBase64)}
  let item
  let meshFrom = 'cave'
  if (given) {
    // Two uint32 counts, then the vertices, then the faces -- what the mesh subcommand writes.
    const raw = Uint8Array.from(atob(given), (c) => c.charCodeAt(0))
    const counts = new Uint32Array(raw.buffer, 0, 2)
    const vn = counts[0], fn = counts[1]
    item = {
      positions: new Float32Array(raw.buffer.slice(8, 8 + vn * 12)),
      indices: new Uint32Array(raw.buffer.slice(8 + vn * 12, 8 + vn * 12 + fn * 12)),
    }
    meshFrom = 'seam'
  } else {
    const meshes = await source.fetchMeshes({ datasetId, neuronIds: [${JSON.stringify(neuron)}] })
    item = meshes.items[0]
    if (!item) return { error: 'no mesh for ${neuron}' }
    // The whole measurement rests on this: scan.py reaches nanometres by multiplying, so a voxel
    // mesh tiles at a wrong physical scale and answers plausibly.
    if (meshes.units !== 'nm') return { error: 'mesh in ' + meshes.units }
  }

  if (${JSON.stringify(Boolean(args.value("--dump-mesh")))}) {
    // The mesh and nothing else, so the question "is this the same surface SEAM scored?" can be
    // asked in numpy rather than guessed at from a vertex count.
    const bytes = new Uint8Array(8 + item.positions.byteLength + item.indices.byteLength)
    new Uint32Array(bytes.buffer, 0, 2).set([item.positions.length / 3, item.indices.length / 3])
    bytes.set(new Uint8Array(item.positions.buffer, item.positions.byteOffset, item.positions.byteLength), 8)
    bytes.set(
      new Uint8Array(item.indices.buffer, item.indices.byteOffset, item.indices.byteLength),
      8 + item.positions.byteLength,
    )
    let out = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return { meshOnly: true, meshFrom, vertices: item.positions.length / 3,
             faces: item.indices.length / 3, meshBase64: btoa(out) }
  }

  const session = await sessionMod.openModel({
    manifestUrl: ${JSON.stringify(manifestUrl)},
    task: loaded.manifest.task,
  })

  const base = {
    positions: item.positions,
    indices: item.indices,
    radiusUm: pre.windowRadiusUm,
    spacingUm: pre.spacingUm,
    nPoints: pre.nPoints,
    useNormals: pre.features === 'normals',
    units: 'nm',
    // e_cells.py scores with seed 0, and the seed is the whole of the parity.
    seed: 0,
    drawEvery: 1,
    // Built once and kept: every call after the first skips the tiling *and* the 20 MB of mesh.
    meshKey: ${JSON.stringify(neuron)} + ':' + meshFrom,
  }

  /**
   * Windows built, scored and **pooled** before the next page is built.
   *
   * \`reduce_max\` is idempotent, so pooling a page and pooling the pooled pages gives what
   * pooling everything at once gives — which is exactly what \`score_neuron\` does, and what
   * keeps a neuron's 4,096-points-a-window from having to exist at once.
   */
  let sent = false
  /** The centres within a distance of a place, worked out from the tiling the bridge hands back. */
  const centresNear = (centres, at, withinNm) => {
    const want = []
    for (let c = 0; c * 3 < centres.length; c++) {
      const dx = centres[c * 3] - at[0]
      const dy = centres[c * 3 + 1] - at[1]
      const dz = centres[c * 3 + 2] - at[2]
      if (dx * dx + dy * dy + dz * dz <= withinNm * withinNm) want.push(c)
    }
    return Int32Array.from(want)
  }

  const scanPages = async (over) => {
    let pooledPos = new Float32Array(0)
    let pooledScore = new Float32Array(0)
    let built = 0
    let buildMs = 0
    let runMs = 0
    let tileMs = 0
    let windowMs = 0
    // The tiling first, so the sweep can be named rather than paged blind — and so a run that
    // wants only the centres near a place can work out which those are.
    const first = await windowsMod.runSeamWindows({
      ...base, ...(sent ? { positions: new Float32Array(0), indices: new Uint32Array(0) } : {}),
      only: new Int32Array(0), limit: 0,
    })
    sent = true
    tileMs += first.tileMs
    const order = over.nearNm
      ? centresNear(first.tilingCentresNm, over.nearNm, over.withinNm)
      : Int32Array.from({ length: first.tiled }, (_, i) => i)
    for (let at = 0; at < order.length; at += ${page}) {
      const t0 = performance.now()
      // The mesh went with the tiling call above; from here the key stands for it.
      const batch = await windowsMod.runSeamWindows({
        ...base,
        positions: new Float32Array(0),
        indices: new Uint32Array(0),
        ...over,
        only: order.slice(at, at + ${page}),
        limit: 0,
      })
      buildMs += performance.now() - t0
      // Split, because they answer different questions: the tiling is paid once per *call* --
      // Scan builds its face grid and surface draw in its constructor -- so a node scoring one
      // tip pays all of it for a handful of windows. If that is the bulk, the Scan wants caching.
      tileMs += batch.tileMs
      windowMs += batch.windowMs
      // No windows *built* does not mean nothing is left: a centre whose cells hold no surface
      // yields none. The sweep is named up front, so the loop is over it rather than over luck.
      if (batch.windows === 0) continue
      built += batch.windows
      const t1 = performance.now()
      const scored = await runMod.scoreWindows(
        session, batch.points, batch.feats, batch.windows, pre.nPoints,
      )
      runMs += performance.now() - t1
      const joinPos = new Float32Array(pooledPos.length + batch.sourceNm.length)
      joinPos.set(pooledPos); joinPos.set(batch.sourceNm, pooledPos.length)
      const joinScore = new Float32Array(pooledScore.length + scored.pointLogits.length)
      joinScore.set(pooledScore); joinScore.set(scored.pointLogits, pooledScore.length)
      const cells = await windowsMod.runSeamReduce({
        pointsNm: joinPos, scores: joinScore, cellUm: scan.reduce_um,
      })
      pooledPos = cells.pointsNm
      pooledScore = cells.scores
      if (${limit} > 0 && built >= ${limit}) break
    }
    return { pos: pooledPos, score: pooledScore, built, selected: order.length, buildMs, runMs, tileMs, windowMs }
  }

  const t0 = performance.now()
  const whole = await scanPages({})
  const wholeMs = performance.now() - t0

  /*
   * The claim the streaming node rests on, checked rather than asserted: e_tip from the 16 µm
   * selection against e_tip from the whole neuron, on real tips. Expected identical.
   */
  const at = ${JSON.stringify(tips.xyz)}
  const reachNm = opsMod.E_TIP_UM * 1000
  const eAt = (pos, score, x, y, z) => {
    let best = null
    for (let i = 0; i < score.length; i++) {
      const dx = pos[i * 3] - x, dy = pos[i * 3 + 1] - y, dz = pos[i * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz <= reachNm * reachNm && (best === null || score[i] > best)) {
        best = score[i]
      }
    }
    return best
  }
  const localChecks = []
  const sample = Math.min(${tipSample}, at.length / 3)
  const withinNm = opsMod.reachNm(pre.windowRadiusUm)
  for (let t = 0; t < sample; t++) {
    const x = at[t * 3], y = at[t * 3 + 1], z = at[t * 3 + 2]
    const near = await scanPages({ nearNm: [x, y, z], withinNm })
    localChecks.push({
      tip: t,
      windows: near.built,
      selected: near.selected,
      local: eAt(near.pos, near.score, x, y, z),
      whole: eAt(whole.pos, whole.score, x, y, z),
      ms: Math.round(near.buildMs + near.runMs),
      tileMs: Math.round(near.tileMs),
      windowMs: Math.round(near.windowMs),
      runMs: Math.round(near.runMs),
    })
  }

  await session.close()

  // The cells out as one buffer: 3 floats of position per cell, then one score each. Base64
  // because this crosses as a JSON string, and a 60,000-cell neuron is about a megabyte.
  const flat = new Float32Array(whole.pos.length + whole.score.length)
  flat.set(whole.pos)
  flat.set(whole.score, whole.pos.length)
  const bytes = new Uint8Array(flat.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }

  return {
    model: loaded.manifest.id,
    dataset: datasetId,
    meshFrom,
    vertices: item.positions.length / 3,
    faces: item.indices.length / 3,
    tiled: whole.selected,
    windows: whole.built,
    cells: whole.score.length,
    wholeSeconds: +(wholeMs / 1000).toFixed(1),
    buildMs: Math.round(whole.buildMs),
    tileMs: Math.round(whole.tileMs),
    windowMs: Math.round(whole.windowMs),
    runMs: Math.round(whole.runMs),
    msPerWindow: whole.built ? +((whole.buildMs + whole.runMs) / whole.built).toFixed(1) : null,
    localChecks,
    cellsBase64: btoa(binary),
  }
})()`

const got = await evaluate(script, 3_600_000)
if (got?.meshOnly) {
  writeFileSync(args.value('--dump-mesh'), Buffer.from(got.meshBase64, 'base64'))
  console.log(`${got.vertices} vertices, ${got.faces} faces from ${got.meshFrom} -> ${args.value('--dump-mesh')}`)
  await close()
  process.exit(0)
}
if (got?.error) {
  console.error(got.error)
  await close()
  process.exit(2)
}
const { cellsBase64, localChecks, ...summary } = got
console.log(JSON.stringify(summary, null, 2))

const cellsBin = join(work, 'cells.bin')
writeFileSync(cellsBin, Buffer.from(cellsBase64, 'base64'))

report.check(summary.windows > 0, `${summary.windows} windows of ${summary.tiled} centres`)
report.check(summary.cells > 0, `${summary.cells.toLocaleString()} cells pooled`)

/*
 * The local selection, which is the node's whole design. Zero, not "small": a selection that
 * re-sampled would differ by a little everywhere and read as a model difference rather than a
 * sampling one, which is exactly the kind of error nobody traces.
 */
const differing = localChecks.filter((c) => c.local !== c.whole)
if (limit > 0) {
  // Under `--limit` the whole-neuron side is a fragment of the neuron, so most tips have no cell
  // in it at all and `null !== a number` would fail for a reason that is the flag, not the code.
  console.log(`\n--limit ${limit}: the selection check needs every window, so it is skipped.`)
} else {
  report.check(
    localChecks.length > 0 && differing.length === 0,
    `e_tip from a 16 µm selection equals e_tip from the whole neuron on ${localChecks.length} tips`,
  )
}
if (differing.length && limit <= 0) console.log(JSON.stringify(differing.slice(0, 5), null, 1))
const perTip = localChecks.map((c) => c.ms)
if (perTip.length) {
  const median = perTip.slice().sort((a, b) => a - b)[Math.floor(perTip.length / 2)]
  const windows = localChecks.map((c) => c.windows)
  const tiling = localChecks.map((c) => c.tileMs)
  const retiled = Math.round(tiling.reduce((a, b) => a + b, 0) / tiling.length)
  console.log(
    `\nA tip on its own: ${Math.min(...windows)}–${Math.max(...windows)} windows, ` +
      `${median} ms median — against ${summary.wholeSeconds} s for the whole neuron.\n` +
      (retiled > 0
        ? `Of that median, about ${retiled} ms is re-tiling a mesh that has not changed: pass ` +
          `the same meshKey and the tiling is kept.`
        : `The tiling was cached for every one of them (${summary.tileMs} ms paid once for the ` +
          `whole neuron), which is what makes a tip worth scoring on its own.`),
  )
}

if (limit > 0) {
  console.log(`\n--limit ${limit} was given, so the cell comparison is skipped: it needs every window.`)
} else {
  console.log('\nAgainst SEAM’s own cells:')
  execFileSync(
    'python3',
    ['-I', 'scripts/lib/seam_e_cells.py', 'compare', fixture, neuron, cellsBin, tipsJson],
    { stdio: 'inherit' },
  )
}

await close()
report.finish('is `pnpm dev --port 5178` running?')
