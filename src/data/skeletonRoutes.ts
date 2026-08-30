/**
 * The ways a skeleton can be got, named once.
 *
 * A dataset does not have *a* skeleton source. It has however many its publishers happened to
 * put somewhere, and they are different products rather than copies of one: measured on
 * `male-cns:v1.0` body 45882, neuPrint's SWC and the precomputed layer beside the segmentation
 * are the same 1,688 nodes in the same nanometres — and only the SWC carries radii. Measured on
 * `minnie65_public`, the skeleton service answers 7,167 vertices with a radius on each where the
 * level-2 chunk graph answers a few hundred nodes. So which one answered is a fact about the
 * result, not about the dataset, and it is the user's to choose.
 *
 * ## The ids are shared across backends, deliberately
 *
 * `published` means the same thing on neuPrint, on CAVE and on a Neuroglancer Source node — a
 * `neuroglancer_skeletons` directory somebody published — even though three different code paths
 * open it. That is what lets a graph keep meaning something when its Dataset node is repointed:
 * a Skeletons node pinned to `published` against male-CNS still says "the published ones" against
 * FlyWire, rather than resolving to a route id no other backend has ever heard of.
 *
 * They are stored in saved graphs and folded into provenance keys (invariant 4), so an id here is
 * as good as public API: rename one and every graph pinned to it starts refusing.
 *
 * ## Which one `automatic` picks is each source's own call
 *
 * There is no global ranking here, because the ranking is a fact about a backend's routes rather
 * than about the names — CAVE prefers `published` over `service` over `l2`, and neuPrint prefers
 * its own SWC over `published` because the SWC has radii and the bucket does not. What is shared
 * is only the vocabulary.
 */

import type { SkeletonProvenance } from '../core/values'

/**
 * Route ids, as constants rather than string literals at each use site.
 *
 * The list a node offers and the branch a source takes are written in different files and are
 * the two halves of one decision — invariant 3's shape, one layer down. A typo in either
 * spelling is a route that is offered and then refused, or worse, one that silently never wins.
 */
export const SKELETON_ROUTES = {
  /** A `neuroglancer_skeletons` directory published beside a segmentation. */
  published: 'published',
  /** neuPrint's own `/api/skeletons/skeleton` SWC. */
  neuprint: 'neuprint',
  /** CAVE's skeleton service — a precomputed endpoint that generates on demand and caches. */
  service: 'service',
  /** Built from a CAVE chunkedgraph's level-2 cache: one node per chunk. */
  l2: 'l2',
  /** CATMAID's manually traced skeletons. */
  catmaid: 'catmaid',
  /** Generated in the browser by the mock source. */
  synthetic: 'synthetic',
} as const

export type SkeletonRouteId = (typeof SKELETON_ROUTES)[keyof typeof SKELETON_ROUTES]

/**
 * A stored param value as a route id, or `undefined` for anything this build does not know.
 *
 * The one narrowing between a saved document and `GeometryRequest.skeletonSource`, which is typed
 * as the union so a source's `switch` is checked rather than compared against free text. A graph
 * written by a later build can name a route this one has never heard of; reading that as "nobody
 * chose" is the same degradation every other unknown param value gets, and the alternative — a
 * cast — would put an id no source can serve into a request that then refuses it by accident.
 */
export function asSkeletonRoute(raw: unknown): SkeletonRouteId | undefined {
  const id = String(raw ?? '')
  return (Object.values(SKELETON_ROUTES) as string[]).includes(id)
    ? (id as SkeletonRouteId)
    : undefined
}

/**
 * What a route is called and what it costs, for the routes whose answer does not depend on which
 * dataset is asking.
 *
 * Only the ones that are genuinely the same sentence everywhere live here. CAVE's `published` is
 * *not* one of them — a flat FlyWire bucket is skeletonised at mip 1 and is seventy times an L2
 * skeleton, which is worth saying where it is offered — so each source is free to write its own
 * `detail`. What must not vary is the `label`, since that is what a card footer prints and two
 * spellings of one route read as two routes.
 */
const ROUTE_LABELS: Readonly<Record<SkeletonRouteId, string>> = {
  published: 'published skeletons',
  neuprint: 'neuPrint SWC',
  service: 'CAVE skeleton service',
  l2: 'level-2 chunk graph',
  catmaid: 'CATMAID tracing',
  synthetic: 'synthetic',
}

/** A route description, with the shared label and a per-source sentence. */
export function route(id: SkeletonRouteId, detail: string): SkeletonProvenance {
  return { id, label: ROUTE_LABELS[id], detail }
}
