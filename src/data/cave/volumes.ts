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
 * to, which is why this hands back where the voxels are and an opened volume, never neurons, and
 * is not a `DataSource` method.
 */

import { objectStoreUrl } from '../precomputed/transport'
import type { CaveRequestOptions } from './client'
import { caveGet } from './client'
import type { DatastackInfo } from './api'
import { datastackRecord } from './datastack'
import type { GrapheneSource } from './graphene'
import { parseGrapheneSource } from './graphene'
import type { GraphLayout } from './graphLayout'
import { parseGraphLayout } from './graphLayout'

/** A chunkedgraph's segmentation `info`, as far as this reads it. */
interface SegmentationInfo {
  readonly data_dir?: string
  /** The id layout, read by `parseGraphLayout`. */
  readonly graph?: unknown
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
  // `precomputed://` is a scheme prefix for a viewer, not part of the address.
  return source ? volumeUrl(source.replace(/^precomputed:\/\//, '')) : undefined
}

/**
 * A volume's address as a URL a browser can fetch, or undefined for a scheme this does not know.
 *
 * One rule for both of a datastack's volumes. `objectStoreUrl` refuses a scheme it does not know
 * rather than guessing — not every datastack is on GCS, and a bucket mapped onto the wrong host
 * 404s per chunk — and an `http(s)` address is already a URL.
 */
function volumeUrl(address: string): string | undefined {
  const trimmed = address.replace(/\/+$/, '')
  return objectStoreUrl(trimmed) ?? (/^https?:\/\//.test(trimmed) ? trimmed : undefined)
}

/** Where a datastack's supervoxels are, as its chunkedgraph describes them. */
export interface SupervoxelSource {
  readonly graphene: GrapheneSource
  /** The supervoxel volume's base URL — the bucket the chunkedgraph names. */
  readonly base: string
  /**
   * The graph's id layout, from the same `info` — read here so no caller fetches that signed-in
   * document a second time. Undefined where the graph publishes none; only a caller that needs it
   * (the merge anchors) refuses over that.
   */
  readonly layout: GraphLayout | undefined
}

/**
 * Where a chunkedgraph's supervoxels are, read from its own `info` — or undefined where it names no
 * bucket this can read (none at all, or an address in a scheme `volumeUrl` does not know).
 *
 * One request, and it needs the caller's token — the chunkedgraph is not public even where the
 * bucket it names is. The same shape `openGrapheneMeshes` uses to find the mesh directory, and
 * deliberately so: both are "ask the graph where its data actually lives".
 */
export async function supervoxelVolumeOf(
  graphene: GrapheneSource,
  options: CaveRequestOptions,
): Promise<SupervoxelSource | undefined> {
  const segmentation = await caveGet<SegmentationInfo>(`${graphene.base}/info`, options)
  const base = segmentation.data_dir ? volumeUrl(segmentation.data_dir) : undefined
  return base ? { graphene, base, layout: parseGraphLayout(segmentation) } : undefined
}

/**
 * Where a datastack's supervoxels are: the chunkedgraph, the bucket, and the graph's id layout.
 *
 * The one place that knows the supervoxels sit behind the graphene `info`, shared by the candidate
 * search (`openSearchVolume`) and the merge anchors (`openAnchorVolume`), each of which then opens
 * the volume (`openVolume`) and picks its own scale — after any refusal of its own, so a datastack
 * it is going to refuse costs no bucket request. Refuses by name at each step rather than returning
 * undefined: each is a fact about the datastack a reader picked, and "nothing found" is what a
 * silent failure here would look like.
 */
export async function findSupervoxels(
  datastack: string,
  options: CaveRequestOptions,
): Promise<SupervoxelSource> {
  const record = await datastackRecord(datastack, options)
  const graphene = parseGrapheneSource(record.segmentation_source)
  if (!graphene) {
    throw new Error(
      `${datastack} publishes no \`graphene://\` segmentation, so it has no supervoxels. This ` +
        'needs a chunkedgraph datastack.',
    )
  }
  const source = await supervoxelVolumeOf(graphene, options)
  if (!source) {
    throw new Error(
      `${datastack}'s chunkedgraph names no \`data_dir\` this can read, so there is nowhere to ` +
        'read its supervoxels from.',
    )
  }
  return source
}
