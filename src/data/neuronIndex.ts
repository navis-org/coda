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
 *
 * A fourth job arrived with the dataset card's `cached 3d ago ⟳`, and it belongs here for the
 * same reason the key builders do: it is the **inverse** of a key. Given a dataset, which
 * entries are about it, how old is the oldest, and drop them all. See `datasetCacheKey`.
 */

import type { DatasetAnnotations, TableValue } from '../core/values'
import { cacheDelete, cacheGetEntry, cacheKeys, cachePeek, cacheSet } from './cache'

export interface NeuronIndexRequest {
  datasetId: string
  /** Labels replacing the dataset's own — see `FindNeuronsRequest.annotations`. */
  annotations?: DatasetAnnotations
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
  /**
   * When the table being returned was actually fetched — `Date.now()` for a fresh read, and the
   * *stored* time for a hit.
   *
   * A callback rather than a widened return type, the shape `onProgress` already has here: every
   * caller wants the table and only one wants the age, so making it a pair would edit six call
   * sites to serve one. Not called when an in-flight promise is shared, since the caller that
   * started it is the one being told.
   */
  onFetched?: (at: number) => void
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
      const hit = await cacheGetEntry<TableValue>(spec.key, {
        fingerprint: spec.fingerprint,
        maxAgeMs: spec.maxAgeMs ?? NEURON_INDEX_MAX_AGE_MS,
      })
      if (hit) {
        spec.onFetched?.(hit.savedAt)
        return hit.value
      }
    }
    const table = await spec.fetch()
    const at = Date.now()
    spec.onFetched?.(at)
    void cacheSet(spec.key, table, spec.fingerprint)
    return table
  })().finally(() => {
    inFlight.delete(spec.key)
  })

  inFlight.set(spec.key, load)
  return load
}

/**
 * The shape every dataset-scoped cache key has: `kind:sourceId:datasetId[:variant]`.
 *
 * A convention rather than three key builders that merely resemble each other, because
 * something has to be able to ask the *opposite* question — "everything cached for this
 * dataset" — and answer it from the key alone. That is what the dataset card's `cached 3d ago`
 * reports and what its ⟳ drops, and a card that knew about the index but not the ROI outlines
 * would leave a stale copy behind while claiming to have cleared one.
 *
 * `kind` must not contain a colon; everything after the first one is the dataset scope. That is
 * load-bearing rather than tidy: a neuPrint dataset id is itself `hemibrain:v1.2.1`, so the
 * scope cannot be found by counting segments and is matched as a whole string instead.
 *
 * `variant` is for a cache whose contents depend on something outside the dataset id — the
 * neuron index under a wired annotation chain, where two graphs on one datastack hold genuinely
 * different tables. It is part of the key rather than of the fingerprint because a fingerprint
 * mismatch is a *miss that overwrites*: the second chain would evict the first, and the two
 * would take turns re-fetching for the rest of the session.
 */
export function datasetCacheKey(
  kind: string,
  sourceId: string,
  datasetId: string,
  variant = '',
): string {
  return `${kind}:${sourceId}:${datasetId}${variant && `:${variant}`}`
}

/** Cache key for a source's neuron index. One place, so a reader and a writer agree. */
export function neuronIndexKey(sourceId: string, datasetId: string, variant = ''): string {
  return datasetCacheKey('neuron-index', sourceId, datasetId, variant)
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
 * shapes and a shared key would let one answer for the other. It joins the *prefix* rather than
 * sitting between the source and the dataset, so `datasetCacheKey`'s one rule covers this too.
 */
export function datasetSummaryKey(kind: string, sourceId: string, datasetId: string): string {
  return datasetCacheKey(`dataset-summary-${kind}`, sourceId, datasetId)
}

/** Whether a cache key names this dataset, whatever kind of thing it holds. */
function isDatasetCacheKey(key: string, sourceId: string, datasetId: string): boolean {
  const kindEnd = key.indexOf(':')
  if (kindEnd < 0) return false
  const scope = `${sourceId}:${datasetId}`
  const rest = key.slice(kindEnd + 1)
  if (!rest.startsWith(scope)) return false
  // Either the whole scope, or the scope plus a variant — never a longer dataset id that merely
  // starts with this one, which is how `hemibrain:v1.2` would otherwise claim `v1.2.1`'s cache.
  const tail = rest.slice(scope.length)
  return tail === '' || tail.startsWith(':')
}

/** Every key the cache holds for this dataset — index, roll-ups, region outlines, variants. */
async function datasetCacheKeys(sourceId: string, datasetId: string): Promise<string[]> {
  return (await cacheKeys()).filter((key) => isDatasetCacheKey(key, sourceId, datasetId))
}

/**
 * When the *oldest* thing cached for this dataset was fetched, or undefined if nothing is.
 *
 * The oldest rather than the newest, because this number is read as "how old is what I am
 * looking at" and the answer is only as good as the stalest part of it. A summary re-fetched
 * this morning does not make a month-old neuron index fresh.
 *
 * Judged on the same expiry `loadCachedTable` applies, so an entry too old to be served reads
 * as no cache rather than as a very old one — the card and the loader agree about what is there.
 */
export async function peekDatasetCache(
  sourceId: string,
  datasetId: string,
): Promise<number | undefined> {
  const keys = await datasetCacheKeys(sourceId, datasetId)
  const entries = await Promise.all(
    keys.map((key) => cachePeek(key, { maxAgeMs: NEURON_INDEX_MAX_AGE_MS })),
  )
  let oldest: number | undefined
  for (const entry of entries) {
    if (!entry) continue
    if (oldest === undefined || entry.savedAt < oldest) oldest = entry.savedAt
  }
  return oldest
}

/**
 * Drop everything cached for this dataset.
 *
 * By key rather than by expiry, so an entry already too old to be served goes too: it is
 * invisible to `peekDatasetCache` and would otherwise sit in the store forever, since nothing
 * else ever deletes one.
 */
export async function dropDatasetCache(sourceId: string, datasetId: string): Promise<void> {
  const keys = await datasetCacheKeys(sourceId, datasetId)
  await Promise.all(keys.map((key) => cacheDelete(key)))
  // The in-flight map is keyed the same way, so a load started before the drop would otherwise
  // be handed to the caller that pressed ⟳ — the very copy it asked to replace.
  for (const key of keys) inFlight.delete(key)
}

/** Test seam: drop in-flight state between cases. */
export function resetIndexLoads(): void {
  inFlight.clear()
}
