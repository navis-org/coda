#!/usr/bin/env node
/**
 * Run `src/pyodide/nblast.py` against the real navis-fastcore wheel, in Node.
 *
 * The browser half of this feature (a module worker, a CDN import, `postMessage`) is exactly
 * the class of thing jsdom cannot see, and the Python half is not covered by the suite at all
 * — vitest has no Pyodide. This script is the other half of that admission: it executes the
 * same file the worker executes, calls it the same way, and times it, so a change to the
 * Python can be checked by somebody rather than by nobody.
 *
 *   node scripts/probe-nblast.mjs            # needs `npm i pyodide` somewhere
 *   PYODIDE_PATH=/path/to/node_modules/pyodide node scripts/probe-nblast.mjs
 *
 * Pyodide is deliberately *not* a dependency of this project: the app loads it from a CDN at
 * run time and nothing in the bundle imports it. So this script asks for it and says how to
 * get it rather than assuming it is there — the same skip-with-a-notice `check-export.py` uses.
 * Finding it, booting it and counting failures are shared with `probe-linkage.mjs` in
 * `lib/pyodideProbe.mjs`; what stays here is the request shapes and the assertions.
 */

import { bootPyodide, probeReport, readRepoFile, sources } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

let t = performance.now()
await py.loadPackage('numpy', { messageCallback: () => {} })
console.log(`numpy                ${(performance.now() - t).toFixed(0)} ms`)

t = performance.now()
await py.loadPackage(sources.fastcoreWheel, { messageCallback: () => {} })
console.log(`navis-fastcore       ${(performance.now() - t).toFixed(0)} ms`)

t = performance.now()
py.runPython(readRepoFile('src/pyodide/nblast.py'))
console.log(`nblast.py            ${(performance.now() - t).toFixed(0)} ms`)

// A synthetic neuron set in micrometres: a random walk per neuron, laid end to end exactly
// as `dotpropSetFrom` lays real skeletons out.
function neurons(count, points) {
  const xyz = new Float32Array(count * points * 3)
  const parents = new Int32Array(count * points)
  const offsets = new Int32Array(count + 1)
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5)
  for (let n = 0; n < count; n++) {
    const base = n * points
    offsets[n + 1] = base + points
    for (let i = 0; i < points; i++) {
      const at = (base + i) * 3
      xyz[at] = (i ? xyz[at - 3] : 0) + rand()
      xyz[at + 1] = (i ? xyz[at - 2] : 0) + rand()
      xyz[at + 2] = (i ? xyz[at - 1] : 0) + rand()
      parents[base + i] = i === 0 ? -1 : i - 1
    }
  }
  return { points: xyz, parents, offsets }
}

const { check, attempt, finish } = probeReport()

const run = py.globals.get('coda_nblast_run')

for (const [count, points] of [
  [4, 200],
  [50, 1000],
  [100, 1000],
]) {
  const set = neurons(count, points)
  const notes = []
  t = performance.now()
  const proxy = attempt(`${count}: the call itself`, () =>
    run(
      { query: set, k: 5, resample: 1, normalize: true, symmetry: 'mean', useAlpha: false },
      (f, note) => notes.push(`${f.toFixed(2)} ${note ?? ''}`),
    ),
  )
  if (!proxy) continue
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  const ms = performance.now() - t

  const { scores, rows, cols } = out
  console.log(
    `N=${String(count).padStart(3)} x ${points} pts   ${ms.toFixed(0)} ms   ` +
      `${rows}x${cols}   self=${scores[0].toFixed(3)}   other=${scores[1].toFixed(3)}`,
  )
  // The contract, not the numbers: fastcore owns the scores, this owns the marshalling.
  check(`${count}: square result`, rows === count && cols === count)
  check(`${count}: flat float64 out`, scores instanceof Float64Array)
  check(`${count}: one score per pair`, scores.length === count * count)
  check(`${count}: every score finite`, scores.every(Number.isFinite))
  // Normalised, so a neuron against itself is 1. Anything else means the units, the
  // resampling or the marshalling has gone wrong upstream of the algorithm.
  check(`${count}: self-match is 1`, Math.abs(scores[0] - 1) < 1e-6)
  check(`${count}: progress reported`, notes.length > 0)
}

// The k-NN entry point, whose contract differs in the two ways that matter: the arrays come
// back rectangular and padded, and `idx` has to arrive as int32 rather than as the int64
// numpy holds it in — which would cross as a BigInt64Array and compare equal to nothing.
const knn = py.globals.get('coda_nblast_knn_run')
{
  const count = 40
  const set = neurons(count, 800)
  const k = 5
  t = performance.now()
  const proxy = attempt('knn: the call itself', () =>
    knn(
      {
        query: set,
        k,
        nCandidates: 200,
        tangentK: 5,
        resample: 1,
        normalize: true,
        symmetry: 'mean',
        useAlpha: false,
      },
      undefined,
    ),
  )
  if (proxy) {
    const out = proxy.toJs({ dict_converter: Object.fromEntries })
    proxy.destroy()
    const ms = performance.now() - t
    console.log(
      `k-NN N=${count} x 800 pts   ${ms.toFixed(0)} ms   ${out.rows}x${out.k}   ` +
        `best=${out.scores[0].toFixed(3)}`,
    )
    check('knn: rows and k as asked', out.rows === count && out.k === k)
    check('knn: idx is int32, not int64', out.idx instanceof Int32Array)
    check('knn: scores are flat float64', out.scores instanceof Float64Array)
    check('knn: one entry per (neuron, match)', out.idx.length === count * k)
    // All-by-all excludes a neuron from its own row, so no index may equal its row.
    check(
      'knn: no neuron is its own neighbour',
      out.idx.every((target, at) => target !== Math.floor(at / k)),
    )
    // Descending within a row, which is what makes `rank` mean anything.
    check(
      'knn: each row descends',
      out.scores.every((score, at) => at % k === 0 || score <= out.scores[at - 1]),
    )
  }
}
knn.destroy()

run.destroy()
finish(py)
