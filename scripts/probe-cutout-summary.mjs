#!/usr/bin/env node
/**
 * `summarize_cutout` in Pyodide: that it runs at all, what it costs, and that it agrees with
 * CPython on the same input.
 *
 *   pnpm probe:cutout-summary          # needs `npm i pyodide` somewhere
 *   PYODIDE_PATH=/path/to/pyodide pnpm probe:cutout-summary
 *
 * **What the comparison actually compares.** It runs the *vendored slice* under CPython and
 * under Pyodide. That looks weaker than running SEAM's own file on one side, and is in fact the
 * stronger chain: `pnpm vendor:seam-cutout` already byte-compares the slice against
 * `negatives.py`, so slice == SEAM, and this says slice-in-CPython == slice-in-wasm. Together
 * they give what is wanted, without importing SEAM's package — whose `__init__` pulls in a
 * dependency chain that has nothing to do with these two functions.
 *
 * **Why this is a probe and not a test.** vitest has no Pyodide and no `Worker`, so nothing in
 * `pnpm test` executes a line of `cutoutSummary.py` or of the vendored file under it. What it
 * checks is the thing a unit test could not: that SEAM's own code, unedited, produces the same
 * numbers under wasm that it does under CPython — and the one Coda wrote around it hands the
 * box over the right way round.
 *
 * **The axis order is the point of the comparison.** `readLabelBox` writes x fastest, which
 * numpy reads as the last axis, while the vendored code indexes `inv.shape` as `(x, y, z)`
 * throughout. The bridge transposes, and a transposed cutout summarises perfectly happily: the
 * same roots, the same voxel counts, plausible distances, and every contact point somewhere
 * else. So the check is on `contact_*_nm` and `min_dist_um`, not on the row count.
 *
 * The box is synthetic and that is deliberate — it is built identically on both sides from one
 * seed, so any difference is the runtime rather than the data. Its *shape* is the measured
 * Aedes cutout (188x188x134, 14,424 supervoxels over 900 roots), so the timings are real.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootPyodide, probeReport, readRepoFile } from './lib/pyodideProbe.mjs'

const report = probeReport()

/** One seed, two runtimes — the box has to be built the same way on both sides. */
const BUILD = `
import numpy as np
shape = (188, 188, 134)
res = np.array([32.0, 32.0, 45.0])
lo = np.array([7723, 9692, 6077])
rng = np.random.default_rng(0)
n_sv = 14424
uniq = (np.arange(1, n_sv + 1, dtype=np.uint64) * np.uint64(1000)) + np.uint64(73889314911551537)
roots = (rng.integers(0, 900, n_sv) + 1).astype(np.uint64)
roots[0] = np.uint64(0)
index = rng.integers(0, n_sv, shape).astype(np.uint32)   # x fastest, as readLabelBox writes it
query = int(roots[5])
point = (lo + np.array(shape) // 2) * res
`

const SUMMARISE = `
frame = cutout.summarize_cutout(
    uniq, np.ascontiguousarray(index), roots, query, res, lo,
    centroids=True, point_nm=point, touch_um=0.5, moments_um=3.0,
)
out = {
    'rows': int(len(frame)),
    'min_dist_um': [round(float(v), 6) for v in frame['min_dist_um'].to_numpy()[:8]],
    'contact_x_nm': [round(float(v), 4) for v in frame['contact_x_nm'].to_numpy()[:8]],
    'caliber_um': [None if np.isnan(v) else round(float(v), 6)
                   for v in frame['caliber_um'].to_numpy()[:8]],
    'columns': list(frame.columns),
}
`

// ── CPython, through SEAM's own file ────────────────────────────────────────────────────────
let reference
{
  const vendored = '/tmp/coda-cutout-vendored'
  mkdirSync(vendored, { recursive: true })
  writeFileSync(join(vendored, 'cutout.py'), readRepoFile('src/pyodide/seam/cutout.py'))
  const script = `${BUILD}
import sys, json
sys.path.insert(0, ${JSON.stringify('/tmp/coda-cutout-vendored')})
import cutout
${SUMMARISE}
print(json.dumps(out))
`
  writeFileSync(join(vendored, 'run.py'), script)
  try {
    reference = JSON.parse(
      execFileSync('python3', ['-I', join(vendored, 'run.py')], { encoding: 'utf8' }),
    )
    console.log(`CPython: ${reference.rows} rows, ${reference.columns.length} columns`)
  } catch (error) {
    console.log(
      `CPython comparison unavailable (needs numpy, scipy and pandas): ` +
        `${String(error).split('\n')[0]}`,
    )
  }
}

// ── Pyodide, through the vendored slice ─────────────────────────────────────────────────────
const py = await bootPyodide()
let at = performance.now()
await py.loadPackage(['numpy', 'scipy', 'pandas'])
const loadMs = Math.round(performance.now() - at)
console.log(`numpy + scipy + pandas: ${loadMs} ms`)

py.FS.mkdirTree('/vendored')
py.FS.writeFile('/vendored/cutout.py', readRepoFile('src/pyodide/seam/cutout.py'))

const wasm = (
  await py.runPythonAsync(`
import sys, json, time
sys.path.insert(0, '/vendored')
import cutout
${BUILD}
t = time.perf_counter()
${SUMMARISE}
out['ms'] = round((time.perf_counter() - t) * 1000)

t = time.perf_counter()
cutout.summarize_cutout(uniq, np.ascontiguousarray(index), roots, query, res, lo)
out['edt_only_ms'] = round((time.perf_counter() - t) * 1000)
json.dumps(out)
`)
).toString()
const got = JSON.parse(wasm)

console.log(
  `\nPyodide: ${got.rows} rows, ${got.columns.length} columns, ` +
    `${got.ms} ms (the EDT and reduction alone ${got.edt_only_ms} ms)`,
)

report.check(got.rows > 0, `${got.rows} roots summarised`)
report.check(
  got.columns.includes('min_dist_um') &&
    got.columns.includes('caliber_um') &&
    got.columns.includes('contact_x_nm'),
  'every column the geometric ranker reads is present',
)
/*
 * The ranker's eight features come out of these. `caliber_um` is NaN where a root has fewer
 * than `MIN_LOCAL_VOXELS` near the point, which is ordinary — what must not happen is every
 * one being NaN, which is what a moments pass handed the wrong axis order produces.
 */
report.check(
  got.caliber_um.some((one) => one !== null),
  'the local moments resolved for at least some roots',
)

if (reference) {
  const same = (a, b) =>
    a.length === b.length &&
    a.every((one, i) => (one === null ? b[i] === null : Math.abs(one - b[i]) < 1e-6))
  report.check(reference.rows === got.rows, `row counts agree (${got.rows})`)
  report.check(same(reference.min_dist_um, got.min_dist_um), 'min_dist_um agrees with CPython')
  report.check(
    same(reference.contact_x_nm, got.contact_x_nm),
    'contact_x_nm agrees with CPython — the axis order survived the crossing',
  )
  report.check(same(reference.caliber_um, got.caliber_um), 'caliber_um agrees with CPython')
}

// ── The bridge Coda wrote, which is where the axis order is decided ─────────────────────────
/*
 * Above runs SEAM's code directly. This runs `coda_cutout_summary`, which is the part this
 * repository is responsible for: it takes the box in `readLabelBox`'s layout — x fastest, which
 * numpy reads as the *last* axis — and has to hand the vendored function the `(x, y, z)` order
 * it indexes `inv.shape` as. Everything but the worker, which vitest cannot reach either.
 */
py.FS.writeFile('/vendored/bridge.py', readRepoFile('src/pyodide/cutoutSummary.py'))
const bridged = JSON.parse(
  (
    await py.runPythonAsync(`
import json, types, sys
module = types.ModuleType('bridge')
module.__dict__['__vendored__'] = {'seam.cutout': open('/vendored/cutout.py').read()}
exec(open('/vendored/bridge.py').read(), module.__dict__)

# The same box, handed over the way the TypeScript wrapper hands it: flat, x fastest.
result = module.coda_cutout_summary({
    'labels': uniq,
    'index': np.ascontiguousarray(index).ravel(),
    'size': np.asarray(shape, dtype=np.int64),
    'roots': roots,
    'queryRoot': query,
    'resolutionNm': res,
    'loVoxels': lo.astype(np.float64),
    'pointNm': point,
    'touchUm': 0.5,
    'momentsUm': 3.0,
})
json.dumps({
    'rows': int(result['rows']),
    'missingQuery': bool(result['missingQuery']),
    'root_dtype': str(result['root'].dtype),
    'first_roots': [str(int(v)) for v in result['root'][:4]],
    'contact_x_nm': [round(float(v), 4) for v in result['contact_x_nm'][:8]],
    'min_dist_um': [round(float(v), 6) for v in result['min_dist_um'][:8]],
    'ms': int(result['ms']),
    # Again, warm. The first call in a worker pays scipy's and pandas' own warm-up, which a
    # search doing one cutout per open end pays once and not per end — so the second number is
    # the one to price a search with.
    'warm_ms': int(module.coda_cutout_summary({
        'labels': uniq, 'index': np.ascontiguousarray(index).ravel(),
        'size': np.asarray(shape, dtype=np.int64), 'roots': roots, 'queryRoot': query,
        'resolutionNm': res, 'loVoxels': lo.astype(np.float64), 'pointNm': point,
        'touchUm': 0.5, 'momentsUm': 3.0,
    })['ms']),
})
`)
  ).toString(),
)

report.check(bridged.rows === got.rows, `the bridge returns the same ${bridged.rows} rows`)
report.check(bridged.missingQuery === false, 'the query root was found in its own box')
/*
 * The id columns must still be 64-bit on the way out. A root through a float64 is a different
 * neuron and nothing downstream could tell (invariant 8), so this is checked on the dtype rather
 * than on a value that would look perfectly ordinary either way.
 */
report.check(bridged.root_dtype === 'uint64', `root comes back as ${bridged.root_dtype}`)
report.check(
  bridged.first_roots.every((one) => /^\d+$/.test(one) && one !== '0'),
  'the roots are whole ids, not rounded doubles',
)
/*
 * And the transpose. If the bridge handed the box over in the wrong axis order the summary
 * would still come back — same roots, same counts, plausible distances — with every contact
 * point somewhere else. Comparing against the direct call is what catches it.
 */
report.check(
  bridged.contact_x_nm.every((one, i) => Math.abs(one - got.contact_x_nm[i]) < 1e-4),
  'the bridge put the box the right way round (contact points match the direct call)',
)
report.check(
  bridged.min_dist_um.every((one, i) => Math.abs(one - got.min_dist_um[i]) < 1e-6),
  'min_dist_um matches the direct call',
)

console.log(
  `\nOne cutout's features through the bridge: ${bridged.ms} ms cold, ` +
    `**${bridged.warm_ms} ms warm** — the latter is what a search doing one cutout per open end ` +
    `pays per end, on top of the ~1.2 s the cutout itself takes to fetch. ` +
    `(The first call in this process, ${got.ms} ms, carries scipy's and pandas' warm-up.)`,
)
report.finish(py)
