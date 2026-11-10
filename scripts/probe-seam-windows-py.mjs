#!/usr/bin/env node
/**
 * Run `src/pyodide/seamWindows.py` and its vendored SEAM files, in Node.
 *
 * `probe-meshes.mjs`'s sibling, and the one that makes this capability testable at all: vitest
 * has no Pyodide and jsdom has no `Worker`, so nothing in `pnpm test` executes a line of these
 * three files. `probe:seam-windows` does run them, but it needs a CAVE token, a dev server and a
 * real Chrome — so it is not something CI or a contributor without a token can run, while
 * `.github/workflows/pyodide.yml` fires on every change under `src/pyodide/**`.
 *
 *   node scripts/probe-seam-windows-py.mjs        # needs `npm i pyodide` somewhere
 *
 * **It asserts the contract, not the cost.** The novel thing here is the vendored package: two
 * files copied byte-identical from another repository, which import each other, assembled into
 * `sys.modules` because the bridge runs one source per module with no import machinery. If that
 * assembly breaks there is no partial failure — `from . import canonical` raises and every
 * window is gone — but it breaks in ways a type checker cannot see, and only on a runtime none
 * of the tests have.
 *
 * The fixture is a closed icosphere of a known radius, so the window count is a property of the
 * geometry rather than of a captured number, and a sphere of 30 µm diameter tiles into a handful
 * of 15 µm windows whichever way the tiling rounds.
 */

import { bootPyodide, loadModule, probeReport, readRepoFile } from './lib/pyodideProbe.mjs'

const py = await bootPyodide()

/*
 * Seeded exactly as `runtime.ts` seeds it, keyed by full module name. Done before `loadModule`
 * because the module reads `__vendored__` out of its own globals — see `PyModule.vendored`.
 */
py.globals.set(
  '__vendored__',
  py.toPy({
    'seam.canonical': readRepoFile('src/pyodide/seam/canonical.py'),
    'seam.scan': readRepoFile('src/pyodide/seam/scan.py'),
  }),
)
await loadModule(py, 'src/pyodide/seamWindows.py', ['numpy'])

const { check, finish } = probeReport()

/** An icosphere of `radius` nm about the origin, subdivided `depth` times. Wound outward. */
function icosphere(radius, depth) {
  const t = (1 + Math.sqrt(5)) / 2
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  for (let d = 0; d < depth; d++) {
    const mid = new Map()
    const next = []
    const middle = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      let at = mid.get(key)
      if (at === undefined) {
        const [ax, ay, az] = verts[a]
        const [bx, by, bz] = verts[b]
        at = verts.push([(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2]) - 1
        mid.set(key, at)
      }
      return at
    }
    for (const [a, b, c] of faces) {
      const ab = middle(a, b)
      const bc = middle(b, c)
      const ca = middle(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }
  const positions = new Float32Array(verts.length * 3)
  verts.forEach(([x, y, z], i) => {
    const n = Math.hypot(x, y, z)
    positions[i * 3] = (x / n) * radius
    positions[i * 3 + 1] = (y / n) * radius
    positions[i * 3 + 2] = (z / n) * radius
  })
  return { positions, indices: Uint32Array.from(faces.flat()), faces: faces.length }
}

const RADIUS_NM = 15_000
const N_POINTS = 256
const sphere = icosphere(RADIUS_NM, 3)

/*
 * A plain JS object, not `py.toPy`: the worker posts one and Pyodide proxies it, which is what
 * `request.to_py()` in the module expects. `toPy` would hand Python a dict, which has no
 * `to_py` — so wrapping it here would be testing a shape the app never sends.
 */
const call = (over = {}) =>
  py.globals.get('coda_seam_windows')({
    positions: sphere.positions,
    indices: sphere.indices,
    units: 'nm',
    radiusUm: 15,
    spacingUm: 0.2,
    nPoints: N_POINTS,
    useNormals: true,
    seed: 0,
    limit: 0,
    drawEvery: 1,
    ...over,
  })

/** A call, read and freed. Written out once: a forgotten `destroy()` leaks a proxy in silence. */
const built = (over = {}) => {
  const proxy = call(over)
  const out = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()
  return out
}

const whole = built()

check(`the vendored seam package assembled and tiled: ${whole.windows} windows`, whole.windows > 0)
check(
  `tiled (${whole.tiled}) is windows (${whole.windows}) plus empty (${whole.empty}) at limit 0`,
  whole.tiled === whole.windows + whole.empty,
)
for (const name of ['points', 'feats', 'sourceNm']) {
  check(
    `${name} is ${whole.windows} x ${N_POINTS} x 3`,
    whole[name].length === whole.windows * N_POINTS * 3,
  )
}
/*
 * The one property the flat packing can get wrong without any length changing: every window must
 * be its own points, not the previous one's tail. The sphere is centred on the origin and the
 * windows are not, so two windows sharing a first point would be a packing bug rather than a
 * coincidence.
 */
const firsts = new Set()
for (let w = 0; w < whole.windows; w++) {
  firsts.add(whole.sourceNm.slice(w * N_POINTS * 3, w * N_POINTS * 3 + 3).join(','))
}
check(`each window carries its own points (${firsts.size} distinct firsts)`, firsts.size === whole.windows)
/* Points leave in model units, which is µm over SCALE_UM — so a 15 µm window is well under 1. */
const extent = Math.max(...Array.from(whole.points, Math.abs))
check(`points are in model units, not nm or µm (max |x| ${extent.toFixed(4)})`, extent > 0 && extent < 1)
/* The source points are where the surface actually is: on a sphere, at its radius. */
const radii = []
for (let i = 0; i < Math.min(whole.sourceNm.length, 3000); i += 3) {
  radii.push(Math.hypot(whole.sourceNm[i], whole.sourceNm[i + 1], whole.sourceNm[i + 2]))
}
const worst = Math.max(...radii.map((r) => Math.abs(r - RADIUS_NM)))
check(`sampled points sit on the sphere (worst ${Math.round(worst)} nm off)`, worst < RADIUS_NM * 0.05)

const limited = built({ limit: 3 })
check(`limit caps the windows built (${limited.windows} of ${whole.windows})`, limited.windows <= 3)
check('limit does not change the tiling it reports', limited.tiled === whole.tiled)

/*
 * One window of the whole repeated three ways, because `only` carries all three jobs a caller
 * has: taking a page of the tiling, taking the centres near a place, and taking them in an order
 * of the caller's own. They used to be three request fields; the properties are the same.
 *
 * The one that matters is **not** that fewer windows come back. It is that the ones that do are
 * *the same windows*. `Scan` draws its centres once over the whole surface and builds window `i`
 * from its own stream `[seed, i]`, so a selection cannot re-sample and an order cannot change a
 * window; if either did, a per-tip answer would differ from a whole-neuron answer by a little,
 * everywhere, and read as a model difference rather than as a sampling one.
 */

/** Whether two runs built the same window wherever they built the same centre. */
function sameWindows(got, want) {
  for (let w = 0; w < got.windows; w++) {
    const from = want.windowIndex.indexOf(got.windowIndex[w])
    if (from < 0) return false
    for (let i = 0; i < N_POINTS * 3; i++) {
      if (got.points[w * N_POINTS * 3 + i] !== want.points[from * N_POINTS * 3 + i]) return false
    }
  }
  return true
}

{
  // A page: a slice of the centres, which is what the node does with its own sweep.
  const pages = []
  for (let at = 0; at < whole.tiled; at += 7) {
    const only = Int32Array.from({ length: Math.min(7, whole.tiled - at) }, (_, k) => at + k)
    pages.push(built({ only }))
  }
  const count = pages.reduce((n, page) => n + page.windows, 0)
  check(`paging builds every window exactly once (${count} of ${whole.windows})`, count === whole.windows)
  const paged = []
  for (const page of pages) paged.push(...page.windowIndex)
  check(
    'paged windows are the whole run, in order',
    String(paged) === String(Array.from(whole.windowIndex)),
  )
  check('every page builds the windows the whole run built', pages.every((p) => sameWindows(p, whole)))
}

{
  // Near a place: the caller works out which centres those are, from the tiling it was handed.
  const near = (x, y, z, withinNm) => {
    const want = []
    for (let c = 0; c < whole.tiled; c++) {
      const dx = whole.tilingCentresNm[c * 3] - x
      const dy = whole.tilingCentresNm[c * 3 + 1] - y
      const dz = whole.tilingCentresNm[c * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz <= withinNm * withinNm) want.push(c)
    }
    return Int32Array.from(want)
  }
  const at = whole.centresNm.slice(0, 3)
  const only = near(at[0], at[1], at[2], 1000)
  const picked = built({ only })
  check(
    `a place selects fewer centres than the whole tiling (${picked.selected} of ${whole.tiled})`,
    picked.selected > 0 && picked.selected < whole.tiled,
  )
  check(
    `the whole tiling reports itself as wholly selected (${whole.selected} of ${whole.tiled})`,
    whole.selected === whole.tiled,
  )
  check(
    `a selected window is the same window, point for point (${picked.windows} compared)`,
    picked.windows > 0 && sameWindows(picked, whole),
  )
  check('a place with no surface near it selects nothing', near(1e9, 1e9, 1e9, 1000).length === 0)
}

{
  // And an order of the caller's own, which is what lets the node sweep tip by tip.
  const want = Int32Array.from([3, 1, 0])
  const picked = built({ only: want, meshKey: 'only-order' })
  check(
    `only builds the centres named, in order (${String(picked.windowIndex)})`,
    String(picked.windowIndex) === String(want) && picked.selected === want.length,
  )
  check('a window built out of order is the same window', picked.windows > 0 && sameWindows(picked, whole))

  let refusedIndex = ''
  try {
    call({ only: Int32Array.from([0, 9999]) })
  } catch (error) {
    refusedIndex = String(error?.message ?? error)
  }
  check(
    `a centre index outside the tiling is refused (${refusedIndex.slice(0, 40)})`,
    refusedIndex.includes('outside'),
  )
}

/*
 * The reduction, and the one property the streaming design rests on: it is **idempotent**, so a
 * batch can be pooled as it arrives and the pooled batches pooled again. `score_neuron` does
 * exactly that, and without it a whole neuron's points — 4,096 a window — would have to exist at
 * once.
 */
{
  const reduce = (pointsNm, scores) => {
    const proxy = py.globals.get('coda_seam_reduce')({ pointsNm, scores, cellUm: 0.5 })
    const out = proxy.toJs({ dict_converter: Object.fromEntries })
    proxy.destroy()
    return out
  }
  const points = whole.sourceNm.slice(0, 6000 * 3)
  const scores = Float32Array.from({ length: 6000 }, (_, i) => Math.sin(i) )
  const once = reduce(points, scores)
  check(`pooling keeps one point per cell (${once.cells} of ${scores.length})`, once.cells > 0 && once.cells < scores.length)

  const half = 3000
  const a = reduce(points.slice(0, half * 3), scores.slice(0, half))
  const b = reduce(points.slice(half * 3), scores.slice(half))
  const joinedPoints = new Float32Array(a.pointsNm.length + b.pointsNm.length)
  joinedPoints.set(a.pointsNm)
  joinedPoints.set(b.pointsNm, a.pointsNm.length)
  const joinedScores = new Float32Array(a.scores.length + b.scores.length)
  joinedScores.set(a.scores)
  joinedScores.set(b.scores, a.scores.length)
  const streamed = reduce(joinedPoints, joinedScores)
  let identical = streamed.cells === once.cells
  for (let i = 0; identical && i < once.scores.length; i++) {
    if (streamed.scores[i] !== once.scores[i]) identical = false
    for (let k = 0; k < 3; k++) {
      if (streamed.pointsNm[i * 3 + k] !== once.pointsNm[i * 3 + k]) identical = false
    }
  }
  check(
    `pooling in two batches gives what pooling once gives (${streamed.cells} cells)`,
    identical,
  )
}

/*
 * The cached tiling, which is what makes scoring one tip worth doing: the expensive half is
 * `Scan`'s constructor, and without this it is paid on every call.
 *
 * Three properties, and the first is the one that matters — a reused tiling must give the *same*
 * windows. A cache that quietly re-tiled would be invisible in every count and show up only as
 * scores that drift between runs of the same neuron.
 */
{
  const KEY = 'probe-sphere'
  const first = call({ meshKey: KEY, limit: 4 })
  const warm = first.toJs({ dict_converter: Object.fromEntries })
  first.destroy()
  check('the first call for a key builds the tiling', warm.scanCached === false)

  // No mesh at all this time: the key is the whole request for the geometry.
  const second = call({
    meshKey: KEY,
    limit: 4,
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
  })
  const reused = second.toJs({ dict_converter: Object.fromEntries })
  second.destroy()
  check('a second call for the same key reuses it', reused.scanCached === true)
  let same = reused.windows === warm.windows && reused.tiled === warm.tiled
  for (let i = 0; same && i < warm.points.length; i++) {
    if (reused.points[i] !== warm.points[i]) same = false
  }
  check(
    `a reused tiling gives the same windows, point for point (${reused.windows})`,
    reused.windows > 0 && same,
  )

  // Window constants are part of the key: the same mesh at another radius is another tiling.
  const other = call({ meshKey: KEY, limit: 4, radiusUm: 10 })
  const rebuilt = other.toJs({ dict_converter: Object.fromEntries })
  other.destroy()
  check('a different window radius rebuilds rather than serving the old tiling', rebuilt.scanCached === false)

  // And asking for a tiling nobody has, with no mesh to build it from, is said rather than
  // answered with an empty neuron.
  let refusedBare = ''
  try {
    call({ meshKey: 'never-built', positions: new Float32Array(0), indices: new Uint32Array(0) })
  } catch (error) {
    refusedBare = String(error?.message ?? error)
  }
  check(
    `a key with no cached tiling and no mesh is refused (${refusedBare.slice(0, 48)})`,
    refusedBare.includes('never-built'),
  )

  const dropped = py.globals.get('coda_seam_forget')({}).toJs({ dict_converter: Object.fromEntries })
  check('forgetting reports that something was held', dropped.dropped === true)
  const after = call({
    meshKey: KEY,
    limit: 4,
    positions: sphere.positions,
    indices: sphere.indices,
  })
  const rebuiltAfter = after.toJs({ dict_converter: Object.fromEntries })
  after.destroy()
  check('after forgetting, the next call builds again', rebuiltAfter.scanCached === false)
}

/*
 * The centres on their own — an **empty** selection, which is the first call a streaming caller
 * makes: it has to know where the windows are before it can say which tip each one finishes.
 * Named none is not the same request as named nothing, which is why no second flag says so.
 */
{
  const only = built({ only: new Int32Array(0), meshKey: 'centres-only' })
  check(`an empty selection builds no windows (${only.windows})`, only.windows === 0)
  check(
    `an empty selection still reports the whole tiling (${only.tiled} against ${whole.tiled})`,
    only.tiled === whole.tiled,
  )
  check(
    'the tiling centres are one triple per centre',
    only.tilingCentresNm.length === whole.tiled * 3,
  )
  // Indexed by centre number, so a built window's centre is at its own index.
  let placed = true
  for (let w = 0; w < whole.windows; w++) {
    const at = whole.windowIndex[w] * 3
    for (let k = 0; k < 3; k++) {
      if (only.tilingCentresNm[at + k] !== whole.centresNm[w * 3 + k]) placed = false
    }
  }
  check('a built window sits at its own centre index in the tiling', placed)
}

let refusedVoxels = ''
try {
  call({ units: 'voxels' })
} catch (error) {
  refusedVoxels = String(error?.message ?? error)
}
// A plain try/catch rather than `attempt`, which counts a throw as a failure: here the throw is
// the pass. A voxel mesh tiles at a wrong physical scale and answers plausibly, so being refused
// is the whole property.
check(
  `a mesh in voxels is refused, not tiled at the wrong scale (${refusedVoxels.slice(0, 60)})`,
  refusedVoxels.includes('voxels'),
)

/* `report=None` is the house default, and the Pyodide-side probes rely on it. */
check('the two timings come back', typeof whole.tileMs === 'number' && typeof whole.windowMs === 'number')

finish(py)
