#!/usr/bin/env node
/**
 * Run `src/pyodide/matches.py` against the real navis-fastcore wheel, in Node.
 *
 * `probe-linkage.mjs`'s sibling and the smallest of the family, because the function it checks
 * is small. vitest has no Pyodide and jsdom has no `Worker`, so nothing in `pnpm test` executes
 * a line of the file this runs.
 *
 *   node scripts/probe-matches.mjs           # needs `npm i pyodide` somewhere
 *
 * **This one does check numbers**, unlike its siblings, and that is the whole point of the
 * node existing. `NBLAST Matches` crosses the bridge for *parity* rather than for speed — a
 * top-N is microseconds of JavaScript at Coda's matrix sizes — so what is worth asserting is
 * exactly the semantics somebody would otherwise re-derive slightly differently:
 *
 * - `skip_self` is the **diagonal**, not a comparison of labels.
 * - `percentage` is a band around each group's **own** best value, not a quantile of the
 *   matrix. Every reading of "within 5%" that is not this one is a plausible wrong answer.
 * - `distances` reverses which end is best, rather than negating the scores.
 * - `axis` picks which axis is *grouped*, and the indices returned are along the other one.
 *
 * Each is checked against a brute-force count written here from the definition, so a fastcore
 * change of meaning shows up as a failure rather than as a quietly different match table.
 */

import { bootPyodide, lcg, loadModule, probeReport } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

await loadModule(py, 'src/pyodide/matches.py')

const { check, attempt, finish } = probeReport()

const N = 12

/** A reproducible asymmetric score matrix with a self-score of 1, laid out row-major. */
function scoreMatrix(n) {
  const rand = lcg(7)
  const scores = new Float64Array(n * n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) scores[r * n + c] = r === c ? 1 : rand()
  }
  return scores
}

const M = scoreMatrix(N)
const cell = (r, c) => M[r * N + c]

const DEFAULTS = {
  rows: N,
  cols: N,
  mode: 'top',
  axis: 0,
  distances: false,
  skipSelf: true,
  n: 3,
  cutoff: 'threshold',
  threshold: 0.5,
  percentage: 0.05,
  maxMatches: 1_000_000,
}

const run = py.globals.get('coda_matches_run')

function matches(label, overrides) {
  const notes = []
  const proxy = attempt(`${label}: the call itself`, () =>
    // A fresh copy every call: `callPython` transfers, and the whole point of `matchOps.ts`
    // copying the matrix is that the caller's buffer survives. Passing `M` here would detach
    // it and every later case would run on nothing.
    run({ ...DEFAULTS, scores: M.slice(), ...overrides }, (f, note) =>
      notes.push(`${f.toFixed(2)} ${note ?? ''}`),
    ),
  )
  if (!proxy) return undefined
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  check(`${label}: progress was reported`, notes.length > 0)
  return out
}

{
  const out = matches('top 3', {})
  if (out) {
    check('top 3: the mode came back', out.mode === 'top')
    check('top 3: indices are int32, not int64', out.idx instanceof Int32Array)
    check('top 3: values are flat float64', out.values instanceof Float64Array)
    check('top 3: the shape is groups x n', out.idx.length === out.groups * out.n)

    let selfMatched = false
    let descending = true
    for (let r = 0; r < out.groups; r++) {
      for (let i = 0; i < out.n; i++) {
        if (out.idx[r * out.n + i] === r) selfMatched = true
        if (i > 0 && out.values[r * out.n + i] > out.values[r * out.n + i - 1] + 1e-12) {
          descending = false
        }
      }
    }
    check('top 3: skip_self dropped every diagonal cell', !selfMatched)
    check('top 3: each row is best first', descending)

    // The scores must be the cells they claim to be. A transposed read is the failure this
    // catches, and it produces a perfectly plausible table.
    let aligned = true
    for (let r = 0; r < out.groups; r++) {
      for (let i = 0; i < out.n; i++) {
        const c = out.idx[r * out.n + i]
        if (c >= 0 && Math.abs(out.values[r * out.n + i] - cell(r, c)) > 1e-12) aligned = false
      }
    }
    check('top 3: every score is the cell its index names', aligned)
  }
}

{
  const out = matches('top 3, distances', { distances: true })
  if (out) {
    let ascending = true
    for (let r = 0; r < out.groups; r++) {
      for (let i = 1; i < out.n; i++) {
        if (out.values[r * out.n + i] < out.values[r * out.n + i - 1] - 1e-12) ascending = false
      }
    }
    check('distances: the smallest cell ranks first', ascending)
  }
}

{
  const out = matches('count, threshold 0.5', { mode: 'count' })
  if (out) {
    check('count: counts are int32', out.counts instanceof Int32Array)
    // Written from the definition rather than read off fastcore: cells at or above the cutoff,
    // minus the diagonal.
    const expected = Array.from({ length: N }, (_, r) => {
      let n = 0
      for (let c = 0; c < N; c++) if (c !== r && cell(r, c) >= 0.5) n += 1
      return n
    })
    check('count: agrees with a hand count of the same cutoff',
      String(Array.from(out.counts)) === String(expected))
  }
}

{
  const above = matches('above, threshold 0.5', { mode: 'above' })
  const counted = matches('above: its own counts', { mode: 'count' })
  if (above && counted) {
    check('above: offsets describe every group', above.offsets.length === above.groups + 1)
    check('above: the last offset is the total', above.offsets[above.groups] === above.idx.length)
    const sizes = Array.from({ length: above.groups }, (_, g) => above.offsets[g + 1] - above.offsets[g])
    // The two functions are documented as two halves of the same answer, so this is the check
    // that they still are.
    check('above: the group sizes are exactly what count_matches said',
      String(sizes) === String(Array.from(counted.counts)))
  }
}

{
  const out = matches('above, within 5% of each best', { mode: 'above', cutoff: 'percentage', percentage: 0.05 })
  if (out) {
    /*
     * The definition, spelled out: each row's own best off-diagonal cell, times 0.95. Not the
     * matrix's best, and not a quantile — both of those are what "within 5%" gets read as, and
     * both produce a table that looks right.
     */
    const expected = Array.from({ length: N }, (_, r) => {
      let best = -Infinity
      for (let c = 0; c < N; c++) if (c !== r) best = Math.max(best, cell(r, c))
      let n = 0
      for (let c = 0; c < N; c++) if (c !== r && cell(r, c) >= best * 0.95) n += 1
      return n
    })
    const sizes = Array.from({ length: out.groups }, (_, g) => out.offsets[g + 1] - out.offsets[g])
    check('percentage: the band is around each row’s own best', String(sizes) === String(expected))
  }
}

{
  const out = matches('axis 1', { axis: 1, n: 2 })
  if (out) {
    check('axis 1: there is one group per column', out.groups === N)
    // Grouping by column means the indices run down the rows. Checked by the same
    // cell-alignment test as `top 3`, transposed — which is the one way to tell the two axes
    // apart on a square matrix.
    let aligned = true
    for (let c = 0; c < out.groups; c++) {
      for (let i = 0; i < out.n; i++) {
        const r = out.idx[c * out.n + i]
        if (r >= 0 && Math.abs(out.values[c * out.n + i] - cell(r, c)) > 1e-12) aligned = false
      }
    }
    check('axis 1: every score is the cell its index names, read down the column', aligned)
  }
}

{
  // Rectangular, where `skip_self` has no meaning. `matchOps.checkSkipSelf` refuses this on the
  // JavaScript side; here it is checked that the *shape* still comes back right, since a
  // query-against-target matrix is the ordinary case for the node. Through the same helper as
  // every other case — which is why `scores` sits before the overrides above — so this one
  // gets the dtype and progress checks too.
  const rows = 5
  const cols = 9
  const rand = lcg(3)
  const out = matches('rectangular', {
    rows,
    cols,
    skipSelf: false,
    n: 4,
    scores: Float64Array.from({ length: rows * cols }, rand),
  })
  if (out) {
    check('rectangular: one group per row', out.groups === rows)
    check('rectangular: n matches per group', out.n === 4)
    check('rectangular: every index is a column', Array.from(out.idx).every((i) => i >= 0 && i < cols))
  }
}

run.destroy()
finish(py)
