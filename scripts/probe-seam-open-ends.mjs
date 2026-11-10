/**
 * Does the Find Open Ends node actually run, and does it stream?
 *
 * `probe:seam-e-cells` measures the *pieces* — the windows, the model, the pooling — against
 * SEAM's own cells, and says nothing about the node that orchestrates them. This runs
 * `seam:openEnds`' own `evaluate` on a real neuron and watches what comes out of it: the
 * skeleton it makes, the tips it decides on, the rows it publishes part-way through, and the
 * table it finally returns.
 *
 * It exists because the orchestration is where the silent failures are. A tip released one page
 * early carries a lower score and never gets another one; a page whose centres are counted twice
 * releases every tip at the end, which is a node that works and does not stream; a published
 * table in the wrong order makes the review card rebuild every row. None of those throws.
 *
 * **`evaluate` is built here rather than run through the scheduler**, which is the same bargain
 * `probe-seam-merge.mjs` makes one level down: a hand-made `EvalContext` is thirteen members and
 * lets the probe see every `publish` and every `warn` as it happens, where a scheduler run would
 * report a result and a duration. What it gives up is the scheduler's own behaviour — the cache,
 * cancellation, the run states — which `src/core` covers and this node does nothing unusual with.
 *
 * ## Read, never written
 *
 * One neuron's mesh from the Aedes datastack through Coda's own `CaveSource`. SEAM's invariant 7
 * is that it never writes to a chunkedgraph, and this repo's rule is the same about every live
 * server.
 *
 * Usage: `pnpm dev --port 5178` in another terminal, then `pnpm probe:seam-open-ends`.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
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
const fixture = args.value('--fixture') ?? join(homedir(), 'Github/SEAM/data/fixtures/coda_rv2')
/**
 * A CAVE nucleus table, for the soma mask.
 *
 * This datastack publishes no soma with its meshes (`MeshGeometry.soma` is null, checked), so
 * without one the mask never fires and the cell body's whole hairball of ends is kept — the
 * node found 1,214 against SEAM's 548, and SEAM masks with a nucleus table of its own.
 */
const nuclei = args.value('--nuclei') ?? ''

/** `--kinks`: turn the card's kink switch on, so the comparison below has both kinds to match. */
const kinks = args.all.includes('--kinks')

/**
 * `--mesh <file>`: a surface to use instead of the one CAVE answers with.
 *
 * Two uint32 counts, then the vertices, then the faces — what `seam_e_cells.py mesh` writes.
 * For asking what a *different* surface does to the tips: the same neuron cleaned, decimated, or
 * taken from somewhere else. The node is otherwise unchanged, so the difference is the mesh.
 */
let meshBase64 = ''
const meshFile = args.value('--mesh')
if (meshFile) meshBase64 = readFileSync(meshFile).toString('base64')

const work = join(process.env.CODA_PROBE_DIR ?? '/tmp', `coda-seam-open-ends-${process.pid}`)
mkdirSync(work, { recursive: true })

/*
 * SEAM's own tips, for the comparison at the end. Not a parity check — the node reads a mesh
 * fetched from CAVE, whose faces are the same triangles in a different order, and
 * `probe:seam-e-cells` measures what that costs (`e_tip` off by 0.29 on two tips in three). What
 * this can honestly say is whether the node finds the same *ends*, which is a different question
 * and the one its own stage is responsible for.
 */
let tips = { xyz: [], eTip: [], kind: [] }
try {
  const tipsJson = join(work, 'tips.json')
  execFileSync(
    'python3',
    ['-I', 'scripts/lib/seam_e_cells.py', 'tips', fixture, neuron, tipsJson],
    { stdio: 'inherit' },
  )
  tips = JSON.parse(readFileSync(tipsJson, 'utf8'))
} catch {
  console.log(`no fixture at ${fixture}: the run still happens, the comparison does not.`)
}

/** Its own, and deleted on the way out: `handCaveToken` persists into this profile. */
const PROFILE = '/tmp/coda-seam-open-ends-profile'
const token = readCaveToken()
if (!token) {
  console.error('no CAVE token: set CAVE_TOKEN or put one in ~/.cloudvolume/secrets/cave-secret.json')
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9357, profile: PROFILE })
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
  const [builtins, registry, nodeMod, defs, specMod, stackMod] = await Promise.all([
    load('/src/data/builtins.ts'),
    load('/src/data/source.ts'),
    load('/src/core/node.ts'),
    load('/src/core/registry.ts'),
    load('/src/data/cave/spec.ts'),
    load('/src/data/cave/datastack.ts'),
  ])
  await load('/src/nodes/index.ts')
  builtins.registerBuiltinSources()

  const name = ${JSON.stringify(datastack)}
  if (!specMod.shippedSpecFor(undefined, name)) {
    specMod.registerDatastackSpec({ datastack: name, label: name, description: 'probe' })
  }
  const versions = await stackMod.materializationsFor(name, {})
  if (versions.length === 0) return { error: 'no materializations for ' + name }
  const datasetId = specMod.datasetIdFor(name, Math.max(...versions))
  const source = registry.getSource('cave')
  let meshes = await source.fetchMeshes({ datasetId, neuronIds: [${JSON.stringify(neuron)}] })
  if (!meshes.items[0]) return { error: 'no mesh for ${neuron}' }
  const given = ${JSON.stringify(meshBase64)}
  if (given) {
    const raw = Uint8Array.from(atob(given), (c) => c.charCodeAt(0))
    const counts = new Uint32Array(raw.buffer, 0, 2)
    const vn = counts[0], fn = counts[1]
    meshes = {
      ...meshes,
      items: [{
        ...meshes.items[0],
        positions: new Float32Array(raw.buffer.slice(8, 8 + vn * 12)),
        indices: new Uint32Array(raw.buffer.slice(8 + vn * 12, 8 + vn * 12 + fn * 12)),
      }],
    }
  }

  const def = defs.requireNodeDef('seam:openEnds')
  const params = {
    ...nodeMod.defaultParams(def),
    download: true,
    nucleusTable: ${JSON.stringify(nuclei)},
    kinks: ${kinks ? 'true' : 'false'},
  }
  // The Dataset the nucleus table is read from — a *reference* port, so this is the identity and
  // not a value anything consumes.
  const datasetRef = { kind: 'dataset', sourceId: 'cave', datasetId: datasetId }

  // Every publish, so the probe can see whether rows actually arrived early or all at the end.
  const publishes = []
  const warnings = []
  const notes = []
  const started = performance.now()
  const ctx = {
    params,
    input: (port) =>
      port === 'meshes' ? meshes : port === 'dataset' ? datasetRef : undefined,
    inputKey: () => undefined,
    inputPorts: () => [],
    outputPorts: () => [],
    column: () => undefined,
    columns: () => [],
    resolveSource: (id) => registry.getSource(id),
    refresh: false,
    signal: new AbortController().signal,
    progress: (fraction, note) => { if (note) notes.push(note) },
    warn: (message) => warnings.push(message),
    publish: (outputs) => publishes.push({
      at: Math.round(performance.now() - started),
      rows: outputs.tips?.length ?? 0,
    }),
    reportFetched: () => {},
  }

  const out = await def.evaluate(ctx)
  const table = out.tips
  const column = (name) => table.data[name] ?? []
  return {
    seconds: +((performance.now() - started) / 1000).toFixed(1),
    rows: table.length,
    columns: Object.keys(table.data).sort(),
    publishes,
    warnings,
    firstNotes: notes.slice(0, 4),
    // The three columns this stage fills, out for the comparison below.
    x: column('x'), y: column('y'), z: column('z'), eTip: column('e_tip'),
    // And one a later stage will: present, and null throughout.
    pTip: column('p_tip').filter((v) => v !== null).length,
  }
})()`

const got = await evaluate(script, 3_600_000)
if (got?.error) {
  console.error(got.error)
  await close()
  process.exit(2)
}

const { x, y, z, eTip, publishes, ...summary } = got
console.log(JSON.stringify({ ...summary, publishes: publishes.length }, null, 2))

report.check(summary.rows > 0, `${summary.rows} open ends found`)
report.check(
  eTip.filter((v) => v !== null).length > 0,
  `${eTip.filter((v) => v !== null).length} of them carry a score`,
)
report.check(summary.pTip === 0, 'p_tip is present and null, for the stage that will fill it')

/*
 * The streaming property, and the reason it is worth a check rather than a timing: a node that
 * published once at the end would pass every other assertion here. "More than one publish" is
 * the weak half; the strong half is that the *first* one arrived well before the run ended.
 */
report.check(publishes.length > 1, `${publishes.length} publishes, not one at the end`)
if (publishes.length > 0) {
  const first = publishes[0]
  const share = first.at / 1000 / summary.seconds
  console.log(
    `\nFirst rows after ${(first.at / 1000).toFixed(1)} s of ${summary.seconds} s ` +
      `(${Math.round(share * 100)}% in), ${first.rows} of ${summary.rows} of them.`,
  )
  report.check(share < 0.5, 'the first rows arrive in the first half of the run')
  let grew = true
  for (let i = 1; i < publishes.length; i++) {
    if (publishes[i].rows < publishes[i - 1].rows) grew = false
  }
  report.check(grew, 'every publish is at least as long as the one before it')
}

/*
 * And whether the ends are SEAM's ends. Matched by position within a micrometre — the two meshes
 * are the same surface, so a tip of one should sit on a tip of the other even though the scores
 * drift. A low match rate here is this node's own stage being wrong (the prune, the degree rule,
 * the snap, the soma mask); a high match rate with drifting scores is the mesh-order difference
 * `probe:seam-e-cells` measures.
 */
if (tips.xyz.length > 0) {
  /*
   * Split by kind, because they are two rules and they fail apart. SEAM's candidates are tips
   * *and* kinks — a sharp turn inside an unbranched run, where a side branch swallowed the real
   * end — and the node only looks for the second under `--kinks`. On this neuron SEAM's 548
   * candidates are 382 tips and 166 kinks, and on the mesh as CAVE answers with it:
   *
   *     without --kinks   tips 366 of 382 (96%)   kinks  44 of 166 (27%, incidental)
   *     with --kinks      tips 368 of 382 (96%)   kinks 124 of 166 (75%)
   *
   * and on the same neuron cleaned through `Clean Meshes`' `drop_internals`, which is what SEAM
   * skeletonizes, 380 of 382 (99%) and 153 of 166 (92%). The residue is the skeleton: a kink is a
   * turn *in the skeleton*, so a wavefront run that smooths a corner has no kink to find.
   */
  const found = { tip: 0, kink: 0 }
  const total = { tip: 0, kink: 0 }
  const errors = []
  for (let t = 0; t * 3 < tips.xyz.length; t++) {
    const kind = tips.kind[t] === 'kink' ? 'kink' : 'tip'
    total[kind] += 1
    const tx = tips.xyz[t * 3]
    const ty = tips.xyz[t * 3 + 1]
    const tz = tips.xyz[t * 3 + 2]
    let best = Infinity
    let at = -1
    for (let i = 0; i < summary.rows; i++) {
      const d = (x[i] - tx) ** 2 + (y[i] - ty) ** 2 + (z[i] - tz) ** 2
      if (d < best) {
        best = d
        at = i
      }
    }
    if (Math.sqrt(best) <= 1000) {
      found[kind] += 1
      if (kind === 'tip' && eTip[at] !== null) errors.push(Math.abs(eTip[at] - tips.eTip[t]))
    }
  }
  errors.sort((a, b) => a - b)
  const share = (kind) =>
    `${found[kind]} of ${total[kind]} ` +
    `(${Math.round((100 * found[kind]) / Math.max(1, total[kind]))}%)`
  console.log(
    `\nAgainst SEAM's candidates for this neuron, within 1 µm:\n` +
      `  tips  ${share('tip')}\n` +
      `  kinks ${share('kink')}${kinks ? '' : ' — not asked for, so these are incidental'}\n` +
      `  median |Δe_tip| on matched tips: ` +
      `${errors.length ? errors[Math.floor(errors.length / 2)].toFixed(3) : 'n/a'}`,
  )
  report.check(
    found.tip / Math.max(1, total.tip) > 0.7,
    `most of SEAM's tips are found again (${share('tip')})`,
  )
}

await close()
report.finish('is `pnpm dev --port 5178` running?')
