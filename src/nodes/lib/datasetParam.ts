/**
 * Shared helpers for nodes that consume a Dataset socket.
 *
 * The recurring problem: edit-time code needs dataset metadata (column schemas, ROI
 * lists, statuses) but only has a *type*, not a value. The Dataset node solves this by
 * refining its output type with `sourceId`/`datasetId`; everything here reads that
 * refinement back out.
 */

import type { CodaType, PopulationFilter } from '../../core/types'
import type { EnumOption } from '../../core/node'
import { datasetRef } from '../../core/types'
import type { DatasetValue, Value } from '../../core/values'
import { isDatasetValue } from '../../core/values'
import type {
  DataSource,
  DatasetInfo,
  DatasetRequest,
  EdgeAnswerableRequest,
  SourceCapabilities,
  SourceSchemas,
} from '../../data/source'
import { withAnnotations } from '../../data/annotations/schema'
import { backendName } from './datasetFamilies'
import {
  CANONICAL_SCHEMAS,
  allSources,
  backendOf,
  canSplitConnectivityByRoi,
  canTotalSynapses,
  canTracePaths,
  capabilityOf,
  getSource,
} from '../../data/source'

/** Source referenced by a dataset-typed socket, if it is registered. */
export function sourceFromType(type: CodaType | undefined): DataSource | undefined {
  const ref = datasetRef(type)
  return ref?.sourceId ? getSource(ref.sourceId) : undefined
}

/**
 * Edit-time capability check, so a source that cannot do the thing says so on the node rather
 * than failing at Run.
 *
 * Unknown sources are assumed capable — a warning we cannot substantiate is worse than no
 * warning. Written out four times before this, once per node that needed it, and the fourth
 * had drifted into name-checking `sourceId === 'mock'`: correct only until a second source
 * cannot run Cypher, and its message named neuPrint by hand.
 *
 * **Takes the type, not the context**, like every other reader in this file. It used to take
 * `(ctx, capability)` and dig `ctx.inputs.dataset` out itself, which made it the one helper here
 * that knew what a Dataset socket is *called* — and a variadic node's sockets are called
 * `dataset1`, `dataset2`, …. Adding a port-id argument answered that and left the node
 * reconstructing `` `dataset${i}` `` to pass in, which is the concatenation
 * [core.md](../../../docs/core.md) forbids a variadic body from doing. With a type, the caller
 * already holds a resolved port and the question never arises.
 */
export function sourceSupports(
  type: CodaType | undefined,
  capability: keyof SourceCapabilities,
): boolean {
  const source = sourceFromType(type)
  const datasetId = datasetRef(type)?.datasetId
  // `paths` is the one capability an attached edge set can *add*, so it has its own resolver —
  // shared with the two run-time readers, which had drifted apart. Connectivity and adjacency
  // are required methods rather than capabilities, so there is nothing there to unlock.
  const edges = type?.kind === 'dataset' && type.edges === true
  if (capability === 'paths') return canTracePaths(source, datasetId, edges)
  // The two an edge set *removes*, for the reasons written at each predicate: a file of
  // `pre, post, weight` carries no regions, and its weights are not the population the backend's
  // synapse totals count.
  if (capability === 'connectivityRois')
    return canSplitConnectivityByRoi(source, datasetId, edges)
  if (capability === 'synapseTotals') return canTotalSynapses(source, datasetId, edges)
  return capabilityOf(source, datasetId, capability)
}

/** The source behind a Dataset socket, for a message that names it. */
export function sourceLabel(type: CodaType | undefined): string | undefined {
  return sourceFromType(type)?.label
}

/**
 * The backend on a Dataset socket where it is **not** the one asked for, spelled for prose —
 * `neuPrint`, `CATMAID` — or undefined where it matches, or where the type does not say yet.
 *
 * `sourceSupports` is the check for anything reachable through `DataSource`, and it is the one to
 * reach for first: a capability is per dataset, so it can say "this datastack has no skeletons"
 * where a backend name can only say "CAVE". This is for the other kind — a node whose work is
 * written against one backend's own API rather than against the seam. `Update root IDs` calls a
 * chunkedgraph and `CAVE table` reads an annotation table; neither is a source method, so there is
 * no capability to declare and no per-dataset answer to give. Both used to accept any Dataset and
 * fail at Run, one of them with `"male-cns:v1.0" does not name a CAVE dataset` — a message about a
 * grammar, three layers from the wire that caused it.
 *
 * Returns the name rather than a boolean so the node writes its own sentence. What is wrong
 * differs per node even when the check does not — root ids do not move outside CAVE, and a
 * neuPrint dataset names no datastack — and one shared message would have to be vague about both.
 *
 * **An unresolved socket refuses nothing**, which is `capabilityOf`'s rule and matters more here:
 * no `sourceId` is the ordinary state before a listing lands (invariant 2), and the reference
 * ports these two nodes use are also the ports somebody leaves unwired on purpose.
 */
export function foreignBackend(
  type: CodaType | undefined,
  backend: string,
): string | undefined {
  const sourceId = datasetRef(type)?.sourceId
  if (!sourceId) return undefined
  const actual = backendOf(sourceId)
  return actual === backend ? undefined : backendName(actual)
}

/**
 * Column schemas to advertise downstream.
 *
 * Three levels of fallback, narrowest first: the dataset's own schema where the source
 * knows it, the source's default, then the canonical shape so column pickers work before a
 * Dataset node is even connected. All synchronous — this is called from `inferOutputs`.
 *
 * The dataset-specific level is what lets hemibrain offer `cellBodyFiber` and manc offer
 * `hemilineage` from the same Find Neurons node.
 */
export function schemasFromType(type: CodaType | undefined): SourceSchemas {
  const ref = datasetRef(type)
  const source = sourceFromType(type)
  if (!source) return CANONICAL_SCHEMAS
  const schemas = ref?.datasetId ? schemasById(source, ref.datasetId) : source.schemas
  return withAnnotations(schemas, type?.kind === 'dataset' ? type.annotations : undefined)
}

/**
 * The same narrowing, from a resolved source and dataset id rather than from a type.
 *
 * `evaluate` holds a `DatasetValue`, not a `CodaType`, so it cannot call `schemasFromType` —
 * and a node that declares one schema at edit time and builds another at run time breaks
 * invariant 3 in the one direction no type check catches. Both halves go through here.
 */
export function schemasForDataset(source: DataSource, dataset: DatasetValue): SourceSchemas {
  /*
   * Takes the whole handle, not an id, so the annotation substitution cannot be skipped. It took
   * `DatasetValue | string` for a moment and one caller duly passed `dataset.datasetId` while
   * holding `dataset` — which is the shape of the bug this function's own comment describes,
   * reintroduced by the widening meant to fix it. A union here is an invitation.
   */
  return withAnnotations(
    schemasById(source, dataset.datasetId),
    dataset.annotations?.table.schema,
  )
}

/**
 * A source's schemas for a dataset id, before any annotation substitution.
 *
 * The type half's building block: `schemasFromType` reads the chain off the *type* (where it is
 * a `TableSchema`) rather than off a value, so it substitutes itself. Nothing else should call
 * this — a caller with a `DatasetValue` wants `schemasForDataset`.
 */
function schemasById(source: DataSource, datasetId: string): SourceSchemas {
  return source.schemasFor?.(datasetId) ?? source.schemas
}

/** Dataset metadata for edit-time enums (ROIs, statuses). Undefined until cached. */
export function datasetInfoFromType(type: CodaType | undefined): DatasetInfo | undefined {
  const ref = datasetRef(type)
  if (!ref?.sourceId || !ref.datasetId) return undefined
  return getSource(ref.sourceId)?.peekDataset(ref.datasetId)
}

/**
 * The region names a Dataset socket offers a picker, alphabetically.
 *
 * Two nodes ask — the ROI Viewer and Connectivity — and they are the only region pickers in the
 * app. Written per node, both carried their own copy of the rule *and* of the reason for it,
 * which is the shape a third one would have inherited.
 *
 * **Alphabetical, overriding the source's own order.** `DatasetInfo.rois` arrives "in a sensible
 * display order", which is right for a list somebody *reads* — it groups a hierarchy the way the
 * dataset thinks about it. This is a list somebody *searches*, one name at a time, in a dropdown
 * of a hundred and forty-four, and the only order that helps there is the one the eye can
 * binary-search.
 *
 * `primaryOnly` picks the vocabulary: the subset that tiles the volume, or everything published.
 * The two differ by a lot — male-CNS lists 5,619 regions against 144 that tile — so this is not
 * a filter over a list of roughly the same size.
 */
export function roiOptions(
  type: CodaType | undefined,
  options: { primaryOnly?: boolean } = {},
): EnumOption[] {
  const info = datasetInfoFromType(type)
  const names = options.primaryOnly ? (info?.primaryRois ?? []) : (info?.rois ?? [])
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((roi) => ({ value: roi, label: roi }))
}

/** Resolve the `source` param, falling back to the first registered source. */
export function resolveSourceId(raw: unknown): string {
  const sources = allSources()
  if (typeof raw === 'string' && raw && sources.some((s) => s.id === raw)) return raw
  return sources[0]?.id ?? 'mock'
}

/**
 * Resolve the `dataset` param. An empty value means "first dataset of this source",
 * resolved identically at infer and eval time so cache keys stay stable.
 */
export function resolveDatasetId(sourceId: string, raw: unknown): string | undefined {
  const source = getSource(sourceId)
  const available = source?.peekDatasets()
  if (typeof raw === 'string' && raw) {
    if (!available) return raw // not yet listed; trust the stored value
    if (available.some((d) => d.id === raw)) return raw
  }
  return available?.[0]?.id
}

/** Unwrap a Dataset socket value, with a message that says which port is at fault. */
export function requireDataset(value: Value | undefined, portLabel = 'Dataset'): DatasetValue {
  if (!isDatasetValue(value)) {
    throw new Error(`${portLabel} input is not a dataset`)
  }
  return value
}

/** Enum option list for a "no filter" choice. */
export const ANY_OPTION = { value: '', label: 'Any' }

/**
 * The dataset half of a source request: the id, and the labels that go with it.
 *
 * **Both together, deliberately.** Every request on the seam starts `datasetId: dataset.datasetId`
 * and a wired chain has to ride alongside it — so a call site that spreads this cannot supply one
 * without the other. Passing the annotations separately is how five call sites came to advertise
 * the chain's columns at edit time and return the datastack's rows at run time: invariant 3
 * across a seam, silent, and caught only by reading every caller.
 *
 * The deeper fix is for these methods to take the `DatasetValue` itself rather than an id plus
 * fields peeled off it, which would make the omission unrepresentable. That is a change to every
 * source and every query node; this is the shape that makes the pair hard to split meanwhile.
 */
export function datasetRequest(dataset: DatasetValue): DatasetRequest {
  return {
    datasetId: dataset.datasetId,
    ...(dataset.annotations ? { annotations: dataset.annotations } : {}),
  }
}

/**
 * The same, for the three questions a user-supplied edge set can answer.
 *
 * Separate from `datasetRequest` because `edges` is honoured by no source at all — only by the
 * funnel in `data/queries.ts`. Folded into the general projection it was spread into seven
 * requests that do not declare it (find, explore, all three morphology fetches, input ids,
 * labels), and object spread does no excess-property checking, so nothing caught it.
 */
export function connectivityRequest(dataset: DatasetValue): EdgeAnswerableRequest {
  return {
    ...datasetRequest(dataset),
    ...(dataset.edges ? { edges: dataset.edges } : {}),
  }
}

/**
 * The same again, for the queries that answer **which neurons this dataset has**.
 *
 * Separate from `datasetRequest` for `connectivityRequest`'s reason turned around: `population`
 * is honoured by a source, but not by every call that names a dataset, and object spread does no
 * excess-property checking — so folding it into the general projection would apply it to seven
 * requests silently rather than to the two that mean it.
 *
 * Which two, and why the others are excluded, is the substance here:
 *
 *  - **`Input IDs`** looks up ids somebody pasted. Narrowing that to Traced deletes the rows they
 *    named, and reports the deletion as neurons the dataset does not have.
 *  - **The three morphology fetches** are keyed by id as well, one step further downstream.
 *  - **Connectivity, Paths, Adjacency** go through `connectivityRequest`, and their far end is
 *    matched as a bare node on purpose: a partner may be a `Segment` below the neuron threshold,
 *    and excluding those under-reports total synapse weight. See `connectivityCypher`.
 *  - **The neuron index** is never filtered on the wire at all. It is downloaded and cached
 *    whole, and `narrowPopulation` narrows it on load — so Explore, Match Cell Types and a
 *    Dataset Summary share one 26 MB table instead of one per reading of the same dataset.
 *
 * **A pure projection, like the other two.** It does not drop a filter the dataset cannot answer
 * — the *source* does that, against its own discovered schema, which is the authoritative copy.
 * Resolving here as well meant the same question answered twice against two schemas, with the
 * later one winning; the node-side peek is a synchronous fallback that can be a discovery behind.
 * `populationIssues` is what tells somebody a ticked box is not applying, and it reads the
 * discovered schema rather than this.
 */
export function neuronSetRequest(
  dataset: DatasetValue,
): DatasetRequest & { population?: readonly PopulationFilter[] } {
  return {
    ...datasetRequest(dataset),
    ...(dataset.population?.length ? { population: dataset.population } : {}),
  }
}
