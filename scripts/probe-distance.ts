/**
 * What `Distance` actually costs, in the unit its warning is counted in.
 *
 * `pnpm probe:distance`. Two numbers decide whether the node is usable and neither can be read
 * off the code: what one nearest-point search costs against a skeleton's k-d tree, and what the
 * same question costs against a mesh's triangle tree, which is the slower of the two and is the
 * one a reader will meet on a wire of full-resolution surfaces.
 *
 * It runs the shipped modules — `buildKdTree` and `buildTargetIndexes` — rather than a
 * transcription, so a change to the leaf size or the build options moves these numbers.
 *
 * **The leaf size is swept rather than asserted.** `LEAF_SIZE` is the one free parameter in the
 * tree and the usual advice is "16", which is advice about caches on machines that are not
 * necessarily this one. The sweep is cheap and it is the only thing standing between a constant
 * whose doc comment says *measured* and a constant nobody measured.
 *
 * Synthetic geometry rather than a real dataset: what a search descends is a tree, and what
 * varies down it is depth and fan-out rather than which brain the neuron came from. A fetch here
 * would also need a network and a neuPrint deployment, which puts the measurement out of reach of
 * anybody re-running it.
 *
 * `console.error` rather than `console.log`, which is what the other TypeScript probes here do:
 * `eslint.config.js` lifts `no-console` for the plain-JavaScript scripts only, and a stream is a
 * smaller thing to bend than a lint config. (Do not write that glob out here — it ends in a star
 * and a slash, which closes this comment; the parse error lands on the line after it.)
 *
 *     pnpm probe:distance
 */

import type { MeshGeometry, MeshesValue, SkeletonGeometry } from '../src/core/values'
import { column, tableSchema } from '../src/core/types'
import { makeTable } from '../src/core/values'
import { cloud, rng } from '../src/nodes/lib/__fixtures__/rng'
import { buildTargetIndexes } from '../src/nodes/lib/geometryIndex'
import type { KdTree } from '../src/nodes/lib/kdTree'
import { LEAF_SIZE, buildKdTree } from '../src/nodes/lib/kdTree'
import { distanceParamsFrom, distanceValues } from '../src/nodes/lib/geometryDistance'
import type { SkeletonsValue } from '../src/core/values'

/**
 * A branching arbour rather than a cloud: a k-d tree over uniform noise is the *easy* case, and a
 * real skeleton is a thin tree in a large box — long thin structures are what make a median split
 * produce boxes a query has to descend more than one of.
 */
function arbour(nodes: number, seed = 1, spread = 0): SkeletonGeometry {
  const next = rng(seed)
  const positions = new Float32Array(nodes * 3)
  const parents = new Int32Array(nodes)
  parents[0] = -1
  // Where this neuron's root sits. `spread` 0 puts every one at the origin, which is every pair
  // interpenetrating — the worst case for anything that prunes, and not a brain.
  for (let a = 0; a < 3; a++) positions[a] = next() * spread
  for (let i = 1; i < nodes; i++) {
    // Mostly continue the current branch; occasionally jump back to an earlier node.
    const parent = next() < 0.02 ? Math.floor(next() * i) : i - 1
    parents[i] = parent
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = positions[parent * 3 + a]! + (next() - 0.5) * 600
    }
  }
  return { id: 'n', positions, radii: new Float32Array(nodes), parents }
}

/** A closed-ish surface: a sphere of `rings²` quads, which is what a neuron mesh looks like to a tree. */
function sphere(rings: number, radius: number, centre: readonly number[] = [0, 0, 0]): MeshGeometry {
  const positions = new Float32Array((rings + 1) * (rings + 1) * 3)
  for (let iy = 0; iy <= rings; iy++) {
    for (let ix = 0; ix <= rings; ix++) {
      const theta = (iy / rings) * Math.PI
      const phi = (ix / rings) * Math.PI * 2
      const at = (iy * (rings + 1) + ix) * 3
      positions[at] = radius * Math.sin(theta) * Math.cos(phi) + centre[0]!
      positions[at + 1] = radius * Math.cos(theta) + centre[1]!
      positions[at + 2] = radius * Math.sin(theta) * Math.sin(phi) + centre[2]!
    }
  }
  const indices = new Uint32Array(rings * rings * 6)
  let at = 0
  for (let iy = 0; iy < rings; iy++) {
    for (let ix = 0; ix < rings; ix++) {
      const a = iy * (rings + 1) + ix
      indices.set([a, a + 1, a + rings + 2, a, a + rings + 2, a + rings + 1], at)
      at += 6
    }
  }
  return { id: 'm', positions, indices }
}

/** Median of three, for `probe-mesh-decimate.ts`' reason: one reading is not a number. */
function median3(run: () => number): number {
  const runs = [run(), run(), run()].sort((a, b) => a - b)
  return runs[1]!
}

/**
 * Searches a second against one index, as the median of three timed passes.
 *
 * The three tables below each measured this by hand, which is three chances for one of them to
 * drop the `sink` the optimiser needs in order not to delete the loop being measured.
 */
function searchRate(
  index: { nearest(x: number, y: number, z: number): number },
  probes: Float32Array,
  count: number,
): number {
  const ms = median3(() => {
    const started = performance.now()
    let sink = 0
    for (let i = 0; i < count; i++) {
      sink += index.nearest(probes[i * 3]!, probes[i * 3 + 1]!, probes[i * 3 + 2]!)
    }
    // Read, so the loop cannot be optimised away; never true, so it costs a branch.
    if (!Number.isFinite(sink)) throw new Error('unreachable')
    return performance.now() - started
  })
  return Math.round(count / (ms / 1000))
}

const QUERIES = 200_000

console.error('# Distance\n')
console.error('## One nearest-point search against a skeleton\n')
console.error('| target nodes | build ms | searches/s |')
console.error('| --- | --- | --- |')

let skeletonRate = Infinity
for (const nodes of [1_000, 10_000, 100_000]) {
  const item = arbour(nodes)
  const probes = cloud(QUERIES, 60_000, 7)
  const build = median3(() => {
    const t = performance.now()
    buildKdTree(item.positions, item.parents.length)
    return performance.now() - t
  })
  const rate = searchRate(buildKdTree(item.positions, item.parents.length), probes, QUERIES)
  // The **worst**, not the best: `SEARCHES_PER_SECOND` estimates a wait, and a wait promised from
  // the fastest target size is a wait that is wrong in the direction nobody forgives.
  skeletonRate = Math.min(skeletonRate, rate)
  console.error(`| ${nodes.toLocaleString()} | ${build.toFixed(1)} | ${rate.toLocaleString()} |`)
}

console.error('\n## The same against a mesh surface\n')
console.error('| triangles | build ms | searches/s |')
console.error('| --- | --- | --- |')

// The first `buildTargetIndexes` pays for the dynamic import of `three` and `three-mesh-bvh`,
// which is tens of milliseconds and nothing to do with the tree. Warmed, or the smallest surface
// reports the slowest build.
await buildTargetIndexes({
  kind: 'meshes',
  items: [sphere(4, 1000)],
  attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['warm'] }),
  bounds: { min: [-1000, -1000, -1000], max: [1000, 1000, 1000] },
  units: 'nm',
})

let meshRate = Infinity
for (const rings of [32, 96, 192, 384]) {
  const item = sphere(rings, 20_000)
  const value: MeshesValue = {
    kind: 'meshes',
    items: [item],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['m'] }),
    bounds: { min: [-20000, -20000, -20000], max: [20000, 20000, 20000] },
    units: 'nm',
  }
  const build = performance.now()
  const [index] = await buildTargetIndexes(value)
  const buildMs = performance.now() - build
  const probes = cloud(QUERIES / 10, 60_000, 9)
  const rate = searchRate(index!, probes, QUERIES / 10)
  meshRate = Math.min(meshRate, rate)
  console.error(
    `| ${(rings * rings * 2).toLocaleString()} | ${buildMs.toFixed(1)} | ${rate.toLocaleString()} |`,
  )
}

console.error('\n## The leaf size\n')
console.error('| points per leaf | searches/s at 100,000 nodes |')
console.error('| --- | --- |')
{
  const item = arbour(100_000)
  const probes = cloud(QUERIES, 60_000, 7)
  for (const leaf of [4, 8, 16, 32, 64]) {
    const tree = buildKdTree(item.positions, item.parents.length, leaf)
    const mark = leaf === LEAF_SIZE ? ' ← LEAF_SIZE' : ''
    console.error(`| ${leaf} | ${searchRate(tree, probes, QUERIES).toLocaleString()}${mark} |`)
  }
}

/* --------------------------------------------------------------------------------------------
 * What a whole comparison costs, which is what the warning is actually about.
 *
 * The per-search rates above price one *lookup*. They are the right unit for `mean` and `median`,
 * which ask every sample its own question, and badly wrong for the other two: `min` walks both
 * trees at once and rejects a distant pair at its roots, and `within` asks the same question as a
 * pre-rejection before it counts anything. Priced per lookup, a 2,600-neuron all-by-all was
 * announced at **twenty hours** and takes about a minute.
 * ---------------------------------------------------------------------------------------- */

console.error('\n## A whole pair, by method\n')
console.error('| method | kind | arrangement | µs per pair | effective searches/s | 2,600 x 2,600 |')
console.error('| --- | --- | --- | --- | --- | --- |')

/** A neuron-sized sphere, placed like an arbour, so the mesh rows measure the same arrangement. */
function blob(rings: number, seed: number, spread: number): MeshGeometry {
  const next = rng(seed)
  // A different radius each, so the overlapping arrangement is neurons sharing territory rather
  // than one surface laid exactly on another — coplanar triangles, which no real pair presents.
  const radius = 9_000 + next() * 6_000
  const built = sphere(rings, radius, [next() * spread, next() * spread, next() * spread])
  return { ...built, id: String(seed) }
}

/**
 * How the neurons are placed. A brain has both, and they bracket what a pair costs: a descent
 * that can prune rejects a distant pair at its roots and can do nothing with an overlapping one.
 */
const ARRANGEMENTS = [
  // 250,000 nm is about the width of a fly brain.
  { arrangement: 'scattered', spread: 250_000 },
  { arrangement: 'overlapping', spread: 0 },
] as const

/** What is being measured, named as the table prints it. */
const METHODS = [
  { label: 'nearest / min', method: 'nearest', statistic: 'min' },
  { label: 'nearest / mean', method: 'nearest', statistic: 'mean' },
  // `statistic` is inert here and is supplied only because `distanceParamsFrom` reads every key.
  { label: 'within', method: 'within', statistic: 'min' },
] as const

for (const { arrangement, spread } of ARRANGEMENTS) {
  for (const kind of ['skeletons', 'meshes'] as const) {
    const items =
      kind === 'skeletons'
        ? Array.from({ length: 24 }, (_, k) => arbour(2_000, k + 101, spread))
        : Array.from({ length: 12 }, (_, k) => blob(24, k + 201, spread))
    const value = {
      kind,
      items,
      attributes: makeTable(tableSchema(column('neuronId', 'str')), {
        neuronId: items.map((item) => item.id),
      }),
      bounds: { min: [0, 0, 0], max: [250_000, 250_000, 250_000] },
      units: 'nm',
    } as SkeletonsValue | MeshesValue
    // Built once for the three methods below, which is the grouping the loops are for.
    const indexes = await buildTargetIndexes(value)
    const samples =
      items.reduce((n, item) => n + Math.floor(item.positions.length / 3), 0) / items.length

    for (const { label, method, statistic } of METHODS) {
      const params = distanceParamsFrom({
        method,
        statistic,
        within: 2,
        report: 'absolute',
        symmetry: 'mean',
      })
      const started = performance.now()
      await distanceValues({
        queryItems: items,
        targetItems: items,
        targetIndexes: indexes,
        queryIndexes: indexes,
        params,
        queryKind: kind,
        allByAll: true,
      })
      const perPair = ((performance.now() - started) / ((items.length * items.length) / 2)) * 1000
      // Per *nominal* lookup — one per sample of the query side — which is the unit the warning
      // counts in. The ratio to the exhaustive rate is what a method's pruning is worth.
      const perLookup = perPair / samples
      // A mirrored all-by-all computes half the cells, scaled to a 2,000-sample neuron —
      // which is the right scaling for the per-sample methods and an over-estimate for
      // `min` between skeletons, whose cost is per pair and barely moves with samples.
      const minutes = (perPair * ((2_600 * 2_600) / 2) * (2_000 / samples)) / 1e6 / 60
      console.error(
        `| ${label} | ${kind} | ${arrangement} | ${perPair.toFixed(1)} | ` +
          `${(1 / perLookup).toFixed(2)} M/s | ` +
          `${minutes < 1 ? `${(minutes * 60).toFixed(0)} s` : `${minutes.toFixed(0)} min`} |`,
      )
    }
  }
}

/* --------------------------------------------------------------------------------------------
 * What an index costs to hold, which is the other half of "can this node take a thousand
 * neurons" and the half no search rate answers.
 *
 * Every target's tree is built up front and held for the whole run — and past it, `treeFor`
 * keeping it against the geometry — so the bill is the whole wire at once. Nothing refuses it:
 * `checkDistanceSize` guards the *matrix*, which is 8 MB at 1,000 x 1,000 and never the
 * constraint.
 *
 * **`arrayBuffers`, not `heapUsed`**, for `probe-mesh-decimate.ts`' reason: a typed array is off
 * the JS heap, so a probe reading `heapUsed` measures everything except the arrays it is about.
 * The build allocates no throwaway typed arrays, so that delta is exact without a collection.
 * The heap column is the one that needs `--expose-gc` to mean anything, and it is here because
 * it is where a retained build scratch would show up — `Build` in `kdTree.ts` records the round
 * where it did.
 * ---------------------------------------------------------------------------------------- */

console.error('\n## What an index costs to hold\n')
console.error('| neurons | nodes each | points | typed arrays | JS heap | bytes per point |')
console.error('| --- | --- | --- | --- | --- | --- |')
{
  const gc = (globalThis as { gc?: () => void }).gc
  const CASES = [
    { neurons: 2_000, nodes: 2_000 },
    { neurons: 200, nodes: 20_000 },
  ] as const
  /*
   * **Every case's geometry is built before any of it is measured**, which is the trap this
   * table fell into twice. Built inside the loop, a row's `before` is read while the *previous*
   * row's arbours are still counted and its `after` while they are being released, so the delta
   * is this row's cost minus that row's geometry — which published a third of the truth on one
   * ordering and **minus nine bytes a point** on another. Nothing about the reading looks wrong.
   */
  const geometries = CASES.map(({ neurons, nodes }) =>
    Array.from({ length: neurons }, (_, k) => arbour(nodes, k + 301, 250_000)),
  )
  /*
   * **Held in a binding this loop clears by hand**, which is the second half of the same trap. A
   * `const held` in the body is dead the moment the iteration ends and is *not* collected by the
   * next one's `gc()` — it went on living until the next build allocated over it, so row two
   * published its own 49 MB minus row one's 38 and read 11. Cleared here, the release happens
   * before the baseline rather than inside the measurement.
   */
  let held: KdTree[] = []
  for (let c = 0; c < CASES.length; c++) {
    const { neurons, nodes } = CASES[c]!
    const items = geometries[c]!
    held = []
    // Twice: the first pass drops the previous row's trees and the second settles what it freed.
    gc?.()
    gc?.()
    const before = process.memoryUsage()
    // Through `buildKdTree` rather than `buildTargetIndexes`, so the number is the tree's and not
    // a mesh library's — and held in an array, or a tree is collected during the walk that builds
    // the next one and the reading is of whatever happened to survive.
    held = items.map((item) => buildKdTree(item.positions, item.parents.length))
    gc?.()
    gc?.()
    const after = process.memoryUsage()
    const points = neurons * nodes
    const buffers = after.arrayBuffers - before.arrayBuffers
    const heap = after.heapUsed - before.heapUsed
    if (held.length !== neurons) throw new Error('unreachable')
    console.error(
      `| ${neurons.toLocaleString()} | ${nodes.toLocaleString()} | ${points.toLocaleString()} | ` +
        `${(buffers / 1e6).toFixed(0)} MB | ${gc ? `${(heap / 1e6).toFixed(0)} MB` : 'needs --expose-gc'} | ` +
        `${((buffers + (gc ? Math.max(heap, 0) : 0)) / points).toFixed(1)} |`,
    )
  }
  if (!gc) {
    console.error()
    console.error(
      'Run with `NODE_OPTIONS=--expose-gc` for the heap column: the build holds nothing but the',
      'typed arrays, so it should read about zero, and a number there means a scratch array is',
      'being kept alive by a closure over the build scope.',
    )
  }
}

console.error('\n## What the constants should be\n')
console.error(`| kind | searches/s (worst size measured) |`)
console.error('| --- | --- |')
console.error(`| skeletons | ${skeletonRate.toLocaleString()} |`)
console.error(`| meshes | ${meshRate.toLocaleString()} |`)
console.error()
console.error('The **worst**, not the best, of the sizes above: the constant estimates a wait, and a')
console.error('wait promised from the fastest target size is wrong in the direction nobody forgives.')
console.error('The two are an order of magnitude apart, which is why `SEARCHES_PER_SECOND` is a rate')
console.error('per kind and the threshold is a number of seconds rather than a number of searches.')
