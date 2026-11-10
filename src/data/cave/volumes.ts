/**
 * A CAVE datastack's **voxels** — where to read the EM and the supervoxels from.
 *
 * `src/data/precomputed/volume.ts` reads a box out of a precomputed volume and knows nothing
 * about CAVE. This is the one layer above it that does: a datastack names its two volumes in two
 * different ways, and neither is a URL a browser can fetch.
 *
 * - **The EM is on the *aligned volume*, not on the datastack** — `aligned_volume.image_source`,
 *   which is where `caveclient`'s `info.image_source()` reads it from too. It arrives as an
 *   already-prefixed `precomputed://gs://…`, so it needs the prefix stripped and the bucket
 *   rewritten, and then it is an ordinary precomputed volume.
 * - **The supervoxels are behind the graphene source**, and are not at that address at all:
 *   `graphene://…/segmentation/table/<table>` is the chunkedgraph, whose `info` names a
 *   `data_dir` bucket where the watershed voxels actually live. So reading them is two requests,
 *   the first of which needs the user's token and the second of which needs none.
 *
 * **Supervoxels, not neurons.** The box that comes back from the segmentation volume holds
 * *supervoxel* ids, which are not root ids and are not stable the way a neuron is. Turning them
 * into neurons is a chunkedgraph lookup at a timestamp (`roots_binary`, what
 * `caveclient.chunkedgraph.get_roots` calls) — the reader cannot do it and should not pretend
 * to, which is why this returns an address rather than a `DataSource` method.
 */

import { objectStoreUrl } from '../precomputed/transport'
import type { CaveRequestOptions } from './client'
import { caveGet } from './client'
import type { DatastackInfo } from './api'
import { parseGrapheneSource } from './graphene'

/** Just enough of the segmentation `info` to find the bucket its voxels are in. */
interface SegmentationInfo {
  data_dir?: string
}

/**
 * The EM volume's base URL, or undefined where the datastack publishes none.
 *
 * No request: the address is already in the datastack record. Undefined rather than a throw
 * because an image source is genuinely optional — a datastack of segmentation alone is unusual
 * but valid, which `caveScene` relies on too.
 */
export function imageVolumeOf(info: DatastackInfo): string | undefined {
  const source = info.aligned_volume?.image_source
  if (!source) return undefined
  // `precomputed://` is a scheme prefix for a viewer, not part of the address.
  const address = source.replace(/^precomputed:\/\//, '').replace(/\/+$/, '')
  // `objectStoreUrl` refuses a scheme it does not know rather than guessing — not every
  // datastack is on GCS, and a bucket mapped onto the wrong host 404s per chunk.
  return objectStoreUrl(address) ?? (/^https?:\/\//.test(address) ? address : undefined)
}

/**
 * The supervoxel volume's base URL, read through the chunkedgraph's own `info`.
 *
 * One request, and it needs the caller's token — the chunkedgraph is not public even where the
 * bucket it names is. The same shape `openGrapheneMeshes` uses to find the mesh directory, and
 * deliberately so: both are "ask the graph where its data actually lives".
 */
export async function supervoxelVolumeOf(
  info: DatastackInfo,
  options: CaveRequestOptions,
): Promise<string | undefined> {
  const graphene = parseGrapheneSource(info.segmentation_source)
  if (!graphene) return undefined
  const segmentation = await caveGet<SegmentationInfo>(`${graphene.base}/info`, options)
  if (!segmentation.data_dir) return undefined
  return objectStoreUrl(segmentation.data_dir)
}
