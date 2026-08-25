#!/usr/bin/env node
/**
 * Run `src/pyodide/meshes.py` against the real navis-fastcore wheel, in Node.
 *
 * `probe-skeletons.mjs`'s sibling. vitest has no Pyodide and jsdom has no `Worker`, so nothing
 * in `pnpm test` executes a line of the file this runs.
 *
 *   node scripts/probe-meshes.mjs            # needs `npm i pyodide` somewhere
 *
 * **It asserts the contract, not the surface.** The one property worth checking above all
 * others is that face indices come back **mesh-local** — indexing that mesh's own vertices and
 * no further. A set whose second mesh's faces index into the first's vertices does not fail
 * anywhere: it renders as a cloud of stray triangles somewhere between the two neurons, which
 * reads as a broken viewer. So every case below checks `max(index) < that mesh's vertex count`.
 *
 * The fixture is two icospheres, the second with one face removed — so one mesh is closed and
 * one is open, which is the pair that separates *"fill holes did something"* from *"fill holes
 * capped a mesh that had no holes"*. Both are wound outward, which `drop_internals` requires
 * and which the node's guide says out loud.
 */

import { bootPyodide, loadModule, probeReport } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

await loadModule(py, 'src/pyodide/meshes.py')

const { check, attempt, finish } = probeReport()

/** An outward-wound icosphere of radius 1 µm, subdivided `n` times. */
function icosphere(n) {
  const g = (1 + Math.sqrt(5)) / 2
  let vertices = [
    [-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0],
    [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g],
    [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1],
  ]
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]

  for (let pass = 0; pass < n; pass++) {
    const cache = new Map()
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (!cache.has(key)) {
        cache.set(key, vertices.length)
        vertices.push(vertices[a].map((v, i) => (v + vertices[b][i]) / 2))
      }
      return cache.get(key)
    }
    const next = []
    for (const [a, b, c] of faces) {
      const ab = mid(a, b)
      const bc = mid(b, c)
      const ca = mid(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }

  // Projected onto the sphere and scaled to a micrometre, so the ray offsets `drop_internals`
  // derives from the median edge length land somewhere sensible.
  vertices = vertices.map((v) => {
    const length = Math.hypot(...v)
    return v.map((x) => (x / length) * 1000)
  })
  return { vertices, faces }
}

/** The closed sphere, and an open one with a single triangle cut out of it. */
function fixture() {
  const a = icosphere(2)
  const b = icosphere(1)
  b.faces = b.faces.slice(1)

  const positions = new Float32Array((a.vertices.length + b.vertices.length) * 3)
  const indices = new Uint32Array((a.faces.length + b.faces.length) * 3)
  ;[...a.vertices, ...b.vertices].forEach((v, i) => positions.set(v, i * 3))
  ;[...a.faces, ...b.faces].forEach((f, i) => indices.set(f, i * 3))

  return {
    positions,
    indices,
    vertexOffsets: Int32Array.from([0, a.vertices.length, a.vertices.length + b.vertices.length]),
    faceOffsets: Int32Array.from([0, a.faces.length, a.faces.length + b.faces.length]),
    faceCounts: [a.faces.length, b.faces.length],
  }
}

const DEFAULTS = {
  dropInternals: false,
  openness: 0.05,
  // 8 rays and 1 pass rather than the node's 16 and 3. fastcore's own note is that 8 halves the
  // cost for no measured difference, and this probe is about marshalling rather than about the
  // quality of the cut.
  rays: 8,
  passes: 1,
  fillHoles: false,
  ratio: 1,
  smooth: 0,
  method: 'taubin',
  volumeCorrection: false,
}

const run = py.globals.get('coda_clean_meshes')

function clean(label, overrides) {
  const { positions, indices, vertexOffsets, faceOffsets } = fixture()
  const notes = []
  const proxy = attempt(`${label}: the call itself`, () =>
    run(
      { positions, indices, vertexOffsets, faceOffsets, ...DEFAULTS, ...overrides },
      (f, note) => notes.push(`${f.toFixed(2)} ${note ?? ''}`),
    ),
  )
  if (!proxy) return undefined
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()

  check(`${label}: positions are float32`, out.positions instanceof Float32Array)
  check(`${label}: indices are uint32, not int64`, out.indices instanceof Uint32Array)
  check(`${label}: both offset arrays describe 2 meshes`,
    out.vertexOffsets.length === 3 && out.faceOffsets.length === 3)
  check(`${label}: coordinates divide into triples`, out.positions.length % 3 === 0)
  check(`${label}: indices divide into triangles`, out.indices.length % 3 === 0)

  let local = true
  for (let m = 0; m + 1 < out.vertexOffsets.length; m++) {
    const vertices = out.vertexOffsets[m + 1] - out.vertexOffsets[m]
    for (let i = out.faceOffsets[m] * 3; i < out.faceOffsets[m + 1] * 3; i++) {
      if (out.indices[i] >= vertices) local = false
    }
  }
  // The one that renders rather than raising. See the header.
  check(`${label}: every face index is local to its own mesh`, local)
  check(`${label}: progress was reported`, notes.length > 0)
  return out
}

const faces = (out) => [out.faceOffsets[1] - out.faceOffsets[0], out.faceOffsets[2] - out.faceOffsets[1]]
const verts = (out) => [out.vertexOffsets[1] - out.vertexOffsets[0], out.vertexOffsets[2] - out.vertexOffsets[1]]

const base = fixture()

{
  const out = clean('pass-through', {})
  if (out) check('pass-through: nothing changed', String(faces(out)) === String(base.faceCounts))
}

{
  const out = clean('fill holes', { fillHoles: true })
  if (out) {
    const [closed, open] = faces(out)
    // A ring of three vertices caps to exactly one triangle — `k - 2`, which fastcore
    // guarantees. The closed sphere has no boundary at all and must gain nothing.
    check('fill holes: the closed sphere gained no faces', closed === base.faceCounts[0])
    check('fill holes: the one-triangle hole was capped with one triangle',
      open === base.faceCounts[1] + 1)
  }
}

{
  const out = clean('decimate to 25%', { ratio: 0.25 })
  if (out) {
    const [closed] = faces(out)
    check('decimate: the sphere shed most of its faces', closed < base.faceCounts[0] * 0.5)
    console.log(`decimate  ${base.faceCounts[0]} -> ${closed} faces`)
  }
}

{
  const out = clean('smooth', { smooth: 5 })
  if (out) {
    // The property smoothing promises and the reason anything indexed by vertex survives it.
    check('smooth: the face count is unchanged', String(faces(out)) === String(base.faceCounts))
    check('smooth: the vertex count and order are unchanged',
      String(verts(out)) === String([base.vertexOffsets[1], base.vertexOffsets[2] - base.vertexOffsets[1]]))
    let moved = false
    for (let i = 0; i < out.positions.length; i++) {
      if (Math.abs(out.positions[i] - base.positions[i]) > 1e-3) moved = true
    }
    check('smooth: the vertices actually moved', moved)
  }
}

{
  const out = clean('laplacian + volume correction', {
    smooth: 5,
    method: 'laplacian',
    volumeCorrection: true,
  })
  if (out) check('laplacian: the face count is unchanged', String(faces(out)) === String(base.faceCounts))
}

{
  // The whole pipeline. The check that matters is that the closed, outward-wound sphere does
  // *not* come back empty — which is what an inward-wound mesh does, and the one failure of
  // `drop_internals` that produces no error.
  const t = performance.now()
  const out = clean('everything', {
    dropInternals: true,
    fillHoles: true,
    ratio: 0.5,
    smooth: 2,
  })
  if (out) {
    const [closed] = faces(out)
    console.log(`everything            ${(performance.now() - t).toFixed(0)} ms, ${closed} faces left`)
    check('everything: an outward-wound sphere survived Drop internal membrane', closed > 0)
  }
}

run.destroy()
finish(py)
