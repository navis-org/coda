// @vitest-environment jsdom

/**
 * The store's hold for a card writing to a server (`holdForWrite`, `docs/seam-merge-plan.md`
 * phase 6): while merges are sent, nothing takes the card off the graph or its document off the
 * screen, or the record of a write the server made would have nowhere to go — or would land in
 * another document sharing the node's id. Ordinary edits go on, and the record is written through
 * the hold itself, read and replaced in one step.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import '../nodes'
import { node } from '../test/graph'
import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import type { WriteHold } from './graphStore'
import { useGraphStore } from './graphStore'
import { loadAutosave } from './persistence'

const store = () => useGraphStore.getState()
const has = (id: string) => store().graph.nodes.some((n) => n.id === id)
const holdOn = (id: string) => store().holdForWrite(store().activeTabId, id)

let hold: WriteHold | undefined

beforeEach(() => {
  // Node 26 shadows jsdom's `localStorage`; the immediate save is read back from it.
  installStorageStub()
  clearStorage()
  store().newGraph()
  store().loadGraph(
    addNode(
      addNode(emptyGraph('held'), node('review', 'seam:review')),
      node('other', 'seam:review'),
    ),
  )
  store().setNotice(undefined)
})

afterEach(() => {
  hold?.release()
  hold = undefined
})

describe('holding a card while it writes', () => {
  it('refuses deleting it, and says why', () => {
    hold = holdOn('review')
    store().deleteNodes(['review'])
    expect(has('review')).toBe(true)
    expect(store().notice).toMatch(/Merges are being sent/)
    // Another node is an ordinary edit.
    store().deleteNodes(['other'])
    expect(has('other')).toBe(false)
  })

  /** Refused before anything else: the selection stays, and a cut copies nothing. */
  it('refuses a delete or a cut of it whole, leaving the selection as it was', () => {
    hold = holdOn('review')
    store().setSelection(['review', 'other'])
    store().deleteNodes(['review', 'other'])
    expect(has('other')).toBe(true)
    expect(store().selection).toEqual(['review', 'other'])
    expect(store().cutSelection()).toBeUndefined()
    expect(has('review')).toBe(true)
  })

  it('refuses an undo or a redo that would take it away', () => {
    // An edit that adds a third card: undoing it is what could remove it.
    store().setGraph(addNode(store().graph, node('added', 'seam:review')))
    hold = holdOn('added')
    store().undo()
    expect(has('added')).toBe(true)
    // A delete undone, then held: redoing the delete is refused.
    hold.release()
    store().deleteNodes(['added'])
    store().undo()
    hold = holdOn('added')
    store().redo()
    expect(has('added')).toBe(true)
  })

  it('refuses a load, a new graph and a change of document', () => {
    hold = holdOn('review')
    const tab = store().activeTabId
    store().loadGraph(emptyGraph('other'))
    store().newGraph()
    store().newWorkflow()
    store().closeDocument(tab)
    expect(store().activeTabId).toBe(tab)
    expect(has('review')).toBe(true)
    expect(store().tabs).toHaveLength(1)
  })

  it('writes the record through the hold, from the value as it is, with no undo step', () => {
    hold = holdOn('review')
    const past = store().past.length
    hold.update('merges', (now) => `${String(now)}+a`)
    hold.update('merges', (now) => `${String(now)}+b`)
    expect(store().graph.nodes.find((n) => n.id === 'review')!.params['merges']).toBe('+a+b')
    expect(store().past).toHaveLength(past)
    hold.release()
    expect(() => hold!.update('merges', () => 'late')).toThrow(/released/)
  })

  /** A crash inside the autosave's debounce must not lose the note of a merge the server made. */
  it('saves each record write at once, not on the autosave’s delay', () => {
    hold = holdOn('review')
    hold.update('merges', () => 'entry')
    const saved = loadAutosave()!.graph.nodes.find((n) => n.id === 'review')!
    expect(saved.params['merges']).toBe('entry')
  })

  /**
   * Unreachable through the guards above — so if a path round them ever appears, the write is
   * refused out loud rather than skipped, and the batch stops on it (audit of 77c0625).
   */
  it('throws, rather than skipping, where the card has gone from under it', () => {
    hold = holdOn('review')
    useGraphStore.setState({ graph: emptyGraph('elsewhere') })
    expect(() => hold!.update('merges', () => 'entry')).toThrow(/could not be recorded/)
  })

  it('is refused for a card not on screen, and while another is held', () => {
    expect(() => store().holdForWrite('another-document', 'review')).toThrow(
      /no longer on screen/,
    )
    expect(() => holdOn('gone')).toThrow(/no longer on screen/)
    hold = holdOn('review')
    expect(() => holdOn('other')).toThrow(/already writing/)
    hold.release()
    hold.release()
    store().deleteNodes(['review'])
    expect(has('review')).toBe(false)
    hold = holdOn('other')
  })
})
