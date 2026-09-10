/**
 * The workflow library — graphs saved in the browser.
 *
 * The complement to Save-as-download, not a replacement for it. A download is the export and
 * the sharing path; this is the convenience layer for the graph you want back tomorrow on the
 * same machine. Browser storage is per-origin and per-profile, is wiped by "clear site data",
 * does not sync anywhere and does not exist in a private window, so the file remains the only
 * durable artefact and the UI has to say so.
 *
 * Four decisions worth knowing, because each of them is easy to get backwards:
 *
 * 1. **IndexedDB, not `localStorage`.** The autosave in `persistence.ts` already keeps a full
 *    copy of the working graph inside the ~5 MB origin budget, and a graph can be big — an
 *    Explore select-all is *not* capped — `SELECT_ALL_WARN` warns at 25,000 and selects anyway —
 *    and a CAVE root id costs ~32 characters of serialised param, so 25,000 of them is 782 kB in
 *    one node (measured; `scripts/probe-autosave-budget.ts`).
 *    A handful of saved workflows would hit quota, and `saveAutosave` swallows that failure by
 *    design. IndexedDB has no such ceiling.
 *
 * 2. **Its own database, not `data/cache.ts`.** That module is a *cache*: expiry, fingerprint
 *    mismatch as a miss, and a `cacheClear` that drops everything. A workflow someone saved
 *    must never be evictable by anything clearing caches. A separate database also keeps the
 *    two modules from racing on a version bump of the same `coda` database.
 *
 * 3. **Writes reject; reads resolve.** Everywhere else in this codebase a storage failure
 *    degrades silently, because a failure to *remember* a value is not a failure to compute
 *    it. That reasoning inverts here: a save that silently did not save is data loss, and the
 *    only thing worse than refusing to save is reporting success and losing the work. So every
 *    write path propagates its error for the UI to show, and only the read paths fall back to
 *    "nothing stored".
 *
 * 4. **No in-memory fallback.** Where IndexedDB is missing there is nowhere durable to put a
 *    graph, and something that survives until the tab reloads is not a save. `saveWorkflow`
 *    rejects rather than pretending.
 *
 * The graph is stored as exactly the string `serializeGraph` produces, so a library entry is
 * byte-identical to what the Save button downloads and the two paths cannot drift; loading goes
 * back through `deserializeGraph`, which is what gives a stored graph the same lenient loading
 * and the same warnings a file gets.
 */

import type { CodaGraph } from '../core/graph'
import { deserializeGraph, graphName, newId, serializeGraph } from '../core/graph'
import type { RefusalWords } from '../data/idb'
import { attempt, commit, database } from '../data/idb'

const DB_NAME = 'coda-library'
const DB_VERSION = 1
/** Summaries, read on their own so listing the shelf does not deserialise every graph. */
const META_STORE = 'meta'
/** The serialised graphs, keyed by the same id. */
const GRAPH_STORE = 'graphs'

/**
 * What the shelf shows for one stored workflow.
 *
 * `nodeTypes` is here so the start page can derive a tile from the same art the app already
 * draws without reading a megabyte of graph JSON per card. The list rather than a chosen type,
 * because deciding which node stands for a graph is a UI question and this module is not the
 * place to answer it.
 */
export interface WorkflowSummary {
  id: string
  /** As the user typed it. Identity for an overwrite is the normalised form — see `findByName`. */
  name: string
  /** Epoch ms of the most recent save. */
  savedAt: number
  /** Epoch ms of the first save; survives an overwrite. */
  createdAt: number
  /** Node types in graph order. */
  nodeTypes: string[]
  /**
   * Length of the stored JSON. Characters rather than bytes, which for this ASCII-dominated
   * JSON differ only where a graph name carries non-Latin text — close enough for a size hint
   * and far cheaper than encoding the whole string to measure it.
   */
  size: number
}

const NO_STORAGE =
  'This browser is not storing data for Coda — a private window does this. Use Save ▸ Download instead.'

/**
 * The connection. `idb.ts` is where the opener's rules are argued — a rejected open is not
 * memoised, and another tab's upgrade closes it — so what is this module's own is the words.
 */
const db = database({ name: DB_NAME, version: DB_VERSION, stores: [META_STORE, GRAPH_STORE] })

/** How a write that did not commit is reported. Decision 3 in the header is why it is. */
const REFUSAL: RefusalWords = {
  unavailable: NO_STORAGE,
  rolledBack: 'The save was rolled back',
  failed: 'The save failed',
  quota: 'No room left in browser storage. Delete a stored workflow and try again.',
}

/**
 * Run one read-write transaction across both stores, resolving when it *commits* and rejecting
 * otherwise. Why it waits for `complete` rather than for the requests is recorded on `commit`.
 */
function write(run: (meta: IDBObjectStore, graphs: IDBObjectStore) => void): Promise<void> {
  return commit(
    db,
    [META_STORE, GRAPH_STORE],
    (tx) => run(tx.objectStore(META_STORE), tx.objectStore(GRAPH_STORE)),
    REFUSAL,
  )
}

/** Run one read, resolving to `fallback` on any failure — a broken shelf reads as an empty one. */
function read<T>(
  store: string,
  make: (s: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  return attempt(
    db,
    store,
    'readonly',
    (tx) => make(tx.objectStore(store)) as IDBRequest<T>,
    fallback,
  )
}

/**
 * Everything on the shelf, newest first.
 *
 * Ties break on name so the order is stable — two graphs saved in the same millisecond is a
 * test, not a user, but a list that reshuffles between renders is a bug either way.
 */
export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const rows = await read<WorkflowSummary[]>(META_STORE, (s) => s.getAll(), [])
  return [...rows].sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name))
}

export async function getWorkflow(id: string): Promise<WorkflowSummary | undefined> {
  return read<WorkflowSummary | undefined>(META_STORE, (s) => s.get(id), undefined)
}

/**
 * Normalised form of a name, for deciding whether two saves mean the same document.
 *
 * Case- and whitespace-insensitive: "LC4 sweep" and "lc4  sweep" as two separate entries is a
 * shelf nobody can keep tidy, and the typed form is kept for display either way.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The entry a save under this name would overwrite, if any. */
export function findByName(list: WorkflowSummary[], name: string): WorkflowSummary | undefined {
  const key = normalizeName(name)
  return list.find((entry) => normalizeName(entry.name) === key)
}

/**
 * Write the graph to the shelf.
 *
 * Pass `id` to overwrite that entry — the caller resolves name to id, because whether an
 * overwrite needs confirming is a question about the UI's replace prompt and not about storage.
 * Rejects on any failure; see the header for why this one path is not allowed to degrade.
 */
export async function saveWorkflow(
  graph: CodaGraph,
  options: { id?: string } = {},
): Promise<WorkflowSummary> {
  const name = graphName(graph)
  const json = serializeGraph(graph)
  const previous = options.id ? await getWorkflow(options.id) : undefined
  const now = Date.now()
  const summary: WorkflowSummary = {
    id: options.id ?? newId('w'),
    name,
    savedAt: now,
    createdAt: previous?.createdAt ?? now,
    nodeTypes: graph.nodes.map((node) => node.type),
    size: json.length,
  }
  await write((meta, graphs) => {
    meta.put(summary, summary.id)
    graphs.put(json, summary.id)
  })
  return summary
}

/**
 * Read a stored graph back.
 *
 * Throws on a missing or unreadable entry rather than resolving to an empty graph: loading
 * replaces what is on the canvas and clears the undo history, so a corrupt entry that quietly
 * resolved to "nothing" would take the user's current work with it.
 */
export async function loadWorkflow(
  id: string,
): Promise<{ graph: CodaGraph; warnings: string[] }> {
  const json = await read<string | undefined>(GRAPH_STORE, (s) => s.get(id), undefined)
  if (json === undefined) throw new Error('That stored workflow is no longer in this browser')
  try {
    return deserializeGraph(json)
  } catch (err) {
    throw new Error(`Could not read the stored workflow: ${(err as Error).message}`)
  }
}

export async function renameWorkflow(id: string, name: string): Promise<WorkflowSummary> {
  const previous = await getWorkflow(id)
  if (!previous) throw new Error('That stored workflow is no longer in this browser')
  const trimmed = name.trim() || 'Untitled'
  const summary: WorkflowSummary = { ...previous, name: trimmed }
  await write((meta) => {
    meta.put(summary, id)
  })
  return summary
}

/** Rejects rather than degrading: a delete that silently did not happen is its own surprise. */
export async function deleteWorkflow(id: string): Promise<void> {
  await write((meta, graphs) => {
    meta.delete(id)
    graphs.delete(id)
  })
}

/** Test seam: forget the open database so a fresh `indexedDB` is picked up. */
export function resetLibrary(): void {
  db.reset()
}
