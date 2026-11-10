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
 *
 * The second half runs `coda_simplify_skeletons` (Simplify Skeletons) on four shapes of its own,
 * each the case one of Coda's rules on top of `prune_twigs` is about: the soma survives, an
 * unbranched fragment is never pruned, and `repeat` catches the twig a first pass leaves behind.
 * fastcore's `mask` reads the opposite way from its docstring, and the soma check is what pins it.
 */

import { bootPyodide, loadModule, probeReport } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

await loadModule(py, 'src/pyodide/skeletons.py')

const { check, attempt, finish } = probeReport()

/** Nanometres, as Coda holds them — every distance below is in these units. */
const UM = 1000

/** Shapes flattened the way `skeletonPacking.ts` flattens them: points, parents, offsets. */
function pack(shapes) {
  const total = shapes.reduce((n, s) => n + s.parents.length, 0)
  const points = new Float32Array(total * 3)
  const parents = new Int32Array(total)
  const offsets = new Int32Array(shapes.length + 1)
  let at = 0
  shapes.forEach((shape, index) => {
    shape.xyz.forEach((p, i) => points.set(p, (at + i) * 3))
    parents.set(shape.parents, at)
    at += shape.parents.length
    offsets[index + 1] = at
  })
  return { points, parents, offsets, total }
}

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

  const { points, parents, offsets, total } = pack(shapes)
  const radii = new Float32Array(total).fill(50)
  // Compartments: the chain is dendrite (3) for its first five nodes and axon (2) after, so a
  // label that rides the wrong index map comes back mixed up; the rest are unlabelled.
  const compartments = new Uint8Array(total)
  for (let i = 0; i < 10; i++) compartments[i] = i < 5 ? 3 : 2
  return {
    points,
    parents,
    radii,
    compartments,
    offsets,
    counts: shapes.map((s) => s.parents.length),
  }
}

const DEFAULTS = {
  heal: false,
  healMethod: 'ALL',
  healMaxDist: 0,
  smooth: 0,
  method: 'none',
  spacing: 0,
  factor: 2,
}

const run = py.globals.get('coda_clean_skeletons')

/**
 * One call across the bridge: the request padded with the defaults, the proxy read and freed.
 *
 * Shared so that a field added to `CleanSkeletonsRequest` is added here once — `healMethod` was
 * the field that found this, having to be written into two request literals in this file.
 */
function callClean(label, request, notes = []) {
  const proxy = attempt(`${label}: the call itself`, () =>
    run({ ...DEFAULTS, ...request }, (f, note) => notes.push(`${f.toFixed(2)} ${note ?? ''}`)),
  )
  if (!proxy) return undefined
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  return out
}

function clean(label, overrides) {
  const { points, parents, radii, compartments, offsets } = fixture()
  const notes = []
  const out = callClean(
    label,
    {
      points,
      parents,
      radii,
      compartments,
      offsets,
      // No soma on any of them (`-1`), so a heal keeps the root fastcore picked.
      somas: new Int32Array(offsets.length - 1).fill(-1),
      ...overrides,
    },
    notes,
  )
  if (!out) return undefined

  /*
   * The three lengths and the four parent arrays. Every one of these is a failure that would
   * otherwise reach a viewer as a picture rather than as an error.
   */
  check(`${label}: points are float32`, out.points instanceof Float32Array)
  check(`${label}: parents are int32, not int64`, out.parents instanceof Int32Array)
  check(`${label}: radii are float32`, out.radii instanceof Float32Array)
  check(`${label}: compartments are uint8`, out.compartments instanceof Uint8Array)
  check(
    `${label}: one compartment per node`,
    out.compartments.length === out.parents.length,
  )
  /*
   * The chain's labels ride their points: dendrite (3) below x = 4 µm, axon (2) from 5 µm, whatever
   * was done — asked by *position*, since resampling emits the root and then walks back from the
   * tip. A new node midway between the two gets whichever end is nearer, so that band is not asked.
   */
  const chain = Array.from(out.compartments.slice(out.offsets[0], out.offsets[1])).map((c, i) => [
    out.points[(out.offsets[0] + i) * 3] / UM,
    c,
  ])
  check(
    `${label}: the chain's labels stay with their points`,
    chain.length > 0 &&
      chain.every(([x, c]) => (x < 4.2 ? c === 3 : x > 4.8 ? c === 2 : c === 2 || c === 3)),
  )
  check(
    `${label}: points, parents and radii describe one set of nodes`,
    out.points.length === out.parents.length * 3 && out.radii.length === out.parents.length,
  )
  checkTopology(label, out)
  check(`${label}: progress was reported`, notes.length > 0)
  return out
}

/**
 * The three properties every result must hold, whichever entry point made it: four neurons still,
 * every parent `-1` or an index into its own neuron — the one Coda added on top of fastcore, and
 * the one that fails silently — and the empty neuron still empty.
 */
function checkTopology(label, out) {
  check(`${label}: offsets still describe 4 neurons`, out.offsets.length === 5)
  let valid = true
  for (let n = 0; n + 1 < out.offsets.length; n++) {
    const from = out.offsets[n]
    const to = out.offsets[n + 1]
    for (let i = from; i < to; i++) {
      if (out.parents[i] < -1 || out.parents[i] >= to - from) valid = false
    }
  }
  check(`${label}: every parent is -1 or an index into its own neuron`, valid)
  check(`${label}: the empty neuron stayed empty`, out.offsets[4] === out.offsets[3])
}

/** Roots in one neuron's slice — what every healing case asks about. */
function rootsIn(out, neuron) {
  let roots = 0
  for (let i = out.offsets[neuron]; i < out.offsets[neuron + 1]; i++) {
    if (out.parents[i] === -1) roots += 1
  }
  return roots
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
    check('heal: the forest came back as one rooted tree', rootsIn(out, 2) === 1)
    check('heal: the node count is unchanged', String(counts(out)) === '10,6,4,0')
  }
}

{
  const out = clean('heal, 1 µm limit', { heal: true, healMaxDist: 1 * UM })
  if (out) {
    // The gap is 9 µm. A limit that let this through would be a limit doing nothing.
    check('heal, 1 µm limit: the 9 µm gap was left unbridged', rootsIn(out, 2) === 2)
  }
}

/*
 * `Bridge from`, which the shared fixture cannot show: its two fragments meet leaf to root, so
 * every method bridges the same pair. This one is a T — the nearest node on the far fragment is
 * an *internal* one — and that is the whole of the difference. SEAM heals its tip skeletons with
 * `LEAFS` deliberately: a bridge landing mid-neurite invents a branch point where a tip should be.
 *
 * Fragment A is a chain along x; node 1 is its middle. Fragment B hangs 2 µm above node 1, so
 * `ALL` reaches node 1 at 2 µm and `LEAFS`, which may only land on a leaf or a root, takes 2.24 µm
 * to node 0 or node 2 instead.
 */
{
  // Through `pack`, like every other shape here: a flat coordinate literal hides a miscount.
  const T = pack([
    {
      xyz: [
        [0, 0, 0], // fragment A: root
        [UM, 0, 0], // its middle
        [2 * UM, 0, 0], // its leaf
        [UM, 2 * UM, 0], // fragment B, 2 µm above A's middle
        [UM, 3 * UM, 0],
      ],
      parents: [-1, 0, 1, -1, 3],
    },
  ])
  const bridgedTo = (healMethod) => {
    const out = callClean(`bridge from ${healMethod}`, {
      points: T.points,
      parents: T.parents.slice(),
      radii: new Float32Array(T.total).fill(50),
      compartments: new Uint8Array(T.total),
      offsets: T.offsets,
      somas: Int32Array.from([-1]),
      heal: true,
      healMethod,
    })
    if (!out) return undefined
    check(
      `bridge from ${healMethod}: the two fragments came back as one tree`,
      rootsIn(out, 0) === 1,
    )
    // The one edge that crosses between the fragments, named by the end it landed on in A.
    const landed = []
    for (let i = 0; i < 5; i++) {
      const parent = out.parents[i]
      if (i >= 3 && parent >= 0 && parent < 3) landed.push(parent)
      if (i < 3 && parent >= 3) landed.push(i)
    }
    check(`bridge from ${healMethod}: exactly one bridge was built`, landed.length === 1)
    return landed[0]
  }

  const all = bridgedTo('ALL')
  const leafs = bridgedTo('LEAFS')
  check('bridge from ALL: took the shortest bridge, onto the middle node', all === 1)
  check('bridge from LEAFS: kept off the middle node', leafs === 0 || leafs === 2)
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

// ---------------------------------------------------------------------------
// Simplify: prune twigs, then thin
// ---------------------------------------------------------------------------

/*
 * Four neurons, each the case one rule is about:
 *
 * - a tree whose branch point at node 2 carries a 1 µm twig ending in the **soma** (node 3), and
 *   a second branch point at node 5 carrying a 1 µm twig (node 8) and a 2 µm one (6, 7) — plus a
 *   2-node **fragment** 96 µm away, unbranched and shorter than any threshold below;
 * - a tree where pruning once leaves a new short twig, so `repeat` changes the answer;
 * - a straight chain, unbranched, shorter than every threshold — it must come back whole;
 * - empty.
 */
const SIMPLIFY_SHAPES = [
  {
    xyz: [
      [0, 0, 0],
      [UM, 0, 0],
      [2 * UM, 0, 0],
      [2 * UM, UM, 0],
      [3 * UM, 0, 0],
      [4 * UM, 0, 0],
      [5 * UM, 0, 0],
      [6 * UM, 0, 0],
      [4 * UM, UM, 0],
      [100 * UM, 0, 0],
      [101 * UM, 0, 0],
    ],
    parents: [-1, 0, 1, 2, 2, 4, 5, 6, 5, -1, 9],
    soma: 3,
  },
  {
    xyz: [
      [0, 0, 0],
      [UM, 0, 0],
      [UM, UM, 0],
      [UM, 1.5 * UM, 0],
      [1.5 * UM, UM, 0],
      [11 * UM, 0, 0],
    ],
    parents: [-1, 0, 1, 2, 2, 1],
    soma: -1,
  },
  {
    xyz: Array.from({ length: 10 }, (_, i) => [i * UM, 0, 0]),
    parents: Array.from({ length: 10 }, (_, i) => i - 1),
    soma: -1,
  },
  { xyz: [], parents: [], soma: -1 },
]

const simplifyRun = py.globals.get('coda_simplify_skeletons')

/** Per neuron, the kept rows — or undefined where the call failed. */
function simplify(label, overrides) {
  const { points, parents, offsets } = pack(SIMPLIFY_SHAPES)
  const somas = Int32Array.from(SIMPLIFY_SHAPES.map((s) => s.soma))
  const proxy = attempt(`${label}: the call itself`, () =>
    simplifyRun({
      points,
      parents,
      offsets,
      somas,
      prune: 0,
      repeat: false,
      method: 'none',
      factor: 2,
      tolerance: 0,
      area: 0,
      ...overrides,
    }),
  )
  if (!proxy) return undefined
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()

  check(`${label}: keep is int32`, out.keep instanceof Int32Array)
  check(`${label}: parents are int32, not int64`, out.parents instanceof Int32Array)
  check(`${label}: one parent per kept node`, out.keep.length === out.parents.length)
  checkTopology(label, out)
  // `keep` is in the original order, which is what lets the gather be a straight index.
  let ordered = true
  for (let n = 0; n + 1 < out.offsets.length; n++) {
    for (let i = out.offsets[n] + 1; i < out.offsets[n + 1]; i++) {
      if (out.keep[i] <= out.keep[i - 1]) ordered = false
    }
  }
  check(`${label}: kept rows are in their original order`, ordered)
  return Array.from({ length: 4 }, (_, n) =>
    Array.from(out.keep.slice(out.offsets[n], out.offsets[n + 1])),
  )
}

{
  const kept = simplify('prune 1.5 µm', { prune: 1.5 * UM })
  if (kept) {
    // Node 8 (a 1 µm twig) goes; node 3 is as short but is the soma; 6–7 are 2 µm and stay.
    check(
      'prune: the short twig went and the soma twig stayed',
      String(kept[0]) === '0,1,2,3,4,5,6,7,9,10',
    )
    check(
      'prune: the short unbranched fragment was not pruned',
      kept[0].includes(9) && kept[0].includes(10),
    )
    check('prune: an unbranched neuron came back whole', kept[2].length === 10)
  }
}

{
  const once = simplify('prune 2 µm once', { prune: 2 * UM })
  const again = simplify('prune 2 µm repeated', { prune: 2 * UM, repeat: true })
  if (once && again) {
    // Once removes the two 0.5 µm twigs at node 2, which leaves 1→2 as a 1 µm twig of its own.
    check('repeat: one pass leaves the new short twig', String(once[1]) === '0,1,2,5')
    check('repeat: repeating removes it too', String(again[1]) === '0,1,5')
  }
}

for (const [label, overrides] of [
  ['every 3', { method: 'every', factor: 3 }],
  ['rdp 0.25 µm', { method: 'rdp', tolerance: 0.25 * UM }],
  ['vw 0.05 µm²', { method: 'vw', area: 0.05 * UM * UM }],
]) {
  const kept = simplify(label, overrides)
  if (kept) {
    check(`${label}: the soma survived`, kept[0].includes(3))
    // Root, branch points and leaves: fastcore's promise, and what keeps it the same neuron.
    check(`${label}: the landmarks survived`, [0, 2, 5, 7, 8].every((n) => kept[0].includes(n)))
    check(`${label}: the collinear chain lost nodes`, kept[2].length < 10)
  }
}

simplifyRun.destroy()
finish(py)
