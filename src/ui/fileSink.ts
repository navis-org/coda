/**
 * Where a loop's files go.
 *
 * A single Download writes through `downloadFiles`, one `<a download>` per file, and that is
 * right for the one-to-five files a value normally becomes. A `For Each` over four hundred
 * neurons is a different problem: browsers stop honouring downloads from one gesture somewhere
 * past about fifty, silently, which is the failure `MAX_MORPHOLOGY_FILES` caps at fifty to avoid
 * rather than solve. This is the route that solves it, and there are two of them because no
 * single one works everywhere.
 *
 * | | where the bytes go | holds in memory | available |
 * | --- | --- | --- | --- |
 * | `folder` | straight to disk, one file at a time | nothing | Chromium (File System Access) |
 * | `zip` | one archive at the end | everything | everywhere |
 *
 * **`folder` is the one worth having and `zip` is the one that always works**, and the split is
 * not a nicety: the whole reason to iterate rather than fetch four hundred skeletons at once is
 * that a loop holds one at a time, and a zip gives that back — 400 x 2 MB of SWC accumulates in
 * the tab until the archive is sealed. So a folder is offered wherever the API exists, and the
 * card says which of the two is in force, because the trade differs and it is not guessable.
 *
 * ## The picker has to be asked for from a gesture
 *
 * `showDirectoryPicker` requires transient activation, so it cannot be called from inside a run
 * — by the time the scheduler reaches the loop, the click that started the run is spent. That is
 * why `chooseSink` is called by the card's button, before the run, and the sink is parked in a
 * module-level slot the loop's `onIteration` picks up. A slot rather than a store field because
 * a `FileSystemDirectoryHandle` is not serialisable, must never reach the autosave, and has no
 * business in undo history — the same call `exportRegistry` makes about a live viewer.
 */

import { downloadFiles } from './export'
import type { ExportFile } from './exportValue'
import { zipFiles } from './zip'

export type SinkMode = 'folder' | 'zip'

/** Whether this browser can write into a folder the user picks. */
export function canWriteFolder(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** The best route available here, for a card that has to say which one it will take. */
export function bestSinkMode(): SinkMode {
  return canWriteFolder() ? 'folder' : 'zip'
}

export interface FileSink {
  mode: SinkMode
  /** Where things are going, for the card and for a notice. A folder name, or a zip's name. */
  label: string
  /** Take one pass's files. Resolves when they are safely somewhere. */
  write(files: ExportFile[]): Promise<void>
  /** Seal the archive and hand it over. A folder sink has nothing to do here. */
  close(): Promise<void>
  /** How many files this sink has taken. */
  written: number
}

/*
 * Minimal shapes for the File System Access API rather than `lib.dom` types, which do not
 * describe `showDirectoryPicker` in the TypeScript version this project pins. Narrow on purpose:
 * declaring only what is called keeps this from drifting into a second, wrong copy of the spec.
 */
interface WritableLike {
  write(data: BlobPart): Promise<void>
  close(): Promise<void>
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>
}
interface DirectoryHandleLike {
  name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>
}

/**
 * Names a file can have on disk, which is a smaller set than names a value can produce.
 *
 * A neuron's own label goes into a filename — that is the point of naming a pass by its element
 * — and a CATMAID name is somebody's free text, so a name with a slash or a colon in it is a
 * real one. On a folder sink an unescaped slash silently creates a directory; on Windows a colon
 * makes the file unopenable. Replaced rather than stripped, so two neurons whose names differ
 * only in punctuation stay two files.
 */
export function safeFileName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._()[\]{}+=@,~-]+/g, '-')
      /*
       * Trailing dots are legal here and not on Windows, where they are silently trimmed — two
       * files that then collide, with the second overwriting the first. Leading and trailing
       * dashes go with them: they are what a name made entirely of separators reduces to, and a
       * file called `-` is one most command lines read as a flag.
       */
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 120) || 'file'
  )
}

function folderSink(dir: DirectoryHandleLike): FileSink {
  const sink: FileSink = {
    mode: 'folder',
    label: dir.name,
    written: 0,
    write: async (files) => {
      for (const file of files) {
        /*
         * A name may carry a path, and each segment has to be created before the file. Walked
         * here rather than flattened, because grouping a loop's output into a folder per cell
         * type is the obvious thing to want next and costs nothing now.
         */
        const segments = file.name.split('/').filter(Boolean).map(safeFileName)
        const leaf = segments.pop() ?? 'file'
        let at = dir
        for (const segment of segments) at = await at.getDirectoryHandle(segment, { create: true })
        const handle = await at.getFileHandle(leaf, { create: true })
        const writable = await handle.createWritable()
        try {
          await writable.write(new Blob(file.parts, { type: file.mime }))
        } finally {
          // Closed in a `finally`: an unclosed writable leaves a zero-byte file on disk, which
          // reads as the loop having produced an empty neuron rather than as a failed write.
          await writable.close()
        }
        sink.written++
      }
    },
    close: async () => {},
  }
  return sink
}

/** A zip sink without asking anything, for a run started from the keyboard or the toolbar. */
export function zipSink(name: string): FileSink {
  const held: Array<{ name: string; parts: BlobPart[] }> = []
  const sink: FileSink = {
    mode: 'zip',
    label: `${name}.zip`,
    written: 0,
    write: (files) => {
      for (const file of files) {
        held.push({ name: file.name.split('/').map(safeFileName).join('/'), parts: file.parts })
        sink.written++
      }
      return Promise.resolve()
    },
    close: async () => {
      if (held.length === 0) return
      const blob = await zipFiles(held)
      downloadFiles([{ name: `${name}.zip`, parts: [blob], mime: 'application/zip' }])
    },
  }
  return sink
}

/**
 * Ask for somewhere to put a loop's files. Call from a click, never from inside a run.
 *
 * Returns `undefined` when the picker was dismissed, which is a decision rather than an error:
 * the caller abandons the run instead of quietly falling back to four hundred blocked downloads.
 */
export async function chooseSink(zipName: string): Promise<FileSink | undefined> {
  if (!canWriteFolder()) return zipSink(zipName)
  try {
    const picker = (
      window as unknown as {
        showDirectoryPicker(options?: { mode?: string }): Promise<DirectoryHandleLike>
      }
    ).showDirectoryPicker
    return folderSink(await picker.call(window, { mode: 'readwrite' }))
  } catch {
    // Dismissing the picker throws `AbortError`, and so does a policy that forbids it. Both mean
    // "no folder", and the caller's next move is the same either way.
    return undefined
  }
}

/*
 * The sink the next run's loops will write through.
 *
 * Module-level for `exportRegistry`'s reason: a `FileSystemDirectoryHandle` is not serialisable,
 * so it cannot live in the store without reaching the autosave, the undo history and the shared
 * file. It is claimed by the run that starts and cleared when that run ends, so a handle never
 * outlives the gesture that granted it.
 */
let pending: FileSink | undefined

export function armSink(sink: FileSink | undefined): void {
  pending = sink
}

export function armedSink(): FileSink | undefined {
  return pending
}

export function disarmSink(): FileSink | undefined {
  const sink = pending
  pending = undefined
  return sink
}
