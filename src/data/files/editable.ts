/**
 * Local files the Annotate card edits in place — a CSV somebody keeps their cell types in.
 *
 * Not `registry.ts`' table files: those are read, block by block, and held as a `File`, which is a
 * snapshot — writing needs the **handle** the file was picked through, and permission to write
 * through it. So an edited file is held as its handle, by an id the tab's settings name, and
 * remembered across a reload by the same machine a table file is (`remembered.ts`), asking for
 * `readwrite` rather than `read`. **Chromium only**: no other engine hands out a handle that
 * writes, and elsewhere the CSV backend refuses rather than offering a table nobody could edit —
 * the user's call: a read-only annotation card defeats the purpose of one.
 *
 * The id is minted at pick time, not hashed from the file: every edit changes its size and
 * modification time, and a name-and-size id would name a different file after the first write.
 */

import type { RememberedState } from './remembered'
import { remembered } from './remembered'

const handles = remembered<FileSystemFileHandle, FileSystemFileHandle>(
  async (handle) => handle,
  'readwrite',
)
/** Why this browser cannot have a CSV tab — said on the card and by the target. */
export const NO_FILE_WRITES =
  'editing a file on this computer needs a Chromium browser (Chrome, Edge), which this one is not'

/** Each file's write in progress, so the next waits for it — whichever tab or target asks. */
const writing = new Map<string, Promise<unknown>>()

/**
 * Run a read-modify-write of one file after any already under way. Per file rather than per
 * target: two tabs on one file with different key columns are two targets, and two overlapping
 * rewrites would each write back a file without the other's change.
 */
export function serialiseWrite<T>(id: string, run: () => Promise<T>): Promise<T> {
  const next = (writing.get(id) ?? Promise.resolve()).then(run)
  const settled = next.catch(() => undefined)
  writing.set(id, settled)
  void settled.then(() => {
    if (writing.get(id) === settled) writing.delete(id)
  })
  return next
}

/** Hold a picked file, and the id the tab names it by. */
export function holdEditableFile(handle: FileSystemFileHandle): string {
  const id = `edit-${crypto.randomUUID()}`
  handles.hold(id, handle, handle)
  return id
}

export function editableFile(id: string): FileSystemFileHandle | undefined {
  return handles.get(id)
}

/**
 * In hand, being looked for, remembered but waiting for a click to allow writing again, or not in
 * this browser. The first ask about an id not held starts the look (`remembered.ts`).
 */
export function editableFileState(id: string): RememberedState {
  return handles.state(id)
}

/** Ask the browser to allow writing to a remembered file again — from a click, the only way. */
export function grantEditableFile(id: string): Promise<boolean> {
  return handles.grant(id)
}

/** Test seam. */
export function resetEditableFiles(): void {
  handles.reset()
  writing.clear()
}
