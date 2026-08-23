// @vitest-environment jsdom

/**
 * The autosave, across more than one tab.
 *
 * `localStorage` is shared by every tab on the origin, so a single autosave key meant two tabs
 * on two workflows wrote the same slot and whichever was touched last silently owned both.
 * Nothing detected it and nothing ever re-read the key, so the loss landed at precisely the
 * moment the autosave exists for — a reload, or a crash.
 *
 * What makes this testable at all is that `tabId` reads `sessionStorage` on every call rather
 * than memoising: being a different tab is exactly writing a different value there, which is
 * what a browser does. So a "reload" here is a second `loadAutosave` under the same id, and a
 * "new tab" is one with the key removed.
 *
 * Two things are asserted about eviction rather than only about the happy path, because both
 * fail as a *plausible* result: a slot dropped on sight loses work that was perfectly readable,
 * and a budget that drifts starts evicting live tabs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from '../core/graph'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { loadAutosave, saveAutosave, watchTabIdentity } from './persistence'
import '../nodes'

const TAB_KEY = 'coda.tab.v1'
const SHARED_KEY = 'coda.autosave.v1'
const SLOT_PREFIX = 'coda.autosave.v1.tab.'
const INDEX_KEY = 'coda.autosave.v1.index'

/** A graph identifiable by name, carrying one real node so it counts as non-empty. */
function graphNamed(name: string, padding = ''): CodaGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n1', type: 'note.text', position: { x: 0, y: 0 }, params: { text: padding } },
    ],
    edges: [],
    meta: { name },
  }
}

/** Become a particular tab, the way a browser does — by what is in `sessionStorage`. */
function asTab(id: string): void {
  window.sessionStorage.setItem(TAB_KEY, id)
}

/** A genuinely new tab, or the app reopened after everything was closed. */
function asFreshTab(): void {
  window.sessionStorage.removeItem(TAB_KEY)
}

function loadedName(): string | undefined {
  return loadAutosave()?.graph.meta?.name
}

function slotIds(): string[] {
  const out: string[] = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key?.startsWith(SLOT_PREFIX)) out.push(key.slice(SLOT_PREFIX.length))
  }
  return out
}

beforeEach(() => {
  installStorageStub()
  clearStorage()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('autosave across tabs', () => {
  it('gives a reloading tab its own graph back, not whichever tab wrote last', () => {
    asTab('a')
    saveAutosave(graphNamed('workflow A'))
    asTab('b')
    saveAutosave(graphNamed('workflow B'))

    // The bug: both of these used to answer "workflow B", and tab A's work was unrecoverable.
    asTab('a')
    expect(loadedName()).toBe('workflow A')
    asTab('b')
    expect(loadedName()).toBe('workflow B')
  })

  it('opens a tab with no session of its own on the most recent graph from any tab', () => {
    asTab('a')
    saveAutosave(graphNamed('workflow A'))
    asTab('b')
    saveAutosave(graphNamed('workflow B'))

    asFreshTab()
    expect(loadedName()).toBe('workflow B')
  })

  it('keeps a graph adopted by a fresh tab once that tab has edited it', () => {
    asTab('a')
    saveAutosave(graphNamed('workflow A'))

    // A second tab opens, adopts A's graph, and is edited into something else. A must survive.
    asFreshTab()
    expect(loadedName()).toBe('workflow A')
    saveAutosave(graphNamed('workflow B'))

    expect(loadedName()).toBe('workflow B')
    asTab('a')
    expect(loadedName()).toBe('workflow A')
  })

  it('reads an autosave written before per-tab slots existed', () => {
    // What the previous build left behind: the shared key, and nothing else at all.
    window.localStorage.setItem(SHARED_KEY, JSON.stringify(graphNamed('from an older build')))

    asTab('a')
    expect(loadedName()).toBe('from an older build')
  })

  it('opens the editor on this tab’s own graph, not the last one written', async () => {
    asTab('a')
    saveAutosave(graphNamed('workflow A'))
    asTab('b')
    saveAutosave(graphNamed('workflow B'))

    // The store reads the autosave in its initialiser, so re-importing it is the only way to
    // exercise one — the idiom `shareLoad.test.ts` uses, and for the same reason.
    asTab('a')
    vi.resetModules()
    const { useGraphStore } = await import('./graphStore')
    expect(useGraphStore.getState().graph.meta?.name).toBe('workflow A')
  })

  it('falls back to one shared slot where there is no sessionStorage', () => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage is disabled in this mode')
      },
    })

    saveAutosave(graphNamed('workflow A'))
    expect(loadedName()).toBe('workflow A')
    // Degraded to exactly what this file did before slots existed — no slot, no index.
    expect(slotIds()).toEqual([])
    expect(window.localStorage.getItem(INDEX_KEY)).toBeNull()
  })
})

describe('bounding what the slots hold', () => {
  it('caps how many slots exist, evicting the least recently active and never the writer', () => {
    vi.useFakeTimers()
    const tabs = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
    tabs.forEach((id, i) => {
      // Real tabs write seconds apart; in one tick every `at` would tie and which slot went
      // would be down to sort stability rather than to the policy.
      vi.setSystemTime(new Date(1_700_000_000_000 + i * 1000))
      asTab(id)
      saveAutosave(graphNamed(id))
    })

    expect(slotIds()).toHaveLength(6)
    expect(slotIds()).toContain('t8')
    expect(slotIds()).not.toContain('t1')
    expect(slotIds()).not.toContain('t2')
  })

  it('caps the total the slots hold, whatever the count', () => {
    vi.useFakeTimers()
    // Two graphs of ~1.2 MB against a 2 MB budget: the second cannot be kept beside the first.
    const padding = 'x'.repeat(1_200_000)
    vi.setSystemTime(new Date(1_700_000_000_000))
    asTab('a')
    saveAutosave(graphNamed('workflow A', padding))
    vi.setSystemTime(new Date(1_700_000_001_000))
    asTab('b')
    saveAutosave(graphNamed('workflow B', padding))

    expect(slotIds()).toEqual(['b'])
    // The writer's own slot is charged first and is never the one evicted.
    expect(loadedName()).toBe('workflow B')
  })

  it('keeps a slot the index has lost track of rather than dropping it on sight', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    asTab('a')
    saveAutosave(graphNamed('workflow A'))

    // A corrupt or cleared index leaves A's slot unclaimed. It is readable work, so budget
    // pressure is the only thing allowed to remove it.
    window.localStorage.removeItem(INDEX_KEY)
    vi.setSystemTime(new Date(1_700_000_001_000))
    asTab('b')
    saveAutosave(graphNamed('workflow B'))

    asTab('a')
    expect(loadedName()).toBe('workflow A')
  })

  it('takes back the claim when a slot write is refused', () => {
    asTab('a')
    saveAutosave(graphNamed('workflow A'))

    const real = window.localStorage.setItem.bind(window.localStorage)
    // Spied on the object rather than on `Storage.prototype`: under the stub there is no
    // `Storage` instance to have a prototype, so the obvious target silently patches nothing.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(
      (key: string, value: string) => {
        if (key.startsWith(SLOT_PREFIX)) throw new Error('QuotaExceededError')
        real(key, value)
      },
    )

    asTab('b')
    saveAutosave(graphNamed('workflow B'))

    // The shared key still took it, so tab B has a crash net — the coarser one.
    expect(window.localStorage.getItem(SHARED_KEY)).toContain('workflow B')
    // But nothing may be left claiming bytes that were never written.
    expect(slotIds()).not.toContain('b')
    expect(window.localStorage.getItem(INDEX_KEY) ?? '').not.toContain('"b"')
  })
})

describe('a tab that was duplicated from another', () => {
  /**
   * What another tab on the origin actually does: it writes, and *then* the browser raises the
   * event — in every document but the one that wrote. Dispatching the event alone is the
   * tempting shortcut and it is not the same thing: the slot would still hold whatever this tab
   * last put there, so an assertion about whose graph survives would be checking nothing.
   */
  function otherTabWrote(key: string, newValue: string | null): void {
    if (newValue === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
  }

  /** The store's own reclaim: write what this tab is holding to whatever slot it now owns. */
  function watchHolding(name: string): () => void {
    const reclaim = vi.fn(() => saveAutosave(graphNamed(name)))
    watchTabIdentity(reclaim)
    return reclaim
  }

  it('takes a new identity when another tab writes the slot it thinks is its own', () => {
    // Duplicate Tab and `window.open` copy sessionStorage, id and all — measured in Chrome,
    // where without this the original reloaded onto the copy's graph.
    watchHolding('workflow A')
    asTab('shared')
    saveAutosave(graphNamed('workflow A'))

    otherTabWrote(`${SLOT_PREFIX}shared`, '{}')

    expect(window.sessionStorage.getItem(TAB_KEY)).not.toBe('shared')
    expect(window.sessionStorage.getItem(TAB_KEY)).toBeTruthy()
  })

  it('keeps its own graph, which the copy had already written over', () => {
    // The ordering that makes `reclaim` necessary rather than tidy: the event arrives after the
    // write, so the copy has overwritten the shared slot *and* this tab's before it hears.
    watchHolding('workflow A')
    asTab('shared')
    saveAutosave(graphNamed('workflow A'))

    otherTabWrote(`${SLOT_PREFIX}shared`, JSON.stringify(graphNamed('the copy')))
    window.localStorage.setItem('coda.autosave.v1', JSON.stringify(graphNamed('the copy')))

    expect(loadedName()).toBe('workflow A')
    // And the id it gave up still belongs to the tab that raised the event.
    expect(window.localStorage.getItem(`${SLOT_PREFIX}shared`)).toContain('the copy')
  })

  it('does not move for a removal, which is an eviction rather than a collision', () => {
    const reclaim = watchHolding('workflow A')
    asTab('mine')
    saveAutosave(graphNamed('workflow A'))

    otherTabWrote(`${SLOT_PREFIX}mine`, null)

    expect(window.sessionStorage.getItem(TAB_KEY)).toBe('mine')
    expect(reclaim).not.toHaveBeenCalled()
  })

  it('does not move for a write to somebody else\u2019s slot', () => {
    const reclaim = watchHolding('workflow A')
    asTab('mine')
    saveAutosave(graphNamed('workflow A'))

    otherTabWrote(`${SLOT_PREFIX}theirs`, '{}')

    expect(window.sessionStorage.getItem(TAB_KEY)).toBe('mine')
    expect(reclaim).not.toHaveBeenCalled()
  })
})
