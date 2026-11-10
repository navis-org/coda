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
    uniq, index, roots, query, res, lo,
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
      execFileSync(process.env.CODA_PYTHON ?? 'python3', ['-I', join(vendored, 'run.py')], {
        encoding: 'utf8',
      }),
    )
    console.log(`CPython: ${reference.rows} rows, ${reference.columns.length} columns`)
  } catch (error) {
    const said = `${error.stdout ?? ''}${error.stderr ?? ''}` || String(error)
    if (error.code === 'ENOENT') {
      console.log('CPython comparison skipped: no `python3` on PATH.')
    } else if (/ModuleNotFoundError|ImportError/.test(said)) {
      console.log(
        'CPython comparison skipped: this interpreter has no numpy/scipy/pandas. (The run uses ' +
          '`-I`, so a `--user` install is not visible — set CODA_PYTHON to one that has them.)',
      )
    } else {
      /*
       * **Not a skip.** This leg is the only thing that imports the cut file on its own, so it
       * is what notices a slice that left a module-level dependency behind upstream — which
       * surfaces as a `NameError` and would otherwise reach a browser. Reporting every failure
       * as "needs numpy" turned that into a green run with four checks quietly not made.
       */
      console.error(`\n  FAIL  the vendored slice does not run under CPython:\n${said}`)
      process.exit(1)
    }
  }
}

// ── Pyodide, through the vendored slice ─────────────────────────────────────────────────────
const py = await bootPyodide()
const startedLoad = performance.now()
// Silenced, as `loadModule` does: Pyodide prints a line per wheel, which buries a probe's own
// output. Not `loadModule` itself, because this probe installs its modules by hand to drive the
// vendored file and the bridge separately.
await py.loadPackage(['numpy', 'scipy', 'pandas'], { messageCallback: () => {} })
console.log(`numpy + scipy + pandas: ${Math.round(performance.now() - startedLoad)} ms`)

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
cutout.summarize_cutout(uniq, index, roots, query, res, lo)
out['edt_only_ms'] = round((time.perf_counter() - t) * 1000)
json.dumps(out)
`)
).toString()
const got = JSON.parse(wasm)

console.log(
  `\nPyodide: ${got.rows} rows, ${got.columns.length} columns, ` +
    `${got.ms} ms (the EDT and reduction alone ${got.edt_only_ms} ms)`,
)

report.check(`${got.rows} roots summarised`, got.rows > 0)
report.check(
  'every column the geometric ranker reads is present',
  got.columns.includes('min_dist_um') &&
    got.columns.includes('caliber_um') &&
    got.columns.includes('contact_x_nm'),
)
/*
 * The ranker's eight features come out of these. `caliber_um` is NaN where a root has fewer
 * than `MIN_LOCAL_VOXELS` near the point, which is ordinary — what must not happen is every
 * one being NaN, which is what a moments pass handed the wrong axis order produces.
 */
report.check(
  'the local moments resolved for at least some roots',
  got.caliber_um.some((one) => one !== null),
)

if (reference) {
  const same = (a, b) =>
    a.length === b.length &&
    a.every((one, i) => (one === null ? b[i] === null : Math.abs(one - b[i]) < 1e-6))
  report.check(`row counts agree (${got.rows})`, reference.rows === got.rows)
  report.check('min_dist_um agrees with CPython', same(reference.min_dist_um, got.min_dist_um))
  report.check(
    'contact_x_nm agrees with CPython — the axis order survived the crossing',
    same(reference.contact_x_nm, got.contact_x_nm),
  )
  report.check('caliber_um agrees with CPython', same(reference.caliber_um, got.caliber_um))
}

// ── The bridge Coda wrote, which is where the axis order is decided ─────────────────────────
/*
 * Above runs SEAM's code directly. This runs `coda_cutout_summary`, which is the part this
 * repository is responsible for: it takes the box in `readLabelBox`'s layout — x fastest, which
 * numpy reads as the *last* axis — and has to hand the vendored function the `(x, y, z)` order
 * it indexes `inv.shape` as. Everything but the worker, which vitest cannot reach either.
 */
py.FS.writeFile('/vendored/bridge.py', readRepoFile('src/pyodide/cutoutSummary.py'))

/*
 * **The request is built in JavaScript and handed over as a plain object**, which is the whole
 * point of this leg. The worker posts one and Pyodide proxies it, so the module has to
 * `request.to_py()` before it can read a key — and the first version of this probe built the
 * request as a Python dict inside `runPythonAsync`, which reads perfectly well without that
 * call. So the module shipped unable to read its own request, and the probe said nothing.
 * `probe-seam-windows-py.mjs` passes a plain JS object for exactly this reason and says so.
 */
const fixture = (
  await py.runPythonAsync(`
import json
json.dumps({
    'labels': [str(int(v)) for v in uniq],
    'roots': [str(int(v)) for v in roots],
    # order='F', and this is the whole point of the comparison below. readLabelBox writes
    # index[x + y*sx + z*sx*sy] -- x fastest -- which for an array shaped (x, y, z) is a Fortran
    # ravel, not a C one. A C ravel passes a box the bridge then un-transposes wrongly, and the
    # summary comes back with the same roots, the same counts and every contact point somewhere
    # else. The first version of this probe did exactly that and said nothing, because its
    # assertions were inert.
    'index': np.asfortranarray(index).ravel(order='F').tolist(),
    'size': [int(v) for v in shape],
    'queryRoot': str(int(query)),
    'resolutionNm': [float(v) for v in res],
    'loVoxels': [float(v) for v in lo],
    'pointNm': [float(v) for v in point],
})
`)
).toString()
const built = JSON.parse(fixture)

py.globals.set('__vendored__', py.toPy({ 'seam.cutout': readRepoFile('src/pyodide/seam/cutout.py') }))
await py.runPythonAsync(`
import types, sys
module = types.ModuleType('bridge')
module.__dict__['__vendored__'] = __vendored__
exec(open('/vendored/bridge.py').read(), module.__dict__)
sys.modules['bridge'] = module
`)

/**
 * The request exactly as `runCutoutSummary` builds one: typed arrays for the two big columns,
 * **plain arrays** for the small ones, a bigint for the query, and no Python anywhere. The small
 * ones are plain because `callPython` transfers every view, and a three-element typed array
 * would be detached on the caller's side for no saving — so sending them as typed arrays here
 * would exercise a shape the app does not use.
 */
const request = {
  labels: BigUint64Array.from(built.labels.map(BigInt)),
  index: Uint32Array.from(built.index),
  size: built.size,
  roots: BigUint64Array.from(built.roots.map(BigInt)),
  queryRoot: BigInt(built.queryRoot),
  resolutionNm: built.resolutionNm,
  loVoxels: built.loVoxels,
  pointNm: built.pointNm,
  touchUm: 0.5,
  momentsUm: 3.0,
}

/*
 * The result crosses back as **JavaScript**, not as JSON built inside Python. `root` and
 * `rep_svid` are the first uint64 arrays any module on this bridge returns and `missingQuery`
 * the first bool, so reading them through `json.dumps` would check Python's own values and say
 * nothing about what `runCutoutSummary` will actually receive.
 */
const callBridge = async (one) => {
  py.globals.set('__request__', one)
  const proxy = await py.runPythonAsync(
    `import sys; sys.modules['bridge'].coda_cutout_summary(__request__)`,
  )
  const result = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  return result
}

// Two calls: the module is already warm from the direct runs above, so both are warm numbers
// and the difference between them is noise, not warm-up. Priced accordingly below.
const bridged = await callBridge(request)
const again = await callBridge({ ...request, index: Uint32Array.from(built.index) })
bridged.warm_ms = again.ms

report.check(`the bridge returns the same ${bridged.rows} rows`, bridged.rows === got.rows)

/*
 * The id columns must still be 64-bit on the way out. A root through a float64 is a different
 * neuron and nothing downstream could tell (invariant 8), so this is checked on the dtype rather
 * than on a value that would look perfectly ordinary either way.
 */
report.check(
  `the id columns cross as ${bridged.root.constructor.name}`,
  bridged.root instanceof BigUint64Array && bridged.rep_svid instanceof BigUint64Array,
)
report.check('missingQuery crosses as a boolean', bridged.missingQuery === false)
/*
 * The check that can actually fail. `rep_svid` holds the fixture's 18-digit supervoxel ids, so
 * every value must be one of the ids that went in — a column that had been through a double
 * comes back near-miss, which is a different supervoxel and nothing downstream could tell.
 */
report.check(
  'every rep_svid is an id that went in, not a rounded near-miss',
  [...bridged.rep_svid].every((one) => built.labels.includes(one.toString())),
)
/*
 * And the transpose. If the bridge handed the box over in the wrong axis order the summary
 * would still come back — same roots, same counts, plausible distances — with every contact
 * point somewhere else. Comparing against the direct call is what catches it.
 */
report.check(
  'the bridge put the box the right way round (contact points match the direct call)',
  got.contact_x_nm.every((one, i) => Math.abs(bridged.contact_x_nm[i] - one) < 1e-4),
)
report.check(
  'min_dist_um matches the direct call',
  got.min_dist_um.every((one, i) => Math.abs(bridged.min_dist_um[i] - one) < 1e-6),
)

console.log(
  `\nOne cutout's features through the bridge: ${bridged.ms} and ${bridged.warm_ms} ms — both ` +
    `warm, since the direct calls above already paid scipy's and pandas' warm-up, and that is ` +
    `the number to price a search with (one cutout per open end, on top of the ~1.2 s the ` +
    `cutout itself takes to fetch). The first call in this process took ${got.ms} ms, which is ` +
    `the warm-up and is paid once per worker, not per end.`,
)
report.finish(py)
