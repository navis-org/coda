/**
 * What a chunkedgraph merge is, as the server takes it — shared by whatever prepares a merge and
 * whatever sends one (`docs/seam-merge-plan.md`).
 *
 * In `src/data` rather than beside the SEAM code that first needed it: the merge writer (phase 2)
 * states the same request, and `src/data` imports nothing from a pack. Not in the writer itself,
 * which only the submit path may import, so the anchors could not reach it there.
 *
 * Read off pychunkedgraph `handle_merge` at both versions in use (1.27.0, 2.20.0): two points,
 * each `[supervoxel, x_nm, y_nm, z_nm]`, and a refusal for two supervoxels more than three chunks
 * apart. This module only *states* the request; nothing here writes.
 */

import type { Triple } from '../precomputed/volume'
import type { GraphLayout } from './graphLayout'
import { chunkDistance, isNodeId, layerOf } from './graphLayout'

/** The server's long-range guard, in chunks (`handle_merge`; fixed in 1.27.0, the default in 2.20.0). */
export const MAX_MERGE_CHUNKS = 3

/** One side of a merge. Text, because an id is (invariant 8). */
export interface MergeEnd {
  readonly supervoxel: string
  /** A voxel centre inside that supervoxel, absolute nanometres at the graph's base scale. */
  readonly positionNm: Triple
}

/** Three finite numbers: a position a merge can be sent with. */
export function isPositionNm(value: unknown): value is Triple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * One side of a merge as the writer would send it: a chunkedgraph id and a position. The writer's
 * `confirmMerge` asks this, and so does anything reading a merge back from saved text.
 */
export function isMergeEnd(value: unknown): value is MergeEnd {
  if (typeof value !== 'object' || value === null) return false
  const { supervoxel, positionNm } = value as Record<string, unknown>
  return typeof supervoxel === 'string' && isNodeId(supervoxel) && isPositionNm(positionNm)
}

/**
 * How many chunks apart two **supervoxels** are, as the merge handler measures it.
 *
 * Throws for an id that is not a layer-1 node rather than answering "too far": a supervoxel read
 * out of the graph's own watershed is layer 1 by construction, so a failure here means the layout
 * and the volume disagree — true of every pair on the datastack, and a fault to name rather than a
 * refusal to repeat per merge. (`parseGraphLayout` refuses a layout without layer 1, so a layer-1
 * id always decodes.)
 */
export function mergeChunkDistance(layout: GraphLayout, a: bigint, b: bigint): number {
  for (const id of [a, b]) {
    const layer = layerOf(layout, id)
    if (layer !== 1) {
      throw new Error(
        `${id} is not a supervoxel of this chunkedgraph (layer ${layer}), so the graph's ` +
          'published id layout does not match its own supervoxels.',
      )
    }
  }
  return chunkDistance(layout, a, b)!
}
