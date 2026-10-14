#!/usr/bin/env node
/**
 * Run `src/pyodide/skeletonize.py` against the real navis-fastcore wheel, in Node.
 *
 * `probe-meshes.mjs`' sibling. vitest has no Pyodide and jsdom has no `Worker`, so nothing in
 * `pnpm test` executes a line of the file this runs; `scripts/probe-skeletonize.py` holds the
 * algorithm against skeletor, but in CPython, where skeletor can be installed and this wheel
 * cannot. This is the half CI can run: the wasm build of every fastcore call the module makes,
 * and the contract the worker relies on.
 *
 *   node scripts/probe-skeletonize.mjs        # needs `npm i pyodide` somewhere
 *
 * **What it asserts.** The marshalling — float32 points and radii, int32 parents and offsets, an
 * empty mesh keeping its slot. Parents local to their own skeleton and before their children,
 * which is the failure that draws rather than raises. Then one property a wrong answer cannot
 * fake: a tube skeletonizes to a single tree running its length, with node radii near the tube's.
 * Then `minFragment`, every shave, and the soma — placed, collapsed, detected, and beside debris it
 * must skip — which has to come back a root on the cell's own tree.
 */

import { bootPyodide, loadModule, probeReport } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()
await loadModule(py, 'src/pyodide/skeletonize.py')
const { check, attempt, finish } = probeReport()

/**
 * A capped tube along x: `rings` rings of `around` vertices, radius `r`, `length` long, plus a
 * centre vertex at each end so it is closed. Outward winding does not matter to a wavefront.
 */
function tube({ rings = 60, around = 12, r = 100, length = 6000, x0 = 0 } = {}) {
  const v = []
  const f = []
  for (let i = 0; i < rings; i++) {
    const x = x0 + (length * i) / (rings - 1)
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around
      v.push([x, r * Math.cos(a), r * Math.sin(a)])
    }
  }
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j
      const b = i * around + ((j + 1) % around)
      f.push([a, b, a + around], [b, b + around, a + around])
    }
  }
  const start = v.push([x0, 0, 0]) - 1
  const end = v.push([x0 + length, 0, 0]) - 1
  for (let j = 0; j < around; j++) {
    f.push([start, (j + 1) % around, j])
    const last = (rings - 1) * around
    f.push([end, last + j, last + ((j + 1) % around)])
  }
  return { vertices: v, faces: f }
}

/** A tetrahedron of four vertices: a small loose piece, of the kind both drops remove. */
function speck(x0) {
  return {
    vertices: [[x0, 0, 0], [x0 + 10, 0, 0], [x0, 10, 0], [x0, 0, 10]],
    faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
  }
}

/** Two pieces as one mesh, the second's faces shifted past the first's vertices. */
function joined(a, b) {
  return {
    vertices: [...a.vertices, ...b.vertices],
    faces: [...a.faces, ...b.faces.map((t) => t.map((k) => k + a.vertices.length))],
  }
}

function request(meshes, overrides = {}) {
  const vertexOffsets = new Int32Array(meshes.length + 1)
  const faceOffsets = new Int32Array(meshes.length + 1)
  meshes.forEach((m, n) => {
    vertexOffsets[n + 1] = vertexOffsets[n] + m.vertices.length
    faceOffsets[n + 1] = faceOffsets[n] + m.faces.length
  })
  return {
    positions: Float32Array.from(meshes.flatMap((m) => m.vertices.flat())),
    indices: Uint32Array.from(meshes.flatMap((m) => m.faces.flat())),
    vertexOffsets,
    faceOffsets,
    waves: 1,
    stepSize: 1,
    radiusAgg: 'mean',
    minFragment: 0,
    shave: 'off',
    shaveCutoff: 1000,
    fixZeroRadii: false,
    somaPositions: new Float32Array(meshes.length * 3).fill(NaN),
    somaCleanup: false,
    somaRadius: 3000,
    detectSoma: false,
    minSomaRadius: 1000,
    ...overrides,
  }
}

const run = py.globals.get('coda_skeletonize_meshes')

function skeletonize(label, meshes, overrides) {
  const notes = []
  const proxy = attempt(`${label}: the call itself`, () =>
    run(request(meshes, overrides), (f, note) => notes.push(`${f.toFixed(2)} ${note ?? ''}`)),
  )
  if (!proxy) return undefined
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()

  check(`${label}: points and radii are float32`,
    out.points instanceof Float32Array && out.radii instanceof Float32Array)
  check(`${label}: parents and offsets are int32, not int64`,
    out.parents instanceof Int32Array && out.offsets instanceof Int32Array)
  check(`${label}: one skeleton per mesh`, out.offsets.length === meshes.length + 1)
  check(`${label}: one point and one radius per parent`,
    out.points.length === out.parents.length * 3 && out.radii.length === out.parents.length)

  let ordered = true
  for (let m = 0; m + 1 < out.offsets.length; m++) {
    const from = out.offsets[m]
    for (let i = from; i < out.offsets[m + 1]; i++) {
      const p = out.parents[i]
      // Local to its own skeleton, and a row before its child — the one that draws when wrong.
      if (p !== -1 && !(p >= 0 && p < i - from)) ordered = false
    }
  }
  check(`${label}: every parent is -1 or an earlier row of its own skeleton`, ordered)
  check(`${label}: progress was reported`, notes.length > 0)
  return out
}

/** One skeleton of a result, as plain arrays. */
function item(out, m) {
  const from = out.offsets[m]
  const to = out.offsets[m + 1]
  return {
    points: out.points.slice(from * 3, to * 3),
    radii: out.radii.slice(from, to),
    parents: out.parents.slice(from, to),
  }
}

/** How many trees one skeleton of a result is in. */
function roots(out, m = 0) {
  return item(out, m).parents.filter((p) => p === -1).length
}

const empty = { vertices: [], faces: [] }

{
  const t = performance.now()
  const out = skeletonize('tube', [tube(), empty, tube({ x0: 20000 })])
  if (out) {
    console.log(`tube                 ${(performance.now() - t).toFixed(0)} ms`)
    const first = item(out, 0)
    const xs = Array.from({ length: first.radii.length }, (_, i) => first.points[i * 3])
    // The median rather than the mean: the rings that cross an end cap are wider than the tube.
    const sorted = Array.from(first.radii).sort((a, b) => a - b)
    const medianRadius = sorted[Math.floor(sorted.length / 2)]
    check('tube: the empty mesh kept its slot as an empty skeleton',
      out.offsets[2] === out.offsets[1])
    check('tube: one tree', roots(out) === 1)
    check('tube: it runs the length of the tube',
      Math.min(...xs) < 300 && Math.max(...xs) > 5700)
    check(`tube: node radii are the tube's 100 (median ${medianRadius.toFixed(1)})`,
      medianRadius > 95 && medianRadius < 105)
    check('tube: the two copies came back as the same tree',
      String(item(out, 2).parents) === String(first.parents))
  }
}

{
  const mesh = joined(tube(), speck(10000))
  const kept = skeletonize('fragments kept', [mesh])
  const dropped = skeletonize('fragments dropped', [mesh], { minFragment: 10 })
  if (kept && dropped) {
    check('minFragment 0: the speck is a second tree',
      roots(kept) === 2)
    check('minFragment 10: the speck is gone',
      roots(dropped) === 1)
  }
  const gone = skeletonize('everything dropped', [speck(0)], { minFragment: 10 })
  if (gone) check('a mesh with nothing left comes back empty', gone.offsets[1] === 0)
}

{
  // Every aggregation the card offers is one the module accepts. A third copy of the list, written
  // out here, so it holds the module to the names rather than reading the card's own.
  for (const radiusAgg of ['mean', 'median', 'min', 'max', 'percentile25', 'percentile75']) {
    skeletonize(`radius ${radiusAgg}`, [tube()], { radiusAgg, waves: 2, stepSize: 2 })
  }
}

{
  // The tidy-up after the wavefront, in wasm. Which nodes each shave removes is the CPython
  // parity probe's to check, against navis and fafbseg on a real neuron mesh; this asserts that
  // every shave the card offers runs here, that none adds nodes or keeps more than a milder one,
  // and that the radius fix leaves no non-root node at 0. Two tubes as one mesh give it short
  // trees with leaves to work on.
  const cross = joined(tube(), tube({ x0: 2000, length: 2000, rings: 20 }))
  const counts = {}
  for (const shave of ['off', 'bristles', 'thorough']) {
    const out = skeletonize(`shave ${shave}`, [cross], { shave, fixZeroRadii: true })
    if (!out) continue
    counts[shave] = out.parents.length
    let zero = 0
    for (let i = 0; i < out.parents.length; i++) {
      if (out.parents[i] >= 0 && out.radii[i] === 0) zero += 1
    }
    check(`shave ${shave}: no non-root node left at radius 0 (${zero})`, zero === 0)
  }
  console.log(`shave counts         off ${counts.off}, bristles ${counts.bristles}, thorough ${counts.thorough}`)
  check(`shaves only remove: off ${counts.off} ≥ bristles ${counts.bristles} ≥ thorough ${counts.thorough}`,
    counts.off >= counts.bristles && counts.bristles >= counts.thorough)
}

{
  // The soma, in wasm: a position at one end of a tube, labelled, collapsed, and detected. Which
  // the soma node is has to come back as a root of its own skeleton in every case, since every
  // consumer downstream roots there; collapsed, it has to sit exactly at the position given.
  const at = Float32Array.from([0, 0, 0])
  const placed = skeletonize('soma from the source', [tube()], { somaPositions: at })
  const merged = skeletonize('soma collapsed', [tube()], {
    somaPositions: at,
    somaCleanup: true,
    somaRadius: 300,
  })
  const found = skeletonize('soma detected', [tube()], { detectSoma: true, minSomaRadius: 50 })
  for (const [label, out] of [['placed', placed], ['collapsed', merged], ['detected', found]]) {
    if (!out) continue
    const soma = out.somas[0]
    check(`soma ${label}: somas is int32`, out.somas instanceof Int32Array)
    check(`soma ${label}: a soma was found`, soma >= 0)
    check(`soma ${label}: it is a root`, soma >= 0 && out.parents[soma] === -1)
  }
  // A speck of debris inside the soma radius, beside the tube's soma end — a nuclear envelope in
  // miniature. The clean-up drops it; labelling alone leaves it as a tree of its own.
  const withDebris = joined(tube(), speck(-150))
  const kept = skeletonize('debris kept', [withDebris], { somaPositions: at, somaRadius: 300 })
  const cleaned = skeletonize('debris dropped', [withDebris], {
    somaPositions: at,
    somaCleanup: true,
    somaRadius: 300,
  })
  check(`soma debris: labelling alone keeps it as a second tree`, kept && roots(kept) === 2)
  check(`soma debris: the clean-up drops it`, cleaned && roots(cleaned) === 1)
  // And the label goes on the tube, not the speck, though the speck is nearer the position (30 nm
  // off the tube's end, where nearest-node-anywhere picks the speck's 2-node tree — checked):
  // a soma is snapped only onto a tree reaching outside the soma radius.
  const atDebris = skeletonize('soma beside debris', [joined(tube(), speck(-35))], {
    somaPositions: Float32Array.from([-30, 0, 0]),
    somaRadius: 300,
  })
  if (atDebris) {
    const { parents } = item(atDebris, 0)
    const tree = Int32Array.from(parents.keys())
    for (let i = 0; i < parents.length; i++) if (parents[i] >= 0) tree[i] = tree[parents[i]]
    const size = tree.filter((t) => t === atDebris.somas[0]).length
    check(`soma beside debris: the label is on the cell's tree, not the speck's (${size} nodes)`, size > 4)
  }

  if (merged) {
    const s = merged.somas[0]
    check('soma collapsed: the soma node sits at the given position',
      s >= 0 && [0, 1, 2].every((k) => Math.abs(merged.points[s * 3 + k] - at[k]) < 1e-3))
  }
}

run.destroy()
finish(py)
