/**
 * The table files this tab knows about: the local ones it holds, and what every one's footer — or,
 * for a Delta table, its log — said.
 *
 * Imported by the nodes and their cards, so it imports nothing heavy — `client.ts` reaches the
 * format libraries only through `import()` and its worker (`libraries.ts`).
 *
 * ## A local file is held by id, and remembered where the browser can
 *
 * A `File` cannot go into a graph: it is not JSON, and a path is not something a browser will say.
 * So the card hands the file here and writes an **id** into the node — the name, size and
 * modification time, hashed, so picking the same file twice gives the same id and a graph naming
 * one this browser does not have says so rather than reading something else.
 *
 * **Across a reload, only Chromium remembers**, through the handle the file was chosen with — the
 * four states and why are `remembered.ts`', shared with a local BigClust folder. Anywhere without
 * handles — Firefox, Safari, a graph somebody sent — the card asks for the file again, naming it.
 *
 * ## What a footer said, peeked synchronously
 *
 * Inference may not await (invariant 2) and needs the file's columns for every picker downstream,
 * so summaries are kept here and announced through `reportUploadLearned` — the channel the store
 * already re-infers on, which `Table from URL` reuses for the same reason. A failure is kept as
 * well as a success, so `validate` can say why a URL cannot be read before anybody presses Run.
 *
 * **The peek starts the read it cannot answer**, for a URL — `peekDatasets`' rule, and the reason
 * is the one CLAUDE.md records for it: without it, a reloaded graph's pickers below a URL stay
 * empty until something runs, and the first Run behaves differently from the second. Once per
 * file: a read in flight is shared, and a failure is remembered rather than retried per peek.
 *
 * **A summary is kept with the refresh nonce it was read under**, so the node re-reads a footer
 * only when that moves — not when somebody ticks Detect id columns, which changes the node's key
 * and nothing about the file.
 */

import { readSummary } from './client'
import { errorMessage } from '../../core/errors'
import { hashValue } from '../../core/hash'
import type { TableFileRef } from '../../core/values'
import { memoPromise, untilAborted } from '../memoPromise'
import { reportUploadLearned } from '../uploads'
import type { FileSpec } from './bytes'
import { ARROW_MAGIC, PARQUET_MAGIC, bytesOf, endsWith, httpUrl, urlHead } from './bytes'
import { fetchBlob } from '../precomputed/transport'
import type { DeltaSnapshot } from './delta/log'
import { readDeltaSnapshot } from './delta/log'
import { httpDeltaStore } from './delta/store'
import type { FileSummary } from './columns'
import { resetFileStore } from './store'
import type { RememberedState } from './remembered'
import { remembered } from './remembered'

/**
 * The local files this tab holds, and their remembered handles (`remembered.ts`, the state machine
 * a local project folder shares).
 */
const localFiles = remembered<FileSystemFileHandle, File>((handle) => handle.getFile())

/**
 * Hold a picked file, and the id a node names it by — remembering the handle it came through,
 * where the browser gave one, so a reload can have it back.
 */
export function holdLocalFile(file: File, handle?: FileSystemFileHandle): string {
  const id = `file-${hashValue([file.name, file.size, file.lastModified])}`
  localFiles.hold(id, file, handle)
  return id
}

export function heldLocalFile(id: string): File | undefined {
  return localFiles.get(id)
}

/**
 * Where a local file is: in hand, being looked for among remembered handles, remembered but
 * waiting for a click to read it again, or not in this browser at all.
 */
/** Synchronously — and, the first time an id is not held, starting the look for its handle. */
export function localFileState(id: string): RememberedState {
  return localFiles.state(id)
}

/**
 * Look for a remembered handle and read its file where reading is still allowed. Once per id,
 * shared while in flight; what it finds is announced so the node and its card re-infer.
 */
export function restoreLocalFile(id: string): Promise<void> {
  return localFiles.restore(id)
}

/**
 * Ask the browser for a remembered file back — from the card's button, since only a user gesture
 * may. True where it is now held.
 */
export function grantLocalFile(id: string): Promise<boolean> {
  return localFiles.grant(id)
}

/** One key per place a file can be, for the summary cache. */
function refKey(ref: TableFileRef): string {
  return ref.kind === 'local' ? `local:${ref.id}` : `url:${ref.url}`
}

type SummaryEntry = { readonly refresh: number } & (
  | {
      readonly summary: FileSummary
      /** When the footer was read, epoch ms — the card's foot says how long ago. */
      readonly readAt: number
      readonly error?: undefined
    }
  | { readonly error: string; readonly summary?: undefined }
)

const summaries = new Map<string, SummaryEntry>()
const pending = new Map<string, Promise<FileSummary>>()

/**
 * What is known about a file's footer, synchronously — and, where it can be read and nobody has,
 * the read started: a URL, or a local file this tab holds. The second is what a reload needs: the
 * file comes back through its handle with no summary beside it, and a boot derives rather than
 * runs, so without this every picker below it stays empty until somebody presses Run. A local
 * read is a slice of a `File`, so it costs no network and needs no credential.
 */
export function peekTableFile(ref: TableFileRef, refresh = 0): SummaryEntry | undefined {
  const entry = summaries.get(refKey(ref))
  const readable = ref.kind === 'url' || localFiles.get(ref.id) !== undefined
  if (!entry && readable) void readTableFileSummary(ref, { refresh }).catch(() => {})
  return entry
}

/**
 * A file's footer summary: the one already read under this `refresh`, or a fresh read that is
 * remembered — success or failure — and announced.
 *
 * Deduplicated while a read is in flight (`memoPromise`), so the card's read on pick and the
 * node's `evaluate` that follows it share one. **The shared read carries nobody's signal**: it
 * used to carry its first caller's, so a run cancelled by the next edit handed that edit's run the
 * cancelled read, and the card went red with "aborted". A footer is a few small reads, so it is
 * left to finish and kept; each caller stops waiting on its own signal instead.
 */
export function readTableFileSummary(
  ref: TableFileRef,
  options: {
    refresh?: number
    signal?: AbortSignal
    /**
     * A reader that reads the file whole anyway — a BigClust project — taking a URL in **one
     * request** rather than as a footer and then a range per column chunk: a 60 MB features file
     * is about 8,400 of them. Every read of that URL is then served from the download (`fileSpec`)
     * until ⟳. Not Link Table's: its files are gigabytes, read a block at a time.
     */
    whole?: boolean
  } = {},
): Promise<FileSummary> {
  const refresh = options.refresh ?? 0
  const key = refKey(ref)
  const held = summaries.get(key)
  const refreshed = held !== undefined && held.refresh !== refresh
  const whole = options.whole && ref.kind === 'url' ? ref.url : undefined
  // Asked for even when the footer is known — read by a Link Table on the same URL, say — since
  // what it serves is every read after this one. Under ⟳, the read below lets go of it first.
  if (whole && !refreshed) holdWhole(whole)
  if (held?.summary && !refreshed) return Promise.resolve(held.summary)
  const shared = memoPromise(
    pending,
    // A read under a new nonce is not the one in flight under the old.
    `${key}#${refresh}`,
    async () => {
      try {
        // ⟳ on a local file: the held `File` is a snapshot, which a rewrite on disk makes unreadable.
        if (held && ref.kind === 'local') await reacquireLocalFile(ref.id)
        // ⟳ on a URL: what was learned of it let go — a Delta table's log, which is how a new
        // commit is taken up, and a whole download, which is then made again.
        if (refreshed && ref.kind === 'url') {
          tables.delete(tableRoot(ref.url))
          wholes.delete(ref.url)
        }
        if (whole) holdWhole(whole)
        const summary = await readSummary(await fileSpec(ref))
        summaries.set(key, { summary, refresh, readAt: Date.now() })
        return summary
      } catch (error) {
        summaries.set(key, { error: errorMessage(error), refresh })
        throw error
      } finally {
        reportUploadLearned()
      }
    },
    { keep: 'inflight' },
  )
  return untilAborted(shared, options.signal)
}

/**
 * Take a held local file again from disk, for a refresh. A `File` is a snapshot, and Chromium
 * refuses to read one whose file has changed since (`NotReadableError`), so holding on to it
 * would make ⟳ fail the same way forever. Through a remembered handle the file is simply read
 * afresh; without one — a browser with no handles, or the plain file input — a snapshot that no
 * longer reads is dropped, so the card asks for the file again by name.
 */
async function reacquireLocalFile(id: string): Promise<void> {
  const file = localFiles.get(id)
  if (!file) return
  const found = await localFiles.reopen(id)
  if (found) return void localFiles.hold(id, found)
  try {
    await file.slice(0, 1).arrayBuffer()
  } catch {
    localFiles.drop(id)
  }
}

const heads = new Map<string, Promise<{ size: number; modified?: string }>>()

/**
 * URLs downloaded in one request for a reader that reads them whole (`readTableFileSummary`'s
 * `whole`), by URL, served by `fileSpec` to every reader of that URL until ⟳ lets one go.
 */
const wholes = new Map<string, Promise<Blob>>()

/**
 * Start a URL's whole download, once: through the transport a range read takes, so the routes a
 * bucket needs and the retry on a dropped connection are the same ones, and revalidated rather
 * than taken from the cache unasked (`no-cache`), so ⟳ reads what the server now has. Kept until
 * ⟳; a failed download is not, so the next read tries again.
 */
function holdWhole(url: string): void {
  void memoPromise(wholes, url, () => fetchBlob(httpUrl(url), { cache: 'no-cache' }), {
    keep: 'resolved',
  })
}

/**
 * What is at a URL with no table file's extension, by its root: a Delta table's snapshot, or
 * `'file'` where the address turned out to be one file. Read once and kept, which **pins every
 * read to the version the Link Table saw** until ⟳ reads it again (`readTableFileSummary`). A
 * commit landing meanwhile changes nothing under anybody — the pinning is the point, a table
 * under active writes being where a number would otherwise move between two runs of a workflow.
 */
const tables = new Map<string, Promise<DeltaSnapshot | 'file'>>()

const EXTENSIONS = {
  parquet: ['parquet', 'parq', 'pq'],
  feather: ['feather', 'arrow', 'ipc'],
} as const

/** Every extension a table file goes by — the picker's list, and what a Delta folder lacks. */
export const TABLE_FILE_EXTENSIONS: readonly string[] = [
  ...EXTENSIONS.parquet,
  ...EXTENSIONS.feather,
]

/**
 * What a reference's name says it is, before anything is read: a table file by its extension, and
 * a URL with none a Delta table's folder. **A hint, never the answer** — it decides which is asked
 * for first (`fileSpec`) and what an export writes before a footer has landed; what a thing *is*
 * comes from its bytes (`openTableFile`) or its log, and is `FileSummary.format` from then on.
 *
 * A URL with a query string is a file whatever its path: a folder has objects *under* it, and
 * `…/datafile/123?format=original/_delta_log/…` is the same file asked for again, whole.
 */
export function formatByName(ref: TableFileRef): FileSummary['format'] {
  const byExtension = (path: string) => {
    const extension = /\.([a-z0-9]+)\/*$/i.exec(path)?.[1]?.toLowerCase() ?? ''
    if ((EXTENSIONS.feather as readonly string[]).includes(extension)) return 'feather'
    return (EXTENSIONS.parquet as readonly string[]).includes(extension) ? 'parquet' : undefined
  }
  if (ref.kind === 'local') return byExtension(ref.name) ?? 'parquet'
  try {
    const url = new URL(httpUrl(ref.url))
    return byExtension(url.pathname) ?? (url.search ? 'parquet' : 'delta')
  } catch {
    // Not a URL yet: read as typed.
    return byExtension(ref.url.trim()) ?? 'delta'
  }
}

/** A URL as the key a table is kept under: what is fetched, with no trailing slash. */
function tableRoot(url: string): string {
  return httpUrl(url).replace(/\/+$/, '')
}

/**
 * What is at an address whose name says folder. The log is asked first; where that fails — there
 * is none, or the server answers a missing object with something other than a clean 404, as a
 * bucket without list permission (403), a server sending no CORS header on its errors, and one
 * answering every path with a page all do — **the bytes at the address decide**: a table file
 * ends in its magic, and a download endpoint names a Parquet file with no extension at all.
 * Where it is neither, the table's own refusal is the one worth showing.
 */
async function tableAt(url: string, root: string): Promise<DeltaSnapshot | 'file'> {
  try {
    return await readDeltaSnapshot(httpDeltaStore(root))
  } catch (error) {
    if (await endsAsTableFile(url).catch(() => false)) return 'file'
    throw error
  }
}

async function endsAsTableFile(url: string): Promise<boolean> {
  const { size } = await urlHead(url)
  const tail = await bytesOf({ kind: 'url', url, size }).read(Math.max(0, size - 8), size)
  return endsWith(tail, PARQUET_MAGIC) || endsWith(tail, ARROW_MAGIC)
}

/**
 * Where a table's bytes are, for a reader.
 *
 *  - **A local file**: the held `File`.
 *  - **A file at a URL**: its size and modification time, asked of the server every time, one HEAD
 *    shared by the readers asking at once — so a file rewritten there is read at its new size and
 *    refused by its fingerprint (`requireFingerprint`), rather than read at stale offsets and
 *    misreported as a CSV or a server ignoring Range.
 *  - **A Delta table**: its snapshot, read once and kept until ⟳ (`tables`) — the opposite rule,
 *    a version being the one thing about a table that may not move under a workflow.
 */
export async function fileSpec(ref: TableFileRef, signal?: AbortSignal): Promise<FileSpec> {
  if (ref.kind === 'local') {
    // A remembered file still being looked for is waited on, not reported missing.
    await restoreLocalFile(ref.id)
    const file = localFiles.get(ref.id)
    if (!file) throw new Error(localFileProblem(ref.id, ref.name))
    return { kind: 'blob', blob: file }
  }
  const whole = wholes.get(ref.url)
  if (whole) return { kind: 'blob', blob: await untilAborted(whole, signal) }
  if (formatByName(ref) === 'delta') {
    const root = tableRoot(ref.url)
    const found = memoPromise(tables, root, () => tableAt(ref.url, root), { keep: 'resolved' })
    const table = await untilAborted(found, signal)
    if (table !== 'file') return { kind: 'delta', snapshot: table }
  }
  const head = memoPromise(heads, ref.url, () => urlHead(ref.url), { keep: 'inflight' })
  return { kind: 'url', url: ref.url, ...(await untilAborted(head, signal)) }
}

/**
 * Why a local file cannot be read now, or undefined where it can (or is still being looked for) —
 * one sentence per state, for the card, `validate` and a run alike.
 */
export function localFileProblem(id: string, name: string): string | undefined {
  switch (localFileState(id)) {
    case 'absent':
      return localFileMissing(name)
    case 'permission':
      return localFilePermission(name)
    default:
      return undefined
  }
}

function localFileMissing(name: string): string {
  return `The file handle for "${name || 'the file'}" was dropped (e.g. by a reload). Please select the file again.`
}

function localFilePermission(name: string): string {
  return (
    `Allow access to "${name || 'the file'}" again. The browser remembers the file but asks ` +
    `again after a reload. Use the button on the card.`
  )
}

/** Test seam: forget every held file, remembered-handle lookup and summary. */
export function resetTableFiles(): void {
  localFiles.reset()
  summaries.clear()
  pending.clear()
  heads.clear()
  tables.clear()
  wholes.clear()
  resetFileStore()
}
