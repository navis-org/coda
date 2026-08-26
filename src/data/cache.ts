/**
 * A small persistent key/value cache for the data layer.
 *
 * Exists because a neuron index is far too big for `localStorage`: male-CNS is 165k neurons
 * across ~20 properties, which is 26 MB of JSON — five times the entire localStorage budget.
 * IndexedDB has no such limit and, more usefully, stores structured clones, so a columnar
 * table goes in and comes back out as arrays without a JSON round trip.
 *
 * Two properties this has to keep:
 *
 *  - **Headless.** No React, no store, and no hard dependency on IndexedDB existing. Under
 *    vitest's node environment there is no `indexedDB` at all, and a browser in private mode
 *    can refuse to open one, so every path falls back to an in-memory Map. Callers cannot
 *    tell the difference apart from the cache being empty next session.
 *  - **Never fatal.** A cache miss and a broken cache must look the same to the caller. Every
 *    operation resolves rather than rejecting; a failed write is dropped silently, because a
 *    failure to *remember* something is not a failure to compute it.
 *
 * ## Why there is a second store holding nothing but timestamps
 *
 * IndexedDB has no partial read: `store.get(key)` deserialises the whole structured clone, and
 * for a neuron index that is 26 MB. So anything that wants only *when* a value was stored — the
 * dataset card's `cached 3d ago`, which every dataset node on the canvas asks on mount — would
 * pay a full deserialisation per card per session to read one number.
 *
 * `meta` is that number, written beside the value. A peek reads it and touches nothing else.
 * Entries written before this store existed have no record in it, so `cachePeek` falls back to
 * one full read and writes the sidecar as it goes: the cost is paid once per key and then never
 * again, and nothing has to be re-downloaded to get there.
 */

const DB_NAME = 'coda'
const DB_VERSION = 2
const STORE = 'cache'
/** Timestamps only, keyed exactly as `STORE` is. See the header. */
const META = 'meta'

/** What actually goes in the store, so `maxAgeMs` can be judged on read. */
interface Envelope {
  value: unknown
  /** Epoch ms. Callers decide what counts as too old. */
  savedAt: number
  /**
   * Opaque caller-supplied string describing the *shape* of the value — for the neuron index
   * this is the column list. A mismatch is a miss, which is what stops a cached table from
   * outliving the schema it was built for.
   */
  fingerprint: string
}

export interface CacheGetOptions {
  fingerprint?: string
  maxAgeMs?: number
}

/**
 * What a peek answers with: the envelope minus the expensive half.
 *
 * The same two fields `fresh` judges, so a peek and a read agree about what counts as a hit
 * without either having to state the rule twice.
 */
export interface CacheEntryMeta {
  savedAt: number
  fingerprint: string
}

const memory = new Map<string, Envelope>()

let dbPromise: Promise<IDBDatabase | undefined> | undefined

function openDb(): Promise<IDBDatabase | undefined> {
  dbPromise ??= new Promise<IDBDatabase | undefined>((resolve) => {
    // `typeof` rather than a truthiness check: the identifier is simply absent in node.
    if (typeof indexedDB === 'undefined') return resolve(undefined)
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        // Created, never recreated: a version bump that dropped `STORE` would make every user
        // re-download a dataset to gain a feature that only reads a timestamp.
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
      }
      request.onsuccess = () => resolve(request.result)
      // Private-mode Firefox rejects here; so does a browser with storage disabled.
      request.onerror = () => resolve(undefined)
      request.onblocked = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
  return dbPromise
}

/** Promisify one IDB read, resolving to undefined on any failure. */
function read<T>(store: string, make: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined)
        try {
          const tx = db.transaction(store, 'readonly')
          const req = make(tx.objectStore(store))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(undefined)
          tx.onabort = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

/**
 * One write across both stores, so a value and its timestamp cannot disagree.
 *
 * The value goes first on every path that writes both. `put` throws synchronously on something
 * that cannot be structured-cloned — a function, a DOM node — which this catches and drops; if
 * the meta record had been queued first it would already be in the transaction, and the store
 * would then claim a timestamp for a value it does not hold.
 */
function write(make: (cache: IDBObjectStore, meta: IDBObjectStore) => void): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve()
        try {
          const tx = db.transaction([STORE, META], 'readwrite')
          make(tx.objectStore(STORE), tx.objectStore(META))
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
          tx.onabort = () => resolve()
        } catch {
          resolve()
        }
      }),
  )
}

function fresh(entry: CacheEntryMeta | undefined, options: CacheGetOptions): boolean {
  if (!entry) return false
  if (options.fingerprint !== undefined && entry.fingerprint !== options.fingerprint) return false
  if (options.maxAgeMs !== undefined && Date.now() - entry.savedAt > options.maxAgeMs) return false
  return true
}

/**
 * Everything wanting to know when the cache changed.
 *
 * A cache write is the one event a card reading `cached 3d ago` cannot see: the download that
 * refreshes it belongs to a widget somewhere else on the canvas, or to a node's `evaluate`, and
 * neither has any relationship to the card. Without this the age would be right on mount and
 * wrong from the first Run — which is worse than not showing it, because it is a number that
 * looks maintained.
 *
 * Callbacks rather than anything React-shaped: this module is headless (invariant 1).
 */
const watchers = new Set<(key: string | undefined) => void>()

/**
 * Subscribe to writes and deletes. Returns the unsubscribe.
 *
 * The key is **undefined for a `cacheClear`**, meaning every key rather than none: the memory
 * map is not the whole cache, so a clear cannot enumerate what it dropped without a listing it
 * has no reason to pay for. A listener that filters by key has to treat undefined as a match.
 */
export function onCacheChange(listener: (key: string | undefined) => void): () => void {
  watchers.add(listener)
  return () => {
    watchers.delete(listener)
  }
}

function announce(key: string | undefined): void {
  if (key !== undefined) peeks.delete(key)
  else peeks.clear()
  for (const watcher of watchers) watcher(key)
}

/**
 * Read a cached value. Resolves undefined on a miss, a shape mismatch, an expiry, or any
 * storage failure — all four are the same thing to a caller.
 */
export async function cacheGet<T>(
  key: string,
  options: CacheGetOptions = {},
): Promise<T | undefined> {
  return (await cacheGetEntry<T>(key, options))?.value
}

/**
 * The same read, with **when the value was stored**.
 *
 * The age is the half a caller cannot reconstruct: a hit and a fresh fetch are indistinguishable
 * from the value alone, so anything wanting to say "this is a month-old copy of a base somebody
 * edits daily" has to be told. It was recorded from the start (`Envelope.savedAt`) and reachable
 * from nowhere.
 */
export async function cacheGetEntry<T>(
  key: string,
  options: CacheGetOptions = {},
): Promise<{ value: T; savedAt: number } | undefined> {
  const held = memory.get(key)
  if (fresh(held, options)) return { value: held!.value as T, savedAt: held!.savedAt }

  const stored = await read<Envelope>(STORE, (store) => store.get(key) as IDBRequest<Envelope>)
  if (!fresh(stored, options)) return undefined
  // Promote into memory so a second reader in the same session skips IndexedDB entirely.
  memory.set(key, stored!)
  return { value: stored!.value as T, savedAt: stored!.savedAt }
}

/** Peeks already in flight, so two dataset cards on one dataset share the backfill below. */
const peeks = new Map<string, Promise<CacheEntryMeta | undefined>>()

/**
 * **When** a value was stored, without deserialising it.
 *
 * The whole reason the `meta` store exists — see the header. Returns undefined on a miss and on
 * an entry `options` judges stale, which is the same answer `cacheGet` would give, so a card
 * saying "no cache" and a loader deciding to re-fetch cannot disagree.
 */
export function cachePeek(
  key: string,
  options: CacheGetOptions = {},
): Promise<CacheEntryMeta | undefined> {
  const held = memory.get(key)
  if (held) {
    return Promise.resolve(
      fresh(held, options) ? { savedAt: held.savedAt, fingerprint: held.fingerprint } : undefined,
    )
  }
  const existing = peeks.get(key)
  if (existing) return existing.then((entry) => (fresh(entry, options) ? entry : undefined))

  const load = (async () => {
    const meta = await read<CacheEntryMeta>(META, (store) => store.get(key) as IDBRequest<CacheEntryMeta>)
    if (meta) return meta
    /*
     * No sidecar: either there is nothing here, or this entry predates the `meta` store. Only a
     * full read can tell the two apart, so pay it once and leave a sidecar behind — the next
     * peek, this session or any later one, takes the cheap path.
     */
    const stored = await read<Envelope>(STORE, (store) => store.get(key) as IDBRequest<Envelope>)
    if (!stored) return undefined
    const backfilled: CacheEntryMeta = {
      savedAt: stored.savedAt,
      fingerprint: stored.fingerprint,
    }
    await write((_cache, metaStore) => {
      metaStore.put(backfilled, key)
    })
    return backfilled
  })().finally(() => {
    peeks.delete(key)
  })

  peeks.set(key, load)
  return load.then((entry) => (fresh(entry, options) ? entry : undefined))
}

/**
 * Every key the cache holds.
 *
 * Read off `STORE` rather than `META`, which is not interchangeable: an entry written before the
 * sidecar existed appears only here, and listing from `META` would hide exactly the entries
 * whose age nobody can otherwise see.
 *
 * `getAllKeys` returns primary keys, so this deserialises no values however large they are.
 */
export async function cacheKeys(): Promise<string[]> {
  const stored = await read<IDBValidKey[]>(STORE, (store) => store.getAllKeys())
  // Union, because the in-memory half is the whole cache when there is no IndexedDB at all.
  return [...new Set([...memory.keys(), ...(stored ?? []).map(String)])]
}

/**
 * Write a cached value.
 *
 * The in-memory copy is set synchronously and the persistent write is awaited, so a caller
 * that wants fire-and-forget should not await. Values that cannot be structured-cloned (a
 * function, a DOM node) are kept in memory and dropped from IndexedDB rather than throwing.
 */
export async function cacheSet(key: string, value: unknown, fingerprint = ''): Promise<void> {
  const envelope: Envelope = { value, savedAt: Date.now(), fingerprint }
  memory.set(key, envelope)
  announce(key)
  await write((cache, meta) => {
    cache.put(envelope, key)
    meta.put({ savedAt: envelope.savedAt, fingerprint }, key)
  })
}

export async function cacheDelete(key: string): Promise<void> {
  memory.delete(key)
  announce(key)
  await write((cache, meta) => {
    cache.delete(key)
    meta.delete(key)
  })
}

/** Drop everything. Used by the Sources panel's "clear cached data" action and by tests. */
export async function cacheClear(): Promise<void> {
  memory.clear()
  announce(undefined)
  await write((cache, meta) => {
    cache.clear()
    meta.clear()
  })
}

/** Test seam: forget the opened database so a fresh environment is picked up. */
export function resetCache(): void {
  memory.clear()
  peeks.clear()
  dbPromise = undefined
}
