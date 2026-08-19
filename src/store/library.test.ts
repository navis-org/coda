/**
 * The workflow library — graphs saved in the browser.
 *
 * What is worth pinning here is not the round trip, which is a `put` and a `get`, but the two
 * places this module deliberately behaves *unlike* every other storage path in the codebase:
 *
 *  - **A failed write is reported, not swallowed.** `data/cache.ts` degrades to an in-memory map
 *    because a failure to remember a fetched value is not a failure to compute it. That
 *    reasoning does not survive contact with a save: something that lives until the tab reloads
 *    is not a save, and reporting success would lose the user's work silently. So the no-storage
 *    case has to *reject*, and the test for it is the one that would catch a well-meant
 *    `try/catch` added later for symmetry with the cache.
 *
 *  - **Identity is the name, normalised.** Saving twice under one name is one document with two
 *    versions, not two documents — which is only true if "LC4 sweep" and "lc4  sweep" are the
 *    same name.
 *
 * Runs against `fake-indexeddb`, because a persistence layer verified against an in-memory shim
 * verifies the shim. Each case gets a fresh factory, so nothing leaks between them.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { CodaGraph } from '../core/graph'
import { emptyGraph } from '../core/graph'
// Side-effect import: `deserializeGraph` drops nodes whose type is not registered, so without
// the node pack every round trip here would come back empty and pass a weaker assertion.
import '../nodes'
import {
  deleteWorkflow,
  findByName,
  libraryAvailable,
  listWorkflows,
  loadWorkflow,
  normalizeName,
  renameWorkflow,
  resetLibrary,
  saveWorkflow,
} from './library'

function graph(
  name: string,
  nodeTypes: string[] = ['neuron.connectivity', 'out.table'],
): CodaGraph {
  return {
    ...emptyGraph(name),
    nodes: nodeTypes.map((type, i) => ({
      id: `n${i}`,
      type,
      position: { x: i * 40, y: 0 },
      params: {},
    })),
  }
}

beforeEach(() => {
  // A new factory per case, and the module told to forget the handle it opened against the
  // old one — without the second half every case after the first writes into a dead database.
  globalThis.indexedDB = new IDBFactory()
  resetLibrary()
})

describe('workflow library', () => {
  it('round-trips a graph', async () => {
    const saved = await saveWorkflow(graph('LC4 sweep'))
    const { graph: back, warnings } = await loadWorkflow(saved.id)

    expect(warnings).toEqual([])
    expect(back.meta?.name).toBe('LC4 sweep')
    expect(back.nodes.map((n) => n.type)).toEqual(['neuron.connectivity', 'out.table'])
  })

  it('summarises without needing the graph read back', async () => {
    // The start page rail draws a tile per entry, and a shelf of ten graphs is megabytes —
    // so the node types travel in the summary rather than being recovered from the document.
    const saved = await saveWorkflow(
      graph('With a network', ['neuron.connectivity', 'out.network']),
    )
    expect(saved.nodeTypes).toEqual(['neuron.connectivity', 'out.network'])
    expect(saved.size).toBeGreaterThan(0)
  })

  it('lists newest first', async () => {
    const first = await saveWorkflow(graph('older'))
    const second = await saveWorkflow(graph('newer'))
    // Same millisecond is entirely possible here, so make the ordering unambiguous rather
    // than asserting on a race.
    await renameWorkflow(second.id, 'newer')

    const list = await listWorkflows()
    expect(list.map((e) => e.id)).toContain(first.id)
    expect(list).toHaveLength(2)
    expect(list[0]!.savedAt).toBeGreaterThanOrEqual(list[1]!.savedAt)
  })

  it('overwrites in place when told which entry, keeping the original creation time', async () => {
    const first = await saveWorkflow(graph('LC4 sweep', ['neuron.connectivity']))
    const again = await saveWorkflow(graph('LC4 sweep', ['neuron.connectivity', 'out.table']), {
      id: first.id,
    })

    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(await listWorkflows()).toHaveLength(1)
    expect((await loadWorkflow(first.id)).graph.nodes).toHaveLength(2)
  })

  it('makes a second entry for a second name', async () => {
    await saveWorkflow(graph('one'))
    await saveWorkflow(graph('two'))
    expect(await listWorkflows()).toHaveLength(2)
  })

  it('treats case and repeated spaces as the same name', async () => {
    // Identity for a save is this comparison. Without it a shelf grows three entries that all
    // look identical in the menu and none of which is the one you meant.
    expect(normalizeName('  LC4   sweep ')).toBe('lc4 sweep')
    const saved = await saveWorkflow(graph('LC4 sweep'))
    expect(findByName(await listWorkflows(), 'lc4  SWEEP')?.id).toBe(saved.id)
    expect(findByName(await listWorkflows(), 'LC4 sweep 2')).toBeUndefined()
  })

  it('falls back to a name rather than storing an unnamed entry', async () => {
    const saved = await saveWorkflow(graph('   '))
    expect(saved.name).toBe('Untitled')
  })

  it('renames without touching the graph', async () => {
    const saved = await saveWorkflow(graph('before'))
    const renamed = await renameWorkflow(saved.id, 'after')

    expect(renamed.name).toBe('after')
    expect(renamed.createdAt).toBe(saved.createdAt)
    expect((await loadWorkflow(saved.id)).graph.nodes).toHaveLength(2)
    expect((await listWorkflows()).map((e) => e.name)).toEqual(['after'])
  })

  it('deletes the summary and the graph together', async () => {
    const saved = await saveWorkflow(graph('doomed'))
    await deleteWorkflow(saved.id)

    expect(await listWorkflows()).toEqual([])
    // Not an empty graph: loading replaces the canvas and clears the undo history, so an
    // entry that has gone has to say so rather than resolve to nothing.
    await expect(loadWorkflow(saved.id)).rejects.toThrow(/no longer in this browser/)
  })

  it('reports a corrupt entry rather than opening an empty graph over the user’s work', async () => {
    const saved = await saveWorkflow(graph('fine'))
    await new Promise<void>((resolve) => {
      const request = indexedDB.open('coda-library', 1)
      request.onsuccess = () => {
        const tx = request.result.transaction('graphs', 'readwrite')
        tx.objectStore('graphs').put('{ not json', saved.id)
        tx.oncomplete = () => resolve()
      }
    })
    await expect(loadWorkflow(saved.id)).rejects.toThrow(/Could not read/)
  })

  describe('with no IndexedDB', () => {
    beforeEach(() => {
      // What a private window looks like from in here.
      // @ts-expect-error deliberately removing the platform API
      delete globalThis.indexedDB
      resetLibrary()
    })

    it('says so', async () => {
      expect(await libraryAvailable()).toBe(false)
    })

    it('reads as an empty shelf', async () => {
      expect(await listWorkflows()).toEqual([])
    })

    it('refuses to save rather than pretending', async () => {
      // The whole point. A save that resolved here would be reported as done, and be gone on
      // the next reload — which is the one failure mode this module exists to rule out.
      await expect(saveWorkflow(graph('nowhere'))).rejects.toThrow(/not storing data/)
    })

    it('retries the next time rather than caching the refusal', async () => {
      await expect(saveWorkflow(graph('nowhere'))).rejects.toThrow()
      globalThis.indexedDB = new IDBFactory()
      // No `resetLibrary()` here: a rejected open must not be memoised, or a user who fixes
      // their browser settings has to reload the tab before anything works.
      await expect(saveWorkflow(graph('somewhere'))).resolves.toBeTruthy()
    })
  })
})
