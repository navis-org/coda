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

const wholeProxy = call()
const whole = wholeProxy.toJs({ dict_converter: Object.fromEntries })
wholeProxy.destroy()

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

const limitedProxy = call({ limit: 3 })
const limited = limitedProxy.toJs({ dict_converter: Object.fromEntries })
limitedProxy.destroy()
check(`limit caps the windows built (${limited.windows} of ${whole.windows})`, limited.windows <= 3)
check('limit does not change the tiling it reports', limited.tiled === whole.tiled)

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
