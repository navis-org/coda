/**
 * A local file across a reload: what the registry does with the handle it was chosen through —
 * and a footer read shared across a cancelled run, and ⟳ reading a rewritten file afresh.
 *
 * The store is mocked, since a handle is a platform object nothing outside Chromium can make or
 * put into IndexedDB. What is pinned is the three outcomes a reload can have, and that each is
 * announced — a node whose file came back must re-infer.
 */

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { subscribeUploadLearned } from '../uploads'

const remembered = new Map<string, FileSystemFileHandle>()
vi.mock('./store', () => ({
  saveHandle: async (id: string, handle: FileSystemFileHandle) =>
    void remembered.set(id, handle),
  loadHandle: async (id: string) => remembered.get(id),
  resetFileStore: () => {},
}))

const {
  grantLocalFile,
  heldLocalFile,
  holdLocalFile,
  localFileState,
  peekTableFile,
  readTableFileSummary,
  resetTableFiles,
  restoreLocalFile,
} = await import('./registry')

/** A handle as Chromium hands one back, reading `file` once permission is `granted`. */
function handle(file: File, permission: PermissionState): FileSystemFileHandle {
  let state = permission
  return {
    queryPermission: async () => state,
    requestPermission: async () => (state = 'granted'),
    getFile: async () => file,
  } as unknown as FileSystemFileHandle
}

const FILE = new File(['PAR1'], 'synapses.parquet', { lastModified: 1 })

/** The real synapse fixture as a picked file, and the ref a node would name it by. */
function fixtureFile(name = 'synapses.parquet'): File {
  return new File([readFileSync(`src/data/files/__fixtures__/${name}`)], name, {
    lastModified: 1,
  })
}
const localRef = (id: string) => ({ kind: 'local' as const, id, name: 'synapses.parquet' })

beforeEach(() => {
  resetTableFiles()
  remembered.clear()
})

describe('a local file after a reload', () => {
  it('is back without a word where reading is still allowed', async () => {
    const id = holdLocalFile(FILE, handle(FILE, 'granted'))
    resetTableFiles() // the reload: nothing held, the handle still remembered
    const heard = vi.fn()
    const stop = subscribeUploadLearned(heard)
    expect(localFileState(id)).toBe('restoring')
    await restoreLocalFile(id)
    stop()
    expect(localFileState(id)).toBe('held')
    expect(heldLocalFile(id)).toBe(FILE)
    expect(heard).toHaveBeenCalled()
  })

  it('waits for a click where the browser wants to ask again', async () => {
    const id = holdLocalFile(FILE, handle(FILE, 'prompt'))
    resetTableFiles()
    await restoreLocalFile(id)
    expect(localFileState(id)).toBe('permission')
    expect(await grantLocalFile(id)).toBe(true)
    expect(localFileState(id)).toBe('held')
  })

  it('is absent where nothing was remembered — another browser, or one without handles', async () => {
    const id = holdLocalFile(FILE)
    resetTableFiles()
    await restoreLocalFile(id)
    expect(localFileState(id)).toBe('absent')
  })
})

describe('a local file’s footer after a reload', () => {
  it('is read by the next peek once the file is back, with nothing pressed', async () => {
    const file = fixtureFile()
    const id = holdLocalFile(file, handle(file, 'granted'))
    resetTableFiles() // the reload: the file and its summary both gone, the handle remembered
    const ref = localRef(id)
    expect(peekTableFile(ref)).toBeUndefined()
    await restoreLocalFile(id)
    // The peek that follows the announcement starts the read; the one after answers it.
    peekTableFile(ref)
    await vi.waitFor(() => expect(peekTableFile(ref)?.summary?.rows).toBe(12))
  })
})

describe('a footer read', () => {
  it('shared with a cancelled run still answers the run after it', async () => {
    const ref = localRef(holdLocalFile(fixtureFile()))
    const first = new AbortController()
    const cancelled = readTableFileSummary(ref, { signal: first.signal })
    first.abort()
    // The next edit's run joins the read the last one started, under a live signal of its own.
    const next = readTableFileSummary(ref, { signal: new AbortController().signal })
    await expect(cancelled).rejects.toThrow()
    await expect(next).resolves.toMatchObject({ rows: 12 })
    expect(peekTableFile(ref)?.error).toBeUndefined()
  })

  it('reads a local file afresh through its handle on ⟳, the held one being a snapshot', async () => {
    const before = fixtureFile()
    const after = fixtureFile('synapses.feather')
    let onDisk = before
    const id = holdLocalFile(before, {
      queryPermission: async () => 'granted',
      getFile: async () => onDisk,
    } as unknown as FileSystemFileHandle)
    await vi.waitFor(() => expect(remembered.has(id)).toBe(true))
    const ref = localRef(id)
    await readTableFileSummary(ref)
    onDisk = after
    await expect(readTableFileSummary(ref, { refresh: 1 })).resolves.toMatchObject({
      format: 'feather',
    })
    expect(heldLocalFile(id)).toBe(after)
  })

  it('asks for a local file again on ⟳ where its snapshot no longer reads and nothing remembers it', async () => {
    const file = fixtureFile()
    const id = holdLocalFile(file)
    const ref = localRef(id)
    await readTableFileSummary(ref)
    // What Chromium does to a picked file rewritten on disk.
    file.slice = () =>
      ({
        arrayBuffer: () => Promise.reject(new DOMException('changed', 'NotReadableError')),
      }) as unknown as Blob
    await expect(readTableFileSummary(ref, { refresh: 1 })).rejects.toThrow()
    expect(localFileState(id)).toBe('absent')
  })
})
