/**
 * A BigClust project chosen as a folder on this machine: held by id, remembered where the browser
 * can, and answered a file at a time.
 *
 * The folder's twin of a local table file, on the same state machine (`files/remembered.ts`):
 * **only Chromium remembers it across a reload**, through the directory handle it was chosen with,
 * at most asking for one click to read it again; anywhere else the card asks for the folder again.
 * One handle per *folder* rather than one per file is the point of holding a folder at all: a
 * project is six files, and six permission prompts after every reload is not a feature.
 *
 * Elsewhere the folder comes from a `webkitdirectory` input as a flat list of files, each carrying
 * its path below the folder — held for this tab, and that is all.
 *
 * Each file a project reads is then handed to the table-file registry as an ordinary local file
 * (`projectFileRef` in `project.ts`), so footers, range reads and the reading worker are the ones
 * Link Table uses rather than a copy of them.
 */

import { hashValue } from '../../core/hash'
import type { RememberedState } from '../files/remembered'
import { remembered } from '../files/remembered'

/** A held folder: the handle it came through, or the files a folder input listed. */
type Held =
  | { readonly kind: 'handle'; readonly handle: FileSystemDirectoryHandle }
  | { readonly kind: 'files'; readonly files: ReadonlyMap<string, File> }

const folders = remembered<FileSystemDirectoryHandle, Held>(async (handle) => ({
  kind: 'handle',
  handle,
}))

/** Whether this browser can remember a chosen folder across a reload. Chromium only. */
export function remembersFolders(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/**
 * The id a folder is named by: its name and its `info` file's size and modification time, hashed,
 * so choosing the same project twice gives the same id and a graph naming one this browser does not
 * have says so rather than reading another. Its other files can change under the same id, which is
 * why choosing a folder reads it afresh (the card's `refresh` bump).
 */
function folderId(name: string, info: File): string {
  return `folder-${hashValue([name, info.size, info.lastModified])}`
}

/** Hold a folder chosen through Chromium's picker, remembering its handle. */
export async function holdFolderHandle(handle: FileSystemDirectoryHandle): Promise<string> {
  const info = await (await handle.getFileHandle('info')).getFile()
  const id = folderId(handle.name, info)
  folders.hold(id, { kind: 'handle', handle }, handle)
  return id
}

/**
 * Hold a folder chosen through a `webkitdirectory` input: its files by their path below the
 * folder. Undefined where the list holds no `info`, which is the one file a project must have.
 */
export function holdFolderFiles(
  files: Iterable<File>,
): { id: string; name: string } | undefined {
  const byPath = new Map<string, File>()
  let name = ''
  for (const file of files) {
    const [top, ...rest] = (file.webkitRelativePath || file.name).split('/')
    name ||= top ?? ''
    byPath.set(rest.length ? rest.join('/') : file.name, file)
  }
  const info = byPath.get('info')
  if (!info) return undefined
  const id = folderId(name, info)
  folders.hold(id, { kind: 'files', files: byPath })
  return { id, name }
}

export function folderState(id: string): RememberedState {
  return folders.state(id)
}

export function restoreFolder(id: string): Promise<void> {
  return folders.restore(id)
}

export function grantFolder(id: string): Promise<boolean> {
  return folders.grant(id)
}

/** A file of a held folder by its path below it — `meta.parquet`, `data/embeddings.parquet`. */
export async function folderFile(id: string, path: string, name: string): Promise<File> {
  await folders.restore(id)
  const folder = folders.get(id)
  if (!folder) throw new Error(folderProblem(id, name) ?? `The folder "${name}" is not open.`)
  const parts = path.split('/').filter((p) => p && p !== '.')
  if (folder.kind === 'files') {
    const file = folder.files.get(parts.join('/'))
    if (!file) throw new Error(`The folder "${name}" has no ${path}.`)
    return file
  }
  try {
    let dir = folder.handle
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
    return await (await dir.getFileHandle(parts[parts.length - 1] ?? '')).getFile()
  } catch {
    throw new Error(`The folder "${name}" has no ${path}.`)
  }
}

/** Why a folder cannot be read now, or undefined where it can (or is still being looked for). */
export function folderProblem(id: string, name: string): string | undefined {
  switch (folders.state(id)) {
    case 'absent':
      return (
        `This browser does not have the folder "${name || 'the project'}" open (after a reload, ` +
        `or in a graph from somebody else). Choose it again.`
      )
    case 'permission':
      return (
        `Allow access to the folder "${name || 'the project'}" again. The browser remembers the ` +
        `folder but asks again after a reload. Use the button on the card.`
      )
    default:
      return undefined
  }
}

/** Test seam: forget every held folder. */
export function resetFolders(): void {
  folders.reset()
}
