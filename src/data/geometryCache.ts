/**
 * Geometry already downloaded, kept for the rest of the session.
 *
 * ## The problem this solves, measured
 *
 * A morphology node's provenance key is `hash(type, params, upstream keys)` — invariant 4 — so
 * it re-runs whenever *anything* about its Neurons input changes. Probed on a 12-neuron scene:
 * widening a type pattern from `LC4` to `LC4|LC6` asked the source for 21 ids of which 12 had
 * just been fetched, and an upstream Filter edit that kept every row asked for the same 12 again,
 * byte-identical list and all. Every one of those is an HTTP GET per body — or, for a graphene
 * mesh, several hundred.
 *
 * Nothing downstream caught it. `cache.ts`'s IndexedDB store holds neuron indexes, dataset
 * summaries, root-id lookups and annotation tables; geometry was never in it, and neuPrint's
 * `cached<>` helper is that server's own `/api/cached/` route rather than a client cache.
 *
 * ## Why here and not in the scheduler
 *
 * Because the graph is not wrong. Re-running is what a changed input *means*, and keying a node
 * on the content of its input instead of its provenance is exactly what invariant 4 forbids — it
 * would mean hashing every row of every table on every edit, which is the cost that rule exists
 * to avoid. What is wasteful is not the re-run; it is the re-download inside it. So the memo goes
 * below the `DataSource` seam, where the unit is a neuron rather than a node: the node still
 * re-runs, still asks for the whole list, and the source answers the part it already holds.
 *
 * Nothing about the graph changes — no port, no param, no scheduler rule, nothing new in a saved
 * file.
 *
 * ## Why holding it costs almost nothing
 *
 * The cache holds **the same typed arrays** the returned values hold, not copies. While a scene
 * is on screen its geometry is referenced by the scheduler's result cache anyway, so the marginal
 * memory is only for geometry no longer referenced by any live result. That is safe because the
 * transform nodes copy rather than mutate in place (`transformOps.ts` builds a `new
 * Float32Array`), and it is checked — see `geometryCache.test.ts`. A transform that started
 * writing through its input would corrupt every later reader of the same neuron, so that is an
 * invariant this file depends on rather than a coincidence.
 *
 * ## What it deliberately is not
 *
 * **Not persistent.** In memory, for the session. Skeletons and meshes are tens to hundreds of
 * megabytes of typed array; writing that through a structured clone into IndexedDB on every run
 * has a cost of its own, and the reported pain is within-session iteration. `cache.ts` remains
 * the persistent layer for tables.
 *
 * **Not a freshness policy.** A neuPrint body id and a CAVE root id both name immutable geometry
 * — an edit mints a new root id — so there is nothing to go stale. CATMAID is live tracing data
 * and is cached on the same terms by explicit decision; **Clear Cache** on the node is the way
 * back, which is why the morphology nodes declare `dataCache` and pass `ctx.refresh` through.
 * The card's `cached 12m ago ⟳` badge is the other half: nothing here ages silently.
 */

import type { NeuronId } from '../core/ids'

/**
 * How much geometry to hold, in bytes.
 *
 * A guard rail rather than a target, for the reason in the header: while a result is live its
 * arrays are referenced anyway, so this bounds the *orphaned* tail. Sized so the common loop —
 * adjust the neuron set, run again — always hits: a full `Max neurons` batch of skeletons is on
 * the order of 100 MB, and this holds that plus the batch before it.
 */
const BUDGET_BYTES = 256 * 1024 * 1024

interface Entry {
  value: unknown
  bytes: number
  /** When this was *fetched*, not when it was last read — it is what the age badge reports. */
  fetchedAt: number
}

/**
 * Insertion-ordered, and re-inserted on read, so `Map`'s own iteration order is the LRU queue.
 * The same trick `cameraMemo` and `layoutMemo` use, with a byte budget instead of a count
 * because the entries here differ in size by four orders of magnitude — a 264-byte coarse mesh
 * against a megabyte of densely traced CATMAID skeleton.
 */
const entries = new Map<string, Entry>()
let held = 0

function evict(): void {
  for (const [key, entry] of entries) {
    if (held <= BUDGET_BYTES) return
    entries.delete(key)
    held -= entry.bytes
  }
}

function read(key: string): Entry | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  // Re-insert to move it to the young end. Read counts as use; that is what LRU means.
  entries.delete(key)
  entries.set(key, entry)
  return entry
}

function write(key: string, value: unknown, bytes: number, fetchedAt: number): void {
  const existing = entries.get(key)
  if (existing) held -= existing.bytes
  entries.delete(key)
  entries.set(key, { value, bytes, fetchedAt })
  held += bytes
  evict()
}

export interface CachedGeometryRequest<T> {
  /** Every id the caller wants, in the order it wants them. Duplicates are collapsed. */
  ids: readonly NeuronId[]
  /**
   * The cache key for one id.
   *
   * Built by the caller because only the caller knows what the geometry is a function of. It
   * must name the source and the dataset — a body id means different things in two datasets —
   * and, for a mesh, the level of detail actually used: `chooseLod` picks one level for the whole
   * batch against the triangle budget, so the same id can legitimately be two different meshes.
   * A skeleton has no such parameter, which is why skeletons hit whenever the sets overlap and
   * meshes hit whenever the level also holds.
   */
  key: (id: NeuronId) => string
  /** Bytes this item occupies, for the budget. Typed-array `byteLength`s, not an estimate. */
  bytes: (item: T) => number
  /**
   * Fetch exactly the ids not already held.
   *
   * Called with the *missing* list rather than the whole one, which is the entire point and also
   * what keeps progress honest: a source reporting `n/total` reports against what it is fetching
   * rather than against what was asked for. **Not called at all when nothing is missing**, so a
   * fully-cached set costs zero requests rather than an empty round trip.
   */
  fetch: (missing: NeuronId[]) => Promise<Map<NeuronId, T>>
  /** Clear Cache: drop what is held *for these ids* and read them again. */
  refresh?: boolean
  /**
   * When the geometry being returned was actually fetched — the *stored* time for a hit and
   * `Date.now()` for a fresh read, exactly as `CachedTableSpec.onFetched` means it.
   *
   * Wired to `ctx.reportFetched`, so the card can say `cached 12m ago`. On a mixed batch the
   * oldest hit is what gets reported, which is right in both directions: the scheduler already
   * keeps the oldest report of a run, and what a reader needs to know is how stale the stalest
   * thing behind the answer is.
   */
  onFetched?: (at: number) => void
}

export interface CachedGeometryResult<T> {
  /**
   * What was found, **in the order the caller asked for**, ids nothing answered for omitted.
   *
   * Pairs rather than a bare map, because the order is the caller's and only the caller's list
   * knows it: a partly-cached batch resolves in whatever order the network returned, and a scene
   * that drew in that order would reshuffle itself every time somebody added a neuron. Every
   * caller wants exactly this, which is why it is computed here — it was five copies of
   * `ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!)` before, one per source.
   */
  ordered: Array<[NeuronId, T]>
  /** Ids nothing could answer for, in request order — what a source reports as `missing`. */
  missing: NeuronId[]
}

/**
 * Answer for a set of ids from what is held, fetching only the remainder.
 *
 * An id the source cannot answer for is simply absent from `ordered` and present in `missing`,
 * which is what every caller already does with a body that has no mesh. Note that a body which
 * fails to fetch is **not** remembered as absent: a transient failure must not become permanent
 * for the session, so the next call asks again.
 */
export async function cachedGeometry<T>(
  request: CachedGeometryRequest<T>,
): Promise<CachedGeometryResult<T>> {
  const { ids, key, bytes, fetch, refresh, onFetched } = request

  // Deduplicated, because a caller's list may repeat an id and fetching it twice is the bug this
  // whole file is about, in miniature.
  const wanted = [...new Set(ids)]
  if (refresh) {
    for (const id of wanted) {
      const entry = entries.get(key(id))
      if (!entry) continue
      entries.delete(key(id))
      held -= entry.bytes
    }
  }

  const held_ = new Map<NeuronId, T>()
  const absent: NeuronId[] = []
  let oldest: number | undefined

  for (const id of wanted) {
    const entry = read(key(id))
    if (!entry) {
      absent.push(id)
      continue
    }
    held_.set(id, entry.value as T)
    if (oldest === undefined || entry.fetchedAt < oldest) oldest = entry.fetchedAt
  }

  onFetched?.(oldest ?? Date.now())

  if (absent.length > 0) {
    const fetched = await fetch(absent)
    const now = Date.now()
    for (const [id, item] of fetched) {
      held_.set(id, item)
      write(key(id), item, bytes(item), now)
    }
  }

  const ordered: Array<[NeuronId, T]> = []
  const missing: NeuronId[] = []
  for (const id of ids) {
    const item = held_.get(id)
    if (item === undefined) missing.push(id)
    else ordered.push([id, item])
  }
  return { ordered, missing }
}

/** Bytes of a typed array, or 0 for anything without one — used by the `bytes` callbacks. */
export function byteLengthOf(...arrays: Array<ArrayBufferView | undefined>): number {
  let total = 0
  for (const array of arrays) total += array?.byteLength ?? 0
  return total
}

/** What the cache is holding, for tests and for anything that wants to report it. */
export function geometryCacheStats(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: held }
}

/** Test seam, and the reset a `Clear Cache` over everything would use. */
export function resetGeometryCache(): void {
  entries.clear()
  held = 0
}
