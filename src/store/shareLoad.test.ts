// @vitest-environment jsdom

/**
 * What a share link does to the app before anything has been fetched.
 *
 * Two questions, both settled in the tick the store is created, and both invisible from the
 * feature's own code: whether the welcome modal opens over a workflow somebody was sent, and
 * whether opening one runs anything of its own.
 *
 * The store is a module singleton built at import time, so each case resets the module registry
 * and re-imports it with a different address bar. That is the only way to exercise an
 * initialiser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getNodeDef } from '../core/registry'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import '../nodes'

function setHash(hash: string): void {
  window.history.replaceState(null, '', `/${hash}`)
}

async function freshStore() {
  vi.resetModules()
  const module = await import('./graphStore')
  return module.useGraphStore.getState()
}

beforeEach(() => {
  installStorageStub()
  clearStorage()
})

afterEach(() => {
  setHash('')
  vi.resetModules()
})

describe('the start page and a share link', () => {
  it('is open on a first visit with no link', async () => {
    setHash('')
    expect((await freshStore()).startPageOpen).toBe(true)
  })

  /**
   * The load-bearing one. A link noticed an effect later means the modal is already up, over a
   * workflow the recipient has not seen — which reads as the link having failed.
   */
  it('is withheld when the address carries one', async () => {
    setHash('#!c1.abc')
    expect((await freshStore()).startPageOpen).toBe(false)
  })

  it('is withheld for a gist link too, not only a packed one', async () => {
    setHash('#!gh://schlegelp/b52b3af9')
    expect((await freshStore()).startPageOpen).toBe(false)
  })

  /** An ordinary anchor is not a workflow. The tutorial page uses fragments of its own. */
  it('is unaffected by a plain fragment', async () => {
    setHash('#chapter-3')
    expect((await freshStore()).startPageOpen).toBe(true)
  })

  it('stays closed for somebody who dismissed it, link or no link', async () => {
    setHash('')
    const store = await freshStore()
    store.setStartPageDismissed(true)
    expect((await freshStore()).startPageOpen).toBe(false)
  })
})

describe('what opening a shared workflow runs', () => {
  /**
   * The honest answer to "what does following a stranger's link do", and it is a property of
   * the node registry rather than of this feature: `loadGraph` schedules the *cheap* pass, so
   * anything `cheap` in a shared graph runs without the recipient pressing anything.
   *
   * `core.tableFromUrl` is the only node that fetches a URL written into the document, and it
   * is `expensive` — for its own reason (invariant 6: its URL is a text field, and `cheap`
   * would fire a request per keystroke), which happens to be exactly the property that makes a
   * shared graph inert until Run. Asserted here because the *reason* it must stay expensive is
   * now larger than the reason it was made expensive, and nothing else records that.
   */
  it('leaves the one node that fetches a document-named URL to Run', () => {
    expect(getNodeDef('core.tableFromUrl')?.cost).toBe('expensive')
  })

  /** Same argument for the two nodes that fetch a URL a *user* names at a source. */
  it('leaves the query nodes to Run as well', () => {
    for (const type of [
      'neuron.findNeurons',
      'neuron.connectivity',
      'neuron.paths',
      'neuron.explore',
    ]) {
      expect(getNodeDef(type)?.cost).toBe('expensive')
    }
  })
})
