#!/usr/bin/env node
/**
 * Run `src/pyodide/skeletons.py` against the real navis-fastcore wheel, in Node.
 *
 * `probe-linkage.mjs`'s sibling, and its own script for the same reason each capability has its
 * own `.py`: what it checks is one function's contract. vitest has no Pyodide and jsdom has no
 * `Worker`, so nothing in `pnpm test` executes a line of the file this runs.
 *
 *   node scripts/probe-skeletons.mjs         # needs `npm i pyodide` somewhere
 *   PYODIDE_PATH=/path/to/node_modules/pyodide node scripts/probe-skeletons.mjs
 *
 * **It asserts the contract, not the geometry.** fastcore owns the resampling; this owns the
 * marshalling and the one thing on top of it that Coda added — `_reindex`. That is the check
 * worth having, because a parent array that was not re-based onto row numbers **still draws**:
 * it is a neuron whose branches have been shuffled, with nothing anywhere to say so. So every
 * case below asserts that every parent is either `-1` or a valid index *into its own neuron*,
 * which is exactly what `SkeletonGeometry.parents` promises and the one property a wrong
 * answer cannot fake.
 *
 * The three shapes it runs are the three that behave differently: a plain chain, a Y (so a
 * branch point and two leaves have to survive the thinning), and a two-fragment forest (so
 * healing has something to join). A fourth, empty neuron rides along because the item count is
 * an invariant — the attribute table is index-aligned, so a set that came back one neuron
 * shorter would put every label after it on the wrong row.
 */

import { bootPyodide, loadModule, probeReport } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

await loadModule(py, 'src/pyodide/skeletons.py')

const { check, attempt, finish } = probeReport()

/** Nanometres, as Coda holds them — every distance below is in these units. */
const UM = 1000

/**
 * Four neurons flattened the way `cleanRequestFrom` flattens them.
 *
 * The forest is two fragments 9 µm apart, which is the number both healing cases turn on: no
 * limit joins them, a 1 µm limit must not.
 */
function fixture() {
  const shapes = [
    // A straight chain of 10, one micrometre apart.
    {
      xyz: Array.from({ length: 10 }, (_, i) => [i * UM, 0, 0]),
      parents: Array.from({ length: 10 }, (_, i) => i - 1),
    },
    // A Y: root, stem, two branches. Four topological landmarks that must always survive.
    {
      xyz: [
        [0, 0, 0],
        [UM, 0, 0],
        [2 * UM, 0, 0],
        [3 * UM, 0, 0],
        [2 * UM, UM, 0],
        [2 * UM, 2 * UM, 0],
      ],
      parents: [-1, 0, 1, 2, 1, 4],
    },
    // Two fragments, 9 µm apart.
    {
      xyz: [
        [0, 0, 0],
        [UM, 0, 0],
        [10 * UM, 0, 0],
        [11 * UM, 0, 0],
      ],
      parents: [-1, 0, -1, 2],
    },
    // Empty, deliberately. See the header.
    { xyz: [], parents: [] },
  ]

  const total = shapes.reduce((n, s) => n + s.parents.length, 0)
  const points = new Float32Array(total * 3)
  const parents = new Int32Array(total)
  const radii = new Float32Array(total).fill(50)
  const offsets = new Int32Array(shapes.length + 1)

  let at = 0
  shapes.forEach((shape, index) => {
    shape.xyz.forEach((p, i) => points.set(p, (at + i) * 3))
    parents.set(shape.parents, at)
    at += shape.parents.length
    offsets[index + 1] = at
  })
  return { points, parents, radii, offsets, counts: shapes.map((s) => s.parents.length) }
}

const DEFAULTS = {
  heal: false,
  healMaxDist: 0,
  smooth: 0,
  method: 'none',
  spacing: 0,
  factor: 2,
}

const run = py.globals.get('coda_clean_skeletons')

function clean(label, overrides) {
  const { points, parents, radii, offsets } = fixture()
  const notes = []
  const proxy = attempt(`${label}: the call itself`, () =>
    run({ points, parents, radii, offsets, ...DEFAULTS, ...overrides }, (f, note) =>
      notes.push(`${f.toFixed(2)} ${note ?? ''}`),
    ),
  )
  if (!proxy) return undefined
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()

  /*
   * The three lengths and the four parent arrays. Every one of these is a failure that would
   * otherwise reach a viewer as a picture rather than as an error.
   */
  check(`${label}: points are float32`, out.points instanceof Float32Array)
  check(`${label}: parents are int32, not int64`, out.parents instanceof Int32Array)
  check(`${label}: radii are float32`, out.radii instanceof Float32Array)
  check(`${label}: offsets still describe 4 neurons`, out.offsets.length === 5)
  check(
    `${label}: points, parents and radii describe one set of nodes`,
    out.points.length === out.parents.length * 3 && out.radii.length === out.parents.length,
  )

  let valid = true
  for (let n = 0; n + 1 < out.offsets.length; n++) {
    const from = out.offsets[n]
    const to = out.offsets[n + 1]
    for (let i = from; i < to; i++) {
      const parent = out.parents[i]
      if (parent < -1 || parent >= to - from) valid = false
    }
  }
  // The one Coda added on top of fastcore, and the one that fails silently.
  check(`${label}: every parent is -1 or an index into its own neuron`, valid)
  check(`${label}: the empty neuron stayed empty`, out.offsets[4] === out.offsets[3])
  check(`${label}: progress was reported`, notes.length > 0)
  return out
}

/** Nodes per neuron, from the offsets. */
const counts = (out) => Array.from(out.offsets).slice(1).map((v, i) => v - out.offsets[i])

{
  const out = clean('pass-through', {})
  if (out) {
    check('pass-through: nothing was added or dropped', String(counts(out)) === '10,6,4,0')
    const { points } = fixture()
    check(
      'pass-through: no coordinate moved',
      out.points.every((v, i) => Math.abs(v - points[i]) < 1e-3),
    )
  }
}

{
  const out = clean('heal', { heal: true })
  if (out) {
    let roots = 0
    for (let i = out.offsets[2]; i < out.offsets[3]; i++) if (out.parents[i] === -1) roots += 1
    check('heal: the forest came back as one rooted tree', roots === 1)
    check('heal: the node count is unchanged', String(counts(out)) === '10,6,4,0')
  }
}

{
  const out = clean('heal, 1 µm limit', { heal: true, healMaxDist: 1 * UM })
  if (out) {
    let roots = 0
    for (let i = out.offsets[2]; i < out.offsets[3]; i++) if (out.parents[i] === -1) roots += 1
    // The gap is 9 µm. A limit that let this through would be a limit doing nothing.
    check('heal, 1 µm limit: the 9 µm gap was left unbridged', roots === 2)
  }
}

{
  const out = clean('smooth', { smooth: 2 * UM })
  if (out) {
    check('smooth: the node count is unchanged', String(counts(out)) === '10,6,4,0')
    const { parents } = fixture()
    let same = true
    for (let i = 0; i < out.parents.length; i++) if (out.parents[i] !== parents[i]) same = false
    check('smooth: the topology is unchanged', same)
  }
}

{
  const out = clean('resample 0.5 µm', { method: 'resample', spacing: 0.5 * UM })
  if (out) {
    const [chain, y] = counts(out)
    check('resample: the chain gained nodes at half the spacing', chain > 10)
    check('resample: the Y did too', y > 6)
    // A uniform radius must interpolate to the same uniform radius. This is the cheapest check
    // that `source`/`alpha` were read the way fastcore's docstring prescribes: read the wrong
    // way round, or off the wrong column, and a neuron comes back with radii that are not 50.
    check(
      'resample: a uniform radius interpolates to itself',
      out.radii.every((r) => Math.abs(r - 50) < 1e-3),
    )
  }
}

{
  const out = clean('downsample x4', { method: 'downsample', factor: 4 })
  if (out) {
    const [chain, y] = counts(out)
    check('downsample: the chain lost nodes', chain < 10)
    // Root, branch point and two leaves. fastcore promises these survive any factor, and it is
    // what makes the result still the same neuron rather than a shorter one.
    check('downsample: the Y kept its four landmarks', y >= 4)
    check('downsample: radii came along', out.radii.every((r) => Math.abs(r - 50) < 1e-3))
  }
}

{
  // All three together, which is the order the node applies and the one case where a stale
  // `parents` from an earlier step would reach the next one.
  const out = clean('heal + smooth + resample', {
    heal: true,
    smooth: 1.5 * UM,
    method: 'resample',
    spacing: 0.75 * UM,
  })
  if (out) check('composed: something came back', out.parents.length > 0)
}

run.destroy()
finish(py)
