#!/usr/bin/env node
/**
 * One open end's candidates, ranked — against SEAM's own answer for the same end.
 *
 *   pnpm probe:candidate-search          # needs `npm i pyodide` somewhere, and a CAVE token
 *   PYODIDE_PATH=/path/to/pyodide pnpm probe:candidate-search
 *
 * **This is the check the whole phase rests on.** Stages 4 and 5 are three vendored steps — the
 * cutout summary, the eight features, the logistic score — and every way of getting them wrong
 * produces a *plausible* ranked list. A feature computed slightly differently still ranks; a
 * ranker handed the wrong column order still ranks; and sorting the rank key the wrong way round
 * gives the list exactly reversed, with every number believable. So the only honest test is
 * SEAM's own `geo_rank` for a real end, which is what `__fixtures__/searchEnd.json` holds.
 *
 * It fetches rather than mocks, for the same reason: the supervoxels and their roots are what
 * the features are computed from, and a synthetic box would check the arithmetic against itself.
 * Both reads are cached under `CODA_PROBE_DIR` so a re-run asks nothing — the chunkedgraph call
 * is ~14,000 supervoxels at a shared public server (SEAM's invariant 8).
 *
 * Reads only. Nothing here writes to CAVE.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootPyodide, probeReport, readRepoFile } from './lib/pyodideProbe.mjs'
import { readCaveToken } from './lib/browserProbe.mjs'

const report = probeReport()
const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-candidate-search')
mkdirSync(WORK, { recursive: true })

const golden = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/searchEnd.json'))
const fixture = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/fixture.json'))
const ranker = fixture.pipeline.search.geometric_ranker
/** `roots_at: snapshot - 1 ms`, which is the instant the published search asked about. */
const AT_MS = Date.parse(fixture.snapshot.replace(' ', 'T')) - 1

const BUCKET = 'https://storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain'
const CHUNKEDGRAPH =
  'https://cave.fanc-fly.com/segmentation/api/v1/table/wclee_aedes_brain/roots_binary'

/*
 * **The box comes from `probe:volume`'s own golden, not from arithmetic here.**
 *
 * `aedesCutout.json` is the same end, the same half-width and the same scale, and its `lo`,
 * `hi` and `chunk_names` were produced by `boxAround`/`chunksCovering` and are checked against
 * them in a browser by `pnpm probe:volume`. A second copy of that arithmetic here drifted
 * immediately — it wrote each chunk's end as `start + chunkSize` where the reader clamps to the
 * volume's own end, which is interior-only and so invisible, and `volume.ts`'s header calls out
 * as one of its three silent failures. Reading the golden makes `probe:volume` the one thing
 * that keeps the addressing honest for both.
 */
const cutout = JSON.parse(readRepoFile('src/data/precomputed/__fixtures__/aedesCutout.json'))
const SCALE = { key: cutout.scale, res: [32, 32, 45] }
const { lo, hi } = cutout

report.check(
  'the search golden and the cutout golden are the same end',
  cutout.centre_nm.every((nm, i) => nm === golden.endNm[i]),
)

async function fetchChunks() {
  const names = cutout.chunk_names
  for (const name of names) {
    const at = join(WORK, `${name}.bin`)
    if (existsSync(at)) continue
    const answer = await fetch(`${BUCKET}/${SCALE.key}/${name}`)
    if (!answer.ok) throw new Error(`${name}: ${answer.status}`)
    writeFileSync(at, Buffer.from(await answer.arrayBuffer()))
  }
  return names
}

console.log(`One end of ${golden.neuron} at ${golden.endNm.join(', ')} nm.`)
const names = await fetchChunks()
console.log(`${names.length} chunks (cached in ${WORK}).`)

// ── Decode and factor the box, with the reference decoder ───────────────────────────────────
const boxFile = join(WORK, 'box.json')
if (!existsSync(boxFile)) {
  const script = `
import numpy as np, glob, re, json, sys
from compressed_segmentation import decompress
lo, hi = ${JSON.stringify(lo)}, ${JSON.stringify(hi)}
size = [h - l for l, h in zip(lo, hi)]
box = np.zeros(size, dtype=np.uint64, order='F')
for f in sorted(glob.glob(${JSON.stringify(join(WORK, '*.bin'))})):
    x0, x1, y0, y1, z0, z1 = map(int, re.search(r'(\\d+)-(\\d+)_(\\d+)-(\\d+)_(\\d+)-(\\d+)', f).groups())
    a = np.asarray(decompress(open(f, 'rb').read(), volume_size=(x1-x0, y1-y0, z1-z0),
                              dtype=np.uint64, block_size=(8, 8, 8), order='F'))
    sx0, sy0, sz0 = max(lo[0], x0), max(lo[1], y0), max(lo[2], z0)
    sx1, sy1, sz1 = min(hi[0], x1), min(hi[1], y1), min(hi[2], z1)
    box[sx0-lo[0]:sx1-lo[0], sy0-lo[1]:sy1-lo[1], sz0-lo[2]:sz1-lo[2]] = \\
        a[sx0-x0:sx1-x0, sy0-y0:sy1-y0, sz0-z0:sz1-z0]
uniq, inv = np.unique(box, return_inverse=True)
json.dump({'labels': [str(int(v)) for v in uniq],
           'index': inv.ravel(order='F').astype(np.uint32).tolist(),
           'size': size}, open(${JSON.stringify(boxFile)}, 'w'))
`
  writeFileSync(join(WORK, 'box.py'), script)
  execFileSync(process.env.CODA_PYTHON ?? 'python3', ['-I', join(WORK, 'box.py')], {
    stdio: 'inherit',
  })
}
const box = JSON.parse(readFileSync(boxFile, 'utf8'))
console.log(`box ${box.size.join('×')}, ${box.labels.length} distinct supervoxels`)
/*
 * Against the golden's own counts. If the segmentation is rebuilt this fails here, naming the
 * box — rather than fifty lines later as a ranking that does not match, which reads as the
 * ranker being wrong.
 */
report.check(
  `${box.labels.length} supervoxels, against the cutout golden's ${cutout.distinct_labels}`,
  box.labels.length === cutout.distinct_labels,
)

// ── Their roots at the snapshot, from the chunkedgraph ──────────────────────────────────────
// Keyed on the instant: `AT_MS` comes from the fixture's snapshot, and a stale cache from
// another moment would otherwise be reused in silence.
const rootsFile = join(WORK, `roots-${AT_MS}.json`)
if (!existsSync(rootsFile)) {
  const token = readCaveToken()
  if (!token) {
    console.error('no CAVE token: set CAVE_TOKEN or put one in ~/.cloudvolume/secrets/cave-secret.json')
    process.exit(2)
  }
  /*
   * `roots_binary` — what `caveclient.chunkedgraph.get_roots` calls, and what `cavePostBinary`
   * calls in the app. uint64 both ways, so no id is ever a double (invariant 8).
   *
   * **One request where the app sends two.** `rootIds.ts` batches at `CHUNK = 10_000` and this
   * box holds ~14,400 supervoxels, so the app crosses a batch boundary here and this does not —
   * the one place an ordering bug could enter the roots array is therefore untested. Said rather
   * than papered over: batching here would test this script's own loop, not the app's.
   */
  const body = new BigUint64Array(box.labels.map(BigInt))
  const answer = await fetch(`${CHUNKEDGRAPH}?timestamp=${AT_MS / 1000}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body,
  })
  if (!answer.ok) throw new Error(`chunkedgraph: ${answer.status} ${await answer.text()}`)
  const roots = new BigUint64Array(await answer.arrayBuffer())
  writeFileSync(rootsFile, JSON.stringify([...roots].map(String)))
}
const roots = JSON.parse(readFileSync(rootsFile, 'utf8'))
report.check(`${roots.length} roots for ${box.labels.length} supervoxels`, roots.length === box.labels.length)
report.check('the query root is in the box', roots.includes(golden.queryRoot))

// ── The search, through the bridge ──────────────────────────────────────────────────────────
const py = await bootPyodide()
await py.loadPackage(['numpy', 'scipy', 'pandas'], { messageCallback: () => {} })
py.FS.mkdirTree('/vendored')
for (const name of ['cutout', 'candidates']) {
  py.FS.writeFile(`/vendored/${name}.py`, readRepoFile(`src/pyodide/seam/${name}.py`))
}
py.FS.writeFile('/vendored/bridge.py', readRepoFile('src/pyodide/cutoutSummary.py'))
py.globals.set(
  '__vendored__',
  py.toPy({
    'seam.cutout': readRepoFile('src/pyodide/seam/cutout.py'),
    'seam.candidates': readRepoFile('src/pyodide/seam/candidates.py'),
  }),
)
await py.runPythonAsync(`
import types, sys
module = types.ModuleType('bridge')
module.__dict__['__vendored__'] = __vendored__
exec(open('/vendored/bridge.py').read(), module.__dict__)
sys.modules['bridge'] = module
`)

/** The request as `runCandidateSearch` builds one. Rebuilt per call: the box is transferred. */
const requestFor = () => ({
  labels: BigUint64Array.from(box.labels.map(BigInt)),
  index: Uint32Array.from(box.index),
  size: box.size,
  roots: BigUint64Array.from(roots.map(BigInt)),
  queryRoot: BigInt(golden.queryRoot),
  resolutionNm: SCALE.res,
  loVoxels: lo,
  endNm: golden.endNm,
  ranker,
  topK: 100,
})

py.globals.set('__request__', requestFor())

const search = async () => {
  const proxy = await py.runPythonAsync(
    `import sys; sys.modules['bridge'].coda_candidate_search(__request__)`,
  )
  const answer = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  return answer
}

const got = await search()
/*
 * **Twice, because the first call is not the price.** `started` is taken before `_seam`, which
 * `exec`s both vendored sources, and `summarize_cutout`'s first statement is `from scipy import
 * ndimage` — so scipy's and pandas' first imports are inside the measured `ms`. That is paid
 * once per worker, not per open end, and reporting it as the per-end cost overstates it about
 * fourfold. `probe:cutout-summary` is arranged the same way and says so.
 *
 * The second call transfers the box again, so the request is rebuilt: `callPython` and
 * `py.globals.set` both hand the buffer to Python, and the first call's is spent.
 */
py.globals.set('__request__', requestFor())
const warm = await search()

console.log(
  `\n${got.rows} candidates ranked: ${got.ms} ms cold, **${warm.ms} ms warm**. The warm figure ` +
    `is the per-end price; the difference is scipy's and pandas' first imports, once per worker.`,
)
report.check(`${got.rows} candidates, against SEAM's ${golden.rows}`, got.rows === golden.rows)
report.check('the ids cross as uint64', got.candRoot instanceof BigUint64Array)

/*
 * The ranking, in order. `geo_score` is a rank **key** — lower is better — so a list sorted the
 * other way is exactly reversed with every number plausible, which is the failure this exists to
 * catch and which no count or score distribution would show.
 */
const mine = [...got.candRoot].map(String)
const theirs = golden.top.map((one) => one.cand_root)
const firstWrong = theirs.findIndex((root, at) => mine[at] !== root)
report.check(
  firstWrong < 0
    ? `the top ${theirs.length} candidates are SEAM's, in SEAM's order`
    : `rank ${firstWrong + 1} is ${mine[firstWrong]}, SEAM's is ${theirs[firstWrong]}`,
  firstWrong < 0,
)

const scores = got.geo_score
const off = golden.top.flatMap((one, at) =>
  Math.abs(scores[at] - one.geo_score) < 1e-4 ? [] : [{ ...one, got: scores[at] }],
)
report.check(
  off.length === 0
    ? `every geo_score matches SEAM's to 1e-4 (top ${golden.top.length})`
    : `${off.length} scores differ, e.g. rank ${off[0].geo_rank}: ${off[0].got} against ${off[0].geo_score}`,
  off.length === 0,
)
const dists = got.min_dist_um
report.check(
  'min_dist_um matches SEAM’s for the top candidate',
  Math.abs(dists[0] - golden.top[0].min_dist_um) < 1e-5,
)

/*
 * **The negative control, run rather than described** — and it corrected the story it was
 * written to illustrate.
 *
 * `geo_score` is a rank key, `-score`, sorted ascending. The plausible mistake is to publish the
 * raw logit and sort *that* descending — but those two orderings are **identical**, so that
 * mistake does not reverse anything: it gets every rank right and publishes every score with the
 * wrong sign. The `geo_score` comparison above is what catches it, not the order comparison.
 *
 * What genuinely reverses the list is sorting the rank key the *wrong* way, and that is what
 * this runs: worst-first, every number still plausible. Both failures are real and they are
 * caught by different checks, which is why the probe makes both comparisons.
 */
py.globals.set('__request__', requestFor())
const reversed = JSON.parse(
  (
    await py.runPythonAsync(`
import json, sys, numpy as np
bridge = sys.modules['bridge']
seam = bridge._seam(dict(bridge.__vendored__))
cut, cand = seam['seam.cutout'], seam['seam.candidates']
req = __request__.to_py()
end = np.asarray(req['endNm'], dtype=np.float64)
inv, query = bridge._box(req)
frame = cut.summarize_cutout(
    np.asarray(req['labels'], dtype=np.uint64), inv,
    np.asarray(req['roots'], dtype=np.uint64), query,
    np.asarray(req['resolutionNm'], dtype=np.float64),
    np.asarray(req['loVoxels'], dtype=np.int64), **cand.summary_args(end))
pool = cand.pool_features(frame, query, end)
r = cand.GeometricRanker(features=list(req['ranker']['features']), mu=list(req['ranker']['mu']),
                         sd=list(req['ranker']['sd']), w=list(req['ranker']['w']),
                         b=float(req['ranker']['b']))
# The rank key, sorted the wrong way: worst first. This is the reversal.
wrong = pool.assign(s=r.rank_key(pool)).sort_values('s', ascending=False).head(100)
json.dumps([str(int(v)) for v in wrong['root'].to_numpy()[:5]])
`)
  ).toString(),
)
report.check(
  `sorting the rank key the wrong way puts ${reversed[0]} first, not SEAM's ${theirs[0]} — so ` +
    'the order comparison above can fail',
  reversed[0] !== theirs[0],
)

report.finish(py)
