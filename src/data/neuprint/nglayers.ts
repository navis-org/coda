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
import { parseNgSource } from '../neuroglancer/sourceUrl'
import { parseDvidRef } from '../dvid/refs'
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
 * A layer `source` string as a mesh directory URL, or undefined if it is not a candidate.
 *
 * Two narrowings on top of `parseNgSource`, and both are facts about **filtering a published
 * state's layer list** rather than about neuroglancer URLs — which is why they live here instead
 * of beside the parser.
 *
 * **The format must have been stated.** `parseNgSource` reads a bare `gs://…` as precomputed,
 * because somebody pasting one into a node means precomputed. A `source` field with no format is
 * a different thing: a string nobody wrote as a source. The preference order below is measured
 * (see docs/backends.md — preferring the wrong candidate downloaded male-CNS at full resolution
 * with nothing failing), so widening what counts as a candidate re-opens that decision.
 *
 * **The location must be an object store.** `dvid://` is the case: DVID serves meshes through a
 * completely different API, and mapping it onto a bucket host turns "unsupported source" into
 * "every neuron is missing". Asked of `objectStoreUrl`, which owns which schemes are buckets and
 * answers undefined for the rest, rather than re-spelled as a regex here.
 */
export function meshCandidateUrl(source: string): string | undefined {
  const ref = parseNgSource(source)
  if (!ref?.stated) return undefined
  if (ref.scheme !== 'precomputed' && ref.scheme !== 'zarr' && ref.scheme !== 'n5')
    return undefined
  return objectStoreUrl(ref.location)
}

export interface MeshSourceRef {
  /** HTTP URL of a mesh directory, or of a segmentation volume that names one. */
  url: string
  /** The raw `precomputed://…` or `dvid://…` string, for display and provenance. */
  source: string
  /**
   * Which reader opens it.
   *
   * Carried rather than re-derived, so the one decision about what a layer *is* is made here and
   * `NeuPrintSource` dispatches on the answer. Re-parsing at the far end would be cheap and
   * would be a second place that can disagree.
   */
  scheme: 'precomputed' | 'dvid'
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
  const candidates = segmentationCandidates(state, datasetId)

  const matching = (hints: string[]) =>
    candidates.find((url) => hints.some((hint) => url.toLowerCase().includes(hint)))

  const multires = matching(MULTIRES_HINTS)
  // The volume names its own preferred mesh subdirectory in its `info`, so following it is
  // how a dataset's own choice gets honoured — see the header for why that beats a hint.
  const volume = volumeCandidate(candidates)
  const hinted = matching(MESH_HINTS)

  for (const source of [multires, volume, hinted]) {
    if (!source) continue
    const url = meshCandidateUrl(source)
    if (url) return { url, source, scheme: 'precomputed' }
  }

  /*
   * DVID last, and only once no object store answered.
   *
   * Last because the preference order above is measured (see the header — preferring the wrong
   * precomputed candidate downloaded male-CNS at full resolution with nothing failing), and a
   * dataset that publishes both should keep taking the pyramid: DVID has one level and its
   * bodies run to 107 MB. Separate from `meshCandidateUrl` rather than folded into it because
   * that function's rule — the location must be an object store — is still exactly right, and
   * it is what stops a `dvid://` being mapped onto a bucket host and reported as every neuron
   * missing. `mushroombody` and `fib19:v1.0` are the two neuPrint datasets this reaches.
   */
  const dvid = candidates.map(parseNgSource).find((ref) => ref?.scheme === 'dvid')
  if (dvid && parseDvidRef(dvid.location)) {
    return { url: dvid.location, source: dvid.canonical, scheme: 'dvid' }
  }
  return undefined
}

/** Every source URL on the layers that could be this dataset's own segmentation, in state order. */
function segmentationCandidates(state: NgScene, datasetId: string): string[] {
  const layers = ((state as NgState).layers ?? []).filter((l) => l.type === 'segmentation')
  const family = datasetId.split(':')[0] ?? datasetId
  const named = layers.filter((l) => (l.name ?? '').startsWith(family))
  return (named.length ? named : layers).flatMap(urls)
}

/** The first candidate that is neither a segment-property sidecar nor an unreadable scheme. */
function volumeCandidate(candidates: readonly string[]): string | undefined {
  return candidates.find((url) => !/_propert(y|ies)\/?$/i.test(url) && meshCandidateUrl(url))
}

/**
 * The dataset's segmentation **volume**, which is a different question from where its meshes are.
 *
 * `meshSourceFromState` resolves as far as a mesh *directory*, and for optic-lobe:v1.1 that is
 * `…/segmentation/multi-res-meshes` — a sibling of the volume, not the volume. Skeletons are
 * named by the volume's own `info` (`male-cns:v1.0` says
 * `skeletons: skeletons-malecns/skeletons-precomputed`), so following the mesh answer would look
 * for an `info` one directory too deep and conclude the dataset publishes none. Four of the
 * twelve neuPrint datasets publish one — male-CNS v0.9 and v1.0, optic-lobe v1.0.1 and v1.1, and
 * manc:v1.0 — so getting this wrong is silent for the other eight.
 *
 * The same first-non-sidecar pick `meshSourceFromState` makes for its middle tier, shared rather
 * than written twice: they are the same question, and the mesh path is where the rule was
 * measured (see the header).
 */
export function volumeSourceFromState(
  state: NgScene,
  datasetId: string,
): MeshSourceRef | undefined {
  const source = volumeCandidate(segmentationCandidates(state, datasetId))
  const url = source ? meshCandidateUrl(source) : undefined
  // Precomputed only, deliberately: this answers "which volume names a skeleton directory in its
  // `info`", and a DVID node has no such document. DVID skeletons live in a sibling keyvalue
  // instance and are found by name — see `data/dvid/refs.ts`.
  return url && source ? { url, source, scheme: 'precomputed' } : undefined
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
