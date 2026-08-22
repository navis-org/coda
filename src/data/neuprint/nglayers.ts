/**
 * Finding a dataset's mesh source.
 *
 * neuPrint's `Meta` node is an unreliable place to look — hemibrain has `neuroglancerMeta`,
 * manc:v1.2.3 has nothing at all — but `/api/npexplorer/nglayers/<dataset>.json` returns the
 * full neuroglancer state for every dataset, and that always names the segmentation.
 *
 * What the layers actually point at, verified per dataset:
 *
 *   hemibrain:v1.2.1  gs://neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation → mesh/
 *   manc:v1.2.3       gs://manc-seg-v1p2/manc-seg-v1.2 → mesh-multi-res/
 *   optic-lobe:v1.1   gs://flyem-optic-lobe/v1.1/segmentation/multi-res-meshes
 *   male-cns:v1.0     gs://flyem-male-cns/v1.0/segmentation → multi-res-meshes/
 *
 * **Preference order is multi-resolution, then the volume, then anything else mesh-shaped,**
 * and the middle tier is not an afterthought. Two datasets pull in opposite directions:
 *
 *  - optic-lobe's volume declares `mesh: single-res-meshes` (flat, full resolution) while a
 *    `multi-res-meshes` *sibling* exists and is what its neuroglancer state links. So a
 *    dedicated multi-res layer has to beat the volume.
 *  - male-CNS's state advertises `meshes-malecns/single-res-meshes` while its volume declares
 *    `mesh: multi-res-meshes`. So a *legacy* dedicated layer must NOT beat the volume.
 *
 * Preferring any hinted layer over the volume — which this file did originally — got male-CNS
 * wrong in a way nothing failed on: meshes still arrived, just at full resolution, several
 * megabytes per neuron, with `Detail` unable to help because a legacy source has one level.
 * That is also what makes thumbnails possible at all, since those want the coarsest level.
 */

import type { NgScene } from '../neuroglancer/scene'
import { objectStoreUrl } from '../precomputed/transport'
import type { RequestOptions } from './client'
import { get } from './client'

interface NgSource {
  url?: string
  subsources?: Record<string, boolean>
}

interface NgLayer {
  type?: string
  name?: string
  source?: string | NgSource | Array<string | NgSource>
}

interface NgState {
  layers?: NgLayer[]
}

/**
 * Path of the endpoint that serves a dataset's neuroglancer state.
 *
 * The dataset id is *not* percent-encoded past its colon: every id contains one
 * (`hemibrain:v1.2.1`) and neuPrint's router matches the raw segment, so `%3A` gets a 400.
 */
function nglayersPath(datasetId: string): string {
  return `/api/npexplorer/nglayers/${encodeURIComponent(datasetId).replace(/%3A/gi, ':')}.json`
}

/**
 * The whole published state for a dataset.
 *
 * The same document `fetchMeshSource` reads, kept whole rather than reduced to a mesh URL —
 * it also carries the curated camera, the ROI meshes and the synapse layers, which is
 * everything an embedded viewer wants. Needs no token; it does need the proxy, like every
 * other neuPrint path.
 */
export async function fetchNgState(
  datasetId: string,
  options?: RequestOptions,
): Promise<NgScene> {
  return get<NgScene>(nglayersPath(datasetId), options)
}

/** Directory names that mean "levels of detail live here". Highest priority. */
const MULTIRES_HINTS = ['multi-res-meshes', 'mesh-multi-res', 'multires', 'multi-res']

/** Other names that mark a layer as geometry rather than a segment-property sidecar. */
const MESH_HINTS = ['single-res-meshes', 'neuron_meshes', 'meshes']

function urls(layer: NgLayer): string[] {
  const source = layer.source
  const items = Array.isArray(source) ? source : [source]
  return items
    .map((item) => (typeof item === 'string' ? item : item?.url))
    .filter((url): url is string => Boolean(url))
}

/**
 * Convert a neuroglancer source URL to something `fetch` accepts.
 *
 * Only object-store schemes are handled. `dvid://` is deliberately not: DVID serves meshes
 * through a completely different API (a keyvalue instance of `.ngmesh` blobs), and silently
 * mapping it to an HTTP URL would produce 404s that look like missing neurons.
 */
export function precomputedToHttp(source: string): string | undefined {
  const match = /^(?:precomputed|zarr|n5):\/\/(.+)$/.exec(source.trim())
  // The bucket mapping itself is `objectStoreUrl`, shared with the CAVE mesh reader, which
  // meets the same `gs://` without a neuroglancer prefix in front of it.
  return match ? objectStoreUrl(match[1]!) : undefined
}

export interface MeshSourceRef {
  /** HTTP URL of a mesh directory, or of a segmentation volume that names one. */
  url: string
  /** The raw `precomputed://…` string, for display and provenance. */
  source: string
}

/**
 * Pick the mesh source out of a neuroglancer state.
 *
 * The dataset's own segmentation layer is identified by name; the many `*_property` sources
 * alongside it are segment metadata, not geometry, and must not be mistaken for meshes.
 */
export function meshSourceFromState(
  state: NgScene,
  datasetId: string,
): MeshSourceRef | undefined {
  const layers = ((state as NgState).layers ?? []).filter((l) => l.type === 'segmentation')
  const family = datasetId.split(':')[0] ?? datasetId
  const named = layers.filter((l) => (l.name ?? '').startsWith(family))
  const candidates = (named.length ? named : layers).flatMap(urls)

  const matching = (hints: string[]) =>
    candidates.find((url) => hints.some((hint) => url.toLowerCase().includes(hint)))

  const multires = matching(MULTIRES_HINTS)
  // The volume names its own preferred mesh subdirectory in its `info`, so following it is
  // how a dataset's own choice gets honoured — see the header for why that beats a hint.
  const volume = candidates.find(
    (url) => !/_propert(y|ies)\/?$/i.test(url) && precomputedToHttp(url),
  )
  const hinted = matching(MESH_HINTS)

  for (const source of [multires, volume, hinted]) {
    if (!source) continue
    const url = precomputedToHttp(source)
    if (url) return { url, source }
  }
  return undefined
}

/**
 * Convenience for callers holding no state of their own.
 *
 * `NeuPrintSource` deliberately does *not* use this: it caches the published document once
 * per dataset and derives the mesh source from that, because the same 38 kB (male-CNS, 38
 * layers) would otherwise be downloaded twice for a graph that both draws meshes and emits a
 * neuroglancer link.
 */
export async function fetchMeshSource(
  datasetId: string,
  options?: RequestOptions,
): Promise<MeshSourceRef | undefined> {
  return meshSourceFromState(await fetchNgState(datasetId, options), datasetId)
}
