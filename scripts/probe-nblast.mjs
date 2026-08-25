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

import { bootPyodide, lcg, probeReport, readRepoFile, sources } from './lib/pyodideProbe.mjs'

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
  const next = lcg(7)
  const rand = () => next() - 0.5
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

/*
 * syNBLAST, which shares this file because it shares the module — and which is a different
 * shape of input rather than a variant of the same one. Where `coda_dotprops` takes a tree,
 * this takes clouds of connectors with a type per point, and the two things worth asserting
 * are the two a wrong answer would still satisfy on its own: a self-match of exactly 1, and a
 * pair of overlapping clouds outscoring a pair that are sixty micrometres apart. Either alone
 * passes on a matrix that is entirely constant.
 */
const synblast = py.globals.get('coda_synblast_run')
{
  // Three clouds: two on top of each other, one far away. Micrometres, as the bridge takes
  // them — the same conversion `synapseSetFrom` applies on the way in.
  const per = 40
  const centres = [
    [0, 0, 0],
    [0.2, 0, 0],
    [60, 60, 60],
  ]
  const points = new Float32Array(centres.length * per * 3)
  const types = new Int32Array(centres.length * per)
  const offsets = new Int32Array(centres.length + 1)
  const next = lcg(13)
  const rand = () => (next() - 0.5) * 4

  centres.forEach((centre, n) => {
    offsets[n + 1] = (n + 1) * per
    for (let i = 0; i < per; i++) {
      const at = (n * per + i) * 3
      points[at] = centre[0] + rand()
      points[at + 1] = centre[1] + rand()
      points[at + 2] = centre[2] + rand()
      // Alternating pre and post, so `by_type` has two groups to keep apart rather than one.
      types[n * per + i] = i % 2
    }
  })

  t = performance.now()
  const proxy = attempt('synblast: the call itself', () =>
    synblast({
      query: { points, types, offsets },
      byType: true,
      normalize: true,
      symmetry: 'mean',
    }),
  )
  if (proxy) {
    const out = proxy.toJs({ dict_converter: Object.fromEntries })
    proxy.destroy()
    const ms = performance.now() - t
    const at = (r, c) => out.scores[r * out.cols + c]
    console.log(
      `synblast 3 x ${per} pts    ${ms.toFixed(0)} ms   ${out.rows}x${out.cols}   ` +
        `near=${at(0, 1).toFixed(3)} far=${at(0, 2).toFixed(3)}`,
    )
    check('synblast: square over one set', out.rows === 3 && out.cols === 3)
    check('synblast: scores are flat float64', out.scores instanceof Float64Array)
    check('synblast: one score per pair', out.scores.length === out.rows * out.cols)
    check('synblast: every score is finite', out.scores.every(Number.isFinite))
    // Normalised, so a neuron against itself is exactly 1. The check that catches a matrix
    // handed over unnormalised, or transposed onto the wrong diagonal.
    check(
      'synblast: a neuron matches itself at 1',
      [0, 1, 2].every((i) => Math.abs(at(i, i) - 1) < 1e-6),
    )
    // The one that catches a scoring matrix fed the wrong units: at 60 um every pair is out
    // past the last distance bin and scores the same, so this comparison collapses.
    check('synblast: the overlapping pair beats the distant one', at(0, 1) > at(0, 2))
    check(
      'synblast: symmetry=mean is symmetric',
      [0, 1, 2].every((r) => [0, 1, 2].every((c) => Math.abs(at(r, c) - at(c, r)) < 1e-6)),
    )
  }
}
{
  // With a Target wired, which is a different fastcore call and a rectangular result.
  const per = 30
  const query = {
    points: new Float32Array(2 * per * 3),
    types: new Int32Array(2 * per),
    offsets: Int32Array.from([0, per, 2 * per]),
  }
  const next = lcg(5)
  const rand = () => (next() - 0.5) * 4
  for (let i = 0; i < 2 * per; i++) {
    query.points[i * 3] = rand() + (i < per ? 0 : 30)
    query.points[i * 3 + 1] = rand()
    query.points[i * 3 + 2] = rand()
  }
  const target = {
    points: query.points.slice(0, per * 3),
    types: query.types.slice(0, per),
    offsets: Int32Array.from([0, per]),
  }
  const proxy = attempt('synblast target: the call itself', () =>
    synblast({ query, target, byType: false, normalize: true, symmetry: 'none' }),
  )
  if (proxy) {
    const out = proxy.toJs({ dict_converter: Object.fromEntries })
    proxy.destroy()
    check('synblast target: the result is 2 x 1', out.rows === 2 && out.cols === 1)
    check('synblast target: the identical neuron scores best', out.scores[0] > out.scores[1])
  }
}
synblast.destroy()

run.destroy()
finish(py)
