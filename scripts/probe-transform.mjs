#!/usr/bin/env node
/**
 * Run `src/pyodide/warp.py` against the real navis-fastcore wheel and the real landmark files.
 *
 * vitest has no Pyodide and jsdom has no `Worker`, so nothing in `pnpm test` executes a line of
 * that file. This is the other half of that admission — same shape as `probe-nblast.mjs`, same
 * shared harness — and it exists to check two different kinds of thing:
 *
 * - **The contract.** A thin-plate spline interpolates its own landmarks exactly, so
 *   `xform(source)` must reproduce `target`. That one assertion catches a mis-parsed CSV, a
 *   column read in the wrong order, a unit conversion applied twice, and coefficients restored
 *   into the wrong slot — all of which otherwise produce a neuron that draws.
 * - **The marshalling**, which is what the bridge's own comments say keeps biting: a flat
 *   float32 array out, a length that matches what went in, and the fitted-transform cache
 *   actually hitting rather than silently re-fitting.
 *
 * And it **times the fit**, because that number is the whole reason `warp.ts` has three layers
 * of cache in it and the only one that could make the design wrong.
 *
 *   node scripts/probe-transform.mjs            # needs `npm i pyodide` somewhere
 *   PYODIDE_PATH=/path/to/node_modules/pyodide node scripts/probe-transform.mjs
 *
 * Pyodide is deliberately not a dependency of this project: the app loads it from a CDN at run
 * time and nothing in the bundle imports it. So this asks for it and says how to get it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { bootPyodide, probeReport, readRepoFile, root, sources } from './lib/pyodideProbe.mjs'

const MANIFEST = JSON.parse(readRepoFile('src/data/transforms/manifest.json'))

/** Read one of our own landmark CSVs, the way `landmarks.ts` does — and to nanometres. */
function readLandmarks(spec) {
  const text = readFileSync(join(root, 'public/transforms', spec.file), 'utf8')
  const lines = text.trim().split('\n')
  const header = lines[0].split(',').map((name) => name.trim())
  const si = spec.sourceColumns.map((name) => header.indexOf(name))
  const ti = spec.targetColumns.map((name) => header.indexOf(name))
  const scale = (units) => (units === 'um' ? 1000 : 1)
  const sScale = scale(spec.sourceUnits)
  const tScale = scale(spec.targetUnits)

  const count = lines.length - 1
  const source = new Float64Array(count * 3)
  const target = new Float64Array(count * 3)
  for (let row = 0; row < count; row++) {
    const fields = lines[row + 1].split(',')
    for (let axis = 0; axis < 3; axis++) {
      source[row * 3 + axis] = Number(fields[si[axis]]) * sScale
      target[row * 3 + axis] = Number(fields[ti[axis]]) * tScale
    }
  }
  return { source, target, count }
}

const py = await bootPyodide()

let t = performance.now()
await py.loadPackage('numpy', { messageCallback: () => {} })
console.log(`numpy                ${(performance.now() - t).toFixed(0)} ms`)

t = performance.now()
await py.loadPackage(sources.fastcoreWheel, { messageCallback: () => {} })
console.log(`navis-fastcore       ${(performance.now() - t).toFixed(0)} ms`)

t = performance.now()
py.runPython(readRepoFile('src/pyodide/warp.py'))
console.log(`warp.py              ${(performance.now() - t).toFixed(0)} ms`)

const { check, attempt, finish } = probeReport()
const fit = py.globals.get('coda_warp_fit')
const apply = py.globals.get('coda_warp_apply')

/** Every landmark set the manifest names, both kinds. */
const SETS = MANIFEST.spaces.flatMap((space) => [space.mirror, space.toCommon].filter(Boolean))

console.log('')
console.log('set                              M      fit   from_coefs      apply     pts/s   lm err')

for (const spec of SETS) {
  const pairs = readLandmarks(spec)
  const key = spec.file

  // 1. Fit, and keep the coefficients — this is the four seconds `warp.ts` exists to spend once.
  const fitted = attempt(`${key}: fit`, () =>
    fit({ key, source: pairs.source.slice(), target: pairs.target.slice() }).toJs({
      dict_converter: Object.fromEntries,
    }),
  )
  if (!fitted) continue

  check(
    `${key}: weights are a flat Float32Array of M x 3`,
    fitted.weights instanceof Float32Array && fitted.weights.length === pairs.count * 3,
  )
  check(
    `${key}: affine is a flat Float32Array of 4 x 3`,
    fitted.affine instanceof Float32Array && fitted.affine.length === 12,
  )
  check(`${key}: reports the landmark count the manifest does`, fitted.landmarks === spec.landmarks)

  /*
   * 2. The contract. A TPS interpolates its landmarks exactly, so pushing the source side
   * through must reproduce the target side. Run under a *fresh key* with the coefficients
   * supplied — so this checks `from_coefs` as well, which is the path every session after the
   * first takes and the one nothing else exercises.
   */
  const restored = `${key}#restored`
  const applied = attempt(`${key}: apply via from_coefs`, () =>
    apply({
      key: restored,
      source: pairs.source.slice(),
      coefficients: { weights: fitted.weights.slice(), affine: fitted.affine.slice() },
      points: Float32Array.from(pairs.source),
    }).toJs({ dict_converter: Object.fromEntries }),
  )
  if (!applied) continue

  check(
    `${key}: returns a flat Float32Array, one point per point in`,
    applied.positions instanceof Float32Array && applied.positions.length === pairs.count * 3,
  )
  check(`${key}: counts what it was given`, applied.count === pairs.count)
  check(`${key}: restoring coefficients costs no fit`, applied.fitMs === 0)

  let worst = 0
  for (let i = 0; i < applied.positions.length; i++) {
    worst = Math.max(worst, Math.abs(applied.positions[i] - pairs.target[i]))
  }
  /*
   * A landmark maps to its partner. The tolerance is float32's, not the spline's: coordinates
   * run to 1e6 nm, where a float32 step is 0.0625 nm, and the coefficients themselves were
   * narrowed to float32 on the way through the store. Anything above this is a real error —
   * a column read in the wrong order lands kilometres out, not fractions of a nanometre.
   */
  check(`${key}: reproduces its own landmarks (worst ${worst.toExponential(1)} nm)`, worst < 1)

  // 3. The session cache. Same key again, no coefficients: it must not re-fit.
  const cached = attempt(`${key}: session cache`, () =>
    apply({ key: restored, source: pairs.source.slice(), points: new Float32Array([0, 0, 0]) }).toJs(
      { dict_converter: Object.fromEntries },
    ),
  )
  check(`${key}: a second call re-fits nothing`, cached?.fitMs === 0)

  // 4. Timings, on a set the size a real run uses.
  const points = new Float32Array(100_000 * 3)
  for (let i = 0; i < points.length; i++) points[i] = pairs.source[i % pairs.source.length]
  const timed = attempt(`${key}: 100k points`, () =>
    apply({ key: restored, source: pairs.source.slice(), points }).toJs({
      dict_converter: Object.fromEntries,
    }),
  )

  const coefs = attempt(`${key}: from_coefs timing`, () =>
    fit({
      key: `${key}#timing`,
      source: pairs.source.slice(),
      coefficients: { weights: fitted.weights.slice(), affine: fitted.affine.slice() },
    }).toJs({ dict_converter: Object.fromEntries }),
  )

  console.log(
    `${key.replace('.csv', '').padEnd(30)} ${String(pairs.count).padStart(5)} ` +
      `${fitted.fitMs.toFixed(0).padStart(7)}ms ${(coefs?.fitMs ?? 0).toFixed(1).padStart(9)}ms ` +
      `${(timed?.applyMs ?? 0).toFixed(0).padStart(8)}ms ` +
      `${Math.round(100_000 / ((timed?.applyMs ?? 1) / 1000))
        .toLocaleString()
        .padStart(9)} ${worst.toExponential(1).padStart(8)}`,
  )
}

/*
 * The one thing progress reporting can get wrong invisibly: a bar that never moves. Chunking is
 * free here — every point's cost is independent — so unlike NBLAST there is no excuse for it.
 */
const seen = []
const first = SETS[0]
if (first) {
  const pairs = readLandmarks(first)
  const many = new Float32Array(60_000 * 3)
  for (let i = 0; i < many.length; i++) many[i] = pairs.source[i % pairs.source.length]
  attempt('progress is reported', () =>
    apply(
      { key: `${first.file}#restored`, source: pairs.source.slice(), points: many },
      (fraction) => seen.push(fraction),
    ).toJs({ dict_converter: Object.fromEntries }),
  )
  check(`progress moves in steps (${seen.length} reports)`, seen.length >= 3)
  check('progress ends at 1', seen.length > 0 && Math.abs(seen[seen.length - 1] - 1) < 1e-9)
}

fit.destroy()
apply.destroy()
finish(py)
