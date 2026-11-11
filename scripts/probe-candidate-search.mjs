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

import { bootPyodide, installBridge, probeReport, readRepoFile } from './lib/pyodideProbe.mjs'
import { rootsAt } from './lib/browserProbe.mjs'

const report = probeReport()
const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-candidate-search')
mkdirSync(WORK, { recursive: true })

const golden = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/searchEnd.json'))
const fixture = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/fixture.json'))
const ranker = fixture.pipeline.search.geometric_ranker
/** `roots_at: snapshot - 1 ms`, which is the instant the published search asked about. */
const AT_MS = Date.parse(fixture.snapshot.replace(' ', 'T')) - 1

const BUCKET = 'https://storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain'

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
const roots = [
  ...(await rootsAt(
    BigUint64Array.from(box.labels.map(BigInt)),
    AT_MS,
    join(WORK, `roots-${AT_MS}.json`),
  )),
].map(String)
report.check(`${roots.length} roots for ${box.labels.length} supervoxels`, roots.length === box.labels.length)
report.check('the query root is in the box', roots.includes(golden.queryRoot))

// ── The search, through the bridge ──────────────────────────────────────────────────────────
const py = await bootPyodide()
await py.loadPackage(['numpy', 'scipy', 'pandas'], { messageCallback: () => {} })
const call = await installBridge(py, {
  bridge: 'src/pyodide/cutoutSummary.py',
  vendored: {
    'seam.cutout': 'src/pyodide/seam/cutout.py',
    'seam.candidates': 'src/pyodide/seam/candidates.py',
  },
})

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

const search = () => call('coda_candidate_search', requestFor())

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

/*
 * One comparison, used by every column below.
 *
 * A helper rather than a fourth copy, because the second copy had already drifted: of the two
 * comparisons here before this change, `geo_score` read all twenty rows and `min_dist_um` read
 * **row 0**, so nineteen rows of it were never compared to anything. Each column still brings
 * its own tolerance — a score, a distance in micrometres and a position in nanometres are not
 * comparable at one number — but the walk, the count and the sentence are now in one place.
 *
 * The column is named once and read once: `got[name]`, so the name in the message cannot come
 * to disagree with the array actually walked, which is the other way the copies could have lied.
 */
const sameColumn = (name, theirs, tol, unit = '') => {
  const ours = got[name]
  if (!ours) {
    // The result passes SEAM's own column names through, so a rename upstream lands here. As a
    // bare property access it would throw before `report.finish`, losing every other check's
    // verdict and naming an index rather than the column that went missing.
    report.check(`the result has no "${name}" column — SEAM renamed or dropped it`, false)
    return
  }
  const off = golden.top.flatMap((one, at) =>
    Math.abs(ours[at] - theirs(one)) <= tol
      ? []
      : [{ rank: one.geo_rank, ours: ours[at], theirs: theirs(one) }],
  )
  report.check(
    off.length === 0
      ? `every ${name} matches SEAM's to ${tol}${unit} (top ${golden.top.length})`
      : `${off.length} ${name} differ, e.g. rank ${off[0].rank}: ${off[0].ours} against ${off[0].theirs}`,
    off.length === 0,
  )
}

sameColumn('geo_score', (one) => one.geo_score, 1e-4)
sameColumn('min_dist_um', (one) => one.min_dist_um, 1e-5, ' µm')

/*
 * **The contact point, not just the distance** — because the own-tip rule is measured entirely
 * from it (`src/packs/seam/ownTip.ts`), and it is the one output of the summary that a wrong
 * axis order or a wrong voxel origin moves without moving any *distance*. A box read z-fastest
 * and summarised happily puts every contact somewhere else in the volume while `min_dist_um`,
 * `vol_um3` and the whole ranking stay exactly as they are — so it is checked per axis, which
 * is also what makes a swap say which way round it went.
 */
for (const [axis, name] of ['x', 'y', 'z'].entries()) {
  sameColumn(`contact_${name}_nm`, (one) => one.contact_nm[axis], 1e-6, ' nm')
}

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
