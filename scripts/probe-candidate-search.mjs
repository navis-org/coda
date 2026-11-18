#!/usr/bin/env node
/**
 * One open end's candidates, ranked — against SEAM's own answer for the same end.
 *
 *   pnpm probe:candidate-search          # needs `npm i pyodide` somewhere, and a CAVE token
 *   PYODIDE_PATH=/path/to/pyodide pnpm probe:candidate-search
 *
 * **This is the check the whole phase rests on.** Every way of getting stages 4 and 5 wrong
 * produces a *plausible* ranked list. A feature computed slightly differently still ranks; a
 * ranker handed the wrong column order still ranks; and sorting the rank key the wrong way round
 * gives the list exactly reversed, with every number believable. So the only honest test is
 * SEAM's own `geo_rank` for a real end, which is what `__fixtures__/searchEnd.json` holds.
 *
 * ## The parts it drives
 *
 * Since SEAM moved to a forest ranker the search is no longer one crossing of the bridge, and
 * this runs all of it: `coda_candidate_pool` for the measured pool, `l2ChunkCounts` for the
 * level-2 counts two of the eleven features read, `coda_pool_sizes` for those two columns, and
 * `rankPool` for the score, the sort, the cut and the numbering. `cutoutSummary.ts`' header says
 * why that cannot be collapsed back into one call.
 *
 * ## And the own-tip rule, which is the part that moved
 *
 * SEAM's published lists are now **post-own-tip**. On `rv2-0d62bc912a89` this end's
 * `candidates_all.parquet` row group held 100 candidates and the rule then removed 86 of them
 * (54 too far, 32 nearer another tip); on `rv2-20483049f936` it holds 9, and the rule as re-run
 * over them removes none — every list in `ownTipNeuron.json` now comes back `tooFar: 0`,
 * `anothersTip: 0`. So Coda, which reconstructs the pool from the box and therefore sees the
 * *pre*-rule population, has to apply the rule itself before it is looking at the same list.
 * `searchEnd.json`'s `how` line records this, and `make_search.py` writes it.
 *
 * It fetches rather than mocks, for the same reason: the supervoxels and their roots are what
 * the features are computed from, and a synthetic box would check the arithmetic against itself.
 * Every read is cached under `CODA_PROBE_DIR` so a re-run asks nothing — the chunkedgraph call
 * is ~14,000 supervoxels at a shared public server (SEAM's invariant 8).
 *
 * Reads only. Nothing here writes to CAVE.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseGrapheneSource } from '../src/data/cave/graphene.ts'
import { l2ChunkCounts } from '../src/data/cave/rootIds.ts'
import { countsInPoolOrder, searchEnds } from '../src/packs/seam/searchRun.ts'
import { rankKeys, treeRankerFor } from '../src/packs/seam/treeRanker.ts'
import { orderByScores } from '../src/nodes/lib/matrixShape.ts'
import { float64Columns } from '../src/pyodide/types.ts'
import { bootPyodide, installBridge, probeReport, readRepoFile } from './lib/pyodideProbe.mjs'
import {
  AEDES_DEPLOYMENT,
  AEDES_SEGMENTATION,
  requireCaveToken,
  rootsAt,
} from './lib/browserProbe.mjs'

const report = probeReport()
const WORK = join(process.env.CODA_PROBE_DIR ?? '/tmp', 'coda-candidate-search')
mkdirSync(WORK, { recursive: true })

const golden = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/searchEnd.json'))
const fixture = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/fixture.json'))
const ownGolden = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/ownTipNeuron.json'))

/*
 * The forest, from the set's own model file. The 1.3 MB of LightGBM text is vendored into
 * `__fixtures__/rankerModel.txt` so this probe can run offline; `features` comes from the
 * manifest beside it, never from a copy here.
 *
 * `features` comes from the manifest beside it and is part of `treeRankerFor`'s key, because the
 * parse refuses a model whose feature count is not the set's and a memo on the path alone would
 * hand back a forest fitted on a different eleven.
 */
const spec = fixture.pipeline.search.ranker
if (!spec?.features) {
  report.check('the set publishes a tree ranker at `pipeline.search.ranker`', false)
  console.error('\nNothing was checked: this probe drives the forest, and the set has none.')
  process.exit(1)
}
const ranker = treeRankerFor(
  spec.model_file,
  readRepoFile('src/packs/seam/__fixtures__/rankerModel.txt'),
  spec.features,
)
const TOP_K = fixture.pipeline.search.top_k
const OWN_UM = fixture.pipeline.own_tip.own_um
console.log(`${ranker.trees.length} trees on ${ranker.features.length} features, top_k ${TOP_K}.`)

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
    // The organelle flag's measure, which the pool call has run since 2026-11-17.
    'seam.enclosure': 'src/pyodide/seam/enclosure.py',
  },
})

/** The request as `runCandidatePool` builds one. Rebuilt per call: the box is transferred. */
const requestFor = () => ({
  labels: BigUint64Array.from(box.labels.map(BigInt)),
  index: Uint32Array.from(box.index),
  size: box.size,
  roots: BigUint64Array.from(roots.map(BigInt)),
  queryRoot: BigInt(golden.queryRoot),
  resolutionNm: SCALE.res,
  loVoxels: lo,
  endNm: golden.endNm,
})

const search = () => call('coda_candidate_pool', requestFor())

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
  `\n${got.rows} candidates measured: ${got.ms} ms cold, **${warm.ms} ms warm**. The warm figure ` +
    `is the per-end price; the difference is scipy's and pandas' first imports, once per worker.`,
)
report.check('the ids cross as uint64', got.candRoot instanceof BigUint64Array)
/*
 * The pool crosses **unranked**, which is the whole point of the three-part split. A `geo_rank`
 * arriving here would mean the worker still ranks, and `rankPool` would then renumber a list the
 * old ranker had already chosen — a hundred believable rows drawn from the wrong population.
 */
// `call` hands back the raw Python dict, flat — so this reads the column directly.
report.check('the pool arrives unranked, as the bridge no longer scores', got.geo_rank === undefined)

// ── The level-2 chunk counts, cached on disk ────────────────────────────────────────────────
/*
 * **The app's `l2ChunkCounts`, not a second implementation.** This probe had its own batched
 * `leaves_many` loop, which meant the one part of the search that is app code was the one part
 * the probe did not exercise — and it has no other caller yet, so nothing ran it against the
 * real server at all. Calling it keeps the batch size, the absent-not-zero rule and the named
 * 404 in one place.
 *
 * The disk cache is the probe's, and it is additive: only roots the file is missing are asked
 * for. A root names a fixed state of the graph, so this cache needs no instant in its key and
 * never goes stale. **Absence is recorded as `null`**, because
 * `l2ChunkCounts` drops a root the graph does not list from its *answer* (keeping it in its own
 * memo instead) — so writing only what came back would re-ask for exactly those roots on every
 * run, for ever, against a shared public server.
 */
const countsFile = join(WORK, 'l2-counts.json')
const cached = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {}
const counts = async (roots) => {
  const missing = roots.filter((root) => cached[root] === undefined)
  if (missing.length > 0) {
    const fetched = await l2ChunkCounts(parseGrapheneSource(AEDES_SEGMENTATION), missing, {
      deployment: AEDES_DEPLOYMENT,
      token: requireCaveToken(),
    })
    for (const root of missing) cached[root] = fetched.get(root) ?? null
    writeFileSync(countsFile, JSON.stringify(cached))
  }
  return new Map(roots.flatMap((root) => (cached[root] === null ? [] : [[root, cached[root]]])))
}

/** The counts for a pool, positionally — `countsInPoolOrder` is the app's own join. */
const countsFor = async (candRoot) =>
  countsInPoolOrder(candRoot, await counts([...candRoot].map(String)))

// ── The search, as `searchEnds` sequences it ────────────────────────────────────────────────
/*
 * **The probe drives the app's sequence; it does not define one.** The order of the parts, the
 * rule running after the cut, and the positional join of the counts are all facts that fail
 * silently, so they live in `packs/seam/searchRun.ts` where a unit test can reach them — and
 * this probe passes its own bridge calls in, because `callPython` needs a Worker it has no way
 * to give. What is checked here is that the sequence agrees with SEAM on real data.
 */
const tipsNm = Float32Array.from(ownGolden.tipsNm.flat())
const tipOf = ownGolden.endUids.indexOf(golden.end_uid)
report.check(`the search end is tip ${tipOf} of the neuron`, tipOf >= 0)
if (tipOf < 0) {
  // Stop here rather than hand -1 to `ownTipRule`, which refuses it — and would throw before
  // `report.finish`, losing the verdict of every check that has already run.
  report.finish(py)
}

/*
 * `searchEnds` yields one end at a time now, so the node can publish each as it lands — the
 * generator is the shape, not an array. One end here, so one `for await`.
 */
let found
for await (const end of searchEnds(
  tipsNm,
  [{ tip: tipOf, queryRoot: BigInt(golden.queryRoot), box: async () => requestFor() }],
  { ranker, topK: TOP_K, ownUm: OWN_UM },
  {
    measure: async (request) => {
      const raw = await call('coda_candidate_pool', request)
      // `float64Columns` is the bridge's own rule — measurements are float64, ids are uint64,
      // told apart by dtype and never by a name list. Inline here it had lost exactly that.
      return { ...raw, columns: float64Columns(raw) }
    },
    sizes: (request) => call('coda_pool_sizes', request),
    counts,
  },
)) {
  found = end
}
if (!found) {
  report.check('the search answered for the end', false)
  report.finish(py)
}

console.log(
  `${found.pooled} in the pool, cut at ${TOP_K}, and the own-tip rule keeps ${found.rows} ` +
    `(${found.tooFar} too far, ${found.anothersTip} nearer another tip).`,
)
const mine = [...found.candRoot].map(String)
report.check(`${mine.length} candidates, against SEAM's ${golden.rows}`, mine.length === golden.rows)

/*
 * The ranking, in order. `geo_score` is a rank **key** — lower is better — so a list sorted the
 * other way is exactly reversed with every number plausible, which is the failure this exists to
 * catch and which no count or score distribution would show.
 */
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
 * The column is named once and read once, so the name in the message cannot come to disagree
 * with the array actually walked, which is the other way the copies could have lied.
 */
const sameColumn = (name, theirValue, tol, unit = '') => {
  const ours = found.columns[name]
  if (!ours) {
    // The result passes SEAM's own column names through, so a rename upstream lands here. As a
    // bare property access it would throw before `report.finish`, losing every other check's
    // verdict and naming an index rather than the column that went missing.
    report.check(`the result has no "${name}" column — SEAM renamed or dropped it`, false)
    return
  }
  const off = golden.top.flatMap((one, at) =>
    Math.abs(ours[at] - theirValue(one)) <= tol
      ? []
      : [{ rank: one.geo_rank, ours: ours[at], theirs: theirValue(one) }],
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
 * raw score and sort *that* descending — but those two orderings are **identical**, so that
 * mistake does not reverse anything: it gets every rank right and publishes every score with the
 * wrong sign. The `geo_score` comparison above is what catches it, not the order comparison.
 *
 * What genuinely reverses the list is sorting the rank key the *wrong* way, and that is what
 * this runs: worst-first, every number still plausible. Both failures are real and they are
 * caught by different checks, which is why the probe makes both comparisons.
 *
 * In TypeScript now rather than in the worker, because the ranker is — and it is `rankKeys` on
 * the same pool rather than a second scorer, so the control differs from the real path in the
 * comparator alone. It reads the **whole** pool — `got`, the cold timing call, which is still
 * in hand — because `found` has had the losers cut away and the worst of them is what this
 * needs.
 */
const queryCount = (await counts([golden.queryRoot])).get(golden.queryRoot)
if (queryCount === undefined) {
  // Reported rather than sent: `float(None)` raises inside the worker, before `report.finish`,
  // which would lose the verdict of every check above.
  report.check(`the query root ${golden.queryRoot} has a level-2 chunk count`, false)
  report.finish(py)
}
const wholeSizes = await call('coda_pool_sizes', {
  candRoot: BigUint64Array.from(got.candRoot),
  candCount: await countsFor(got.candRoot),
  queryRoot: BigInt(golden.queryRoot),
  queryCount,
})
const keys = rankKeys(ranker, {
  rows: got.rows,
  columns: { ...float64Columns(got), l2c: wholeSizes.l2c, l2x: wholeSizes.l2x },
})
const worstFirst = orderByScores(keys, true)
report.check(
  `sorting the rank key the wrong way puts ${got.candRoot[worstFirst[0]]} first, not SEAM's ` +
    `${theirs[0]} — so the order comparison above can fail`,
  String(got.candRoot[worstFirst[0]]) !== theirs[0],
)

report.finish(py)
