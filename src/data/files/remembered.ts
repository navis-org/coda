/**
 * Something on this machine held by id, and remembered across a reload where the browser can —
 * the one state machine behind a local table file (`registry.ts`) and a local project folder
 * (`bigclust/folders.ts`).
 *
 * A file or folder cannot go into a graph, so a node names it by an id. **Only Chromium remembers
 * it across a reload**, through the handle it was chosen with, which `store.ts` keeps in IndexedDB;
 * a reload looks the handle up and asks whether reading is still allowed — often it is, otherwise
 * the browser wants a click, which only a user gesture can give. So four states, and "still
 * looking" is the one that says nothing: a warning that something is missing, a moment before it is
 * found, is one people learn to distrust.
 *
 * Written once because it was written twice, line for line, down to the permission sentence.
 */

import { memoPromise } from '../memoPromise'
import { reportUploadLearned } from '../uploads'
import { loadHandle, saveHandle } from './store'

/**
 * Whether this browser hands out file handles — the File System Access picker, Chromium only. The
 * one statement of it: a handle is what is remembered across a reload, and what writes to a file.
 */
export function hasFileHandles(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

/** In hand, being looked for, remembered but waiting for a click, or not in this browser. */
export type RememberedState = 'held' | 'restoring' | 'permission' | 'absent'

export interface Remembered<H extends FileSystemHandle, T> {
  get(id: string): T | undefined
  /** Hold a value under an id — remembering the handle it came through, where there is one. */
  hold(id: string, value: T, handle?: H): void
  /** Let a held value go, so the id reads as absent. */
  drop(id: string): void
  /** Synchronously — and, the first time an id is not held, starting the look for its handle. */
  state(id: string): RememberedState
  /** Look for a remembered handle once per id, and hold what it opens where reading is allowed. */
  restore(id: string): Promise<void>
  /** Ask the browser for a remembered handle back — a click being the only thing that may. */
  grant(id: string): Promise<boolean>
  /** What the remembered handle opens now where reading is allowed, without holding it. */
  reopen(id: string): Promise<T | undefined>
  reset(): void
}

export function remembered<H extends FileSystemHandle, T>(
  open: (handle: H) => Promise<T>,
  /** What the remembered handle must still allow: reading, or — an edited file — writing too. */
  mode: 'read' | 'readwrite' = 'read',
): Remembered<H, T> {
  const held = new Map<string, T>()
  /** Remembered handles whose permission for `mode` the browser wants asked for again. */
  const awaiting = new Map<string, H>()
  /** Ids whose remembered handle has been looked for and not turned into a value. */
  const looked = new Set<string>()
  const restoring = new Map<string, Promise<void>>()

  const stateOf = (id: string): RememberedState =>
    held.has(id)
      ? 'held'
      : awaiting.has(id)
        ? 'permission'
        : looked.has(id)
          ? 'absent'
          : 'restoring'

  /** The handle, and whether `mode` through it is allowed; nothing where none is remembered. */
  const lookUp = async (id: string): Promise<{ handle: H; allowed: boolean } | undefined> => {
    try {
      const handle = await loadHandle<H>(id)
      if (!handle) return undefined
      return { handle, allowed: (await handle.queryPermission({ mode })) === 'granted' }
    } catch {
      return undefined
    }
  }

  const self: Remembered<H, T> = {
    get: (id) => held.get(id),
    hold(id, value, handle) {
      held.set(id, value)
      awaiting.delete(id)
      if (handle) void saveHandle(id, handle)
    },
    drop(id) {
      held.delete(id)
      looked.add(id)
    },
    state(id) {
      const state = stateOf(id)
      if (state === 'restoring') void self.restore(id)
      return state
    },
    restore(id) {
      if (stateOf(id) !== 'restoring') return Promise.resolve()
      return memoPromise(
        restoring,
        id,
        async () => {
          try {
            const found = await lookUp(id)
            if (!found) return
            // A handle pointing at something since deleted or moved opens nothing: absent.
            if (found.allowed) held.set(id, await open(found.handle))
            else awaiting.set(id, found.handle)
          } catch {
            // Absent, as below.
          } finally {
            looked.add(id)
            reportUploadLearned()
          }
        },
        { keep: 'inflight' },
      )
    },
    async grant(id) {
      const handle = awaiting.get(id)
      if (!handle) return held.has(id)
      if ((await handle.requestPermission({ mode })) !== 'granted') return false
      held.set(id, await open(handle))
      awaiting.delete(id)
      reportUploadLearned()
      return true
    },
    async reopen(id) {
      const found = await lookUp(id)
      if (!found?.allowed) return undefined
      try {
        return await open(found.handle)
      } catch {
        return undefined
      }
    },
    reset() {
      held.clear()
      awaiting.clear()
      looked.clear()
      restoring.clear()
    },
  }
  return self
}
