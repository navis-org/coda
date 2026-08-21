/**
 * Shared helpers for nodes that consume a Dataset socket.
 *
 * The recurring problem: edit-time code needs dataset metadata (column schemas, ROI
 * lists, statuses) but only has a *type*, not a value. The Dataset node solves this by
 * refining its output type with `sourceId`/`datasetId`; everything here reads that
 * refinement back out.
 */

import type { CodaType } from '../../core/types'
import { datasetRef } from '../../core/types'
import type { AnnotationsValue, DatasetValue, Value } from '../../core/values'
import { isDatasetValue } from '../../core/values'
import type {
  DataSource,
  DatasetInfo,
  SourceCapabilities,
  SourceSchemas,
} from '../../data/source'
import { withAnnotations } from '../../data/annotations/schema'
import { CANONICAL_SCHEMAS, allSources, getSource } from '../../data/source'

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
 */
export function sourceSupports(
  ctx: { inputs: Record<string, CodaType | undefined> },
  capability: keyof SourceCapabilities,
): boolean {
  const source = sourceFromType(ctx.inputs['dataset'])
  return source ? source.capabilities[capability] : true
}

/** The source behind a Dataset socket, for a message that names it. */
export function sourceLabel(type: CodaType | undefined): string | undefined {
  return sourceFromType(type)?.label
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
  return withAnnotations(schemasById(source, dataset.datasetId), dataset.annotations?.table.schema)
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
export function datasetRequest(dataset: DatasetValue): {
  datasetId: string
  annotations?: AnnotationsValue
} {
  return {
    datasetId: dataset.datasetId,
    ...(dataset.annotations ? { annotations: dataset.annotations } : {}),
  }
}
