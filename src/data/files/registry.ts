/**
 * The table files this tab knows about: the local ones it holds, and what every one's footer said.
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
 * **Across a reload, only Chromium remembers**, through the handle the file was chosen with
 * (`store.ts`). A reload finds the handle and asks whether reading is still allowed: often it is,
 * and the file is simply back; otherwise the browser wants a click, which only a user gesture can
 * give, so the card shows a button (`grantLocalFile`). Anywhere without handles — Firefox, Safari,
 * a graph somebody sent — the card asks for the file again, naming it. The four states are
 * `LocalFileState`'s, and "still looking" is the one that says nothing: a warning that a file is
 * missing, a moment before it is found, is one people learn to distrust.
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
import { urlHead } from './bytes'
import type { FileSummary } from './columns'
import { loadHandle, resetFileStore, saveHandle } from './store'

const localFiles = new Map<string, File>()
/** Remembered handles whose read permission the browser wants asked for again. */
const awaitingPermission = new Map<string, FileSystemFileHandle>()
/** Ids whose remembered handle has been looked for and not turned into a file. */
const looked = new Set<string>()
const restoring = new Map<string, Promise<void>>()

/**
 * Whether this browser can remember a picked file across a reload: the File System Access picker
 * hands back a handle, which `store.ts` keeps in IndexedDB. Chromium only. The one statement of
 * it — the card's picker and Link Table's hint both ask here.
 */
export function remembersLocalFiles(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

/**
 * Hold a picked file, and the id a node names it by — remembering the handle it came through,
 * where the browser gave one, so a reload can have it back.
 */
export function holdLocalFile(file: File, handle?: FileSystemFileHandle): string {
  const id = `file-${hashValue([file.name, file.size, file.lastModified])}`
  localFiles.set(id, file)
  awaitingPermission.delete(id)
  if (handle) void saveHandle(id, handle)
  return id
}

export function heldLocalFile(id: string): File | undefined {
  return localFiles.get(id)
}

/**
 * Where a local file is: in hand, being looked for among remembered handles, remembered but
 * waiting for a click to read it again, or not in this browser at all.
 */
export type LocalFileState = 'held' | 'restoring' | 'permission' | 'absent'

/** The state, with no side effect: the one statement of it. */
function stateOf(id: string): LocalFileState {
  if (localFiles.has(id)) return 'held'
  if (awaitingPermission.has(id)) return 'permission'
  if (looked.has(id)) return 'absent'
  return 'restoring'
}

/** Synchronously — and, the first time an id is not held, starting the look for its handle. */
export function localFileState(id: string): LocalFileState {
  const state = stateOf(id)
  if (state === 'restoring') void restoreLocalFile(id)
  return state
}

/**
 * Look for a remembered handle and read its file where reading is still allowed. Once per id,
 * shared while in flight; what it finds is announced so the node and its card re-infer.
 */
export function restoreLocalFile(id: string): Promise<void> {
  if (stateOf(id) !== 'restoring') return Promise.resolve()
  return memoPromise(
    restoring,
    id,
    async () => {
      try {
        const found = await readRemembered(id)
        if (found instanceof File) localFiles.set(id, found)
        else if (found) awaitingPermission.set(id, found)
      } finally {
        looked.add(id)
        reportUploadLearned()
      }
    },
    { keep: 'inflight' },
  )
}

/**
 * A remembered file read afresh through its handle where reading is still allowed; the handle
 * where the browser wants a click first; nothing where no handle is remembered, or it points at a
 * file since deleted or moved.
 */
async function readRemembered(id: string): Promise<File | FileSystemFileHandle | undefined> {
  try {
    const handle = await loadHandle(id)
    if (!handle) return undefined
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') return handle
    return await handle.getFile()
  } catch {
    return undefined
  }
}

/**
 * Ask the browser for a remembered file back — from the card's button, since only a user gesture
 * may. True where it is now held.
 */
export async function grantLocalFile(id: string): Promise<boolean> {
  const handle = awaitingPermission.get(id)
  if (!handle) return localFiles.has(id)
  if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return false
  localFiles.set(id, await handle.getFile())
  awaitingPermission.delete(id)
  reportUploadLearned()
  return true
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
  const readable = ref.kind === 'url' || localFiles.has(ref.id)
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
  options: { refresh?: number; signal?: AbortSignal } = {},
): Promise<FileSummary> {
  const refresh = options.refresh ?? 0
  const key = refKey(ref)
  const held = summaries.get(key)
  if (held?.summary && held.refresh === refresh) return Promise.resolve(held.summary)
  const shared = memoPromise(
    pending,
    // A read under a new nonce is not the one in flight under the old.
    `${key}#${refresh}`,
    async () => {
      try {
        // ⟳ on a local file: the held `File` is a snapshot, which a rewrite on disk makes unreadable.
        if (held && ref.kind === 'local') await reacquireLocalFile(ref.id)
        const spec = await fileSpec(ref)
        const summary = await readSummary(spec)
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
  const found = await readRemembered(id)
  if (found instanceof File) return void localFiles.set(id, found)
  try {
    await file.slice(0, 1).arrayBuffer()
  } catch {
    localFiles.delete(id)
    looked.add(id)
  }
}

const heads = new Map<string, Promise<{ size: number; modified?: string }>>()

/**
 * Where a file's bytes are, for a reader: the held `File`, or a URL with its size and modification
 * time — asked of the server every time, one HEAD shared by the readers asking at once, so a file
 * rewritten there is read at its new size and refused by its fingerprint (`requireFingerprint`),
 * rather than read at stale offsets and misreported as a CSV or a server ignoring Range.
 */
export async function fileSpec(ref: TableFileRef, signal?: AbortSignal): Promise<FileSpec> {
  if (ref.kind === 'local') {
    // A remembered file still being looked for is waited on, not reported missing.
    await restoreLocalFile(ref.id)
    const file = localFiles.get(ref.id)
    if (!file) throw new Error(localFileProblem(ref.id, ref.name))
    return { kind: 'blob', blob: file }
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
    `Allow access to "${name || 'the file'}" again — the browser remembers it but asks after a ` +
    `reload. Use the button on the card.`
  )
}

/** Test seam: forget every held file, remembered-handle lookup and summary. */
export function resetTableFiles(): void {
  localFiles.clear()
  awaitingPermission.clear()
  looked.clear()
  restoring.clear()
  summaries.clear()
  pending.clear()
  heads.clear()
  resetFileStore()
}
