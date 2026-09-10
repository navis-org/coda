/**
 * The shared IndexedDB opener and its two transaction policies.
 *
 * What is pinned is what each of the five callers used to get right or wrong on its own: stores
 * created on upgrade, a rejected open **not** memoised, a connection that steps aside for another
 * tab's upgrade (only one of the five had that), and the two policies — a refusing commit that
 * names its failure, a resolving attempt that answers the fallback.
 *
 * `fake-indexeddb` for `library.test.ts`' reason: a persistence layer verified against an
 * in-memory shim verifies the shim.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import { attempt, commit, database } from './idb'

const WORDS = {
  unavailable: 'no storage',
  rolledBack: 'rolled back',
  failed: 'failed',
  quota: 'full',
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('database', () => {
  it('creates the stores it declares and memoises the connection', async () => {
    const db = database({ name: 't', version: 1, stores: ['a', 'b'] })
    const first = await db.open()
    expect([...first.objectStoreNames].sort()).toEqual(['a', 'b'])
    expect(await db.open()).toBe(first)
  })

  it('does not memoise a rejected open', async () => {
    const db = database({ name: 't', version: 1, stores: ['a'] })
    // @ts-expect-error deliberately removing the platform API — a private window, from in here
    delete globalThis.indexedDB
    await expect(db.open()).rejects.toThrow()
    globalThis.indexedDB = new IDBFactory()
    // No `reset()`: somebody who fixes their browser settings should not have to reload the tab.
    await expect(db.open()).resolves.toBeTruthy()
  })

  it('steps aside for another tab upgrading, and reopens afterwards', async () => {
    const old = database({ name: 't', version: 1, stores: ['a'] })
    await old.open()
    // Without `onversionchange` this open is blocked by the connection above.
    const upgraded = await database({ name: 't', version: 2, stores: ['a', 'b'] }).open()
    expect(upgraded.version).toBe(2)
    // The old memo was dropped, so the next open is a real one — refused, at a stale version,
    // rather than a closed connection handed back.
    await expect(old.open()).rejects.toThrow()
  })
})

describe('commit and attempt', () => {
  it('commits a write that an attempt then reads back', async () => {
    const db = database({ name: 't', version: 1, stores: ['a'] })
    await commit(db, ['a'], (tx) => void tx.objectStore('a').put('v', 'k'), WORDS)
    expect(
      await attempt(db, 'a', 'readonly', (tx) => tx.objectStore('a').get('k'), 'none'),
    ).toBe('v')
    expect(
      await attempt(db, 'a', 'readonly', (tx) => tx.objectStore('a').get('missing'), 'none'),
    ).toBe('none')
  })

  it('refuses with the caller’s words when there is no database', async () => {
    // @ts-expect-error deliberately removing the platform API
    delete globalThis.indexedDB
    const db = database({ name: 't', version: 1, stores: ['a'] })
    await expect(commit(db, ['a'], () => {}, WORDS)).rejects.toThrow('no storage')
    expect(
      await attempt(db, 'a', 'readonly', (tx) => tx.objectStore('a').get('k'), 'none'),
    ).toBe('none')
  })

  it('a body that throws commits nothing it had queued', async () => {
    const db = database({ name: 't', version: 1, stores: ['a'] })
    await expect(
      commit(
        db,
        ['a'],
        (tx) => {
          tx.objectStore('a').put('queued', 'first')
          tx.objectStore('a').put(() => 'not cloneable', 'second')
        },
        WORDS,
      ),
    ).rejects.toThrow()
    expect(
      await attempt(db, 'a', 'readonly', (tx) => tx.objectStore('a').get('first'), 'none'),
    ).toBe('none')
  })

  it('an unknown store is refused as unavailable, and read as the fallback', async () => {
    const db = database({ name: 't', version: 1, stores: ['a'] })
    await expect(commit(db, ['nope'], () => {}, WORDS)).rejects.toThrow()
    expect(
      await attempt(db, 'nope', 'readonly', (tx) => tx.objectStore('nope').get('k'), 0),
    ).toBe(0)
  })
})
