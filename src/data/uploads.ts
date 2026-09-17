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
 *
 * ## Two kinds of upload, one of everything else
 *
 * `Upload Mesh` stores geometry rather than rows, and it is here rather than in a module of its
 * own because everything above this line would otherwise be written twice — the learned channel,
 * the revision counter that is the only correct `useSyncExternalStore` snapshot, the mirror that
 * makes the peek synchronous, the started-once rule, and the reset seam. What differs between
 * the two is a store name and a descriptor; what is shared is every decision that was hard.
 *
 * So `UploadMeta` is a union discriminated on `kind`, and **absence means `'table'`**: every
 * record any user already has in this database was written by a build in which a table was the
 * only thing an upload could be, and `kind` is undefined on all of them. That is read once, in
 * `normaliseMeta`, rather than defaulted at each of the six places a meta is looked at — the
 * `absentMeans` shape one layer down, for the same reason.
 */

import type { RefusalWords } from './idb'
import { commit, database, readKey } from './idb'
import { hashBytes, hashString } from '../core/hash'
import type { TableSchema } from '../core/types'
import type { TableValue } from '../core/values'

const DB_NAME = 'coda-uploads'
/*
 * 2 added the mesh store. `idb.ts` creates a store that is missing and never recreates one, so
 * the bump is additive: a browser holding uploaded tables at version 1 opens at 2 with those
 * tables untouched and an empty `meshes` store beside them.
 */
const DB_VERSION = 2
/** Small descriptors, read on their own so a peek does not pull a 26 MB table with it. */
const META_STORE = 'meta'
/** The parsed tables, keyed by the same id. */
const TABLE_STORE = 'tables'
/** The parsed meshes, keyed by the same id. Typed arrays survive IndexedDB's structured clone. */
const MESH_STORE = 'meshes'

const NO_STORAGE = 'This browser has no storage available for uploads.'

/**
 * Where an upload is worth a sentence, and where it stops being possible.
 *
 * Both are on the *file* rather than on the parsed result, because by the time a table exists
 * the tab has already been locked up for a minute — the same call `pivotTable` makes when it
 * checks label cardinalities instead of the array it is about to allocate.
 *
 * 50 MB is comfortably above a whole-dataset embedding (male-CNS at 165k rows and a few floats
 * is a few MB), so a file past it is unusual enough to remark on and not unusual enough to
 * refuse — a synapse table or somebody's segment dump lands here legitimately. The refusal
 * moves out to 200 MB, which is the file size whose parse — strings, then typed arrays, with
 * both alive at once — approaches `CRASH_FLOOR_BYTES`.
 */
export const UPLOAD_WARN_BYTES = 50 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/**
 * How to talk about an upload that is not in this browser.
 *
 * **One home for six literals.** The sentence existed in `validate`, in `evaluate` and on the card
 * for each of the two nodes, and the copies had already drifted in the ways that matter: `pick the
 * file again` against `pick the file(s) again` against `choose the file again`, and three separate
 * fallbacks — `'this file'`, `'these meshes'`, `'This upload'` — for one absent name. Three
 * fallback nouns for one state is the tell.
 *
 * The variation is real but runs along two axes and both are declarable: the **noun** (rows or
 * meshes, one file or several) and the **shape** — a badge is a clause, a thrown error is an
 * instruction, and the card's remedy is "choose" because the button is directly under it where the
 * node's is "on this node". Precedent is `splitRows.ts`' `nothingMatchesReason`, which exists
 * because four surfaces read it and the card had drifted from the rest; this is six.
 *
 * Headless, so both `validate`s, both `evaluate`s and both cards read the same words — and beside
 * `NO_STORAGE`, which is already one string two layers render.
 */
interface UploadNoun {
  /** What is in it: "rows", "meshes". */
  held: string
  /** What to pick again: "the file", "the files". */
  file: string
  /** What is restored, for a sentence that needs the pronoun: "it", "them". */
  them: string
  /** What to call it when the filename is blank. */
  unnamed: string
}

const UPLOAD_NOUNS: Record<UploadMeta['kind'], UploadNoun> = {
  table: { held: 'rows', file: 'the file', them: 'it', unnamed: 'this file' },
  meshes: { held: 'meshes', file: 'the files', them: 'them', unnamed: 'these meshes' },
}

/** The badge a `validate` returns: a clause, because the card draws it under the node's name. */
export function uploadMissingBadge(fileName: string, kind: UploadMeta['kind']): string {
  const noun = UPLOAD_NOUNS[kind]
  return `${fileName || noun.unnamed} is not stored in this browser — pick ${noun.file} again`
}

/**
 * The whole instruction: what is missing, where it went, and what to do.
 *
 * This is what somebody opening a shared workflow sees, so it has to read as an instruction and
 * not as a fault. `where` is the one thing that varies — on a card the picker is directly under
 * the sentence, from a node it is not.
 */
export function uploadMissingReason(
  fileName: string,
  kind: UploadMeta['kind'],
  where: 'node' | 'card',
): string {
  const noun = UPLOAD_NOUNS[kind]
  const remedy =
    where === 'card'
      ? `choose ${noun.file} again`
      : `pick ${noun.file} again on this node to restore ${noun.them}`
  return (
    `“${fileName || noun.unnamed}” is not stored in this browser. Uploaded ` +
    `${noun.held} stay on the machine that uploaded them — ${remedy}.`
  )
}

/** What every upload carries, whatever is in it. */
interface UploadBase {
  id: string
  /** The file's own name, or a label for pasted text or a multi-file pick. */
  name: string
  /** Size of the source file(s), for the card's readout. */
  bytes: number
  savedAt: number
}

/** What the card can say about an uploaded table without loading it. */
export interface TableUploadMeta extends UploadBase {
  kind: 'table'
  rows: number
  schema: TableSchema
}

/** One mesh in an upload, as the card lists it. Geometry is in the mesh store. */
export interface MeshItemMeta {
  /** What the mesh is called — the file's own name, minus its extension. */
  name: string
  /** The file it came from, kept whole: it is the one thing a reader can go and find. */
  file: string
  vertices: number
  triangles: number
}

/**
 * What the card can say about uploaded meshes without loading them.
 *
 * The per-item list rather than a count, because a mesh upload is routinely several files and
 * "3 meshes" is not what somebody checking they picked the right ones needs to read.
 */
export interface MeshUploadMeta extends UploadBase {
  kind: 'meshes'
  items: MeshItemMeta[]
}

export type UploadMeta = TableUploadMeta | MeshUploadMeta

/**
 * One mesh as it is stored: geometry plus the two names it answers to.
 *
 * In the file's **own units**, never scaled. `Upload Mesh`'s Units param is applied in its
 * `evaluate`, so changing it re-scales without re-reading the file — and so the stored bytes are
 * what the file said, which is the only form a second look at them can be checked against.
 */
export interface StoredMesh {
  name: string
  file: string
  positions: Float32Array
  indices: Uint32Array
}

/**
 * A record from before meshes existed says nothing about its kind, and means a table.
 *
 * One reading, here, rather than a `?? 'table'` at each place a meta is used: a second copy of
 * this rule is how a mesh upload comes to be drawn as a table with no rows.
 */
function normaliseMeta(meta: UploadMeta | undefined): UploadMeta | undefined {
  if (!meta) return undefined
  return meta.kind ? meta : { ...(meta as TableUploadMeta), kind: 'table' }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** The connection — `idb.ts`, which records the opener's rules. The words are this module's. */
const db = database({
  name: DB_NAME,
  version: DB_VERSION,
  stores: [META_STORE, TABLE_STORE, MESH_STORE],
})

const REFUSAL: RefusalWords = {
  unavailable: NO_STORAGE,
  rolledBack: 'The upload was rolled back',
  failed: 'The upload failed',
  quota: 'No room left in browser storage. Remove an upload and try again.',
}

/**
 * One read-write transaction across both stores, resolving when it *commits* — `commit`'s
 * policy. For an upload, a save reported before its rollback means claiming to hold a file that
 * is gone.
 */
function write(
  store: typeof TABLE_STORE | typeof MESH_STORE,
  run: (meta: IDBObjectStore, payload: IDBObjectStore) => void,
): Promise<void> {
  return commit(
    db,
    [META_STORE, store],
    (tx) => run(tx.objectStore(META_STORE), tx.objectStore(store)),
    REFUSAL,
  )
}

// ---------------------------------------------------------------------------
// The learned channel
// ---------------------------------------------------------------------------

const learnedListeners = new Set<() => void>()

/**
 * Announce that a locally-held table's schema is now peekable.
 *
 * Not a data-changed event: nothing here invalidates a cached result. It says only that
 * inference ran against "I do not know yet" and can now do better. Fired once per id when an
 * upload's meta lands, and by `core.tableFromUrl` when a fetch fills its own schema mirror —
 * exported for that second caller, which holds the same kind of fact in a different place.
 */
export function reportUploadLearned(): void {
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
  const known = peekUploadMeta(id)
  return known?.kind === 'table' ? known.schema : undefined
}

/** Same, for the card's readout — row count and filename, not only the columns. */
export function peekUploadMeta(id: string): UploadMeta | undefined {
  if (!id) return undefined
  const known = metaMirror.get(id)
  if (!known) startLoad(id)
  return known
}

/**
 * The meshes an upload holds, if it is already known in this session.
 *
 * Asked of the *kind* rather than of the store, so a `dataId` naming an uploaded table answers
 * undefined here rather than "still loading" — the two ids are indistinguishable strings, and a
 * node handed the wrong one should reach its own "not in this browser" sentence rather than wait
 * forever for a read that has already landed.
 */
export function peekMeshUpload(id: string): MeshUploadMeta | undefined {
  const known = peekUploadMeta(id)
  return known?.kind === 'meshes' ? known : undefined
}

/**
 * Whether the peek has finished asking. Distinguishes "loading" from "not in this browser".
 *
 * **Starts the read it cannot answer**, like the two peeks above and for the house reason: a peek
 * that only ever reports "not yet" is one whose answer depends on some *other* caller having
 * asked first. It did not, and that made the order of two lines inside one node's `validate`
 * load-bearing — `Upload Table` got away with asking this first only because its `inferOutputs`
 * peeks the schema on every graph mutation, where `Upload Mesh`'s output shape is constant and
 * peeks nothing. So an upload that was genuinely absent stayed `false` here forever, and the node
 * said nothing at all until somebody pressed Run.
 */
export function uploadPeekSettled(id: string): boolean {
  if (!id) return true
  // Through the peek rather than calling `startLoad` again here: "asking starts the read" is then
  // true by construction at one site, and a fifth peek added later inherits it rather than having
  // to remember it. `.has` and not the peek's return, because a *miss* is settled too.
  peekUploadMeta(id)
  return metaMirror.has(id)
}

/**
 * A meta this session just wrote: mirror it, mark it read, tell inference.
 *
 * `readMeta`'s twin on the write side, and the same argument — three statements both `put`s ended
 * with, which makes remembering them an obligation rather than a call.
 */
function remember(meta: UploadMeta): string {
  metaMirror.set(meta.id, meta)
  started.add(meta.id)
  reportUploadLearned()
  return meta.id
}

/**
 * The one door to the meta store, so `normaliseMeta` cannot be forgotten at a new one.
 *
 * Both callers used to spell out the read, the normalise and the mirror write, which makes
 * "absence means a table" a rule two places have to remember rather than one place that applies
 * it — the same shape of obligation as the `?? 'table'` it replaced, one level up.
 *
 * `started` is set here too, because a read that has landed *is* started and leaving that to the
 * caller was the same obligation in miniature — `getUploadMeta` had to remember it and `loadMeta`
 * did not. `startLoad`'s own add stays: there it is the in-flight dedupe rather than a record.
 */
async function readMeta(id: string): Promise<UploadMeta | undefined> {
  const meta = normaliseMeta(
    await readKey<UploadMeta | undefined>(db, META_STORE, id, undefined),
  )
  metaMirror.set(id, meta)
  started.add(id)
  return meta
}

async function loadMeta(id: string): Promise<void> {
  await readMeta(id)
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
export async function putUpload(
  name: string,
  table: TableValue,
  bytes: number,
): Promise<string> {
  const id = uploadId(table)
  const meta: TableUploadMeta = {
    kind: 'table',
    id,
    name,
    bytes,
    rows: table.length,
    schema: table.schema,
    savedAt: Date.now(),
  }
  await write(TABLE_STORE, (metaStore, tableStore) => {
    metaStore.put(meta, id)
    tableStore.put(table, id)
  })
  return remember(meta)
}

/**
 * Store a set of parsed meshes and return its id. `putUpload`'s twin, rules included.
 *
 * Content-addressed the same way and for the same reason — re-picking the same files re-runs
 * nothing downstream, picking different ones invalidates everything — but over the geometry
 * rather than over cells, because `String(cell)` per coordinate on a five-million-vertex shell is
 * not a hash, it is a hang. `hashBytes` reads the typed arrays as a byte stream, which is the
 * same FNV-1a family and never builds the string.
 */
export async function putMeshUpload(
  name: string,
  meshes: readonly StoredMesh[],
  bytes: number,
): Promise<string> {
  const id = meshUploadId(meshes)
  const meta: MeshUploadMeta = {
    kind: 'meshes',
    id,
    name,
    bytes,
    items: meshes.map((mesh) => ({
      name: mesh.name,
      file: mesh.file,
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
    })),
    savedAt: Date.now(),
  }
  await write(MESH_STORE, (metaStore, meshStore) => {
    metaStore.put(meta, id)
    meshStore.put(meshes, id)
  })
  return remember(meta)
}

/** The stored table, or undefined when this browser does not have it. */
export async function getUpload(id: string): Promise<TableValue | undefined> {
  if (!id) return undefined
  return readKey<TableValue | undefined>(db, TABLE_STORE, id, undefined)
}

/** The stored meshes, or undefined when this browser does not have them. */
export async function getMeshUpload(id: string): Promise<StoredMesh[] | undefined> {
  if (!id) return undefined
  return readKey<StoredMesh[] | undefined>(db, MESH_STORE, id, undefined)
}

/** The stored descriptor, awaited rather than peeked. Also warms the peek's mirror. */
export async function getUploadMeta(id: string): Promise<UploadMeta | undefined> {
  if (!id) return undefined
  return readMeta(id)
}

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

/**
 * Content address for a set of meshes.
 *
 * The names are hashed **beside** the geometry, not instead of it: two files holding the same
 * shell under two names are two different uploads, because the name is what a region is called
 * downstream. Encoded into the same byte stream with the same separator `uploadId` uses, so two
 * items cannot run together — `['a', 'bc']` and `['ab', 'c']` would otherwise share an id.
 */
function meshUploadId(meshes: readonly StoredMesh[]): string {
  const encoder = new TextEncoder()
  const views: ArrayBufferView[] = []
  for (const mesh of meshes) {
    views.push(encoder.encode(`${mesh.name}${SEP}${mesh.file}${SEP}`))
    views.push(mesh.positions, mesh.indices)
  }
  return `m_${hashBytes(views)}`
}

/**
 * Content address for a table.
 *
 * Walks every cell, which is the point: two files differing in one value must not collide,
 * because the id is the whole of this node's contribution to the provenance key. It is paid
 * once per upload rather than per graph edit, unlike `stableStringify` on a param.
 */
function uploadId(table: TableValue): string {
  const parts: string[] = [String(table.length)]
  for (const col of table.schema.columns) {
    parts.push(`${col.name}:${col.dtype}`)
    const data = table.data[col.name] ?? []
    for (const cell of data) parts.push(cell === null ? ' ' : String(cell))
  }
  return `u_${hashString(parts.join(SEP))}`
}

/** Test seam: forget the session's mirror and the memoised connection. */
export function resetUploads(): void {
  metaMirror.clear()
  started.clear()
  db.reset()
  // Not the revision: it only ever has to move, and rewinding it could hand a mounted
  // component the snapshot it is already holding.
  revision++
}
