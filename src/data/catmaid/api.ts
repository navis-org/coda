/**
 * CATMAID's endpoints, and the response shapes they actually answer with.
 *
 * Every shape below was read off `https://catmaid-fafb.virtualflybrain.org` rather than recalled,
 * and the ones that surprise are commented where they sit. The endpoint *paths* follow pymaid's
 * `CatmaidInstance._get_*_url` map, which is the reference implementation.
 *
 * Two conventions run through the file. **Lists are indexed** — see `encodeParams`, where the
 * documented bracket form silently drops all but the last id. And **which verb an endpoint takes
 * is not a style choice**: the ones marked POST here have no GET alias at all (checked against
 * `/apis/`, not guessed), which is what makes a token or the dev relay load-bearing rather than
 * a convenience. See `client.ts`.
 */

import { catmaidGet, catmaidPost } from './client'
import type { CatmaidRequestOptions } from './client'

// ---------------------------------------------------------------------------
// Projects and stacks
// ---------------------------------------------------------------------------

export interface CatmaidStack {
  id: number
  title: string
  comment?: string
  dimensions?: [number, number, number]
}

export interface CatmaidProject {
  id: number
  title: string
  comment: string | null
  stacks: CatmaidStack[]
}

/** Anonymous on a public instance, and the one call that needs no project id. */
export function listProjects(
  server: string,
  options?: CatmaidRequestOptions,
): Promise<CatmaidProject[]> {
  return catmaidGet<CatmaidProject[]>(server, '/projects/', {}, options)
}

/*
 * Treenode, connector and volume coordinates are **project space, which is nanometres**.
 *
 * Not derived from the stack resolution, which is nm-per-*voxel* and describes the image stack
 * rather than the annotations on it. Verified by cross-check: skeleton 16 spans x[326111,495041]
 * and the `LAL_L` volume x[538898,626985], both inside the FAFB extent of 253952 x 4 nm — one
 * frame, no scaling. This is why nothing here does what `neuprint/units.ts` has to, and why
 * every geometry this source builds declares `units: 'nm'`.
 */

// ---------------------------------------------------------------------------
// The annotation graph, which is where a CATMAID neuron's labels live
// ---------------------------------------------------------------------------

/**
 * Every skeleton id in a project, optionally only the substantial ones.
 *
 * `nodecount_gt` is the one server-side filter worth having: FAFB carries 5,601 skeletons of
 * which 4,735 have more than a thousand nodes, and the remainder are fragments.
 */
export function listSkeletons(
  server: string,
  projectId: number,
  minNodes?: number,
  options?: CatmaidRequestOptions,
): Promise<number[]> {
  return catmaidGet<number[]>(
    server,
    `/${projectId}/skeletons/`,
    minNodes ? { nodecount_gt: minNodes } : {},
    options,
  )
}

/**
 * Annotations per skeleton, plus the neuron names, plus the *meta*-annotations.
 *
 * The single most important call in this backend: it is where a `type` column comes from. See
 * `annotations.ts`. POST-only. Chunked by the caller — 2,000 skeletons is ~520 kB and 0.7 s.
 *
 * `metaannotations` is keyed by **annotation** id, not by skeleton, and its values are
 * `{annotations: [{id, uid}]}` rather than a bare list — an easy shape to get wrong, because the
 * obvious reading parses without error and yields nothing.
 */
export interface AnnotationListResponse {
  /** skeleton id → the annotations on its neuron. */
  skeletons: Record<string, { annotations: { id: number; uid: number }[] }>
  /** annotation id → name, for everything referenced above. */
  annotations: Record<string, string>
  /** skeleton id → the neuron's free-text name. */
  neuronnames: Record<string, string>
  /** annotation id → the annotations *on that annotation*. */
  metaannotations: Record<string, { annotations: { id: number; uid: number }[] }>
}

export function annotationList(
  server: string,
  projectId: number,
  skeletonIds: readonly number[],
  options?: CatmaidRequestOptions,
): Promise<AnnotationListResponse> {
  return catmaidPost<AnnotationListResponse>(
    server,
    `/${projectId}/skeleton/annotationlist`,
    { skeleton_ids: skeletonIds, metaannotations: 1, neuronnames: 1 },
    options,
  )
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * Partners of a set of skeletons, query-relative.
 *
 * The per-partner value is `{num_nodes, skids: {querySkid: [c1..c5]}}`, and **that array is
 * synapse counts bucketed by confidence 1–5, so the weight is its sum**. Taking the last element
 * — which is where the overwhelming majority sit, so it looks right — undercounts: on skeleton
 * 16's outgoing partners the sum is 3,070 against 3,039, checked against 3,069 ground-truth
 * links from the connector table. A one-percent error that no assertion on shape would catch.
 */
export interface ConnectivityResponse {
  incoming: Record<string, { num_nodes: number; skids: Record<string, number[]> }>
  outgoing: Record<string, { num_nodes: number; skids: Record<string, number[]> }>
}

export function skeletonConnectivity(
  server: string,
  projectId: number,
  skeletonIds: readonly number[],
  options?: CatmaidRequestOptions,
): Promise<ConnectivityResponse> {
  return catmaidPost<ConnectivityResponse>(
    server,
    `/${projectId}/skeletons/connectivity`,
    { source_skeleton_ids: skeletonIds, boolean_op: 'OR', with_nodes: false },
    options,
  )
}

/** Sum a confidence-bucketed count array. One function, so the rule above is stated once. */
export function synapseWeight(byConfidence: readonly number[] | undefined): number {
  if (!byConfidence) return 0
  let total = 0
  for (const count of byConfidence) total += count
  return total
}

/** Sparse `{sourceSkid: {targetSkid: weight}}`. Absent pairs are zero. */
export function connectivityMatrix(
  server: string,
  projectId: number,
  rows: readonly number[],
  columns: readonly number[],
  options?: CatmaidRequestOptions,
): Promise<Record<string, Record<string, number>>> {
  return catmaidPost<Record<string, Record<string, number>>>(
    server,
    `/${projectId}/skeleton/connectivity_matrix`,
    { rows, columns },
    options,
  )
}

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

/**
 * One skeleton: `[nodes, connectors, tags]`.
 *
 * A node is `[id, parentId, creatorId, x, y, z, radius, confidence]` with `parentId` null at the
 * root and `radius` −1 where unset. A connector link is `[nodeId, connectorId, relation, x, y,
 * z]`, relation 0 presynaptic and 1 postsynaptic.
 *
 * **GET, and anonymous** — which is what lets morphology work on a public instance with no token
 * at all. It is also the most expensive thing here by a wide margin: ~0.9–1.3 MB per neuron,
 * uncompressed, because the server does not gzip. See `docs/catmaid_vfb.md`.
 */
export type CompactNode = [
  number,
  number | null,
  number,
  number,
  number,
  number,
  number,
  number,
]
export type CompactConnector = [number, number, number, number, number, number]
export type CompactSkeleton = [CompactNode[], CompactConnector[], Record<string, number[]>]

export function compactSkeleton(
  server: string,
  projectId: number,
  skeletonId: number,
  withConnectors: boolean,
  options?: CatmaidRequestOptions,
): Promise<CompactSkeleton> {
  return catmaidGet<CompactSkeleton>(
    server,
    `/${projectId}/skeletons/${skeletonId}/compact-detail`,
    { with_connectors: withConnectors, with_tags: true },
    options,
  )
}

/** Cable length in nanometres, per skeleton. GET, anonymous, and cheap. */
export function cableLengths(
  server: string,
  projectId: number,
  skeletonIds: readonly number[],
  options?: CatmaidRequestOptions,
): Promise<Record<string, number>> {
  return catmaidGet<Record<string, number>>(
    server,
    `/${projectId}/skeletons/cable-length`,
    { skeleton_ids: skeletonIds },
    options,
  )
}

export interface SkeletonSummary {
  skeleton_id: number
  num_nodes: number
  cable_length: number
}

/**
 * Node count and cable length together, which is what the neuron table wants.
 *
 * **POST, though the endpoint answers both** — because the caller asks about every skeleton in
 * the project at once, and 5,601 indexed ids is roughly 90 kB of query string, well past what
 * any server will accept on a GET. Measured as a POST: 1.77 MB and 0.72 s for the whole of FAFB,
 * which is what makes these two real columns in the index rather than declared-and-always-null.
 */
export function skeletonSummaries(
  server: string,
  projectId: number,
  skeletonIds: readonly number[],
  options?: CatmaidRequestOptions,
): Promise<Record<string, SkeletonSummary>> {
  return catmaidPost<Record<string, SkeletonSummary>>(
    server,
    `/${projectId}/skeletons/summary`,
    { skeleton_ids: skeletonIds },
    options,
  )
}

/**
 * Connector links for a set of skeletons, one relation at a time.
 *
 * A link is `[skeletonId, connectorId, x, y, z, confidence, userId, treenodeId, created,
 * edited]`. **GET works**, which is the one piece of luck in this backend: synapse clouds need
 * no token even though connectivity does.
 */
export interface LinksResponse {
  links: [number, number, number, number, number, number, number, number, string, string][]
}

export function connectorLinks(
  server: string,
  projectId: number,
  skeletonIds: readonly number[],
  relation: 'presynaptic_to' | 'postsynaptic_to',
  options?: CatmaidRequestOptions,
): Promise<LinksResponse> {
  return catmaidGet<LinksResponse>(
    server,
    `/${projectId}/connectors/links/`,
    { skeleton_ids: skeletonIds, relation_type: relation },
    options,
  )
}

// ---------------------------------------------------------------------------
// Volumes — the neuropil shells
// ---------------------------------------------------------------------------

/**
 * The volume list, as a column table rather than records.
 *
 * `{columns: [...], data: [[...], ...]}`, which is a shape worth handling rather than assuming:
 * the obvious `VolumeRow[]` reading yields `undefined` for every field with no error. `area` and
 * `volume` are precomputed server-side, in nm² and nm³.
 */
export interface VolumeListResponse {
  columns: string[]
  data: (string | number | boolean | null)[][]
}

export function listVolumes(
  server: string,
  projectId: number,
  options?: CatmaidRequestOptions,
): Promise<VolumeListResponse> {
  return catmaidGet<VolumeListResponse>(server, `/${projectId}/volumes/`, {}, options)
}

/** One volume, whose `mesh` is an X3D `<IndexedTriangleSet>` string. See `x3d.ts`. */
export interface VolumeDetail {
  id: number
  name: string
  comment: string | null
  mesh: string
  bbox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
}

export function volumeDetail(
  server: string,
  projectId: number,
  volumeId: number,
  options?: CatmaidRequestOptions,
): Promise<VolumeDetail> {
  return catmaidGet<VolumeDetail>(server, `/${projectId}/volumes/${volumeId}`, {}, options)
}

/** Skeleton ids are small integers here, but the seam carries text (invariant 8). */
