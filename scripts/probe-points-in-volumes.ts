/**
 * What Points in Volumes actually costs, in the unit its warning is counted in.
 *
 * `pnpm probe:points-in-volumes`. Two numbers decide whether the node is usable and neither can
 * be read off the code: how long a volume's triangle tree takes to build, and what one
 * containment ray costs once it exists. `ui/viewers/meshPicking.ts` measured the *pick* ray at
 * under 0.03 ms at every size, but a pick is `raycastFirst` from outside a neuron and this is
 * `raycastFirst` from inside a closed shell with `DoubleSide` on, which is a different descent.
 *
 * It runs the shipped module — `buildInsideTests` — rather than a transcription, so a change to
 * the build options or the probe direction moves these numbers.
 *
 * **The rays are counted, not assumed, and that is the whole trap.** Points are sampled in a box
 * larger than the mesh so that some fall outside it — which is the realistic case and is what the
 * prefilter exists for — so most `containing` calls cast **no ray at all**. Dividing the elapsed
 * time by the *point* count therefore measures a call, not a cast: the first version of this
 * probe did exactly that and published 0.67 µs for something that costs about 1.8, which then
 * propagated into `RAYS_PER_SECOND`, into `RAY_WARN` and into three documents. `candidateCount`
 * gives the exact denominator for free, so it is used.
 *
 * Synthetic spheres rather than a real dataset: the shape a ray descends is a triangle tree, and
 * what varies down it is depth and fan-out rather than which brain the surface came from. A
 * fetch here would also need a network and a neuPrint deployment, which puts the measurement out
 * of reach of anybody re-running it.
 *
 *     pnpm probe:points-in-volumes
 */

import { buildInsideTests, volumeBoxes } from '../src/nodes/lib/meshInside'
import type { MeshGeometry } from '../src/core/values'

/** A UV sphere with roughly `target` triangles, centred on `centre`. */
function sphere(id: string, centre: [number, number, number], target: number): MeshGeometry {
  const rings = Math.max(4, Math.round(Math.sqrt(target / 2)))
  const segments = rings * 2
  const xyz: number[] = []
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * Math.PI
    for (let j = 0; j <= segments; j++) {
      const phi = (j / segments) * 2 * Math.PI
      xyz.push(
        centre[0] + Math.sin(theta) * Math.cos(phi),
        centre[1] + Math.sin(theta) * Math.sin(phi),
        centre[2] + Math.cos(theta),
      )
    }
  }
  const tri: number[] = []
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j
      const b = a + segments + 1
      tri.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { id, positions: new Float32Array(xyz), indices: new Uint32Array(tri) }
}

const ms = async (fn: () => unknown): Promise<number> => {
  const at = performance.now()
  await fn()
  return performance.now() - at
}

const POINTS = 200_000
const random = (() => {
  // Deterministic, so two runs of this probe are comparable.
  let seed = 1
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 3 - 1.5
})()

/** Column widths, so the header and the rows cannot drift apart. */
const W = [16, 10, 10, 8] as const
const row = (cells: readonly string[]) => cells.map((c, i) => c.padStart(W[i]!)).join('  ')

/*
 * The library is imported on first use, so without this the first row's "build" would be a cold
 * module load — which is what it was, and it showed as 45 ms for the smallest mesh against 20 ms
 * for one five times larger.
 */
await buildInsideTests([])

console.error(row(['triangles/volume', 'build ms', 'ray µs', 'inside']))
for (const target of [10_000, 50_000, 200_000, 500_000]) {
  // A fresh item each time: the module holds trees weakly against the item it built them for,
  // so re-using one would measure the cache rather than the build.
  const item = sphere(`s${target}`, [0, 0, 0], target)
  const triangles = item.indices.length / 3
  const prefilter = volumeBoxes([item])
  const buildMs = await ms(() => buildInsideTests([item], prefilter))
  const tests = await buildInsideTests([item], prefilter)

  // Sampled once, so the clock covers the casts and not the generator.
  const at = new Float64Array(POINTS * 3)
  for (let i = 0; i < at.length; i++) at[i] = random()
  let rays = 0
  for (let i = 0; i < POINTS; i++)
    rays += prefilter.candidateCount(at[i * 3]!, at[i * 3 + 1]!, at[i * 3 + 2]!)

  const hits: number[] = []
  let inside = 0
  const rayMs = await ms(() => {
    for (let i = 0; i < POINTS; i++) {
      hits.length = 0
      tests.containing(at[i * 3]!, at[i * 3 + 1]!, at[i * 3 + 2]!, hits)
      if (hits.length) inside++
    }
  })
  console.error(
    row([
      String(triangles),
      buildMs.toFixed(0),
      // Per *ray*, which is `rays` and not `POINTS` — see the header.
      ((rayMs / rays) * 1000).toFixed(2),
      `${((inside / POINTS) * 100).toFixed(0)}%`,
    ]),
  )
}

/*
 * The other half: the box prefilter is what keeps a point from costing a ray per volume, so the
 * cost of a *set* is not points × volumes. A tiling set is modelled here as a row of spheres
 * whose boxes touch and no more.
 */
console.error()
console.error(row(['volumes', 'rays', 'ms to count']))
const tiled = Array.from({ length: 63 }, (_, i) => sphere(`r${i}`, [i * 1.9, 0, 0], 20_000))
// `volumeBoxes` rather than the full build: the prefilter is exactly what the node runs before
// it decides whether to warn, and it needs neither the library nor a tree.
const set = volumeBoxes(tiled)
let rays = 0
const countMs = await ms(() => {
  for (let i = 0; i < POINTS; i++)
    rays += set.candidateCount(random() * 40 + 60, random(), random())
})
console.error(row([String(tiled.length), String(rays), countMs.toFixed(0)]))
