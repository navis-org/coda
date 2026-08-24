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

/**
 * The floor on the gap between two `onPartial` calls, in milliseconds.
 *
 * One number for the whole app because a publish is not local: it repaints every card in the
 * graph (`ctx.publish` → `onPreview` → `previewVersion`), and a skeleton channel rebuilds its
 * one merged vertex buffer each time — `SkeletonLines` memoises on the value's identity, and a
 * partial mints a new one by definition. So the cost per publish scales with the scene, while
 * the benefit does not: nobody can read a count that changes sixty times a second.
 *
 * 250 ms is four repaints a second, which reads as continuous fill and leaves a 300-body sweep
 * publishing a dozen times rather than three hundred.
 */
const PUBLISH_INTERVAL_MS = 250

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
   * Fetch exactly the ids not already held, handing each one over as it lands.
   *
   * Called with the *missing* list rather than the whole one, which is the entire point and also
   * what keeps progress honest: a source reporting `n/total` reports against what it is fetching
   * rather than against what was asked for. **Not called at all when nothing is missing**, so a
   * fully-cached set costs zero requests rather than an empty round trip.
   *
   * `deliver` rather than a returned map, so that an item is cached and drawable the moment it
   * arrives instead of at the end of the sweep — that is what makes `onPartial` possible. It is
   * also one statement instead of two: the map it replaced had to be populated *and* returned,
   * and a worker that filled it but published nothing was a fan-out nobody could watch.
   */
  fetch: (missing: NeuronId[], deliver: (id: NeuronId, item: T) => void) => Promise<void>
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
  /**
   * Show what has arrived so far, in request order, while the rest is still in flight.
   *
   * Called from `deliver` and rate-limited to `PUBLISH_INTERVAL_MS`, on the leading edge only —
   * there is no trailing call and no timer to unwind, because the complete answer this function
   * returns *is* the trailing edge. A caller that turns this into a value hands it to
   * `ctx.publish`; see the two ordering rules there, both of which this satisfies by
   * construction.
   *
   * Never called when nothing was missing: a fully-cached set has no arrival to report and the
   * caller's own return value is already the whole thing.
   */
  onPartial?: (ordered: Array<[NeuronId, T]>) => void
  /**
   * Publish nothing until this settles.
   *
   * Every streaming source has a second request in flight — the attribute rows that a geometry
   * value's table is built from — and a partial assembled before it lands carries a null `type`
   * for every body, so a scene set to colour by type fills in grey and then restyles itself
   * wholesale when the last body arrives. Awaiting it *before* the fetch would be worse: on
   * CAVE's cold path that is a 139,255-row index build standing between the user and the first
   * byte of geometry.
   *
   * So the rule is "start it alongside, publish after", and it lives here because all three
   * sources need it and each had grown its own spelling — a boolean beside a nullable result, a
   * shadow copy of the awaited value, and a re-derivation of the condition that decided whether
   * to fetch at all. Stated once, a fourth backend gets it by construction.
   *
   * Settled, not fulfilled: a source that could not label its bodies should still draw them.
   * Nothing is read from it — the source keeps its own reference to whatever it started.
   */
  readyBefore?: Promise<unknown>
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
  const { ids, key, bytes, fetch, refresh, onFetched, onPartial, readyBefore } = request

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

  /** Everything answered for so far, in the caller's order. The same walk the return value does. */
  const orderedSoFar = (): Array<[NeuronId, T]> => {
    const out: Array<[NeuronId, T]> = []
    for (const id of ids) {
      const item = held_.get(id)
      if (item !== undefined) out.push([id, item])
    }
    return out
  }

  if (absent.length > 0) {
    /*
     * Readiness is checked *before* the throttle, so a publish the caller would have dropped
     * does not also spend the interval the next one has to wait out.
     *
     * And it is re-attempted when `readyBefore` settles rather than only on the next arrival.
     * A promise settles on a microtask, so even one that was already resolved flips this after
     * the first body has been handed over — without the retry, the opening publish is always
     * lost, and a fetch whose last body arrives before the rows land streams nothing at all.
     */
    let ready = readyBefore === undefined
    let arrived = false
    let done = false
    let lastPublish = 0

    const publish = (): void => {
      if (!onPartial || !ready || !arrived || done) return
      const now = Date.now()
      if (now - lastPublish < PUBLISH_INTERVAL_MS) return
      lastPublish = now
      onPartial(orderedSoFar())
    }
    const settle = (): void => {
      ready = true
      publish()
    }
    if (readyBefore) void readyBefore.then(settle, settle)

    await fetch(absent, (id, item) => {
      held_.set(id, item)
      write(key(id), item, bytes(item), Date.now())
      arrived = true
      publish()
    })
    // Past here the caller's own return value is the answer, and a late `settle` would publish
    // a partial that says the same thing one repaint before it.
    done = true
  }

  // `held_` is already the answered set, so asking it twice is cheaper than building a third
  // collection to ask instead.
  return { ordered: orderedSoFar(), missing: ids.filter((id) => !held_.has(id)) }
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
