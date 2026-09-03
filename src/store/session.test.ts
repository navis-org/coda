/**
 * The session store: which workflows a tab has open, kept so a reload comes back to all of them.
 *
 * This file is the storage layer alone. What is pinned is the handful of answers the layer above
 * cannot check for itself, each of which fails as a plausible result rather than as an error: an
 * order that comes back rearranged (the switcher draws `docs` in insertion order, so a restore
 * that ignored the meta row would shuffle somebody's tabs on every reload), a document lost
 * because the order forgot it, one tab's session swept up by a range scan because its id prefixes
 * another's, and a missing IndexedDB reporting a failure where it should report an empty session.
 *
 * The seam with the `localStorage` slot — that the active document arrives synchronously and is
 * not then restored a second time from here — is `documents.test.ts`, where the store is.
 *
 * `fake-indexeddb` for `library.test.ts`'s reason: a persistence layer verified against an
 * in-memory shim verifies the shim. No DOM, because this module touches nothing else.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import { emptyGraph } from '../core/graph'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import {
  clearSession,
  loadSession,
  resetSessionStore,
  saveSessionDoc,
  saveSessionMeta,
} from './session'

registerSource(new MockSource({ latencyMs: 0 }))

beforeEach(() => {
  // A new factory per case, and the module told to forget the handle it opened against the old
  // one — `library.test.ts`'s rule, and without the second half every case after the first
  // writes into a dead database.
  globalThis.indexedDB = new IDBFactory()
  resetSessionStore()
})

const json = (name: string) => JSON.stringify({ ...emptyGraph(name), version: 1 })

describe('the session store', () => {
  it('answers an empty session for a tab that has never written one', async () => {
    expect(await loadSession('tab-a')).toEqual([])
  })

  it('round-trips documents in the order the meta row names', async () => {
    await saveSessionDoc('tab-a', 'd1', json('First'))
    await saveSessionDoc('tab-a', 'd2', json('Second'))
    await saveSessionDoc('tab-a', 'd3', json('Third'))
    // Deliberately not the order they were written: the meta row is what decides.
    await saveSessionMeta('tab-a', ['d3', 'd1', 'd2'])

    expect((await loadSession('tab-a')).map((d) => d.docId)).toEqual(['d3', 'd1', 'd2'])
  })

  /*
   * The two are written in separate transactions, so a crash between them is reachable. Losing
   * the order is survivable; losing a document because the order forgot it is not.
   */
  it('still returns a document the order has lost track of', async () => {
    await saveSessionDoc('tab-a', 'd1', json('First'))
    await saveSessionDoc('tab-a', 'd2', json('Second'))
    await saveSessionMeta('tab-a', ['d1'])

    expect((await loadSession('tab-a')).map((d) => d.docId).sort()).toEqual(['d1', 'd2'])
  })

  /*
   * The compound key is a string, so a tab whose id is a prefix of another's would be swept up by
   * a careless range — which is the mistake `SLOT_PREFIX` and `SLOT_INDEX_KEY` already document
   * one layer down.
   */
  it('keeps two tabs apart, including one whose id prefixes the other', async () => {
    await saveSessionDoc('tab', 'd1', json('Short'))
    await saveSessionMeta('tab', ['d1'])
    await saveSessionDoc('tab-long', 'd2', json('Long'))
    await saveSessionMeta('tab-long', ['d2'])

    expect((await loadSession('tab')).map((d) => d.docId)).toEqual(['d1'])
    expect((await loadSession('tab-long')).map((d) => d.docId)).toEqual(['d2'])
  })

  it('drops a whole session on request and leaves the others alone', async () => {
    await saveSessionDoc('tab-a', 'd1', json('Mine'))
    await saveSessionMeta('tab-a', ['d1'])
    await saveSessionDoc('tab-b', 'd2', json('Theirs'))
    await saveSessionMeta('tab-b', ['d2'])

    await clearSession('tab-a')
    expect(await loadSession('tab-a')).toEqual([])
    expect(await loadSession('tab-b')).toHaveLength(1)
  })

  /*
   * Sessions accumulate — nothing deletes one when a tab is closed, because a closed tab is
   * exactly the case this exists for. The bound is against unbounded growth, and the writer's own
   * session is never the one evicted however old it is.
   */
  it('bounds the stored sessions and never evicts the one writing', async () => {
    for (let i = 0; i < 20; i++) {
      await saveSessionDoc(`tab${i}`, 'd', json(`W${i}`))
      await saveSessionMeta(`tab${i}`, ['d'])
    }
    // The first tabs written are the least recently active, so they are what goes.
    expect(await loadSession('tab0')).toEqual([])
    expect(await loadSession('tab19')).toHaveLength(1)
  })

  it('reports no session rather than throwing where IndexedDB is missing', async () => {
    // A private window, and the reason every read here resolves instead of rejecting.
    const held = globalThis.indexedDB
    // @ts-expect-error — deleting a global is the whole point of the case.
    delete globalThis.indexedDB
    resetSessionStore()
    expect(await loadSession('tab-a')).toEqual([])
    // And a write is a no-op rather than an unhandled rejection.
    await expect(saveSessionDoc('tab-a', 'd1', json('x'))).resolves.toBeUndefined()
    globalThis.indexedDB = held
  })
})
