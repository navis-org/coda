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
 */

const DB_NAME = 'coda'
const DB_VERSION = 1
const STORE = 'cache'

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
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
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

/** Promisify one IDB request, resolving to undefined on any failure. */
function request<T>(make: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode) {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined)
        try {
          const tx = db.transaction(STORE, mode)
          const req = make(tx.objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(undefined)
          tx.onabort = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

function fresh(envelope: Envelope | undefined, options: CacheGetOptions): boolean {
  if (!envelope) return false
  if (options.fingerprint !== undefined && envelope.fingerprint !== options.fingerprint)
    return false
  if (options.maxAgeMs !== undefined && Date.now() - envelope.savedAt > options.maxAgeMs)
    return false
  return true
}

/**
 * Read a cached value. Resolves undefined on a miss, a shape mismatch, an expiry, or any
 * storage failure — all four are the same thing to a caller.
 */
export async function cacheGet<T>(
  key: string,
  options: CacheGetOptions = {},
): Promise<T | undefined> {
  const held = memory.get(key)
  if (fresh(held, options)) return held!.value as T

  const stored = await request<Envelope>(
    (store) => store.get(key) as IDBRequest<Envelope>,
    'readonly',
  )
  if (!fresh(stored, options)) return undefined
  // Promote into memory so a second reader in the same session skips IndexedDB entirely.
  memory.set(key, stored!)
  return stored!.value as T
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
  await request((store) => store.put(envelope, key), 'readwrite')
}

export async function cacheDelete(key: string): Promise<void> {
  memory.delete(key)
  await request((store) => store.delete(key), 'readwrite')
}

/** Drop everything. Used by the Sources panel's "clear cached data" action and by tests. */
export async function cacheClear(): Promise<void> {
  memory.clear()
  await request((store) => store.clear(), 'readwrite')
}

/** Test seam: forget the opened database so a fresh environment is picked up. */
export function resetCache(): void {
  memory.clear()
  dbPromise = undefined
}
