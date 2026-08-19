/**
 * Per-dataset column schemas.
 *
 * neuPrint datasets do not share a neuron schema: hemibrain has `cellBodyFiber` and
 * `somaRadius`, manc has `hemilineage` and `birthtime`, optic-lobe has `assignedOlHex1`.
 * Advertising one fixed schema everywhere would mean column pickers that either lie or
 * under-report, so `NeuPrintSource` learns each dataset's shape once and answers
 * `schemasFor(datasetId)` from cache — synchronously, because edit-time inference cannot
 * await.
 *
 * Two things this has to defend against:
 *
 *  - **ROI properties.** A neuron carries one boolean per ROI it innervates. On hemibrain
 *    that is 230 potential columns of pure noise in a picker, so they are subtracted by
 *    exact name against the dataset's own ROI list rather than guessed at by shape — `IB`
 *    and `INP` are ROIs and look nothing like one.
 *  - **Non-scalar properties.** `somaLocation` is a Neo4j point. A table cell cannot hold
 *    one, so it is dropped rather than stringified into something no encoding can read.
 */

import type { DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { SourceSchemas } from '../source'
import { CANONICAL_SCHEMAS } from '../source'

/**
 * Present in every dataset, and the order every query returns them in.
 *
 * These *are* Coda's canonical neuron columns — taken from `CANONICAL_SCHEMAS` rather than
 * restated, because column mapping is positional (the decoder matches `RETURN` order against
 * schema order) so a second copy that drifted in order would mis-map silently rather than
 * throw.
 */
export const CORE_NEURON_COLUMNS = CANONICAL_SCHEMAS.neurons.columns

const CORE_NAMES = new Set(CORE_NEURON_COLUMNS.map((c) => c.name))

/**
 * Never offered as a column, whatever the dataset says.
 *
 * `roiInfo` is the per-ROI blob the ROI Counts node unpacks — as a table cell it is a
 * kilobyte of JSON. The rest are Neo4j points or internal bookkeeping.
 */
const SUPPRESSED = new Set(['roiInfo', 'somaLocation', 'rootLocation', 'tosomaLocation'])

/**
 * A picker with two hundred entries is not a picker. Datasets that genuinely carry more
 * properties than this lose the tail; `extrasTruncated` reports it so the UI can say so.
 */
export const MAX_EXTRA_COLUMNS = 40

export interface DiscoveredSchema {
  neurons: TableSchema
  /** Extra property names, in the order they were added — what queries must RETURN. */
  extras: string[]
  extrasTruncated: boolean
}

/** neuPrint's `neuronProperties` type names, and what a sampled JSON value looks like. */
function dtypeOf(declared: string | undefined, sampled: unknown): DType | undefined {
  switch (declared) {
    case 'int':
    case 'long':
      return 'i64'
    case 'float':
    case 'double':
      return 'f64'
    case 'boolean':
      return 'bool'
    case 'string':
      return 'str'
    default:
      break
  }
  if (typeof sampled === 'number') return Number.isInteger(sampled) ? 'i64' : 'f64'
  if (typeof sampled === 'boolean') return 'bool'
  if (typeof sampled === 'string') return 'str'
  // An object or an all-null sample: no evidence it is a scalar, so leave it out.
  return undefined
}

export interface DiscoveryInput {
  /** `Meta.neuronProperties`, when the dataset has one: `{name: "int" | "string" | …}`. */
  declared?: Record<string, string> | undefined
  /** Property maps from a handful of real neurons. */
  sampled?: Array<Record<string, unknown>> | undefined
  /** Every ROI name in the dataset — subtracted from the candidates. */
  rois?: readonly string[] | undefined
}

/**
 * Build a dataset's neuron schema: the core seven, then whatever else it carries.
 *
 * Ordering is stable (declared properties in their own order, then sampled ones
 * alphabetically) so the same dataset produces the same schema on every connect — a schema
 * that reshuffles would reshuffle every column picker with it.
 */
export function discoverNeuronSchema(input: DiscoveryInput): DiscoveredSchema {
  const rois = new Set(input.rois ?? [])
  const sampledValues = new Map<string, unknown>()
  for (const neuron of input.sampled ?? []) {
    for (const [name, value] of Object.entries(neuron)) {
      if (value === null || value === undefined) continue
      if (!sampledValues.has(name)) sampledValues.set(name, value)
    }
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  const consider = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    if (CORE_NAMES.has(name) || SUPPRESSED.has(name) || rois.has(name)) return
    candidates.push(name)
  }
  for (const name of Object.keys(input.declared ?? {})) consider(name)
  for (const name of [...sampledValues.keys()].sort()) consider(name)

  const extras: string[] = []
  const columns = [...CORE_NEURON_COLUMNS]
  let truncated = false
  for (const name of candidates) {
    const dtype = dtypeOf(input.declared?.[name], sampledValues.get(name))
    if (!dtype) continue
    if (extras.length >= MAX_EXTRA_COLUMNS) {
      truncated = true
      break
    }
    extras.push(name)
    columns.push(column(name, dtype))
  }

  return { neurons: tableSchema(...columns), extras, extrasTruncated: truncated }
}

/**
 * The full `SourceSchemas` for a dataset.
 *
 * Connectivity, ROI counts and morphology are the canonical schemas unchanged — they are
 * derived from relationships and from `roiInfo`, not from neuron properties, so no dataset
 * varies them. Synapses deliberately drop the canonical `partnerId`/`partnerType`: neuPrint
 * models a synapse as a point that *has* partners via `SynapsesTo`, and resolving them would
 * turn one query into a join heavy enough to matter. Emitting the columns as permanent nulls
 * would be worse.
 */
export function schemasFor(discovered: DiscoveredSchema): SourceSchemas {
  return {
    ...CANONICAL_SCHEMAS,
    neurons: discovered.neurons,
    synapses: tableSchema(
      column('bodyId', 'i64'),
      column('type', 'str'),
      column('polarity', 'str'),
      column('confidence', 'f64'),
    ),
  }
}
