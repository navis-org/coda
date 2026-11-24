/**
 * How thick the neurite is along find path's route, read **along the neuron's wavefront skeleton
 * itself** (skeletor's, `pyodide/skeletonize.py`): the route runs node to node down the neurite's
 * middle — the surface search (`surfacePath.ts`) over the skeleton's parent links, every node kept —
 * and each piece, one node to the next, takes the median (the mean, for two) of its nodes' radii.
 *
 * Two settings carry the measurement (`PATH_SKELETONIZE`): short twigs are shaved, or a clicked
 * point's nearest node is a twig's tip; and mesh pieces under 100 vertices are dropped first, or a
 * tiny fragment inside a neurite skeletonizes alone and reads as a neck. What was tried before this
 * (the L2 cache's `max_dt_nm`, rays, nearest nodes, per-vertex rings) and the readings on a live
 * false merge are in `docs/find-path-plan.md`.
 */

import { quantileSorted } from '../../core/stats'
import type { BoxableLayout } from '../../data/cave/graphLayout'
import type { SkeletonizeParams } from '../../nodes/lib/skeletonizeOps'
import { nearestChunksOf } from './splitColours'
import type { SplitNeuron } from './splitGalleryRun'
import type { RouteMesh, SurfaceRoute } from './surfacePath'
import { SEAM_SKELETONIZE } from './tipSkeleton'

/** SEAM's wavefront settings (`twigs` shaved), mesh pieces under 100 vertices dropped first. */
export const PATH_SKELETONIZE: SkeletonizeParams = { ...SEAM_SKELETONIZE, minFragment: 100 }

/** A wavefront skeleton: its nodes (xyz, nm), each one's radius (nm) and parent row (−1 a root). */
export interface Skeleton {
  readonly points: Float32Array
  readonly radii: Float32Array
  readonly parents: Int32Array
}

/**
 * The skeleton as the route search takes a mesh (`prepareSurface`): its parent links as segments,
 * and each node's nearest chunk of `neuron` (`nearestChunksOf`), for the route's corridor.
 */
export function skeletonRouteMesh(
  skeleton: Skeleton,
  neuron: Pick<SplitNeuron, 'chunks' | 'positions' | 'cells'>,
  layout: BoxableLayout,
): RouteMesh {
  const links: number[] = []
  skeleton.parents.forEach((parent, node) => {
    if (parent >= 0) links.push(node, parent)
  })
  return {
    positions: skeleton.points,
    indices: Uint32Array.from(links),
    lines: true,
    nearest: nearestChunksOf(skeleton.points, neuron, layout),
    chunks: neuron.chunks,
  }
}

/**
 * Each of `along`'s pieces' radius — a route found over `skeletonRouteMesh(skeleton, …)`, so its
 * vertices are the skeleton's nodes: the median of their radii, undefined where none has one.
 */
export function pieceRadiiAlong(
  skeleton: Skeleton,
  along: SurfaceRoute,
): (number | undefined)[] {
  return along.vertices.map((nodes) => {
    const radii = nodes
      .map((node) => skeleton.radii[node]!)
      .filter((r) => Number.isFinite(r) && r > 0)
      .sort((a, b) => a - b)
    return radii.length === 0 ? undefined : quantileSorted(radii, 0.5)
  })
}
