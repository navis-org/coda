/**
 * Find path's route along the mesh (`surfacePath.ts`), on toy meshes: it follows the mesh, keeps
 * to the route's own chunks even where another branch through the same cells is shorter, falls back
 * to the route's cells where the chunks have no points of their own, and gives up (the straight
 * lines stay) where the mesh holds no such path. Nothing here reaches a server.
 */

import { describe, expect, it } from 'vitest'

import { FANC_LAYOUT } from './__fixtures__/splitToy'
import type { SplitNeuron } from './splitGalleryRun'
import type { RouteMesh, SurfaceRoute } from './surfacePath'
import { BRIDGE_NM, prepareSurface, surfaceRoute } from './surfacePath'

type Triple = readonly [number, number, number]

/** The route along `mesh`, each bridge width in turn as the session tries them. */
function along(
  mesh: RouteMesh,
  neuron: SplitNeuron,
  layout: typeof FANC_LAYOUT,
  route: readonly string[],
  fromNm: Triple,
  toNm: Triple,
): SurfaceRoute | undefined {
  const prepared = prepareSurface(mesh, neuron, layout, route, fromNm, toNm)
  if (!prepared) return undefined
  for (const bridgeNm of BRIDGE_NM) {
    const found = surfaceRoute(prepared, bridgeNm)
    if (found) return found
  }
  return undefined
}

/** Chunks along x a micrometre apart (FANC's cells are 2.2 µm wide), and one beside them. */
const AT: Record<string, Triple> = {
  c0: [500, 0, 0],
  c1: [1500, 0, 0],
  c2: [2500, 0, 0],
  c3: [3500, 0, 0],
  side: [2000, 300, 0],
}
function neuron(placed: SplitNeuron['placed']): SplitNeuron {
  return {
    root: '1',
    chunks: Object.keys(AT),
    links: [],
    positions: new Map(Object.entries(AT)),
    cells: new Map(
      Object.entries(AT).map(([c, at]) => [c, [Math.floor(at[0] / 2201.6), 0, 0] as Triple]),
    ),
    placed,
  }
}
const ROUTE = ['c0', 'c1', 'c2', 'c3']

/**
 * A ladder of triangles through the points `rail` (each with a twin 20 nm along y), every vertex
 * given the chunk `chunkAt` names.
 */
function ladder(rail: Triple[], chunkAt: (p: Triple) => string, offset = 0) {
  const positions = rail.flatMap((p) => [p[0], p[1], p[2], p[0], p[1] + 20, p[2]])
  const indices = rail.slice(1).flatMap((_, i) => {
    const a = offset + 2 * i
    return [a, a + 1, a + 2, a + 1, a + 3, a + 2]
  })
  const chunks = Object.keys(AT)
  const nearest = rail.flatMap((p) => [chunks.indexOf(chunkAt(p)), chunks.indexOf(chunkAt(p))])
  return { positions, indices, nearest }
}
const byX = (p: Triple) => `c${Math.min(3, Math.floor(p[0] / 1000))}`
const meshOf = (...parts: ReturnType<typeof ladder>[]): RouteMesh => ({
  positions: Float32Array.from(parts.flatMap((p) => p.positions)),
  indices: Uint32Array.from(parts.flatMap((p) => p.indices)),
  nearest: Int32Array.from(parts.flatMap((p) => p.nearest)),
  chunks: Object.keys(AT),
})

describe('surfaceRoute', () => {
  const straight = Array.from({ length: 41 }, (_, i): Triple => [i * 100, 0, 0])

  it('follows the mesh from the start to the end, thinned, each piece on its step', () => {
    const route = along(
      meshOf(ladder(straight, byX)),
      neuron('l2cache'),
      FANC_LAYOUT,
      ROUTE,
      [0, 0, 0],
      [4000, 0, 0],
    )!
    expect(route.points[0]).toEqual([0, 0, 0])
    expect(route.points.at(-1)).toEqual([4000, 0, 0])
    // A point every 250 nm or so, not every 100 nm vertex.
    expect(route.points.length).toBeLessThan(25)
    expect(route.steps).toHaveLength(route.points.length - 1)
    // Steps run in order along the route, from the first to the last.
    expect(route.steps[0]).toBe(0)
    expect(route.steps.at(-1)).toBe(2)
    expect([...route.steps].sort((a, b) => a - b)).toEqual(route.steps)
  })

  it('keeps to the route’s chunks where another branch through the same cells is shorter', () => {
    // The route's own strip bulges 1.5 µm up in z in the middle; a flat strip of `side` beside it
    // joins its two ends.
    const bulge = straight.map((p): Triple => [
      p[0],
      p[1],
      Math.abs(p[0] - 2000) < 600 ? 1500 : 0,
    ])
    const shortcut = straight.map((p): Triple => [p[0], 300, 0])
    const own = ladder(bulge, byX)
    const side = ladder(shortcut, () => 'side', bulge.length * 2)
    // Join the two strips at both ends.
    const ends = [0, 2 * (bulge.length - 1)].flatMap((a) => [a, a + 1, bulge.length * 2 + a])
    const mesh = meshOf(own, side)
    const joined: RouteMesh = { ...mesh, indices: Uint32Array.from([...mesh.indices, ...ends]) }
    const route = along(joined, neuron('l2cache'), FANC_LAYOUT, ROUTE, [0, 0, 0], [4000, 0, 0])!
    expect(Math.max(...route.points.map((p) => p[2]))).toBe(1500)
    expect(route.points.every((p) => p[1] < 300)).toBe(true)
  })

  it('keeps to the route’s cells alone where the chunks have no points of their own', () => {
    const route = along(
      meshOf(ladder(straight, () => 'side')),
      neuron('cells'),
      FANC_LAYOUT,
      ROUTE,
      [0, 0, 0],
      [4000, 0, 0],
    )
    expect(route?.points.at(-1)).toEqual([4000, 0, 0])
  })

  /** A graphene mesh is one piece per fragment, reduced apart: no vertex is shared where two meet. */
  const split = (gapNm: number) => {
    const gap = straight.filter((p) => Math.abs(p[0] - 2000) > gapNm / 2)
    const left = ladder(
      gap.filter((p) => p[0] < 2000),
      byX,
    )
    const right = ladder(
      gap.filter((p) => p[0] > 2000),
      byX,
      left.positions.length / 3,
    )
    return meshOf(left, right)
  }
  const across = (mesh: RouteMesh) =>
    along(mesh, neuron('l2cache'), FANC_LAYOUT, ROUTE, [0, 0, 0], [4000, 0, 0])

  it('bridges the gap between two pieces of the mesh', () => {
    expect(across(split(500))?.points.at(-1)).toEqual([4000, 0, 0])
  })

  it('gives up where the pieces lie further apart than any bridge, and the straight lines stay', () => {
    expect(across(split(3000))).toBeUndefined()
  })
})

describe('surfaceRoute far from the origin', () => {
  it('keeps neighbouring cells apart at a real neuron’s coordinates (hundreds of µm out)', () => {
    // The same strip as above, moved 300 µm out on every axis: cell keys must not collide.
    const out = (p: Triple): Triple => [p[0] + 300_000, p[1] + 300_000, p[2] + 300_000]
    const far: SplitNeuron = {
      ...neuron('l2cache'),
      positions: new Map(Object.entries(AT).map(([c, at]) => [c, out(at)])),
      cells: new Map(
        Object.entries(AT).map(([c, at]) => {
          const p = out(at)
          return [
            c,
            [
              Math.floor(p[0] / 2201.6),
              Math.floor(p[1] / 2201.6),
              Math.floor(p[2] / 5760),
            ] as Triple,
          ]
        }),
      ),
    }
    const strip = Array.from({ length: 41 }, (_, i): Triple => out([i * 100, 0, 0]))
    const route = along(
      meshOf(ladder(strip, (p) => byX([p[0] - 300_000, 0, 0]))),
      far,
      FANC_LAYOUT,
      ROUTE,
      out([0, 0, 0]),
      out([4000, 0, 0]),
    )
    expect(route?.points.at(-1)).toEqual(out([4000, 0, 0]))
    // Off the route's cells (one cell over in z), the same strip finds no route at all.
    const elsewhere = strip.map((p): Triple => [p[0], p[1], p[2] + 6000])
    expect(
      along(
        meshOf(ladder(elsewhere, (p) => byX([p[0] - 300_000, 0, 0]))),
        far,
        FANC_LAYOUT,
        ROUTE,
        out([0, 0, 0]),
        out([4000, 0, 0]),
      ),
    ).toBeUndefined()
  })
})
