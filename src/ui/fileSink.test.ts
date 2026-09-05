/**
 * The file sink: which route a loop takes, and what it does to a name on the way.
 *
 * The folder route is driven against a fake `showDirectoryPicker` rather than skipped, because
 * everything that can go wrong with it is bookkeeping a fake catches — a writable left unclosed,
 * a path segment that never became a directory, a name that would be illegal on Windows. The one
 * thing a fake cannot check is that the browser honours the handle, which no test in jsdom could.
 *
 * Run under **node rather than jsdom**, which is the reverse of every other file in this
 * directory and is forced: jsdom's `Blob` implements neither `text()` nor `arrayBuffer()`, so
 * there is no way to read back what the sink wrote. `window` is the only browser global this
 * module touches, and it touches it only to look for `showDirectoryPicker` — so it is cheaper to
 * supply that one object than to give up checking the bytes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  bestSinkMode,
  canWriteFolder,
  chooseSink,
  safeFileName,
  zipSink,
  armSink,
  armedSink,
  disarmSink,
} from './fileSink'

/** A directory handle that records what was written where, and whether it was closed. */
function fakeDirectory(name = 'neurons') {
  const files = new Map<string, { text: string; closed: boolean }>()
  const make = (prefix: string): Record<string, unknown> => ({
    name: prefix || name,
    getDirectoryHandle: (child: string) => Promise.resolve(make(`${prefix}${child}/`)),
    getFileHandle: (leaf: string) =>
      Promise.resolve({
        createWritable: () => {
          const path = `${prefix}${leaf}`
          const entry = { text: '', closed: false }
          files.set(path, entry)
          return Promise.resolve({
            write: async (data: Blob) => {
              entry.text = await data.text()
            },
            close: () => {
              entry.closed = true
              return Promise.resolve()
            },
          })
        },
      }),
  })
  return { handle: make(''), files }
}

/** The one browser global `fileSink` reads. See the header for why it is stubbed by hand. */
const fakeWindow: Record<string, unknown> = {}
beforeAll(() => {
  ;(globalThis as Record<string, unknown>).window = fakeWindow
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).window
})

function installPicker(handle: unknown) {
  fakeWindow.showDirectoryPicker = () => Promise.resolve(handle)
}

afterEach(() => {
  delete fakeWindow.showDirectoryPicker
  disarmSink()
  vi.restoreAllMocks()
})

describe('safeFileName', () => {
  it('replaces what a filesystem will not take, rather than dropping it', () => {
    // A slash would silently make a directory on the folder route; a colon makes the file
    // unopenable on Windows. Replaced, so two neurons whose names differ only here stay two files.
    expect(safeFileName('LC4 (left) / v2')).toBe('LC4-(left)-v2')
    expect(safeFileName('a:b')).toBe('a-b')
  })

  it('never returns a trailing dot, which Windows trims into a collision', () => {
    expect(safeFileName('neuron...')).toBe('neuron')
  })

  it('never returns empty, so a nameless element still becomes a file', () => {
    // A name made entirely of separators reduces to nothing. `-` would be a legal filename and
    // a bad one — most command lines read a leading dash as a flag.
    expect(safeFileName('///')).toBe('file')
    expect(safeFileName('..')).toBe('file')
  })

  it('keeps a neuron id exactly', () => {
    // Ids are the commonest thing in one of these names and must survive untouched — a mangled
    // id names a different neuron with nothing to say so (invariant 8).
    expect(safeFileName('720575940624438831')).toBe('720575940624438831')
  })
})

describe('choosing a route', () => {
  it('reports zip where the folder API is absent', () => {
    expect(canWriteFolder()).toBe(false)
    expect(bestSinkMode()).toBe('zip')
  })

  it('reports folder where it is present', () => {
    installPicker(fakeDirectory().handle)
    expect(canWriteFolder()).toBe(true)
    expect(bestSinkMode()).toBe('folder')
  })

  it('falls back to a zip sink rather than nothing when there is no picker', async () => {
    const sink = await chooseSink('run')
    expect(sink?.mode).toBe('zip')
  })

  /*
   * Dismissing the picker is a decision, not an error. The caller abandons the run on
   * `undefined`; answering with a zip sink instead would quietly do the thing that was declined.
   */
  it('answers undefined when the picker is dismissed', async () => {
    fakeWindow.showDirectoryPicker = () =>
      Promise.reject(new Error('The user aborted a request.'))
    expect(await chooseSink('run')).toBeUndefined()
  })
})

describe('the folder sink', () => {
  it('writes each file and closes every writable', async () => {
    const dir = fakeDirectory()
    installPicker(dir.handle)
    const sink = await chooseSink('run')

    await sink!.write([{ name: 'a.swc', parts: ['one'], mime: 'text/plain' }])
    await sink!.write([{ name: 'b.swc', parts: ['two'], mime: 'text/plain' }])
    await sink!.close()

    expect([...dir.files.keys()]).toEqual(['a.swc', 'b.swc'])
    expect(dir.files.get('a.swc')?.text).toBe('one')
    // An unclosed writable leaves a zero-byte file on disk, which reads as the loop having
    // produced an empty neuron rather than as a failed write.
    expect([...dir.files.values()].every((f) => f.closed)).toBe(true)
    expect(sink!.written).toBe(2)
  })

  it('creates the directories a path names before the file', async () => {
    const dir = fakeDirectory()
    installPicker(dir.handle)
    const sink = await chooseSink('run')
    await sink!.write([{ name: 'LC4/720575940624.swc', parts: ['x'], mime: 'text/plain' }])
    expect([...dir.files.keys()]).toEqual(['LC4/720575940624.swc'])
  })

  it('sanitises each segment, so a name cannot escape the folder', async () => {
    const dir = fakeDirectory()
    installPicker(dir.handle)
    const sink = await chooseSink('run')
    await sink!.write([{ name: '../../etc/passwd', parts: ['x'], mime: 'text/plain' }])
    // `..` is not a path segment here, it is a name that sanitises to nothing and falls back —
    // so the walk descends into a folder called `file` rather than climbing out of the one the
    // user picked. The API would refuse `..` anyway; this is the belt to that brace.
    expect([...dir.files.keys()]).toEqual(['file/file/etc/passwd'])
  })
})

describe('the armed sink', () => {
  /*
   * A module slot rather than store state, because a `FileSystemDirectoryHandle` is not
   * serialisable and must never reach the autosave or the undo history. What the tests pin is
   * that it is claimed exactly once — a handle outliving the gesture that granted it would have
   * a later, unrelated run writing into a folder nobody chose for it.
   */
  it('is handed over once and then gone', () => {
    const sink = zipSink('run')
    armSink(sink)
    expect(armedSink()).toBe(sink)
    expect(disarmSink()).toBe(sink)
    expect(armedSink()).toBeUndefined()
    expect(disarmSink()).toBeUndefined()
  })
})
