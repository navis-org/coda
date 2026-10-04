// @vitest-environment jsdom

/**
 * The Storage tab's reading of `localStorage`: which key is whose, and which services count as
 * signed in. The second is each credentials module's own answer (`data/signIns.ts`), so a Forget
 * that leaves an empty list behind is not a stored sign-in, and the published CATMAID tokens, which
 * no module declares, are a preference.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetCredentials, setToken } from '../data/cave/credentials'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { localTotal, measureStorage } from './storageReadout'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  installStorageStub()
  clearStorage()
})

afterEach(() => {
  clearStorage()
})

describe('measureStorage', () => {
  it('files each localStorage key under what it is for', async () => {
    localStorage.setItem('coda.autosave.v1', '{"nodes":[]}')
    localStorage.setItem('coda.autosave.v1.tab.x', '{}')
    // Through the module, so the stored shape is the one it reads back.
    resetCredentials()
    setToken('https://global.daf-apis.com', 'cave-token')
    // A Forget leaves an empty list behind; that is not a stored sign-in.
    localStorage.setItem('coda.catmaid.instances.v1', '[]')
    localStorage.setItem('coda.ai.key.anthropic', 'sk-x')
    // Published, not a credential.
    localStorage.setItem('coda.catmaid.publicTokens.v1', '{}')
    localStorage.setItem('coda.theme.v1', 'dark')
    localStorage.setItem('neuroglancer.state', 'xx')

    const { local } = await measureStorage()
    const units = (key: string) => key.length + (localStorage.getItem(key) ?? '').length
    expect(local?.autosave).toBe(units('coda.autosave.v1') + units('coda.autosave.v1.tab.x'))
    expect(local?.services).toEqual(['CAVE', 'AI assistant'])
    expect(local?.signIns).toBe(
      units('coda.cave.credentials.v1') +
        units('coda.catmaid.instances.v1') +
        units('coda.ai.key.anthropic'),
    )
    expect(local?.preferences).toBe(
      units('coda.catmaid.publicTokens.v1') + units('coda.theme.v1'),
    )
    expect(local?.other).toBe(units('neuroglancer.state'))
  })

  it('reports an empty browser as empty, every database included', async () => {
    const reading = await measureStorage()
    expect(reading.cache).toEqual({ entries: 0, bytes: 0 })
    expect(reading.shelves.every((shelf) => shelf.usage?.entries === 0)).toBe(true)
    expect(reading.local && localTotal(reading.local)).toBe(0)
  })
})
