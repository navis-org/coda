/**
 * Tables the user brought in themselves — a CSV of annotations, a cell-type list, an
 * embedding — kept in the browser and referenced from the graph.
 *
 * The rows never enter the `.coda.json`. A node stores a `dataId` and the filename it came
 * from; everything else lives here. That is the whole shape of the feature, and its two
 * consequences are worth stating plainly rather than discovering:
 *
 *  - A graph sent to a colleague arrives without its rows. The node says so and offers to
 *    re-pick the file; `evaluate` throws naming it, so everything downstream is `blocked`
 *    rather than quietly running on nothing.
 *  - Browser storage is per-origin and per-profile, is wiped by "clear site data", and does
 *    not exist in a private window. The file on disk is still the durable artefact.
 *
 * ## Why not `data/cache.ts`
 *
 * That module is a *cache*: expiry, fingerprint-as-miss, and a `cacheClear` that drops
 * everything. A table somebody uploaded is not evictable — losing it to a cache clear is
 * losing their data — so this takes its own database, the same call and the same reasoning as
 * `store/library.ts`. It cannot live beside that one: `src/store` imports `src/nodes`, so a
 * node reaching into the store would close a cycle. `src/data` is the layer nodes may import.
 *
 * ## Writes reject, reads resolve
 *
 * Inherited from `library.ts` for the same reason. Everywhere else here a storage failure
 * degrades silently, because failing to *remember* is not failing to compute; an upload
 * inverts that, because there is nothing to recompute from once the File handle is gone. So
 * `putUpload` propagates its error for the UI to show and there is no in-memory fallback for
 * it — something that survives until the tab reloads is not somewhere to put a file.
 *
 * ## The synchronous peek
 *
 * `inferOutputs` runs on every graph mutation, may not await and may not fetch (invariant 2),
 * but IndexedDB is asynchronous. So `peekUploadSchema` answers from an in-memory mirror and,
 * the first time it cannot, starts the read that will fill it — once per id, never once per
 * peek, because inference runs on every keystroke. When the read lands it fires
 * `reportUploadLearned`, and the store re-infers.
 *
 * This is exactly the `peekDatasets()` / `reportSourceLearned` pair one layer over, and it is
 * here for the same reason it is there: a synchronous peek is the only place a fetch can start
 * on inference's behalf, and being re-run when it lands is what closes the loop.
 */

import { hashString } from '../core/hash'
import type { TableSchema } from '../core/types'
import type { TableValue } from '../core/values'

const DB_NAME = 'coda-uploads'
const DB_VERSION = 1
/** Small descriptors, read on their own so a peek does not pull a 26 MB table with it. */
const META_STORE = 'meta'
/** The parsed tables, keyed by the same id. */
const TABLE_STORE = 'tables'

const NO_STORAGE = 'This browser has no storage available for uploads.'

/**
 * Refused before a byte is read.
 *
 * The ceiling is on the file rather than on the parsed result, because by the time a table
 * exists the tab has already been locked up for a minute — the same call `pivotTable` makes
 * when it checks label cardinalities instead of the array it is about to allocate. 50 MB is
 * comfortably above a whole-dataset embedding (male-CNS at 165k rows and a few floats is a few
 * MB) and well below what parses without a visible stall.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** What the card can say about an upload without loading it. */
export interface UploadMeta {
  id: string
  /** The file's own name, or a label for pasted text. Shown on the card and in errors. */
  name: string
  /** Size of the source text, for the card's readout. */
  bytes: number
  rows: number
  schema: TableSchema
  savedAt: number
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // `typeof` rather than truthiness: the identifier is simply absent under node.
    if (typeof indexedDB === 'undefined') return reject(new Error(NO_STORAGE))
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return reject(new Error(NO_STORAGE))
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE)
      if (!database.objectStoreNames.contains(TABLE_STORE)) database.createObjectStore(TABLE_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    // Private-mode Firefox rejects here; so does a browser with storage switched off.
    request.onerror = () => reject(new Error(NO_STORAGE))
    request.onblocked = () => reject(new Error(NO_STORAGE))
  })
}

/**
 * The open database, memoised on success only. A cached rejection would make one transient
 * failure permanent for the life of the tab, and the next attempt is exactly when to retry.
 */
function db(): Promise<IDBDatabase> {
  dbPromise ??= open().catch((err: unknown) => {
    dbPromise = undefined
    throw err
  })
  return dbPromise
}

function asError(err: unknown, fallback: string): Error {
  if (err instanceof Error) {
    if (err.name === 'QuotaExceededError') {
      return new Error('No room left in browser storage. Remove an upload and try again.')
    }
    return err
  }
  return new Error(fallback)
}

/**
 * One read-write transaction across both stores, resolving when it *commits*.
 *
 * Waiting for `complete` rather than for the requests is load-bearing: a quota failure lets
 * the `put` succeed and then aborts, so awaiting the request would report a save that was
 * rolled back — which for an upload means claiming to hold a file that is gone.
 */
async function write(run: (meta: IDBObjectStore, tables: IDBObjectStore) => void): Promise<void> {
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = database.transaction([META_STORE, TABLE_STORE], 'readwrite')
    } catch (err) {
      return reject(asError(err, NO_STORAGE))
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(asError(tx.error, 'The upload was rolled back'))
    tx.onerror = () => reject(asError(tx.error, 'The upload failed'))
    try {
      run(tx.objectStore(META_STORE), tx.objectStore(TABLE_STORE))
    } catch (err) {
      reject(asError(err, 'The upload failed'))
    }
  })
}

/** One read, resolving to `fallback` on any failure — broken storage reads as empty storage. */
async function read<T>(store: string, key: string, fallback: T): Promise<T> {
  try {
    const database = await db()
    return await new Promise<T>((resolve) => {
      let tx: IDBTransaction
      try {
        tx = database.transaction(store, 'readonly')
      } catch {
        return resolve(fallback)
      }
      const request = tx.objectStore(store).get(key)
      request.onsuccess = () => resolve((request.result as T | undefined) ?? fallback)
      request.onerror = () => resolve(fallback)
      tx.onabort = () => resolve(fallback)
    })
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// The learned channel
// ---------------------------------------------------------------------------

const learnedListeners = new Set<() => void>()

/**
 * Announce that an upload's schema is now peekable.
 *
 * Not a data-changed event: nothing here invalidates a cached result. It says only that
 * inference ran against "I do not know yet" and can now do better. Fired once per id, when its
 * meta lands.
 */
function reportUploadLearned(): void {
  revision++
  for (const listener of learnedListeners) listener()
}

/** Subscribe to `reportUploadLearned`. Returns an unsubscribe. */
export function subscribeUploadLearned(listener: () => void): () => void {
  learnedListeners.add(listener)
  return () => learnedListeners.delete(listener)
}

let revision = 0

/**
 * A counter that moves whenever anything here becomes knowable. The `useSyncExternalStore`
 * snapshot for a component reading the peek.
 *
 * A number rather than the peeked value itself, and that is not a stylistic choice — it is the
 * only correct snapshot. Both "still looking" and "not in this browser" peek to `undefined`,
 * so a snapshot of the *value* is identical either side of the read landing and React never
 * re-renders: the card sits on "looking for the stored rows…" forever, which is precisely the
 * state that has to resolve into an instruction. Same idiom, and the same reason, as the graph
 * store's `runVersion`.
 */
export function uploadRevision(): number {
  return revision
}

// ---------------------------------------------------------------------------
// The peek
// ---------------------------------------------------------------------------

/** Mirror of the meta store, for the synchronous peek. */
const metaMirror = new Map<string, UploadMeta | undefined>()
/** Ids whose read has been started, so inference does not queue one per keystroke. */
const started = new Set<string>()

function startLoad(id: string): void {
  if (started.has(id)) return
  started.add(id)
  void loadMeta(id)
}

/**
 * The schema of an upload, if it is already known in this session.
 *
 * Returns undefined both for "not loaded yet" and for "not in this browser", and the caller
 * cannot tell them apart — deliberately, because neither is something `inferOutputs` may
 * block on. The first resolves itself: the read this starts fires `reportUploadLearned` and
 * inference is re-run. The second is what the node's own error message is for.
 */
export function peekUploadSchema(id: string): TableSchema | undefined {
  if (!id) return undefined
  const known = metaMirror.get(id)
  if (known) return known.schema
  startLoad(id)
  return undefined
}

/** Same, for the card's readout — row count and filename, not only the columns. */
export function peekUploadMeta(id: string): UploadMeta | undefined {
  if (!id) return undefined
  const known = metaMirror.get(id)
  if (!known) startLoad(id)
  return known
}

/** Whether the peek has finished asking. Distinguishes "loading" from "not in this browser". */
export function uploadPeekSettled(id: string): boolean {
  return !id || metaMirror.has(id)
}

async function loadMeta(id: string): Promise<void> {
  const meta = await read<UploadMeta | undefined>(META_STORE, id, undefined)
  metaMirror.set(id, meta)
  // Fire even on a miss: a node whose data is absent has stopped waiting, and the card's
  // "not in this browser" state is only reachable once inference has been told.
  reportUploadLearned()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a parsed table and return its id.
 *
 * The id is **content-addressed** — a hash of the schema and every cell — and that is what
 * makes the provenance key honest without a nonce. Re-picking the same file yields the same
 * id, so nothing downstream re-runs; picking a different file yields a different one, so
 * everything downstream invalidates. Two nodes given the same file share one stored copy.
 *
 * Rejects rather than degrading. See the module note.
 */
export async function putUpload(name: string, table: TableValue, bytes: number): Promise<string> {
  const id = uploadId(table)
  const meta: UploadMeta = {
    id,
    name,
    bytes,
    rows: table.length,
    schema: table.schema,
    savedAt: Date.now(),
  }
  await write((metaStore, tableStore) => {
    metaStore.put(meta, id)
    tableStore.put(table, id)
  })
  metaMirror.set(id, meta)
  started.add(id)
  reportUploadLearned()
  return id
}

/** The stored table, or undefined when this browser does not have it. */
export async function getUpload(id: string): Promise<TableValue | undefined> {
  if (!id) return undefined
  return read<TableValue | undefined>(TABLE_STORE, id, undefined)
}

/** The stored descriptor, awaited rather than peeked. Also warms the peek's mirror. */
export async function getUploadMeta(id: string): Promise<UploadMeta | undefined> {
  if (!id) return undefined
  const meta = await read<UploadMeta | undefined>(META_STORE, id, undefined)
  metaMirror.set(id, meta)
  started.add(id)
  return meta
}

/**
 * Content address for a table.
 *
 * Walks every cell, which is the point: two files differing in one value must not collide,
 * because the id is the whole of this node's contribution to the provenance key. It is paid
 * once per upload rather than per graph edit, unlike `stableStringify` on a param.
 */
/**
 * Field separator for the content hash: ASCII unit separator, written as an escape.
 *
 * A separator is needed at all because the hash walks a joined string, and without one two
 * genuinely different files concatenate to the same text — a column holding `['ab', 'c']` and
 * one holding `['a', 'bc']` are both `abc`, so the two imports would share an id and the second
 * would silently resolve to the first one's rows. Escaped rather than typed literally, because
 * a raw control character in a source file is invisible to every reader and to `grep`.
 */
const SEP = '\u001f'

function uploadId(table: TableValue): string {
  const parts: string[] = [String(table.length)]
  for (const col of table.schema.columns) {
    parts.push(`${col.name}:${col.dtype}`)
    const data = table.data[col.name] ?? []
    for (const cell of data) parts.push(cell === null ? ' ' : String(cell))
  }
  return `u_${hashString(parts.join(SEP))}`
}

/** Whether an upload could survive a reload here. Drives what the node offers. */
export async function uploadsAvailable(): Promise<boolean> {
  try {
    await db()
    return true
  } catch {
    return false
  }
}

/** Test seam: forget the session's mirror and the memoised connection. */
export function resetUploads(): void {
  metaMirror.clear()
  started.clear()
  dbPromise = undefined
  // Not the revision: it only ever has to move, and rewinding it could hand a mounted
  // component the snapshot it is already holding.
  revision++
}
