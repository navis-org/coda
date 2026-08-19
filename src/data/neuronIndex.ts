/**
 * Loading and caching a dataset's *neuron index* — one row per neuron, every scalar
 * property the dataset has.
 *
 * This is what makes the Explore widget possible. Fuzzy-searching every field of every
 * neuron cannot be a query per keystroke against a shared production Neo4j, so the whole
 * table is fetched once and searched locally. Measured on male-CNS v1.0: 165,122 Traced
 * neurons (176,422 in total) × 20 properties is 26 MB of JSON, 6.9 MB gzipped, ~5 s. In the
 * browser that parses in ~85 ms and substring-scans in ~6 ms, so local search is not merely
 * viable, it is faster than a round trip could ever be.
 *
 * Three jobs, all of which have bitten someone before:
 *
 *  1. **Deduplicate.** A graph can hold several Explore nodes on the same dataset, and the
 *     widget loads independently of the node's `evaluate`. Without in-flight dedupe, opening
 *     a starter graph fires the same 7 MB download two or three times over.
 *  2. **Persist across sessions,** so the wait is paid once per dataset rather than once per
 *     reload. `cache.ts` handles the storage; this decides what counts as still valid.
 *  3. **Invalidate on shape change.** The fingerprint is the column list, so an index cached
 *     before schema discovery learned about `superclass` is a miss rather than a table whose
 *     columns disagree with the type the editor is advertising downstream.
 */

import type { TableValue } from '../core/values'
import { cacheGet, cacheSet } from './cache'

export interface NeuronIndexRequest {
  datasetId: string
  /** Ignore any cached copy and re-fetch. Wired to the Explore node's `refresh` param. */
  refresh?: boolean
  /**
   * Coarse progress. There is deliberately no byte-level fraction: the response is gzipped,
   * so `Content-Length` describes the compressed stream while `response.body` yields
   * decompressed bytes, and a fraction built from the two is simply wrong. Phase notes plus
   * the indicator's indeterminate mode are honest; a fake percentage is not.
   */
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

/**
 * A month. The index is a released dataset's static metadata — neuPrint publishes a new
 * dataset *version* rather than mutating one in place — so this is about eventually noticing
 * a re-release, not about staying current. `refresh` is there for "now".
 */
export const NEURON_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface CachedTableSpec {
  /** Cache key. Include the source id and dataset id; nothing else keys the store. */
  key: string
  /** Shape identifier — a mismatch invalidates. For a table, its column names. */
  fingerprint: string
  refresh?: boolean
  maxAgeMs?: number
  fetch(): Promise<TableValue>
}

/** In-flight loads, so concurrent callers share one download. */
const inFlight = new Map<string, Promise<TableValue>>()

/**
 * Return a cached table, or fetch and cache one.
 *
 * The persistent write is deliberately *not* awaited: a 26 MB structured clone takes a few
 * hundred milliseconds, and making every first-time caller wait for it buys nothing — the
 * value is already in hand and already in the in-memory half of the cache.
 */
export function loadCachedTable(spec: CachedTableSpec): Promise<TableValue> {
  const existing = inFlight.get(spec.key)
  if (existing && !spec.refresh) return existing

  const load = (async () => {
    if (!spec.refresh) {
      const hit = await cacheGet<TableValue>(spec.key, {
        fingerprint: spec.fingerprint,
        maxAgeMs: spec.maxAgeMs ?? NEURON_INDEX_MAX_AGE_MS,
      })
      if (hit) return hit
    }
    const table = await spec.fetch()
    void cacheSet(spec.key, table, spec.fingerprint)
    return table
  })().finally(() => {
    inFlight.delete(spec.key)
  })

  inFlight.set(spec.key, load)
  return load
}

/** Cache key for a source's neuron index. One place, so a reader and a writer agree. */
export function neuronIndexKey(sourceId: string, datasetId: string): string {
  return `neuron-index:${sourceId}:${datasetId}`
}

/**
 * Cache key for one of a dataset's precomputed roll-ups.
 *
 * Same store and same reasoning as the neuron index, at a much smaller scale: these are
 * kilobytes rather than megabytes, so persistence is a nicety — what actually matters is the
 * *in-flight deduplication* `loadCachedTable` brings, because a graph can easily hold an ROI
 * node and two Summary cards pointed at one dataset and there is no reason for three requests.
 *
 * `kind` is in the key rather than a separate store because the two summaries have different
 * shapes and a shared key would let one answer for the other.
 */
export function datasetSummaryKey(kind: string, sourceId: string, datasetId: string): string {
  return `dataset-summary:${kind}:${sourceId}:${datasetId}`
}

/** Test seam: drop in-flight state between cases. */
export function resetIndexLoads(): void {
  inFlight.clear()
}
