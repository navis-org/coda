/**
 * Find path's thickness down the neuron's wavefront skeleton (`skeletonThickness.ts`): the route
 * found again along the skeleton's parent links — across the gap between two of its pieces, as a
 * graphene mesh's skeleton is in pieces — and each piece given its nodes' median radius, so a neck
 * reads thin and the rest thick. Nothing here reaches a server or Pyodide.
 */

import { describe, expect, it } from 'vitest'

import { FANC_LAYOUT } from './__fixtures__/splitToy'
import type { Skeleton } from './skeletonThickness'
import { pieceRadiiAlong, skeletonRouteMesh } from './skeletonThickness'
import type { SplitNeuron } from './splitGalleryRun'
import { bridgedRoute, prepareSurface } from './surfacePath'

type Triple = readonly [number, number, number]

/** Chunks along x a micrometre apart (FANC's cells are 2.2 µm wide). */
const AT: Record<string, Triple> = {
  c0: [500, 0, 0],
  c1: [1500, 0, 0],
  c2: [2500, 0, 0],
  c3: [3500, 0, 0],
}
const NEURON: SplitNeuron = {
  root: '1',
  chunks: Object.keys(AT),
  links: [],
  positions: new Map(Object.entries(AT)),
  cells: new Map(
    Object.entries(AT).map(([c, at]) => [c, [Math.floor(at[0] / 2201.6), 0, 0] as Triple]),
  ),
  placed: 'l2cache',
}
const ROUTE = Object.keys(AT)

/**
 * A skeleton along x every 100 nm from 0 to 4 µm, in two pieces split between 2,000 and 2,100 nm (a
 * graphene mesh's fragments skeletonize apart): 200 nm thick, a neck of 50 nm over 2.2–2.8 µm.
 */
function skeleton(): Skeleton {
  const xs = Array.from({ length: 41 }, (_, i) => i * 100)
  return {
    points: Float32Array.from(xs.flatMap((x) => [x, 0, 0])),
    radii: Float32Array.from(xs.map((x) => (x >= 2200 && x <= 2800 ? 50 : 200))),
    parents: Int32Array.from(xs.map((x, i) => (i === 0 || x === 2100 ? -1 : i - 1))),
  }
}

function alongSkeleton(fromNm: Triple, toNm: Triple) {
  const prepared = prepareSurface(
    skeletonRouteMesh(skeleton(), NEURON, FANC_LAYOUT),
    NEURON,
    FANC_LAYOUT,
    ROUTE,
    fromNm,
    toNm,
  )
  return prepared && bridgedRoute(prepared)
}

describe('skeletonRouteMesh', () => {
  it('links each node to its parent, and places each node by its nearest chunk', () => {
    const mesh = skeletonRouteMesh(skeleton(), NEURON, FANC_LAYOUT)
    expect(mesh.lines).toBe(true)
    // 41 nodes, two roots: 39 links.
    expect(mesh.indices.length).toBe(2 * 39)
    expect([...mesh.indices.slice(0, 4)]).toEqual([1, 0, 2, 1])
    expect(mesh.chunks[mesh.nearest[0]!]).toBe('c0')
    expect(mesh.chunks[mesh.nearest[40]!]).toBe('c3')
  })
})

describe('the route down the skeleton', () => {
  it('runs node to node across the gap between pieces, thin along the neck alone', async () => {
    // Clicked points beside the neurite, as a press on the mesh's surface is.
    const along = (await alongSkeleton([50, 150, 0], [3950, 150, 0]))!
    expect(along).toBeDefined()
    expect(along.points[0]).toEqual([50, 150, 0])
    expect(along.points.at(-1)).toEqual([3950, 150, 0])
    // Between the two, on the skeleton's own nodes: y = 0.
    expect(along.points.slice(1, -1).every((p) => p[1] === 0)).toBe(true)
    const radii = pieceRadiiAlong(skeleton(), along)
    const midX = (k: number) => (along.points[k]![0] + along.points[k + 1]![0]) / 2
    const neck = radii.filter((_, k) => midX(k) > 2300 && midX(k) < 2700)
    const rest = radii.filter((_, k) => midX(k) < 1800 || midX(k) > 3200)
    expect(neck.length).toBeGreaterThan(0)
    expect(neck.every((r) => r === 50)).toBe(true)
    expect(rest.every((r) => r === 200)).toBe(true)
  })
})

describe('a short neck', () => {
  it('shows though it is one node: every node is kept, each piece one node to the next', async () => {
    const short = {
      ...skeleton(),
      radii: skeleton().radii.map((_, i) => (i === 30 ? 40 : 200)),
    }
    const prepared = prepareSurface(
      skeletonRouteMesh(short, NEURON, FANC_LAYOUT),
      NEURON,
      FANC_LAYOUT,
      ROUTE,
      [0, 0, 0],
      [4000, 0, 0],
    )!
    const along = (await bridgedRoute(prepared))!
    const radii = pieceRadiiAlong(short, along)
    // The two pieces either side of node 30 (x = 3000 nm) read halfway; the rest thick.
    expect(radii.filter((r) => r === 120)).toHaveLength(2)
    expect(radii.filter((r) => r !== 120 && r !== 200)).toHaveLength(0)
  })
})

describe('pieceRadiiAlong', () => {
  it('takes the median of a piece’s nodes, passing over a node with no radius', () => {
    const measured = { ...skeleton(), radii: Float32Array.from([100, 60, Number.NaN, 0, 80]) }
    const along = {
      points: [],
      steps: [0, 0, 0],
      vertices: [
        [0, 1],
        [1, 2, 4],
        [2, 3],
      ],
    }
    expect(pieceRadiiAlong(measured, along)).toEqual([80, 70, undefined])
  })
})
