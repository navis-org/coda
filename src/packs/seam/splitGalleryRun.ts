/**
 * The split gallery's reads against a live chunkedgraph (reads only, view permission), in the two
 * steps the gallery needs them — so the slow one is paid before the reader asks
 * (`docs/split-gallery-plan.md`, measured 2026-11-23):
 *
 * - **`readSplitNeuron`**, per neuron, while it is in the card: its level-2 graph and every
 *   chunk's point from the L2 cache. 0.8–3.4 s on FANC and Aedes, larger neurons slower. A
 *   chunkedgraph with no L2 cache (the FANC sandbox is one) has each chunk at its grid cell's
 *   centre instead, and says so (`SplitNeuron.placed`).
 * - **`readSplitBox`**, per point: **one** `subgraph` of the point's box one chunk wider on every
 *   side, and that box's chunks' supervoxels, at once. Median 2.3 s, 90th percentile 4.2 s.
 *
 * Then `splitCandidates` (pure) on the two. Pychunkedgraph 2.x only: 1.x (FlyWire) publishes no
 * affinities, and `readSubgraph` refuses it by name.
 */

import type { CaveRequestOptions } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import type { BoxableLayout } from '../../data/cave/graphLayout'
import { cellAt, cellBox, chunkOf } from '../../data/cave/graphLayout'
import type { ChunkPlacement } from '../../data/cave/l2'
import { chunkPositions, readLevelTwoGraph } from '../../data/cave/l2'
import { chunkSupervoxels } from '../../data/cave/rootIds'
import { readSubgraph } from '../../data/cave/subgraph'
import type { Triple } from '../../data/precomputed/volume'
import type { SplitGalleryInput } from './splitGallery'

/**
 * How far around the point the joins are looked for, nm. Measured on 169 simulated clicks up to
 * 2 µm from a false merge: ±4.5 µm put the right split among the first four 97 % of the time.
 */
export const SPLIT_BOX_RADIUS_NM = 4500

/**
 * The most level-2 chunk cells one `subgraph` read may span. FANC answered 4×4×5 = 80 in 2–3 s
 * and refused 6×6×7 = 252 with 503s, which the next requests shared (2026-11-23). A grid with
 * small chunks gets a smaller box rather than a bigger read.
 */
export const MAX_BOX_CELLS = 120

/** One neuron, as the gallery reads it before any point is asked about. */
export interface SplitNeuron {
  readonly root: string
  readonly chunks: readonly string[]
  readonly links: ReadonlyArray<readonly [string, string]>
  readonly positions: ReadonlyMap<string, Triple>
  /** Each chunk's cell on the grid. */
  readonly cells: ReadonlyMap<string, Triple>
  /**
   * Where `positions` came from: each chunk's own point in the L2 cache, or — on a datastack with
   * no cache — its grid cell's centre, which every chunk in that cell shares.
   */
  readonly placed: ChunkPlacement
}

/**
 * The neuron's level-2 graph, each chunk's cell, and each chunk's point (`chunkPositions`: from the
 * L2 cache where there is one, else the cell's centre). The graph needs no cache, so a route or a
 * cut found on it is the same either way; only where it is drawn is rougher.
 */
export async function readSplitNeuron(
  graphene: GrapheneSource,
  layout: BoxableLayout,
  root: string,
  options: CaveRequestOptions,
): Promise<SplitNeuron> {
  const { chunks, edges } = await readLevelTwoGraph(graphene, root, options)
  const cells = new Map<string, Triple>()
  for (const chunk of chunks) {
    const cell = chunkOf(layout, BigInt(chunk))
    if (cell) cells.set(chunk, cell)
  }
  const { positions, placed } = await chunkPositions(graphene, layout, cells, options)
  return { root, chunks, links: edges, positions, cells, placed }
}

/** The point's box and the one-chunk-wider box read around it, as grid cells. */
export function splitBoxCells(
  layout: BoxableLayout,
  pointNm: Triple,
  radiusNm = SPLIT_BOX_RADIUS_NM,
): { inner: [Triple, Triple]; wide: [Triple, Triple] } {
  const cells = (f: (axis: number) => number): Triple => [f(0), f(1), f(2)]
  for (let radius = radiusNm; ; radius *= 0.75) {
    const lo = cells((a) => cellAt(layout, pointNm[a]! - radius, a))
    const hi = cells((a) => cellAt(layout, pointNm[a]! + radius, a))
    const wide: [Triple, Triple] = [cells((a) => lo[a]! - 1), cells((a) => hi[a]! + 1)]
    // A box of one cell is always within reach, whatever the grid.
    if (boxCellCount(wide) <= MAX_BOX_CELLS || lo.every((v, a) => v === hi[a])) {
      return { inner: [lo, hi], wide }
    }
  }
}

/** How many grid cells a box `[lo, hi]` (inclusive) spans — what `MAX_BOX_CELLS` caps. */
export function boxCellCount([lo, hi]: readonly [Triple, Triple]): number {
  return (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1)
}

/**
 * Everything `splitCandidates` needs for one point: the wide box's supervoxel graph and its
 * chunks' supervoxels, read together, with the neuron's level-2 graph from `readSplitNeuron`.
 */
export async function readSplitBox(
  graphene: GrapheneSource,
  layout: BoxableLayout,
  neuron: SplitNeuron,
  pointNm: Triple,
  options: CaveRequestOptions,
): Promise<SplitGalleryInput> {
  const { inner, wide } = splitBoxCells(layout, pointNm)
  const within =
    ([lo, hi]: readonly [Triple, Triple]) =>
    (chunk: string) => {
      const cell = neuron.cells.get(chunk)
      return cell !== undefined && cell.every((v, a) => v >= lo[a]! && v <= hi[a]!)
    }
  const wideChunks = neuron.chunks.filter(within(wide))
  const [graph, members] = await Promise.all([
    readSubgraph(graphene, neuron.root, cellBox(layout, wide[0], wide[1]), options),
    chunkSupervoxels(graphene, wideChunks, options),
  ])
  /*
   * `leaves_many` answers 200 and leaves out an id it does not list. A box chunk missing here would
   * be read as outside the box, its supervoxels never joined to its links beyond — less joining
   * than there is, so a cut could pass the separation check without separating anything. A failed
   * lookup has not answered "none" (CLAUDE.md): refuse.
   */
  const missing = wideChunks.filter((chunk) => !members.get(chunk)?.length)
  if (missing.length > 0) {
    throw new Error(
      `The chunkedgraph listed no supervoxels for ${missing.length} of the neuron's level-2 ` +
        `chunks around the point (${missing[0]}${missing.length > 1 ? ', …' : ''}), so the splits ` +
        'there cannot be checked. Try again in a moment.',
    )
  }
  return {
    wide: graph,
    members,
    inner: new Set(neuron.chunks.filter(within(inner))),
    chunks: neuron.chunks,
    links: neuron.links,
    positions: neuron.positions,
    click: pointNm,
  }
}
