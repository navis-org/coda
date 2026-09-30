/**
 * What this browser keeps about table files between sessions: the handle a local file was chosen
 * through, and the block index a lookup built.
 *
 * Neither is the file. A **handle** is Chromium's reference to a file on disk — structured-
 * cloneable, so it goes into IndexedDB as it is, and a reload can ask for the file again with one
 * click rather than a file dialog. An **index** is a few bytes per block, keyed by the file's
 * fingerprint, so a rewritten file never reads an index built for its previous contents.
 *
 * Both are remembered on a best-effort basis (`attempt`): failing to remember is not failing to
 * compute, and a private window with no IndexedDB simply forgets, which reads as a browser without
 * handles and a file that was never indexed.
 */

import { attempt, database, readKey } from '../idb'
import type { BlockIndex } from './reader'

const HANDLES = 'handles'
const INDEXES = 'indexes'

const db = database({ name: 'coda-table-files', version: 1, stores: [HANDLES, INDEXES] })

/** One write, best-effort: failing to remember is not failing to compute. */
function put(store: string, key: string, value: unknown): Promise<void> {
  return attempt(
    db,
    store,
    'readwrite',
    (tx) => void tx.objectStore(store).put(value, key),
    undefined,
  )
}

export function saveHandle(id: string, handle: FileSystemFileHandle): Promise<void> {
  return put(HANDLES, id, handle)
}

export function loadHandle(id: string): Promise<FileSystemFileHandle | undefined> {
  return readKey<FileSystemFileHandle, undefined>(db, HANDLES, id, undefined)
}

const indexKey = (fingerprint: string, column: string) => `${fingerprint}\u0000${column}`

export function loadIndex(
  fingerprint: string,
  column: string,
): Promise<BlockIndex | undefined> {
  return readKey<BlockIndex, undefined>(db, INDEXES, indexKey(fingerprint, column), undefined)
}

export function saveIndex(
  fingerprint: string,
  column: string,
  index: BlockIndex,
): Promise<void> {
  return put(INDEXES, indexKey(fingerprint, column), index)
}

/** Test seam: forget the connection, so a fresh `indexedDB` is picked up. */
export function resetFileStore(): void {
  db.reset()
}
