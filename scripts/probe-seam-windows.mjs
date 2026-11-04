/**
 * What does it cost to cut a real neuron into the windows a SEAM model takes?
 *
 * This is the number Phase C exists to get, and nobody has it on either side. SEAM's own
 * `docs/serving.md` names it as the spike's one unmeasured item — "a window is megabytes of mesh
 * rather than kilobytes of L2 attributes, so the spike also measures fetch time per window" — and
 * the spike never did. Until it exists, the node in Phase D is being designed against a guess.
 *
 * ## What it actually measures, after one correction
 *
 * The plan said "mesh fetch **per window**". That turns out to be the wrong unit on this backend.
 * FlyWire public ignores a bbox on a mesh request (SEAM's `geometry.window_mesh` filters
 * fragments client-side by the boxes in their names), and Coda's own measurement over sets of 25
 * neurons puts a whole FlyWire mesh at **132 fragments, 0.51 MB, 1.59 s** — so the neuron is
 * fetched once and the windows are local crops of it. The cost splits into:
 *
 *   1. **fetch**, once per neuron, which `src/data/cave/meshes.ts` has already measured;
 *   2. **tiling and resampling**, once per window, in Pyodide — the unmeasured half, and the one
 *      that scales with how much arbour a neuron has;
 *   3. **inference**, 4e-6-accurate at ~49 ms a window (`probe:seam-model`).
 *
 * If (2) is tens of milliseconds a window the node is pleasant; if it is hundreds, the tiling has
 * to coarsen or the sampling has to move, and that is a design decision rather than an
 * optimisation — which is why this runs before the node is written.
 *
 * ## A real neuron, read not written
 *
 * Through Coda's own `CaveSource`, with the CAVE token from `~/.cloudvolume/secrets`, so what is
 * measured is the path the app takes. A read of two neurons, rate-limited by being two: SEAM's
 * invariant 8 and this repo's standing rule are both about not leaning on shared public servers.
 *
 * Usage: `pnpm dev --port 5178` in another terminal, then `pnpm probe:seam-windows`.
 * `--ids` overrides the neurons, `--manifest` the model whose window constants are used.
 */

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
/** Two FlyWire v783 neurons. Not cherry-picked for size — see the spread note in the report. */
const ids = (args.value('--ids') ?? '720575940621522189,720575940628857210').split(',')
const manifestUrl =
  args.value('--manifest') ??
  'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-a-d256-e80/manifest.json'
const limit = Number(args.value('--limit') ?? 0)
if (!Number.isFinite(limit)) {
  // Interpolated straight into the page script, so a NaN here surfaces as "cannot convert float
  // NaN to integer" from inside Python, naming neither the flag nor this file.
  console.error(`--limit must be a number, not ${args.value('--limit')}`)
  process.exit(2)
}

/** Its own, and deleted on the way out: `handCaveToken` persists into this profile. */
const PROFILE = '/tmp/coda-seam-windows-profile'

const token = readCaveToken()
if (!token) {
  console.error('no CAVE token: set CAVE_TOKEN or put one in ~/.cloudvolume/secrets/cave-secret.json')
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9343, profile: PROFILE })
/*
 * The token reaches the page through `localStorage`, which lives in the profile — `launchChrome`
 * clears it at *launch*, not at exit, so without this a live CAVE credential sits in /tmp after
 * every run and across reboots. `changelog-shots.mjs`, the only other `handCaveToken` caller,
 * pairs the two for exactly this reason. Registered before the token is handed over, so the two
 * `process.exit(2)` paths below are covered too.
 */
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
  const [builtins, registry, windows, manifest] = await Promise.all([
    load('/src/data/builtins.ts'),
    load('/src/data/source.ts'),
    load('/src/pyodide/seamWindows.ts'),
    load('/src/ml/manifest.ts'),
  ])
  builtins.registerBuiltinSources()

  // The window constants are the model's, never this probe's: a window built at the wrong
  // radius is a confident answer to a question the checkpoint was never asked.
  const loaded = await manifest.loadManifest(${JSON.stringify(manifestUrl)})
  const pre = loaded.manifest.config.preprocessing
  const source = registry.getSource('cave')

  // One throwaway tile of a tetrahedron, so the first *measured* neuron does not pay numpy's
  // load and the module's runPython -- 6 s of boot landing on whichever neuron came first read
  // as 188 ms a window on this probe's first run.
  const warm = performance.now()
  await windows.runSeamWindows({
    positions: Float32Array.from([0, 0, 0, 1e4, 0, 0, 0, 1e4, 0, 0, 0, 1e4]),
    indices: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]),
    radiusUm: pre.windowRadiusUm, spacingUm: pre.spacingUm, nPoints: pre.nPoints,
    useNormals: pre.features === 'normals', units: 'nm', seed: 0, limit: 1,
  })
  const bootMs = Math.round(performance.now() - warm)

  const out = { model: loaded.manifest.id, preprocessing: pre, bootMs, neurons: [] }
  for (const id of ${JSON.stringify(ids)}) {
    const t0 = performance.now()
    const meshes = await source.fetchMeshes({ datasetId: 'flywire_fafb_public:783', neuronIds: [id] })
    const fetchMs = Math.round(performance.now() - t0)
    const item = meshes.items[0]
    if (!item) { out.neurons.push({ id, error: 'no mesh' }); continue }
    // The units the whole measurement rests on. The wrapper refuses anything else; asserted here
    // too so a dataset that answered in voxels is a sentence rather than a plausible table.
    if (meshes.units !== 'nm') { out.neurons.push({ id, error: 'mesh in ' + meshes.units }); continue }

    // Read before the call. runSeamWindows now copies the mesh so the caller's arrays survive,
    // but reading first is still right: the wrapper's contract is what protects them, and a probe
    // that depends on it silently starts reporting zeros the day it changes. This probe did read
    // 0 vertices on its first run, before that copy existed.
    const vertices = item.positions.length / 3
    const faces = item.indices.length / 3
    const meshMegabytes = +(((item.positions.length + item.indices.length) * 4) / 1e6).toFixed(2)

    const t1 = performance.now()
    const built = await windows.runSeamWindows({
      positions: item.positions,
      indices: item.indices,
      radiusUm: pre.windowRadiusUm,
      spacingUm: pre.spacingUm,
      nPoints: pre.nPoints,
      useNormals: pre.features === 'normals',
      units: meshes.units,
      seed: 0,
      limit: ${limit},
    })
    const buildMs = Math.round(performance.now() - t1)

    const bytes = (built.points.length + built.feats.length + built.sourceNm.length) * 4
    out.neurons.push({
      id,
      fetchMs,
      vertices,
      faces,
      meshMegabytes,
      tiled: built.tiled,
      windows: built.windows,
      empty: built.empty,
      buildMs,
      tileMs: built.tileMs,
      windowMs: built.windowMs,
      msPerWindow: built.windows ? +(built.windowMs / built.windows).toFixed(1) : null,
      // Attributed to the tiling alone, which is the half that scales with the mesh. Null rather
      // than Infinity for a face-less mesh, which JSON would otherwise write as null anyway and
      // a reader would take for "not measured" rather than "divided by zero".
      usPerFace: faces > 0 ? +((built.tileMs * 1000) / faces).toFixed(1) : null,
      windowMegabytes: +(bytes / 1e6).toFixed(1),
    })
  }
  return out
})()`

const got = await evaluate(script, 1_800_000)
console.log(JSON.stringify(got, null, 2))

const ran = got.neurons.filter((n) => !n.error)
report.check(ran.length > 0, `${ran.length} of ${got.neurons.length} neurons gave a mesh`)
for (const n of ran) {
  report.check(n.windows > 0, `${n.id}: ${n.windows} windows from ${n.faces.toLocaleString()} faces`)
  // Not a threshold anybody has defended yet -- it is the question this probe was written to
  // answer, stated as a number so the answer is a pass or a fail rather than a shrug. A window
  // costing more than its own inference (~49 ms) means the input path, not the model, is the wait.
  report.check(
    n.msPerWindow !== null && n.msPerWindow < 200,
    `${n.id}: ${n.msPerWindow} ms a window to build (inference is ~49)`,
  )
}
await close()
report.finish('is `pnpm dev --port 5178` running?')
