// @vitest-environment jsdom

/**
 * More than one workflow open in one tab.
 *
 * The store already had the switch — `loadGraph` replaces the graph, resets the history and the
 * selection, drops the pin and the overlay, and re-derives every badge — so what is new is only
 * the half that used to be thrown away. That makes the interesting assertions the ones about
 * what *survives* a switch, and each of the four below fails as a plausible-looking result
 * rather than as an error:
 *
 *  - an undo stack that came back empty reads as "undo is broken", not as a switch bug;
 *  - results that came back stale read as a cache that expired, and cost a re-query to find out;
 *  - two documents opened from the *same file* share node ids, so one shared cache has them
 *    answering for each other with nothing on screen to say so;
 *  - and a blank document left behind by every open is a tab nobody asked for, which is the one
 *    failure a user notices immediately and forgives least.
 *
 * The viewport half is here rather than in a component test because jsdom performs no layout:
 * what can be pinned is that the canvas is *asked*, which is the same seam `fitOnLoad.test.ts`
 * draws the line at.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from '../core/graph'
import { emptyGraph, serializeGraph } from '../core/graph'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { resetDocuments } from '../test/storeReset'
import { demoWorkflow } from '../wizard/build'
import type * as GraphStoreModule from './graphStore'
import { useGraphStore } from './graphStore'
import { saveAutosave } from './persistence'
import { loadSession, resetSessionStore, saveSessionDoc, saveSessionMeta } from './session'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
  // Node 26 shadows jsdom's, and the reload block below is entirely about what survives in them.
  installStorageStub()
})

/** A graph with a name and one real node, so it is not the blank `beginDocument` reuses. */
function named(name: string): CodaGraph {
  const graph = emptyGraph(name)
  graph.nodes.push({ id: `n_${name}`, type: 'out.table', position: { x: 0, y: 0 }, params: {} })
  return graph
}

beforeEach(() => {
  clearStorage()
  resetDocuments()
})

const store = () => useGraphStore.getState()
const names = () => store().tabs.map((tab) => tab.name)

describe('opening one beside another', () => {
  it('starts on exactly one document', () => {
    expect(store().tabs).toHaveLength(1)
    expect(store().activeTabId).toBe(store().tabs[0]?.id)
  })

  it('reuses a blank untouched canvas rather than stranding an empty document', () => {
    const before = store().activeTabId
    store().openDocument(demoWorkflow('partners'))
    expect(store().tabs).toHaveLength(1)
    expect(store().activeTabId).toBe(before)
  })

  /*
   * "Untouched" is the *history*, not the node count. A graph somebody built and then emptied
   * has a past they can undo into, and reusing it would put another workflow on top of it with
   * no route back — which is precisely the loss the confirm dialog used to be there to prevent.
   */
  it('keeps an emptied canvas that still has an undo stack', () => {
    store().openDocument(demoWorkflow('partners'))
    const mine = store().activeTabId
    store().deleteNodes(store().graph.nodes.map((n) => n.id))
    expect(store().graph.nodes).toHaveLength(0)

    store().openDocument(demoWorkflow('partners'))
    expect(store().tabs).toHaveLength(2)
    store().switchDocument(mine)
    store().undo()
    expect(store().graph.nodes.length).toBeGreaterThan(0)
  })

  it('mints a second document over work, and switches to it', () => {
    store().openDocument(emptyGraph('First'))
    store().addNode('out.table', { x: 0, y: 0 })
    const first = store().activeTabId

    store().openDocument(emptyGraph('Second'))
    expect(store().tabs).toHaveLength(2)
    expect(store().activeTabId).not.toBe(first)
    expect(names()).toEqual(['First', 'Second'])
  })

  it('follows a rename, so the switcher never names a workflow that no longer exists', () => {
    store().openDocument(emptyGraph('First'))
    store().addNode('out.table', { x: 0, y: 0 })
    store().openDocument(emptyGraph('Second'))
    store().setGraphName('Renamed')
    expect(names()).toEqual(['First', 'Renamed'])
  })
})

describe('switching', () => {
  /** Two documents, each with a node of its own; leaves the second active. */
  function twoDocuments(): { first: string; second: string } {
    store().openDocument(emptyGraph('First'))
    store().addNode('out.table', { x: 0, y: 0 })
    const first = store().activeTabId
    store().openDocument(emptyGraph('Second'))
    store().addNode('out.table', { x: 0, y: 0 })
    return { first, second: store().activeTabId }
  }

  it('puts the graph, the selection and the undo stack back', () => {
    const { first, second } = twoDocuments()
    store().setSelection(store().graph.nodes.map((n) => n.id))
    const selection = store().selection
    const past = store().past.length
    expect(past).toBeGreaterThan(0)

    store().switchDocument(first)
    expect(store().graph.meta?.name).toBe('First')

    store().switchDocument(second)
    expect(store().graph.meta?.name).toBe('Second')
    expect(store().selection).toEqual(selection)
    expect(store().past.length).toBe(past)
  })

  it('undoes into the document you are in and not the one you came from', () => {
    const { first } = twoDocuments()
    store().switchDocument(first)
    store().undo()
    expect(store().graph.nodes).toHaveLength(0)
    expect(store().graph.meta?.name).toBe('First')
  })

  it('is a no-op for the active id and for one that is not open', () => {
    const { second } = twoDocuments()
    store().switchDocument(second)
    store().switchDocument('doc-nobody-opened')
    expect(store().activeTabId).toBe(second)
  })

  /*
   * The reason there is a Scheduler per document rather than one shared. A cache keyed by node
   * id would be right if node ids were unique, and they are not: `deserializeGraph` does not
   * remap them, so two documents opened from one file carry the same ones.
   */
  it('keeps each document’s results, including two copies of the same file', async () => {
    const file = demoWorkflow('partners')
    store().openDocument(structuredClone(file))
    const a = store().activeTabId
    await store().runAll()
    const ran = store().graph.nodes.filter((n) => store().nodeInfo(n.id).state === 'ok')
    expect(ran.length).toBeGreaterThan(0)

    /*
     * The same file again, so every node id below is a *shared* id. One cache keyed by node id
     * would report this second copy as already run — the graph is byte-identical, so the
     * provenance keys match too — and the reader would be looking at another document's results
     * with nothing to say so.
     */
    store().openDocument(structuredClone(file))
    const b = store().activeTabId
    expect(a).not.toBe(b)
    const here = new Set(store().graph.nodes.map((n) => n.id))
    for (const node of ran) {
      expect(here.has(node.id)).toBe(true)
      expect(store().nodeInfo(node.id).state).not.toBe('ok')
    }

    // And going back finds the first document's run intact, with nothing re-executed.
    store().switchDocument(a)
    for (const node of ran) expect(store().nodeInfo(node.id).state).toBe('ok')
  })

  it('asks the canvas for the viewport it left, and only once it has one', () => {
    const { first, second } = twoDocuments()
    store().recordViewport({ x: 120, y: 40, zoom: 1.5 })
    const before = store().viewportRequest.seq

    store().switchDocument(first)
    // The first document has never been panned, so there is nothing to restore — the fit that
    // `loadGraph` already asked for is the right answer there, and a second one would fight it.
    expect(store().viewportRequest.seq).toBe(before + 1)
    expect(store().viewportRequest.viewport).toBeUndefined()

    store().switchDocument(second)
    expect(store().viewportRequest.viewport).toEqual({ x: 120, y: 40, zoom: 1.5 })
  })
})

describe('closing', () => {
  it('leaves a fresh blank document when the last one goes', () => {
    store().openDocument(demoWorkflow('partners'))
    store().closeDocument(store().activeTabId)
    expect(store().tabs).toHaveLength(1)
    expect(store().graph.nodes).toHaveLength(0)
    expect(store().past).toHaveLength(0)
  })

  it('leaves the active document alone when another one is closed', () => {
    store().openDocument(emptyGraph('First'))
    store().addNode('out.table', { x: 0, y: 0 })
    const first = store().activeTabId
    store().openDocument(emptyGraph('Second'))
    const second = store().activeTabId

    store().closeDocument(first)
    expect(store().activeTabId).toBe(second)
    expect(store().graph.meta?.name).toBe('Second')
    expect(names()).toEqual(['Second'])
  })

  it('moves to the neighbour under the cursor when the active one goes', () => {
    store().openDocument(emptyGraph('First'))
    store().addNode('out.table', { x: 0, y: 0 })
    store().openDocument(emptyGraph('Second'))
    store().addNode('out.table', { x: 0, y: 0 })
    const second = store().activeTabId
    store().openDocument(emptyGraph('Third'))

    store().switchDocument(second)
    store().closeDocument(second)
    // The one that took its place in the list, rather than the end of it.
    expect(store().graph.meta?.name).toBe('Third')
    expect(names()).toEqual(['First', 'Third'])
  })
})

/**
 * Surviving a reload.
 *
 * The hybrid: the active document arrives from the `localStorage` slot **synchronously**, in the
 * store's initialiser, so the first paint is unchanged; every other open document arrives from
 * IndexedDB an await later. What that split buys is written up in `session.ts`; what it risks is
 * the join, which is all this block is about.
 *
 * A "reload" here is what one is for the store: `vi.resetModules()` and a fresh import, with the
 * storage the previous life left behind still in place. `sessionStorage` survives a real reload,
 * which is exactly why the tab id and the active document id live there.
 */
describe('across a reload', () => {
  const TAB = 'tab-under-test'

  /** Become a tab, the way a browser does — by what is in `sessionStorage`. */
  function becomeTab(tab: string, activeDocId?: string): void {
    sessionStorage.setItem('coda.tab.v1', tab)
    if (activeDocId) sessionStorage.setItem('coda.doc.v1', activeDocId)
    else sessionStorage.removeItem('coda.doc.v1')
  }

  /**
   * Let the asynchronous half finish.
   *
   * `vi.waitFor` rather than a fixed number of macrotasks, which is what this was first: the
   * restore is an IndexedDB open plus two reads and `fake-indexeddb` resolves each on its own
   * turn, so any constant is a guess that catches the two-document case and misses the
   * three-document one — a test that passes for the wrong reason. Polling a condition cannot go
   * stale that way.
   */
  const settle = (until: () => boolean) => vi.waitFor(() => expect(until()).toBe(true))

  /**
   * Boot a fresh store against whatever is in storage, as a reload does.
   *
   * `expect` waits for the restore to have *landed* where one is expected, and the caller says
   * how it will know. `docs` is what a reload with nothing to restore expects, and there the wait
   * is one turn — enough for `restoreSession` to have run and decided there was nothing to do.
   */
  async function reload(docs = 1): Promise<typeof GraphStoreModule> {
    vi.resetModules()
    await import('../nodes')
    const mod = await import('./graphStore')
    await settle(() => mod.useGraphStore.getState().tabs.length >= docs)
    return mod
  }

  /*
   * Drain before seeding, which is the one thing this block cannot do without.
   *
   * A "reload" here is `vi.resetModules()` plus a fresh import — but the *outgoing* store module
   * keeps its module-level `autosaveTimer`, and nothing can cancel a timer belonging to a module
   * that no longer has a reference. So a case that edited the graph leaves a write scheduled
   * `AUTOSAVE_DELAY_MS` out, which lands in the middle of the next case and overwrites the
   * fixture it just seeded — observed as `expected 'Renamed' to be 'Only one'`, and only in a
   * full run, because it needs the previous case to have taken long enough.
   *
   * Waiting past the debounce and *then* clearing is what makes the seed the last write. A
   * second's worth of hold on five cases, in exchange for a block that cannot pass by luck.
   */
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 900))
    globalThis.indexedDB = new IDBFactory()
    resetSessionStore()
    clearStorage()
  })

  it('comes back with every open workflow, in the order they were in', async () => {
    becomeTab(TAB, 'doc-b')
    // What the last life left: the active document in the slot, all three in the session store.
    saveAutosave(named('Beta'))
    await saveSessionDoc(TAB, 'doc-a', serializeGraph(named('Alpha'), { compact: true }))
    await saveSessionDoc(TAB, 'doc-b', serializeGraph(named('Beta'), { compact: true }))
    await saveSessionDoc(TAB, 'doc-c', serializeGraph(named('Gamma'), { compact: true }))
    await saveSessionMeta(TAB, ['doc-a', 'doc-b', 'doc-c'])

    const { useGraphStore } = await reload(3)
    const s = useGraphStore.getState()
    expect(s.tabs.map((t) => t.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    // The one that was on screen is still the one on screen, and it is the slot's copy.
    expect(s.activeTabId).toBe('doc-b')
    expect(s.graph.meta?.name).toBe('Beta')
  })

  /*
   * The failure this is really about: the active document is in *both* halves — its graph in the
   * slot and its record in the session store — so a restore that did not skip it by id would
   * build a second record over the live one. That is why `loadActiveDocId` is read synchronously
   * at boot rather than taken from the session record.
   *
   * The row count alone does not catch it, and that is worth saying because it is the assertion
   * anybody writes first: a second `createDoc` under the same id *replaces* the live record in
   * the `Map` rather than adding to it, so the switcher still shows two rows. What it replaces it
   * with is a record carrying a stash — the one thing that must never be true of the document on
   * screen — and the visible consequence is that `syncTabs` reads the stashed graph's name
   * instead of the live one. So the test edits the live name and looks for it.
   */
  it('does not build a second record over the active document', async () => {
    becomeTab(TAB, 'doc-a')
    saveAutosave(named('Alpha'))
    await saveSessionDoc(TAB, 'doc-a', serializeGraph(named('Alpha'), { compact: true }))
    await saveSessionDoc(TAB, 'doc-b', serializeGraph(named('Beta'), { compact: true }))
    await saveSessionMeta(TAB, ['doc-a', 'doc-b'])

    const { useGraphStore } = await reload(2)
    expect(useGraphStore.getState().tabs.map((t) => t.name)).toEqual(['Alpha', 'Beta'])

    useGraphStore.getState().setGraphName('Renamed')
    expect(useGraphStore.getState().tabs.map((t) => t.name)).toEqual(['Renamed', 'Beta'])
  })

  /*
   * The skew between the two bounds, and the one case where the session store outranks the slot.
   *
   * `MAX_SLOTS` is 6 and `MAX_SESSIONS` is 12, so past six tabs a tab loses its slot while
   * keeping its session — and `loadAutosave` then falls back to "the most recent graph from any
   * tab", which is somebody else's. Before the open set existed that degraded to a whole tab
   * showing a foreign workflow, which is at least recognisable; with a set it degrades to a
   * coherent-looking list with one foreign workflow *inside* it, under this tab's own document
   * id. Found at eight open tabs in a real browser, not by reading the code.
   */
  it('takes its own active document back when the slot was evicted', async () => {
    becomeTab(TAB, 'doc-a')
    // No slot for this tab — only the shared key, holding another tab's work.
    localStorage.setItem(
      'coda.autosave.v1',
      serializeGraph(named('Somebody else’s'), { compact: true }),
    )
    await saveSessionDoc(TAB, 'doc-a', serializeGraph(named('Mine'), { compact: true }))
    await saveSessionDoc(TAB, 'doc-b', serializeGraph(named('Mine too'), { compact: true }))
    await saveSessionMeta(TAB, ['doc-a', 'doc-b'])

    const { useGraphStore } = await reload(2)
    const s = useGraphStore.getState()
    expect(s.graph.meta?.name).toBe('Mine')
    expect(s.tabs.map((t) => t.name)).toEqual(['Mine', 'Mine too'])
  })

  /*
   * The other half of the same rule: where the slot *did* answer, it is the fresher copy — it is
   * written on every autosave tick, and the session record for a document only moves when it is
   * on screen or being left. Preferring the session record here would quietly roll the active
   * workflow back to whatever it looked like at the last switch.
   */
  it('keeps the slot’s copy when the slot is this tab’s own', async () => {
    becomeTab(TAB, 'doc-a')
    saveAutosave(named('Newer'))
    await saveSessionDoc(TAB, 'doc-a', serializeGraph(named('Older'), { compact: true }))
    await saveSessionDoc(TAB, 'doc-b', serializeGraph(named('Other'), { compact: true }))
    await saveSessionMeta(TAB, ['doc-a', 'doc-b'])

    const { useGraphStore } = await reload(2)
    expect(useGraphStore.getState().graph.meta?.name).toBe('Newer')
  })

  it('starts on one document when the tab has no session, exactly as it always did', async () => {
    becomeTab('a-tab-with-no-session')
    saveAutosave(named('Only one'))

    const { useGraphStore } = await reload()
    const s = useGraphStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.graph.meta?.name).toBe('Only one')
  })

  /*
   * Switching away is the moment a document's final state has to reach the store, because only
   * the one on screen is on the autosave debounce. Written synchronously by `persistShape` rather
   * than left to a timer, so this needs no clock.
   */
  /** The ids the session store currently holds for this tab, polled until they settle. */
  const stored = (until: (ids: string[]) => boolean) =>
    vi.waitFor(async () => {
      const ids = (await loadSession(TAB)).map((doc) => doc.docId)
      expect(until(ids)).toBe(true)
      return ids
    })

  it('writes the document being switched away from', async () => {
    becomeTab(TAB)
    const { useGraphStore } = await reload()
    const s = () => useGraphStore.getState()
    s().openDocument(named('Alpha'))
    const alpha = s().activeTabId
    s().openDocument(named('Beta'))

    await stored((ids) => ids.includes(alpha))
  })

  it('forgets a closed document, so a reload does not bring it back', async () => {
    becomeTab(TAB)
    const { useGraphStore } = await reload()
    const s = () => useGraphStore.getState()
    s().openDocument(named('Alpha'))
    const alpha = s().activeTabId
    s().openDocument(named('Beta'))
    await stored((ids) => ids.includes(alpha))

    s().closeDocument(alpha)
    await stored((ids) => !ids.includes(alpha))
  })
})
