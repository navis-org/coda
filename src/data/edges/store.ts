/**
 * The shelf of imported edge sets: a catalogue, and the chunked bytes behind each entry.
 *
 * An edge set is **named and attached**, not owned by the node that uses it. You import a file
 * once, name it, and point any dataset node at it; the node stores the id. That is the whole
 * difference from `uploads.ts`, which is content-addressed with no catalogue at all — and which
 * records the resulting limit in its own comments: *nothing collects orphans*. At fifty
 * kilobytes an upload that limit is tolerable. At a hundred megabytes an edge set it is not, so
 * this ships with the list, the rename and the delete that one is still missing.
 *
 * ## Why its own database
 *
 * `data/cache.ts` is a *cache* — expiry, fingerprint-as-miss, and a `cacheClear` that drops
 * everything. An edge set somebody imported is not evictable: it is authoritative, a graph
 * refuses without it, and losing it to a button labelled "clear cached data" would be losing
 * their data. Same call, and the same reasoning, as `uploads.ts` and `store/library.ts`.
 *
 * ## Writes reject, reads resolve
 *
 * Inherited from both, and it matters more here than anywhere: an import is a file the user
 * chose, parsed over seconds, and there is nothing to recompute it from once the handle is
 * gone. A save that quietly failed would be a catalogue entry pointing at nothing.
 *
 * ## The id is the content
 *
 * An edge set's id is a hash of the encoded arrays, so re-importing the same file is free and
 * idempotent — and, the property worth having, **a colleague who imports the same edge list
 * gets the same id**. A shared `.coda.json` names its edge set by content, so the refusal it
 * raises on a machine that lacks it is recoverable by importing the file rather than by asking
 * whoever sent it what they called theirs. The *name* is a label on top of that, and renaming
 * cannot break an attachment.
 *
 * ## Chunking
 *
 * The arrays go in as pieces of at most `CHUNK_BYTES`, keyed `<id>/<part>/<n>`. Two reasons and
 * only the first is about reading: a single structured clone of a hundred megabytes stalls the
 * tab on write, and a chunked write can report progress. Reads usually pull every chunk of a
 * part, because a query over five hundred scattered neurons touches most of them — sharding
 * earns its place at the writing end.
 */

import { hashBytes } from '../../core/hash'
import { channel } from '../channel'
import type { EdgeCsr, EdgeReport, EncodedEdges, IdArray, WeightArray } from './encode'
import { EDGE_FORMAT, edgeSetBytes } from './encode'

const DB_NAME = 'coda-edge-sets'
const DB_VERSION = 1
/** Catalogue entries. Small, and read on their own so a peek pulls no edges with it. */
const SET_STORE = 'sets'
/** The chunked typed arrays. */
const PART_STORE = 'parts'

const NO_STORAGE = 'This browser has no storage available for edge sets.'

/** Eight megabytes a chunk: large enough that the record count stays modest, small enough
 *  that one structured clone is not felt. */
const CHUNK_BYTES = 8 * 1024 * 1024

/** Ids per chunk of the dictionary, which is strings rather than bytes. */
const IDS_PER_CHUNK = 50_000

/** Which typed array a stored part is, so the destination can be allocated before reading. */
type ArrayKind = 'u8' | 'u16' | 'u32' | 'i32' | 'f64'

const PART_NAMES = [
  'out.offsets',
  'out.targets',
  'out.weights',
  'in.offsets',
  'in.targets',
  'in.weights',
] as const
type PartName = (typeof PART_NAMES)[number]

interface PartMeta {
  kind: ArrayKind
  /** Elements, not bytes — what the destination array is allocated with. */
  length: number
  chunks: number
}

/** What the catalogue holds. Small enough to list without touching a single edge. */
export interface EdgeSetMeta {
  /** Hash of the encoded content. Stable across machines for the same file. */
  id: string
  name: string
  /** Where it came from — a filename or a URL — for the panel to show. */
  origin: string
  createdAt: number
  format: number
  neurons: number
  edges: number
  bytes: number
  report: EdgeReport
  parts: Record<PartName, PartMeta>
  /** Dictionary chunk count; the ids themselves live in `PART_STORE` under `ids/<n>`. */
  idChunks: number
}

/** An edge set in memory, ready to answer. */
export interface LoadedEdgeSet {
  meta: EdgeSetMeta
  /** Dictionary, in index order. */
  ids: string[]
  /** The inverse, built on load: id text to dictionary index. */
  index: Map<string, number>
  out: EdgeCsr
  in: EdgeCsr
}

// ---------------------------------------------------------------------------
// Storage plumbing — the `uploads.ts` shape, deliberately
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error(NO_STORAGE))
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return reject(new Error(NO_STORAGE))
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SET_STORE)) database.createObjectStore(SET_STORE)
      if (!database.objectStoreNames.contains(PART_STORE))
        database.createObjectStore(PART_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    // Private-mode Firefox rejects here; so does a browser with storage switched off.
    request.onerror = () => reject(new Error(NO_STORAGE))
    request.onblocked = () => reject(new Error(NO_STORAGE))
  })
}

/** Memoised on success only: a cached rejection makes one transient failure permanent. */
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
      return new Error(
        'No room left in browser storage. Delete an edge set and try again — an edge set is ' +
          'far larger than anything else Coda keeps.',
      )
    }
    return err
  }
  return new Error(fallback)
}

/**
 * One read-write transaction across both stores, resolving when it **commits**.
 *
 * Waiting for `complete` rather than for the requests is load-bearing: a quota failure lets a
 * `put` succeed and then aborts, so awaiting the request would report an import that was rolled
 * back — a catalogue entry naming edges that are not there.
 */
async function write(
  run: (sets: IDBObjectStore, parts: IDBObjectStore) => void,
): Promise<void> {
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = database.transaction([SET_STORE, PART_STORE], 'readwrite')
    } catch (err) {
      return reject(asError(err, NO_STORAGE))
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(asError(tx.error, 'The edge set was rolled back'))
    tx.onerror = () => reject(asError(tx.error, 'The edge set could not be saved'))
    try {
      run(tx.objectStore(SET_STORE), tx.objectStore(PART_STORE))
    } catch (err) {
      reject(asError(err, 'The edge set could not be saved'))
    }
  })
}

/** One read, resolving to `fallback` on any failure — broken storage reads as empty storage. */
async function read<T>(store: string, key: IDBValidKey, fallback: T): Promise<T> {
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
// The learned channel — `reportSourceLearned`'s idiom, one layer over
// ---------------------------------------------------------------------------

const learned = channel()
let revision = 0

/**
 * Announce that the catalogue is now peekable.
 *
 * Not a data-changed event: nothing here invalidates a cached result. It says only that
 * inference ran against "I do not know yet" and can now do better — a dataset node's `validate`
 * asking whether the edge set it names is present.
 */
export function reportEdgeSetsLearned(): void {
  revision++
  learned.notify()
}

export const subscribeEdgeSetsLearned = learned.subscribe

/** A primitive, so a `useSyncExternalStore` snapshot over it is stable by identity. */
export function edgeSetsRevision(): number {
  return revision
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** The in-memory mirror the synchronous peek answers from. */
let catalogue: Map<string, EdgeSetMeta> | undefined
let listing: Promise<EdgeSetMeta[]> | undefined

/**
 * Every entry, or `undefined` while the first read is still in flight.
 *
 * `inferOutputs` and `validate` may not await (invariant 2), so this answers from the mirror and
 * — the first time it cannot — starts the read that will fill it. **Once per session, never once
 * per peek**: inference runs on every graph mutation, and a read started from there would be one
 * per keystroke. `reportEdgeSetsLearned` is what closes the loop when it lands.
 */
export function peekEdgeSets(): EdgeSetMeta[] | undefined {
  if (catalogue) return [...catalogue.values()]
  void listEdgeSets()
  return undefined
}

/** One entry, `undefined` for absent *and* for not-yet-read — see `edgeSetsKnown`. */
export function peekEdgeSet(id: string): EdgeSetMeta | undefined {
  if (!catalogue) {
    void listEdgeSets()
    return undefined
  }
  return catalogue.get(id)
}

/**
 * Whether the catalogue has been read at all.
 *
 * The distinction `columnSchemaFor` draws, and it is needed for the same reason: a dataset node
 * whose edge set is merely *not loaded yet* must not be reported as naming one that is missing.
 * A refusal is right; a refusal a second before the answer arrives is a warning that cries wolf.
 */
export function edgeSetsKnown(): boolean {
  return catalogue !== undefined
}

/** Read the catalogue, sharing one read between concurrent callers. */
export function listEdgeSets(): Promise<EdgeSetMeta[]> {
  if (catalogue) return Promise.resolve([...catalogue.values()])
  listing ??= (async () => {
    const entries = await readAllSets()
    catalogue = new Map(entries.map((meta) => [meta.id, meta]))
    reportEdgeSetsLearned()
    return entries
  })().finally(() => {
    listing = undefined
  })
  return listing
}

async function readAllSets(): Promise<EdgeSetMeta[]> {
  try {
    const database = await db()
    return await new Promise<EdgeSetMeta[]>((resolve) => {
      let tx: IDBTransaction
      try {
        tx = database.transaction(SET_STORE, 'readonly')
      } catch {
        return resolve([])
      }
      const request = tx.objectStore(SET_STORE).getAll()
      request.onsuccess = () => {
        const all = (request.result as EdgeSetMeta[] | undefined) ?? []
        // A set written by an older layout cannot be read by this one, and reading it wrongly
        // is worse than not offering it. Same rule as the cache fingerprint.
        resolve(all.filter((meta) => meta.format === EDGE_FORMAT))
      }
      request.onerror = () => resolve([])
      tx.onabort = () => resolve([])
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function kindOf(array: IdArray | WeightArray | Uint32Array): ArrayKind {
  if (array instanceof Uint8Array) return 'u8'
  if (array instanceof Uint16Array) return 'u16'
  if (array instanceof Uint32Array) return 'u32'
  if (array instanceof Int32Array) return 'i32'
  return 'f64'
}

function allocate(kind: ArrayKind, length: number) {
  switch (kind) {
    case 'u8':
      return new Uint8Array(length)
    case 'u16':
      return new Uint16Array(length)
    case 'u32':
      return new Uint32Array(length)
    case 'i32':
      return new Int32Array(length)
    default:
      return new Float64Array(length)
  }
}

function partsOf(encoded: EncodedEdges): Record<PartName, IdArray | WeightArray | Uint32Array> {
  return {
    'out.offsets': encoded.out.offsets,
    'out.targets': encoded.out.targets,
    'out.weights': encoded.out.weights,
    'in.offsets': encoded.in.offsets,
    'in.targets': encoded.in.targets,
    'in.weights': encoded.in.weights,
  }
}

/**
 * Split an array into pieces of at most `CHUNK_BYTES`, each owning its own buffer.
 *
 * `slice`, never `subarray`, and it is the whole reason this is a named function rather than
 * two lines inside the write. Structured clone serialises a view as **its entire backing store**
 * plus an offset — measured in node, a 2 MB subarray of an 8 MB array clones 8 MB — so chunking
 * with a view stores the whole array once per chunk, round-trips perfectly, and only shows up
 * as a database several times the size it should be.
 *
 * Extracted because it cannot be tested through the store: `fake-indexeddb` normalises views on
 * the way in, so every assertion routed through it passes under both spellings. Here the
 * property is a fact about the returned arrays and is checked directly.
 */
export function chunkArray<
  T extends { length: number; BYTES_PER_ELEMENT: number; slice(a: number, b: number): T },
>(array: T, budgetBytes = CHUNK_BYTES): T[] {
  const perChunk = chunkLength(array, budgetBytes)
  const out: T[] = []
  for (let i = 0; i < chunkCount(array, budgetBytes); i++) {
    out.push(sliceChunk(array, i, perChunk))
  }
  return out
}

/** Elements per chunk. */
function chunkLength(array: Sliceable, budgetBytes = CHUNK_BYTES): number {
  return Math.max(1, Math.floor(budgetBytes / array.BYTES_PER_ELEMENT))
}

/** How many chunks an array becomes — arithmetic only, so nothing is allocated to count. */
function chunkCount(array: Sliceable, budgetBytes = CHUNK_BYTES): number {
  return Math.max(1, Math.ceil(array.length / chunkLength(array, budgetBytes)))
}

/** Chunk `i`, owning its own buffer. */
function sliceChunk<T extends Sliceable>(array: T, i: number, perChunk: number): T {
  return array.slice(i * perChunk, Math.min((i + 1) * perChunk, array.length)) as T
}

interface Sliceable {
  length: number
  BYTES_PER_ELEMENT: number
  slice(a: number, b: number): unknown
}

export interface SaveEdgeSetOptions {
  name: string
  origin: string
  onProgress?: (fraction: number, note?: string) => void
}

/**
 * Store an encoded set and catalogue it, returning the entry.
 *
 * Re-importing the same file is **free**: the id is the content, so an existing entry means the
 * bytes are already here and only the name is updated. That is what makes the refusal on a
 * shared graph recoverable — import the same edge list and the id matches by construction.
 */
export async function saveEdgeSet(
  encoded: EncodedEdges,
  options: SaveEdgeSetOptions,
): Promise<EdgeSetMeta> {
  const arrays = partsOf(encoded)
  /*
   * The **dictionary is part of the content**, and leaving it out was a collision rather than an
   * omission: the CSR holds indices, so two edge lists over completely different neurons but the
   * same shape hash identically — `1→2` and `720575940628857210→720575940628857211` are byte-for
   * -byte the same arrays. The second import would be answered "already imported" and silently
   * attach the *first* file's edges.
   *
   * Joined on NUL, which cannot occur in an id read from a delimited or columnar column.
   */
  const id = hashBytes([
    ...Object.values(arrays),
    new TextEncoder().encode(encoded.ids.join('\u0000')),
  ])
  await listEdgeSets()

  const existing = catalogue?.get(id)
  if (existing) {
    options.onProgress?.(1, 'Already imported')
    return existing.name === options.name ? existing : await renameEdgeSet(id, options.name)
  }

  /*
   * Counted here and *sliced* at the `put` below, which is the difference between one copy of
   * the set in memory and two. Chunking every part up front held ~96 MB of slices alive beside
   * the ~96 MB they were copied from — in a module that elsewhere goes to some trouble to
   * release intermediates. IndexedDB clones a value synchronously at `put`, so each 8 MB slice
   * is collectable the moment it has been handed over.
   *
   * The count is pure arithmetic, so it cannot disagree with what the loop produces.
   */
  const parts = {} as Record<PartName, PartMeta>
  for (const name of PART_NAMES) {
    const array = arrays[name]
    parts[name] = { kind: kindOf(array), length: array.length, chunks: chunkCount(array) }
  }
  const idChunks = Math.max(1, Math.ceil(encoded.ids.length / IDS_PER_CHUNK))

  const meta: EdgeSetMeta = {
    id,
    name: options.name,
    origin: options.origin,
    createdAt: Date.now(),
    format: encoded.format,
    neurons: encoded.ids.length,
    edges: encoded.edges,
    bytes: edgeSetBytes(encoded),
    report: encoded.report,
    parts,
    idChunks,
  }

  const total = PART_NAMES.reduce((n, name) => n + parts[name].chunks, 0) + idChunks
  let written = 0

  await write((sets, store) => {
    for (const name of PART_NAMES) {
      const array = arrays[name]
      const perChunk = chunkLength(array)
      for (let i = 0; i < parts[name].chunks; i++) {
        store.put(sliceChunk(array, i, perChunk), `${id}/${name}/${i}`)
        options.onProgress?.(++written / total, 'Saving')
      }
    }
    for (let i = 0; i < idChunks; i++) {
      const chunk = encoded.ids.slice(i * IDS_PER_CHUNK, (i + 1) * IDS_PER_CHUNK)
      store.put(chunk, `${id}/ids/${i}`)
      options.onProgress?.(++written / total, 'Saving')
    }
    // The catalogue entry goes in last, inside the same transaction: an entry is a promise that
    // the parts behind it exist, and a torn write must leave orphaned parts rather than an
    // entry pointing at nothing.
    sets.put(meta, id)
  })

  catalogue?.set(id, meta)
  reportEdgeSetsLearned()
  return meta
}

export async function renameEdgeSet(id: string, name: string): Promise<EdgeSetMeta> {
  await listEdgeSets()
  const meta = catalogue?.get(id)
  if (!meta) throw new Error(`No edge set ${id}`)
  const renamed = { ...meta, name }
  await write((sets) => sets.put(renamed, id))
  catalogue?.set(id, renamed)
  loaded.delete(id)
  reportEdgeSetsLearned()
  return renamed
}

/**
 * Remove an entry and every chunk behind it.
 *
 * The parts go by key range rather than by the count in the meta, so a set whose entry and
 * chunks disagree — a torn write, an interrupted import — is still fully removable. Nothing
 * else can reclaim those bytes, and a delete that left half of a hundred megabytes behind
 * would be the control that looks like it worked.
 */
export async function deleteEdgeSet(id: string): Promise<void> {
  await write((sets, parts) => {
    sets.delete(id)
    parts.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`))
  })
  catalogue?.delete(id)
  loaded.delete(id)
  reportEdgeSetsLearned()
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Sets held in memory for the session, and the reads in flight.
 *
 * Held rather than re-read because a Connectivity node runs once per hop per direction and a
 * hundred megabytes is not something to pull out of IndexedDB six times for one press of Run.
 * The cost is stated rather than hidden: an attached set is resident for as long as the tab is,
 * and `releaseEdgeSet` is the way back.
 */
const loaded = new Map<string, LoadedEdgeSet>()
const loading = new Map<string, Promise<LoadedEdgeSet | undefined>>()

/** Drop a set's in-memory copy. The stored bytes are untouched. */
export function releaseEdgeSet(id: string): void {
  loaded.delete(id)
}

/**
 * Load a set, or resolve `undefined` when this browser does not have it.
 *
 * `undefined` is the case a caller must act on and must **not** paper over: a graph naming an
 * edge set that is not here has to refuse, because the alternative is querying the backend and
 * answering a different question under a green node.
 */
export function loadEdgeSet(id: string): Promise<LoadedEdgeSet | undefined> {
  const held = loaded.get(id)
  if (held) return Promise.resolve(held)
  const inFlight = loading.get(id)
  if (inFlight) return inFlight

  const load = (async () => {
    const meta = (await read<EdgeSetMeta | undefined>(SET_STORE, id, undefined)) ?? undefined
    if (!meta || meta.format !== EDGE_FORMAT) return undefined

    const ids: string[] = []
    for (let i = 0; i < meta.idChunks; i++) {
      // Appended rather than spread: `push(...chunk)` passes 50,000 arguments at a time, which
      // is a lot of stack for nothing and is near the engine's own limit.
      for (const text of await read<string[]>(PART_STORE, `${id}/ids/${i}`, [])) ids.push(text)
    }
    if (ids.length !== meta.neurons) return undefined

    const read_ = async (name: PartName) => {
      const part = meta.parts[name]
      const array = allocate(part.kind, part.length)
      let at = 0
      for (let i = 0; i < part.chunks; i++) {
        const chunk = await read<ArrayLike<number> | undefined>(
          PART_STORE,
          `${id}/${name}/${i}`,
          undefined,
        )
        if (!chunk) return undefined
        array.set(chunk as never, at)
        at += chunk.length
      }
      return at === part.length ? array : undefined
    }

    /*
     * A part that is missing or came back short means the entry and its chunks disagree, which is
     * a torn write. Answering with a truncated edge set is the silent wrong connectome this whole
     * module is arranged to avoid; not having it is a state the caller already handles — so the
     * loop stops at the first bad part rather than pulling the other hundred megabytes first.
     */
    const columns = {} as Record<PartName, IdArray | WeightArray | Uint32Array>
    for (const name of PART_NAMES) {
      const array = await read_(name)
      if (!array) return undefined
      columns[name] = array
    }

    const set: LoadedEdgeSet = {
      meta,
      ids,
      index: new Map(ids.map((text, at) => [text, at])),
      out: {
        offsets: columns['out.offsets'] as Uint32Array,
        targets: columns['out.targets'] as IdArray,
        weights: columns['out.weights'] as WeightArray,
      },
      in: {
        offsets: columns['in.offsets'] as Uint32Array,
        targets: columns['in.targets'] as IdArray,
        weights: columns['in.weights'] as WeightArray,
      },
    }
    loaded.set(id, set)
    return set
  })().finally(() => {
    loading.delete(id)
  })

  loading.set(id, load)
  return load
}

/** Test seam: forget the opened database, the catalogue and everything resident. */
export function resetEdgeSets(): void {
  dbPromise = undefined
  catalogue = undefined
  listing = undefined
  loaded.clear()
  loading.clear()
  revision = 0
}
