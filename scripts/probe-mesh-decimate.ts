/**
 * What decimating over the fragments saves, against joining them first.
 *
 * A CAVE neuron arrives as hundreds of Draco supervoxel fragments. Joining them and then
 * decimating allocates a second full-resolution copy of a mesh that is about to be reduced by two
 * orders of magnitude; `decimateParts` clusters over the fragments where they already are. That
 * this changes no pixel is `meshDecimate.test.ts`' to assert — here it is only checked at a scale
 * the suite does not run, and what is measured is the cost.
 *
 *   pnpm probe:mesh-decimate
 *
 * **Typed arrays are not on the JS heap.** `heapUsed` moves by 0.5 MB for a 100 MB `Float32Array`
 * on Node 26; the bytes land in `external`/`arrayBuffers`. A joined mesh is entirely typed arrays,
 * so a probe reading `heapUsed` reports everything *except* the thing this change removes — which
 * is what the first version of this file did, and why it attributed a difference that was really
 * its own scratch allocations. `arrayBuffers` is the number that answers the question.
 *
 * Prints through `console.error`, the convention the other TypeScript probes follow — the
 * `no-console` exemption in `eslint.config.js` reaches only the JavaScript ones.
 */

import { decimateGridFor, decimateMesh, decimateParts } from '../src/data/meshDecimate'
import { DEFAULT_TRIANGLE_BUDGET } from '../src/data/precomputed/index'
import { concatMeshes, type MeshArrays } from '../src/data/meshParts'
import { mulberry32 } from '../src/data/mock/generate'

/**
 * The grids a triangle budget actually asks for, at one, five and twenty neurons.
 *
 * Computed rather than transcribed, now that `decimateGridFor` lives in `meshDecimate.ts` and not
 * behind `cave/meshes.ts`' wasm import: the budget is shared across the set, so a lone neuron asks
 * for a grid an order of magnitude finer than a scene of twenty does, and the fine end is where
 * the index pass and the cell map are largest. The transcribed list had already drifted to a 96
 * that no (budget, count) pair produces.
 */
const GRIDS = [20, 5, 1].map((neurons) => decimateGridFor(DEFAULT_TRIANGLE_BUDGET, neurons))

/** One FlyWire neuron's measured shape — see `cave/meshes.ts`, where it was taken. */
const FRAGMENTS = 471
const VERTICES = 668_750
/** Vertex pitch within a fragment, so a patch spans several cells at the coarsest grid. */
const SPACING = 400
/**
 * The neuron's bounding box, which is **long and thin** — 8 : 3 : 1.5 here.
 *
 * Not decoration: the packed cell key sizes its multiplier per axis precisely because a neuron is
 * not a cube, and a fixture scattered through a cube leaves that unexercised. It was one, and at
 * the finest grid the key ran past 2^31 anyway — so the probe was measuring the slow branch the
 * per-axis multipliers exist to avoid.
 */
const EXTENT = [800_000, 300_000, 150_000] as const

/**
 * One neuron's fragments.
 *
 * Synthetic rather than fetched — what is measured is allocation, not the network, and a fixture
 * this size is 23 MB nobody wants in the repository — but it has to be a *surface*, because the
 * cost of the index pass is set by how many triangles survive clustering. Random indices within a
 * fragment gave 817,582 output triangles from 7,066 output vertices, a ratio no closed surface can
 * have and 130× the real neuron's; each fragment is a small lattice instead.
 */
function neuronParts(): MeshArrays[] {
  const parts: MeshArrays[] = []
  const rnd = mulberry32(12345)
  const perPart = Math.floor(VERTICES / FRAGMENTS)
  // A square w × w lattice: w² vertices and 2(w-1)² triangles, the ~2:1 ratio the real neuron has.
  const w = Math.max(2, Math.round(Math.sqrt(perPart)))
  for (let k = 0; k < FRAGMENTS; k++) {
    const positions = new Float32Array(w * w * 3)
    const ox = rnd() * EXTENT[0]
    const oy = rnd() * EXTENT[1]
    const oz = rnd() * EXTENT[2]
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 3
        positions[at] = ox + x * SPACING
        positions[at + 1] = oy + y * SPACING
        // A little relief, so the patch occupies more than one plane of cells.
        positions[at + 2] = oz + Math.sin(x * 0.4) * SPACING * 5 + Math.cos(y * 0.4) * SPACING * 5
      }
    }
    const indices = new Uint32Array((w - 1) * (w - 1) * 6)
    let i = 0
    for (let y = 0; y + 1 < w; y++) {
      for (let x = 0; x + 1 < w; x++) {
        const a = y * w + x
        indices[i++] = a
        indices[i++] = a + w
        indices[i++] = a + 1
        indices[i++] = a + 1
        indices[i++] = a + w
        indices[i++] = a + w + 1
      }
    }
    parts.push({ positions, indices })
  }
  return parts
}

interface Measured<T> {
  ms: number
  heap: number
  buffers: number
  out: T
}

/**
 * Wall time and the bytes still held in each arena, **median of three, each axis on its own**.
 *
 * Three because one is not a number: the same row measured 111 / 83 / 98 ms across runs, and its
 * heap column read 62.7 / 62.7 / 31.6 MB depending on whether a GC landed mid-call. Those figures
 * get transcribed into source comments, so a ±35% reading is a ±35% design record.
 *
 * Median rather than best, and per column rather than per run: picking the fastest run and
 * reporting *its* memory is picking a memory sample at random — it read a 55 MB saving for one
 * whose true figure is the 23.7 MB joined copy.
 */
function measure<T>(fn: () => T): Measured<T> {
  const ms: number[] = []
  const heap: number[] = []
  const buffers: number[] = []
  let out: T | undefined
  for (let run = 0; run < 3; run++) {
    globalThis.gc?.()
    const before = process.memoryUsage()
    const started = performance.now()
    out = fn()
    ms.push(performance.now() - started)
    const after = process.memoryUsage()
    heap.push(after.heapUsed - before.heapUsed)
    buffers.push(after.arrayBuffers - before.arrayBuffers)
  }
  const median = (xs: number[]): number => xs.sort((a, b) => a - b)[1]!
  return { ms: median(ms), heap: median(heap), buffers: median(buffers), out: out! }
}

/** One line of the table. */
function row(name: string, m: Measured<MeshArrays>): string {
  return (
    `${name.padEnd(20)} ${m.ms.toFixed(0).padStart(5)} ms ` +
    `${(m.heap / 1e6).toFixed(1).padStart(9)} MB ${(m.buffers / 1e6).toFixed(1).padStart(12)} MB ` +
    `${(m.out.indices.length / 3).toLocaleString().padStart(12)}`
  )
}

if (!globalThis.gc) {
  throw new Error('Run through `pnpm probe:mesh-decimate`, which passes --expose-gc.')
}

const parts = neuronParts()
const held = parts.reduce((sum, p) => sum + p.positions.byteLength + p.indices.byteLength, 0)
const inputTriangles = parts.reduce((sum, p) => sum + p.indices.length / 3, 0)
console.error(
  `${parts.length} fragments — ${(parts.reduce((s, p) => s + p.positions.length / 3, 0)).toLocaleString()} vertices, ` +
    `${inputTriangles.toLocaleString()} triangles, ${(held / 1e6).toFixed(1)} MB\n`,
)
console.error('grid        route                 time     JS heap   array buffers    triangles')

for (const grid of GRIDS) {
  // Warmed per grid, so neither route pays for JIT on the run that is reported.
  const warm = parts.slice(0, 20)
  decimateParts(warm, grid)
  const warmJoin = concatMeshes(warm)
  decimateMesh(warmJoin.positions, warmJoin.indices, grid)

  const viaJoin = measure(() => {
    const joined = concatMeshes(parts)
    return decimateMesh(joined.positions, joined.indices, grid)
  })
  const direct = measure(() => decimateParts(parts, grid))

  console.error(`${String(grid).padEnd(11)} ${row('join, then decimate', viaJoin)}`)
  console.error(`${'           '} ${row('decimate over parts', direct)}`)

  const same =
    viaJoin.out.positions.length === direct.out.positions.length &&
    viaJoin.out.indices.length === direct.out.indices.length &&
    viaJoin.out.positions.every((v, i) => v === direct.out.positions[i]) &&
    viaJoin.out.indices.every((v, i) => v === direct.out.indices[i])
  if (!same) console.error(`${'           '} !! the two routes disagree at grid ${grid}`)
}
