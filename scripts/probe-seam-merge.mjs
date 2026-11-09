/**
 * What does SEAM's Model A actually say about a neuron somebody has already looked at?
 *
 * Find Merges' `evaluate` has never run outside a unit test, and the first real run raised a
 * question the tests cannot answer: on a segment with a known false merge, every cell came back
 * as one fragment. Two different things produce that picture — the model scoring the merge site
 * low, or the node never asking the per-point head because `Score cutoff` was empty — and the
 * card shows the same thing either way. This probe separates them by printing the numbers:
 *
 *   * every cell's `window_logit`, as a probability, sorted;
 *   * the cells nearest a coordinate the user names, with their distance from it;
 *   * the per-point head's **balance** in each of those cells — the share of the cell's own
 *     points on the minority side of the bipartition — which is what the node turns into `a`/`b`
 *     and which the node currently never shows unless a cutoff is set.
 *
 * A clean window's balance is meaningless by construction: `piece_loss` skips windows with no
 * masked points, so the head is untrained there. Printing it beside the score is the point —
 * if a high-scoring cell's balance is near zero the head found nothing to split either.
 *
 * ## Read-only, and one neuron
 *
 * Through Coda's own `CaveSource` with the token from `~/.cloudvolume/secrets`, so this is the
 * path the app takes. Nothing is written to any chunkedgraph (SEAM's invariant 7) and the default
 * is a single neuron (invariant 8).
 *
 * Usage: `pnpm dev --port 5178` in another terminal, then
 *   node scripts/probe-seam-merge.mjs --datastack wclee_aedes_brain --ids 648518347586074143 \
 *     --at 597152,333088,131625
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
const datastack = args.value('--datastack') ?? 'wclee_aedes_brain'
const ids = (args.value('--ids') ?? '648518347586074143').split(',')
const manifestUrl =
  args.value('--manifest') ??
  'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-a-d256-e80/manifest.json'
const limit = Number(args.value('--limit') ?? 0)
/** A point in nanometres the reader already suspects; cells are reported by distance from it. */
const at = (args.value('--at') ?? '')
  .split(',')
  .filter((part) => part !== '')
  .map(Number)
if (!Number.isFinite(limit) || (at.length !== 0 && (at.length !== 3 || at.some((n) => !Number.isFinite(n))))) {
  console.error('--limit must be a number and --at must be three numbers in nm, e.g. 1,2,3')
  process.exit(2)
}

/** Its own, and deleted on the way out: `handCaveToken` persists into this profile. */
const PROFILE = '/tmp/coda-seam-merge-profile'

const token = readCaveToken()
if (!token) {
  console.error('no CAVE token: set CAVE_TOKEN or put one in ~/.cloudvolume/secrets/cave-secret.json')
  process.exit(2)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9344, profile: PROFILE })
/* Registered before the token is handed over, so the `process.exit(2)` paths below are covered. */
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
  const [builtins, registry, windows, manifestMod, sessionMod, runMod, specMod, stackMod] =
    await Promise.all([
      load('/src/data/builtins.ts'),
      load('/src/data/source.ts'),
      load('/src/pyodide/seamWindows.ts'),
      load('/src/ml/manifest.ts'),
      load('/src/ml/session.ts'),
      load('/src/packs/seam/windowRun.ts'),
      load('/src/data/cave/spec.ts'),
      load('/src/data/cave/datastack.ts'),
    ])
  builtins.registerBuiltinSources()

  const loaded = await manifestMod.loadManifest(${JSON.stringify(manifestUrl)})
  const pre = loaded.manifest.config.preprocessing
  const source = registry.getSource('cave')

  // A datastack the shipped table does not name is hand-named, the way the Custom CAVE card
  // names one -- listDatasets only enumerates the shipped ones, so asking it for this
  // datastack answers "no such dataset" about a datastack that exists and the account can read.
  const name = ${JSON.stringify(datastack)}
  let datasetId = ${JSON.stringify(args.value('--version') ? datastack + ':' + args.value('--version') : '')}
  if (!datasetId) {
    if (!specMod.shippedSpecFor(undefined, name)) {
      specMod.registerDatastackSpec({ datastack: name, label: name, description: 'probe' })
    }
    // The dataset id carries a materialization and this probe is not told one: take the newest
    // the deployment lists rather than guessing a number.
    const versions = await stackMod.materializationsFor(name, {})
    if (versions.length === 0) return { error: 'no materializations for ' + name }
    datasetId = specMod.datasetIdFor(name, Math.max(...versions))
  }
  const dataset = { id: datasetId }

  const session = await sessionMod.openModel({
    manifestUrl: ${JSON.stringify(manifestUrl)},
    task: loaded.manifest.task,
  })

  const at = ${JSON.stringify(at)}
  const out = { model: loaded.manifest.id, dataset: dataset.id, preprocessing: pre, neurons: [] }
  try {
    for (const id of ${JSON.stringify(ids)}) {
      const meshes = await source.fetchMeshes({ datasetId: dataset.id, neuronIds: [id] })
      const item = meshes.items[0]
      if (!item) { out.neurons.push({ id, error: 'no mesh' }); continue }
      if (meshes.units !== 'nm') { out.neurons.push({ id, error: 'mesh in ' + meshes.units }); continue }
      const faces = item.indices.length / 3

      const built = await windows.runSeamWindows({
        positions: item.positions,
        indices: item.indices,
        radiusUm: pre.windowRadiusUm,
        spacingUm: pre.spacingUm,
        nPoints: pre.nPoints,
        useNormals: pre.features === 'normals',
        units: meshes.units,
        seed: 0,
        drawEvery: 1,
        limit: ${limit},
      })
      if (built.windows === 0) { out.neurons.push({ id, faces, error: 'no windows' }); continue }

      const scored = await runMod.scoreWindows(session, built.points, built.feats, built.windows, pre.nPoints)

      const cells = []
      for (let w = 0; w < built.windows; w++) {
        const centre = [built.centresNm[w * 3], built.centresNm[w * 3 + 1], built.centresNm[w * 3 + 2]]
        // The balance is over the cell's **own** points only, which is the set the node labels.
        let own = 0
        let positive = 0
        for (let p = 0; p < built.drawnPerWindow; p++) {
          if (!built.inOwnCell[w * built.drawnPerWindow + p]) continue
          own += 1
          if (scored.pointLogits[w * pre.nPoints + p] > 0) positive += 1
        }
        const share = own > 0 ? positive / own : null
        cells.push({
          cell: w,
          centre: centre.map((v) => Math.round(v)),
          score: +runMod.probability(scored.windowLogits[w]).toFixed(4),
          logit: +scored.windowLogits[w].toFixed(3),
          ownPoints: own,
          // 0 = every point on one side (no split found), 0.5 = an even cut.
          balance: share === null ? null : +Math.min(share, 1 - share).toFixed(3),
          distanceUm: at.length === 3
            ? +(Math.hypot(centre[0] - at[0], centre[1] - at[1], centre[2] - at[2]) / 1000).toFixed(2)
            : null,
        })
      }
      const scores = cells.map((c) => c.score).sort((a, b) => a - b)
      out.neurons.push({
        id,
        faces,
        windows: built.windows,
        cellUm: built.cellUm,
        scoreMin: scores[0],
        scoreMedian: scores[Math.floor(scores.length / 2)],
        scoreMax: scores[scores.length - 1],
        topByScore: [...cells].sort((a, b) => b.score - a.score).slice(0, 10),
        nearest: at.length === 3 ? [...cells].sort((a, b) => a.distanceUm - b.distanceUm).slice(0, 10) : [],
      })
    }
  } finally {
    await session.close()
  }
  return out
})()`

const got = await evaluate(script, 3_600_000)
console.log(JSON.stringify(got, null, 2))

report.check(!got.error, got.error ?? 'the datastack resolved to a dataset')
for (const n of got.neurons ?? []) {
  report.check(!n.error, `${n.id}: ${n.error ?? `${n.windows} cells from ${n.faces.toLocaleString()} faces`}`)
  if (n.error) continue
  report.check(
    n.scoreMax !== undefined,
    `${n.id}: scores ${n.scoreMin}–${n.scoreMax}, median ${n.scoreMedian}`,
  )
}
await close()
report.finish('is `pnpm dev --port 5178` running?')
