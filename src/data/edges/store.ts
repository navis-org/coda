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

import type { RefusalWords, StoredUsage } from '../idb'
import { attempt, commit, database, readKey, usage } from '../idb'
import { memoPromise, untilAborted } from '../memoPromise'
import { LruMap, PinnedLru } from '../../core/lruMap'
import type { DatasetEdges } from '../../core/values'
import { hashBytes, hashValue } from '../../core/hash'
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

/**
 * An edge set in memory, ready to answer — from the shelf or from a wire (`provideEdgeSet`).
 * Carries no catalogue entry: the query layer never reads one, and a wired set has none.
 */
export interface LoadedEdgeSet {
  /** Dictionary, in index order. */
  ids: string[]
  /** The inverse, built on load: id text to dictionary index. */
  index: Map<string, number>
  out: EdgeCsr
  in: EdgeCsr
  /**
   * Rows a wired list's build dropped — a blank id or a weight that is not a number — which a
   * question below it has to say, the node having read nothing. Absent on a shelf set, whose
   * import reported it on the spot.
   */
  dropped?: number
}

/** An encoded set made ready to answer: the dictionary's inverse, built once. */
export function residentEdgeSet(
  encoded: Pick<EncodedEdges, 'ids' | 'out' | 'in'>,
): LoadedEdgeSet {
  const index = new Map<string, number>()
  for (let at = 0; at < encoded.ids.length; at++) index.set(encoded.ids[at]!, at)
  return {
    ids: encoded.ids,
    index,
    out: encoded.out,
    in: encoded.in,
  }
}

// ---------------------------------------------------------------------------
// Storage plumbing — `idb.ts`, in this module's own words
// ---------------------------------------------------------------------------

const db = database({ name: DB_NAME, version: DB_VERSION, stores: [SET_STORE, PART_STORE] })

const REFUSAL: RefusalWords = {
  unavailable: NO_STORAGE,
  rolledBack: 'The edge set was rolled back',
  failed: 'The edge set could not be saved',
  quota:
    'No room left in browser storage. Delete an edge set and try again; edge sets are ' +
    'far larger than anything else Coda keeps.',
}

/**
 * One read-write transaction across both stores, resolving when it **commits** — `commit`'s
 * policy. An import reported before its rollback would be a catalogue entry naming edges that
 * are not there.
 */
function write(run: (sets: IDBObjectStore, parts: IDBObjectStore) => void): Promise<void> {
  return commit(
    db,
    [SET_STORE, PART_STORE],
    (tx) => run(tx.objectStore(SET_STORE), tx.objectStore(PART_STORE)),
    REFUSAL,
  )
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
const listings = new Map<'catalogue', Promise<EdgeSetMeta[]>>()

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
  return memoPromise(
    listings,
    'catalogue',
    async () => {
      const entries = await readAllSets()
      catalogue = new Map(entries.map((meta) => [meta.id, meta]))
      reportEdgeSetsLearned()
      return entries
    },
    { keep: 'inflight' },
  )
}

async function readAllSets(): Promise<EdgeSetMeta[]> {
  const all = await attempt<EdgeSetMeta[]>(
    db,
    SET_STORE,
    'readonly',
    (tx) => tx.objectStore(SET_STORE).getAll() as IDBRequest<EdgeSetMeta[]>,
    [],
  )
  // A set written by an older layout cannot be read by this one, and reading it wrongly is worse
  // than not offering it. Same rule as the cache fingerprint.
  return all.filter((meta) => meta.format === EDGE_FORMAT)
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

// ---------------------------------------------------------------------------
// Wired sets — built in this tab from a node's input, never stored
// ---------------------------------------------------------------------------

/**
 * A wired set's id prefix. A shelf id is a bare content hash, so the two can never collide, and
 * the refusal for a missing set can say which remedy applies.
 */
const WIRED_PREFIX = 'wired-'

/** Builds an encoded set, when a question first needs it. */
export type EdgeSetLoader = (signal?: AbortSignal) => Promise<EncodedEdges>

/**
 * How many wired sets are remembered, and how many are held built.
 *
 * Two bounds because the two things cost differently. A loader is a closure over its input — a
 * table the scheduler already caches, or a file handle — so remembering sixteen is cheap and is
 * what keeps a dataset value a downstream node still holds answerable. A **built** set is the
 * hundred megabytes, so only two stay resident: switching back to an older edge list re-reads it
 * rather than holding every version somebody tried. `makeRoom` runs once a build's arrays exist and
 * before they are indexed, so a failed build displaces nothing.
 */
const MAX_WIRED = 16
const MAX_WIRED_RESIDENT = 2

const wired = new PinnedLru<EdgeSetLoader>(MAX_WIRED)
const wiredResident = new LruMap<string, LoadedEdgeSet>(MAX_WIRED_RESIDENT)

/**
 * Register how to build a wired set, and return the id it goes by — minted here from whatever
 * identifies its content, so the prefix that routes a load to this tier is written in one place.
 * Nothing is read until a question asks: the node that wires one stays `cheap`, and the first
 * Connectivity, Adjacency or Paths run pays for the read.
 */
export function provideEdgeSet(content: unknown, load: EdgeSetLoader): string {
  const id = `${WIRED_PREFIX}${hashValue(content)}`
  wired.set(id, load)
  return id
}

/** Keep a wired set's loader for as long as `owner` — the dataset value naming it — lives. */
export function pinEdgeSet(owner: object, id: string): void {
  wired.pin(owner, id)
}

function isWiredEdgeSet(id: string): boolean {
  return id.startsWith(WIRED_PREFIX)
}

/**
 * A wired set being built, and who is waiting for it.
 *
 * **Shared, so asked with nobody's signal** — the rule every shared request here keeps (see
 * `untilAborted`): the first caller's Cancel must not become every caller's. What a
 * whole-file read adds is that it is seconds of work in a worker, so it is not simply left to run
 * either: each caller's Cancel stops *its* wait, and the read is aborted only when nobody is left
 * waiting. A caller with no signal can never cancel, so it keeps the build alive to the end.
 */
interface WiredBuild {
  readonly promise: Promise<LoadedEdgeSet>
  readonly controller: AbortController
  waiting: number
}

const building = new Map<string, WiredBuild>()

function loadWired(id: string, signal?: AbortSignal): Promise<LoadedEdgeSet | undefined> {
  const held = wiredResident.get(id)
  if (held) {
    // A question is a use: re-set, so the set in use is the last evicted (`LruMap` counts writes).
    wiredResident.set(id, held)
    return Promise.resolve(held)
  }
  const load = wired.get(id)
  if (!load) return Promise.resolve(undefined)
  // Cancelled already: no build is started for a question nobody is waiting on.
  if (signal?.aborted) return Promise.reject(signal.reason)
  let build = building.get(id)
  // A build everybody walked away from is still settling; a new question is not its answer.
  if (!build || build.controller.signal.aborted) build = startBuild(id, load)
  return waitFor(build, signal)
}

function startBuild(id: string, load: EdgeSetLoader): WiredBuild {
  const controller = new AbortController()
  const promise = (async () => {
    const encoded = await load(controller.signal)
    // Room is made once the set exists: a cancelled or failed build evicts nothing. The price is
    // that the build runs beside both resident sets — a slot of headroom, spent only while full.
    wiredResident.makeRoom()
    const { droppedId, droppedWeight } = encoded.report
    const set: LoadedEdgeSet = {
      ...residentEdgeSet(encoded),
      dropped: droppedId + droppedWeight,
    }
    wiredResident.set(id, set)
    return set
  })()
  const build: WiredBuild = { promise, controller, waiting: 0 }
  building.set(id, build)
  // Settled either way, it is no longer in flight: a failed read is not kept, and the next
  // question starts it again.
  const settled = () => {
    if (building.get(id) === build) building.delete(id)
  }
  promise.then(settled, settled)
  return build
}

function waitFor(build: WiredBuild, signal: AbortSignal | undefined): Promise<LoadedEdgeSet> {
  build.waiting++
  const leave = () => {
    if (--build.waiting === 0) build.controller.abort()
  }
  if (signal) {
    signal.addEventListener('abort', leave, { once: true })
    // A Cancel after the build settled leaves nothing to abort.
    const off = () => signal.removeEventListener('abort', leave)
    build.promise.then(off, off)
  }
  return untilAborted(build.promise, signal)
}

/**
 * Load a set, or resolve `undefined` when this browser does not have it.
 *
 * `undefined` is the case a caller must act on and must **not** paper over: a graph naming an
 * edge set that is not here has to refuse, because the alternative is querying the backend and
 * answering a different question under a green node.
 *
 * `signal` is this caller's alone: it stops this wait, and a wired set's read only once no caller
 * is left waiting (`WiredBuild`). A shelf read is IndexedDB and runs to the end.
 */
export function loadEdgeSet(
  id: string,
  signal?: AbortSignal,
): Promise<LoadedEdgeSet | undefined> {
  if (isWiredEdgeSet(id)) return loadWired(id, signal)
  const held = loaded.get(id)
  if (held) return Promise.resolve(held)
  return memoPromise(
    loading,
    id,
    async () => {
      const meta =
        (await readKey<EdgeSetMeta | undefined>(db, SET_STORE, id, undefined)) ?? undefined
      if (!meta || meta.format !== EDGE_FORMAT) return undefined

      const ids: string[] = []
      for (let i = 0; i < meta.idChunks; i++) {
        // Appended rather than spread: `push(...chunk)` passes 50,000 arguments at a time, which
        // is a lot of stack for nothing and is near the engine's own limit.
        for (const text of await readKey<string[]>(db, PART_STORE, `${id}/ids/${i}`, []))
          ids.push(text)
      }
      if (ids.length !== meta.neurons) return undefined

      const read_ = async (name: PartName) => {
        const part = meta.parts[name]
        const array = allocate(part.kind, part.length)
        let at = 0
        for (let i = 0; i < part.chunks; i++) {
          const chunk = await readKey<ArrayLike<number> | undefined>(
            db,
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

      const set = residentEdgeSet({
        ids,
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
      })
      loaded.set(id, set)
      return set
    },
    { keep: 'inflight' },
  )
}

/**
 * A dataset's edge set, or a refusal naming it — what every reader of a dataset's `edges` calls.
 *
 * Total rather than partial: given an identity it either answers or throws, so a caller has one
 * branch — is anything attached — rather than two that lead to the same place. The refusal is
 * the store's because only the store knows which tier the id names, and the two differ in their
 * remedy: a shelf set is re-imported, a wired one is rebuilt by running the node it is wired into
 * — its loader outlived by a dataset value somebody still holds.
 */
export async function requireEdgeSet(
  edges: DatasetEdges,
  signal?: AbortSignal,
  onWarn?: (message: string) => void,
): Promise<LoadedEdgeSet> {
  const set = await loadEdgeSet(edges.id, signal)
  if (set?.dropped) {
    // A tolerated partial answer is counted, or a connection with a blank weight simply is not
    // there, under a green card.
    onWarn?.(
      `${set.dropped.toLocaleString()} rows of the edge list (${edges.name}) have a blank id or ` +
        `a weight that is not a number, and were left out.`,
    )
  }
  if (set) return set
  if (isWiredEdgeSet(edges.id)) {
    throw new Error(
      `This dataset's edge list (${edges.name}) is no longer held in this tab. Select the ` +
        `dataset node it is wired into, press Invalidate in the inspector, and run again.`,
    )
  }
  throw new Error(
    `This dataset's connectivity comes from the edge set "${edges.name}", which is ` +
      `not in this browser. Import the same file under \`Edge data\` on the dataset node; ` +
      `a set is identified by its contents, so the same file will match.`,
  )
}

/** What the shelf holds, for the Storage tab: one entry per edge set. */
export function edgeSetsUsage(): Promise<StoredUsage | undefined> {
  // Each catalogue entry carries its encoded size, so the chunks themselves are not read.
  return usage(db, SET_STORE, {
    skip: [PART_STORE],
    bytes: (record) => (record as EdgeSetMeta).bytes,
  })
}

/** Test seam: forget the opened database, the catalogue and everything resident. */
export function resetEdgeSets(): void {
  db.reset()
  catalogue = undefined
  listings.clear()
  loaded.clear()
  loading.clear()
  wired.clear()
  wiredResident.clear()
  building.clear()
  revision = 0
}
