/**
 * Colouring a neuron's mesh by a split, for the split gallery's tiles (`docs/split-gallery-plan.md`).
 *
 * A candidate says which side each **level-2 chunk** is on (`SplitCandidate.chunkSides`) and, for a
 * chunk the cut runs through, each of its supervoxels (`divided`). A graphene mesh is not cut
 * along either — fragments are stitched at layer 3 and up, so one fragment can span both sides —
 * so a vertex is placed two ways:
 *
 * - **Exactly, where it matters**: in every grid cell where some tile has chunks of both sides —
 *   the cells the cuts run through, and the cells two branches share — the supervoxel under the
 *   vertex, read from the segmentation (`supervoxelsAtVertices`), and that supervoxel's side.
 * - **By its chunk, everywhere else**: the chunk whose point (the L2 cache's `rep_coord_nm`) is
 *   nearest, **among the chunks in the vertex's own grid cell** (`nearestChunks`) — a level-2 chunk
 *   lies in its cell, so a neighbouring branch's chunk in the next cell cannot claim the vertex.
 *   Every chunk in such a cell is on one side, so this is the vertex's side. Where a cell holds
 *   chunks of both sides, one point per chunk is not enough — a vertex nearer the other chunk's
 *   point is drawn as an island (648518347493136877, 2026-11-23) — which is why those cells are
 *   read exactly (`refine` in `ui/seam/splitSession.ts`).
 *
 * Neither depends on the candidate, so both are found once per neuron or press, and each
 * candidate's colours are one pass (`sideColours`).
 */

import type { BoxableLayout } from '../../data/cave/graphLayout'
import { cellAt } from '../../data/cave/graphLayout'
import type { LabelBox } from '../../data/precomputed/compressedSegmentation'
import type { Triple } from '../../data/precomputed/volume'
import { buildKdTree } from '../../nodes/lib/kdTree'
import type { SplitSide } from './splitGallery'
import type { SplitNeuron } from './splitGalleryRun'

/** Where a vertex's grid cell is asked: each chunk's cell, and the cell holding a point (nm). */
export interface ChunkCells {
  readonly of: ReadonlyMap<string, Triple>
  readonly at: (x: number, y: number, z: number) => Triple
}

/**
 * For each vertex (`xyz` interleaved, nm), the index in `chunks` of the chunk whose point is
 * nearest — among the chunks in the vertex's own grid cell where `cells` says which those are, and
 * among all of them where the cell holds none (a vertex just over a cell's face). -1 where no chunk
 * has a point. The repo's k-d tree (`buildKdTree`) for the fallback, as SEAM's tips snap to a mesh.
 */
export function nearestChunks(
  vertices: Float32Array,
  chunks: readonly string[],
  positions: ReadonlyMap<string, Triple>,
  cells?: ChunkCells,
): Int32Array {
  const points: number[] = []
  const index: number[] = []
  const byCell = new Map<string, number[]>()
  chunks.forEach((chunk, i) => {
    const at = positions.get(chunk)
    if (!at) return
    points.push(at[0], at[1], at[2])
    index.push(i)
    const cell = cells?.of.get(chunk)
    if (!cell) return
    const key = cell.join(',')
    const list = byCell.get(key)
    if (list) list.push(i)
    else byCell.set(key, [i])
  })
  const nearest = new Int32Array(vertices.length / 3).fill(-1)
  if (index.length === 0) return nearest
  const tree = buildKdTree(new Float32Array(points))
  for (let v = 0; v < nearest.length; v++) {
    const x = vertices[3 * v]!
    const y = vertices[3 * v + 1]!
    const z = vertices[3 * v + 2]!
    const own = cells ? byCell.get(cells.at(x, y, z).join(',')) : undefined
    if (own && own.length > 0) {
      let best = own[0]!
      let gap = Infinity
      for (const i of own) {
        const p = positions.get(chunks[i]!)!
        const d = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2
        if (d < gap) [best, gap] = [i, d]
      }
      nearest[v] = best
      continue
    }
    const at = tree.nearestIndex(x, y, z)
    nearest[v] = at < 0 ? -1 : index[at]!
  }
  return nearest
}

/**
 * `nearestChunks` for a neuron read whole (`readSplitNeuron`): its chunks, their points, and each
 * one's grid cell under `layout` — the split gallery's mesh and find path's skeleton alike.
 */
export function nearestChunksOf(
  vertices: Float32Array,
  neuron: Pick<SplitNeuron, 'chunks' | 'positions' | 'cells'>,
  layout: BoxableLayout,
): Int32Array {
  return nearestChunks(vertices, neuron.chunks, neuron.positions, {
    of: neuron.cells,
    at: (x, y, z) => [cellAt(layout, x, 0), cellAt(layout, y, 1), cellAt(layout, z, 2)],
  })
}

/** A label box read from the segmentation, and where it sits. */
export interface PlacedLabels {
  readonly box: LabelBox
  /** The box's first voxel, in the volume's voxels at `resolution`. */
  readonly lo: Triple
  /** Nanometres per voxel. */
  readonly resolution: Triple
}

/**
 * How far around a vertex its supervoxel is looked for, in voxels: a mesh vertex sits on the
 * object's surface, so the voxel under it is as often outside the object as in it.
 */
const SEARCH_VOXELS = 2

/**
 * The supervoxel under each vertex inside `labels`, where it is one of `own` (the neuron's): the
 * nearest voxel to the vertex, within `SEARCH_VOXELS`, holding one. Added to `into`, keyed by
 * vertex index; a vertex outside the box, or with none of the neuron's voxels near it, is left out.
 */
export function supervoxelsAtVertices(
  vertices: Float32Array,
  labels: PlacedLabels,
  own: { has(id: string): boolean },
  into: Map<number, string>,
): void {
  const { box, lo, resolution } = labels
  const [sx, sy, sz] = box.size
  // Each label's slot, once: which slots are the neuron's, and as text.
  const ownSlot = new Map<number, string>()
  box.labels.forEach((label, slot) => {
    const text = String(label)
    if (own.has(text)) ownSlot.set(slot, text)
  })
  if (ownSlot.size === 0) return
  for (let v = 0; v < vertices.length / 3; v++) {
    // In the box's voxels, continuous: the voxel holding the vertex is the floor.
    const qx = vertices[3 * v]! / resolution[0] - lo[0]
    const qy = vertices[3 * v + 1]! / resolution[1] - lo[1]
    const qz = vertices[3 * v + 2]! / resolution[2] - lo[2]
    if (qx < -SEARCH_VOXELS || qx >= sx + SEARCH_VOXELS) continue
    if (qy < -SEARCH_VOXELS || qy >= sy + SEARCH_VOXELS) continue
    if (qz < -SEARCH_VOXELS || qz >= sz + SEARCH_VOXELS) continue
    const [cx, cy, cz] = [Math.floor(qx), Math.floor(qy), Math.floor(qz)]
    let best: string | undefined
    let gap = Infinity
    for (let dz = -SEARCH_VOXELS; dz <= SEARCH_VOXELS; dz++) {
      const z = cz + dz
      if (z < 0 || z >= sz) continue
      for (let dy = -SEARCH_VOXELS; dy <= SEARCH_VOXELS; dy++) {
        const y = cy + dy
        if (y < 0 || y >= sy) continue
        for (let dx = -SEARCH_VOXELS; dx <= SEARCH_VOXELS; dx++) {
          const x = cx + dx
          if (x < 0 || x >= sx) continue
          const sv = ownSlot.get(box.index[x + sx * (y + sy * z)]!)
          if (sv === undefined) continue
          // Distance in nm to the voxel's centre, so an anisotropic voxel does not favour an axis.
          const d =
            ((x + 0.5 - qx) * resolution[0]) ** 2 +
            ((y + 0.5 - qy) * resolution[1]) ** 2 +
            ((z + 0.5 - qz) * resolution[2]) ** 2
          if (d < gap) [best, gap] = [sv, d]
        }
      }
    }
    if (best !== undefined) into.set(v, best)
  }
}

/** Linear-light RGB for each side, and for a vertex whose chunk is on neither. */
export interface SideColours {
  readonly a: Triple
  readonly b: Triple
  readonly none: Triple
}

/** One side's colour — the one rule the mesh and the chunk points both colour by. */
export function colourOfSide(side: SplitSide | undefined, colours: SideColours): Triple {
  return side === 'a' ? colours.a : side === 'b' ? colours.b : colours.none
}

/** Vertices placed exactly (`supervoxelsAtVertices`), and each of those supervoxels' chunk. */
export interface ExactVertices {
  readonly supervoxelOf: ReadonlyMap<number, string>
  readonly chunkOf: ReadonlyMap<string, string>
}

/**
 * Per-vertex colours (`rgb` interleaved) for one split: a vertex placed exactly takes its
 * supervoxel's side (from `divided` where the cut runs through its chunk, else its chunk's); any
 * other its nearest chunk's.
 */
export function sideColours(
  nearest: Int32Array,
  chunks: readonly string[],
  split: {
    readonly chunkSides: ReadonlyMap<string, SplitSide>
    readonly divided: ReadonlyMap<string, ReadonlyMap<string, SplitSide>>
  },
  colours: SideColours,
  exact?: ExactVertices,
): Float32Array {
  // Each chunk's colour once, so a vertex is two array reads, not a lookup by text.
  const byChunk = chunks.map((chunk) => colourOfSide(split.chunkSides.get(chunk), colours))
  const out = new Float32Array(nearest.length * 3)
  for (let v = 0; v < nearest.length; v++) {
    let rgb = nearest[v]! >= 0 ? byChunk[nearest[v]!]! : colours.none
    const sv = exact?.supervoxelOf.get(v)
    if (sv !== undefined) {
      const chunk = exact!.chunkOf.get(sv)
      const side = chunk === undefined ? undefined : split.divided.get(chunk)?.get(sv)
      rgb = colourOfSide(side ?? (chunk ? split.chunkSides.get(chunk) : undefined), colours)
    }
    out[3 * v] = rgb[0]
    out[3 * v + 1] = rgb[1]
    out[3 * v + 2] = rgb[2]
  }
  return out
}
