#!/usr/bin/env node
/**
 * Run `src/pyodide/linkage.py` against the real navis-fastcore wheel, in Node.
 *
 * The sibling of `probe-nblast.mjs`, and its own script for the same reason each capability
 * has its own `.py`: what it checks is one function's contract. Finding Pyodide, booting it and
 * counting failures are the same job for both and live in `lib/pyodideProbe.mjs`. vitest has no Pyodide and
 * jsdom has no `Worker`, so nothing in `pnpm test` executes a line of the file this runs.
 *
 *   node scripts/probe-linkage.mjs           # needs `npm i pyodide` somewhere
 *   PYODIDE_PATH=/path/to/node_modules/pyodide node scripts/probe-linkage.mjs
 *
 * **It asserts the contract, not the numbers.** fastcore owns the clustering; this owns the
 * marshalling — a flat float64 `merges` of the right length, an `order` that arrives as int32
 * rather than as the int64 numpy holds it in, and a leaf order that is a real permutation.
 *
 * The one number it does check is the *structure* of a planted answer: two obvious pairs must
 * come out as two merges below a third, whatever the method. That is the cheapest test that
 * would catch a matrix handed over transposed, unsymmetrised, or as similarities where
 * distances were meant — none of which fails, and all of which produce a tree.
 */

import { bootPyodide, lcg, loadModule, probeReport } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

await loadModule(py, 'src/pyodide/linkage.py')

const { check, attempt, finish } = probeReport()

/**
 * A score matrix with `groups` planted blocks, laid out row-major exactly as a `MatrixValue`
 * is. Deliberately **asymmetric** — real NBLAST is — so a run that ignored `symmetry` would
 * still produce a tree, and a wrong one.
 */
function blocked(n, groups) {
  const scores = new Float64Array(n * n)
  const rand = lcg(11)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const same = r % groups === c % groups
      scores[r * n + c] = r === c ? 1 : (same ? 0.7 : 0.1) + rand() * 0.12
    }
  }
  return scores
}

const run = py.globals.get('coda_linkage_run')

for (const [n, method] of [
  [8, 'ward'],
  [64, 'average'],
  [400, 'complete'],
  [400, 'single'],
]) {
  const notes = []
  const t = performance.now()
  const proxy = attempt(`${method} n=${n}: the call itself`, () =>
    run(
      {
        scores: blocked(n, 4),
        n,
        method,
        symmetry: 'mean',
        transform: 'one_minus',
      },
      (f, note) => notes.push(`${f.toFixed(2)} ${note ?? ''}`),
    ),
  )
  if (!proxy) continue
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  const ms = performance.now() - t

  const { merges, count, order } = out
  const heights = Array.from({ length: count }, (_, i) => merges[i * 4 + 2])
  console.log(
    `${method.padEnd(9)} n=${String(n).padStart(3)}   ${ms.toFixed(0)} ms   ` +
      `${count} merges   top=${heights[count - 1].toFixed(3)}`,
  )

  check(`${method} n=${n}: one merge fewer than observations`, count === n - 1)
  check(`${method} n=${n}: merges are flat float64`, merges instanceof Float64Array)
  check(`${method} n=${n}: four numbers per merge`, merges.length === (n - 1) * 4)
  // int64 crosses as a BigInt64Array, which converts without complaint and then compares
  // equal to nothing on the JavaScript side.
  check(`${method} n=${n}: order is int32, not int64`, order instanceof Int32Array)
  check(`${method} n=${n}: order is a permutation`, new Set(order).size === n && order.length === n)
  check(
    `${method} n=${n}: every height finite and non-negative`,
    heights.every((h) => Number.isFinite(h) && h >= 0),
  )
  // The five methods Coda offers all guarantee this, and the cut in `linkageOps.ts` is a
  // prefix of the rows precisely because of it. A method that inverted would break that.
  check(
    `${method} n=${n}: heights ascend`,
    heights.every((h, i) => i === 0 || h >= heights[i - 1] - 1e-12),
  )
  // Cluster ids: observations are 0..n-1 and merge i is n + i, so nothing may reference a
  // cluster that does not exist yet.
  check(
    `${method} n=${n}: no merge references a later cluster`,
    Array.from({ length: count }).every(
      (_, i) => merges[i * 4] < n + i && merges[i * 4 + 1] < n + i,
    ),
  )
  check(`${method} n=${n}: sizes sum to the tree`, merges[(count - 1) * 4 + 3] === n)
  check(`${method} n=${n}: progress reported`, notes.length > 0)
}

// The planted structure, which is what catches a matrix that arrived transposed or unconverted.
{
  const n = 8
  const proxy = attempt('planted: the call itself', () =>
    run({ scores: blocked(n, 2), n, method: 'average', symmetry: 'mean', transform: 'one_minus' }),
  )
  if (proxy) {
    const { merges, count, order } = proxy.toJs({ dict_converter: Object.fromEntries })
    proxy.destroy()
    // Two planted groups: even indices and odd. Cutting into two by undoing the last merge
    // must recover exactly that, or the distances went in the wrong way round.
    const parent = new Int32Array(2 * n - 1).map((_, i) => i)
    const find = (a) => {
      let x = a
      while (parent[x] !== x) x = parent[x] = parent[parent[x]]
      return x
    }
    for (let i = 0; i < count - 1; i++) {
      parent[find(merges[i * 4])] = n + i
      parent[find(merges[i * 4 + 1])] = n + i
    }
    const groups = new Map()
    for (let i = 0; i < n; i++) {
      const root = find(i)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(i % 2)
    }
    console.log(`planted   n=${n}   two groups recovered as ${[...groups.values()].map((g) => g.length).join(' + ')}`)
    check('planted: exactly two groups', groups.size === 2)
    check(
      'planted: each group is one parity, i.e. the blocks came back',
      [...groups.values()].every((g) => new Set(g).size === 1),
    )
    check('planted: leaf order keeps each group contiguous', (() => {
      const parity = Array.from(order, (o) => o % 2)
      return parity.filter((p, i) => i > 0 && p !== parity[i - 1]).length === 1
    })())
  }
}

run.destroy()
finish(py)
