/**
 * The chunkedgraph's split preview: what its own min-cut between two seed sets would make, without
 * making it (`POST …/table/{table}/graph/split_preview`, pychunkedgraph `c75ace9`). **A read** —
 * `run_split_preview` takes no lock and writes nothing — and the same min-cut the split itself runs
 * with `mincut=true`: the same box (`get_bounding_box` around the seeds' positions, padded by the
 * graph's split offset, (240, 240, 24) voxels by default), the same subgraph, the same
 * `run_multicut` with path augmentation and isolating cuts refused. So where the root has not moved,
 * what it previews is what the split makes (`split-gallery-plan.md`, phase 4).
 */

import type { CaveRequestOptions } from './client'
import { CaveError, cavePost } from './client'
import type { GrapheneSource } from './graphene'
import { tableUrl } from './graphene'
import { isNodeId, replyId } from './graphLayout'
import type { MergeEnd } from './merge'
import { splitBody } from './merge'

/** What the server's min-cut would leave in its box. */
export interface SplitPreview {
  /**
   * The box's supervoxels in pieces after the cut, as text: the one with the most sources first,
   * the one with the most sinks second, any others after (pieces the box holds apart already).
   */
  readonly pieces: readonly (readonly string[])[]
  /**
   * The server's flag for a cut it would refuse to make — one isolating a seed, or leaving the
   * seeds of one side apart.
   */
  readonly illegal: boolean
}

/** The server's min-cut between `sources` and `sinks`, previewed. Throws for an answer it cannot read. */
export async function previewSplit(
  graphene: GrapheneSource,
  sources: readonly MergeEnd[],
  sinks: readonly MergeEnd[],
  options: CaveRequestOptions,
): Promise<SplitPreview> {
  const reply = await cavePost<unknown>(
    tableUrl(graphene, 'graph/split_preview'),
    splitBody(sources, sinks),
    options,
  )
  const { supervoxel_connected_components: ccs, illegal_split: illegal } = (
    typeof reply === 'object' && reply !== null ? reply : {}
  ) as Record<string, unknown>
  const pieces = Array.isArray(ccs)
    ? ccs.map((cc) => (Array.isArray(cc) ? cc.map((id) => replyId(id, isNodeId)) : undefined))
    : undefined
  // A cut the server would refuse is answered so, whatever pieces come with it.
  if (illegal === true) return { pieces: [], illegal: true }
  // Two pieces at least — the sources' and the sinks' — every id a node id, and a true/false flag.
  if (
    !pieces ||
    pieces.length < 2 ||
    !pieces.every((piece) => piece?.every((id) => id !== undefined)) ||
    typeof illegal !== 'boolean'
  ) {
    throw new CaveError(
      `The chunkedgraph's split preview is not one this can read: ${JSON.stringify(reply)?.slice(0, 200)}`,
    )
  }
  return { pieces: pieces as string[][], illegal }
}
