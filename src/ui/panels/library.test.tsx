// @vitest-environment jsdom

/**
 * The workflow library, driven through the real editor.
 *
 * `store/library.test.ts` covers the storage semantics. What is left — and what this file is
 * for — is the part a user actually touches, where the failures are of a different kind: a
 * shelf that is written but never read back into the menu, a rail that appears before anything
 * is on it, and above all a destructive control with no question in front of it. Opening a
 * stored workflow replaces the canvas and clears the undo history, and deleting one is the only
 * irreversible thing in this app; both are asserted here because neither fails a type check.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { listWorkflows, resetLibrary, saveWorkflow } from '../../store/library'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  globalThis.indexedDB = new IDBFactory()
  resetLibrary()
  act(() => {
    useGraphStore.getState().closeStartPage()
    // Past the first-run guides dialog, which is the launch sequence's first stage and would
    // otherwise be what `openStartPage` puts on screen. See `guides.test.tsx`.
    useGraphStore.setState({ library: [], libraryLoaded: false, guidesOpen: false })
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

/** Open one of the toolbar menus and hand back its panel. */
function menu(label: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `${label} ▾` }))
  const panel = document.querySelector('.dropdown__panel')
  if (!(panel instanceof HTMLElement)) throw new Error(`The ${label} menu did not open`)
  return panel
}

/** Save the current graph under `name`, from the UI rather than through the store. */
async function saveAs(name: string) {
  fireEvent.change(screen.getByTitle(/Graph name/), { target: { value: name } })
  fireEvent.click(within(menu('Save')).getByText('Save in this browser'))
  await waitFor(() => {
    expect(useGraphStore.getState().library.map((e) => e.name)).toContain(name)
  })
}

describe('workflow library', () => {
  it('saves the current graph and lists it back under Open', async () => {
    render(<App />)
    await saveAs('My sweep')

    const open = within(menu('Open'))
    expect(open.getByText('My sweep')).toBeTruthy()
    // The blurb answers "is this the copy I was working on?", which is the only question a
    // shelf of your own graphs raises.
    expect(open.getByText(/just now · \d+ nodes/)).toBeTruthy()
  })

  it('keeps the file path alongside the shelf', async () => {
    // Browser storage is per-profile and goes with the site data, so the download has to stay
    // reachable — and stay described as the durable one.
    render(<App />)
    const save = within(menu('Save'))
    expect(save.getByText('Download .coda.json')).toBeTruthy()
    expect(within(menu('Open')).getByText(/Open a .coda.json file/)).toBeTruthy()
  })

  it('says the shelf is empty rather than showing an empty menu', async () => {
    render(<App />)
    // The read is what `menu()` triggers, so wait for it *outside* `waitFor` — a `fireEvent`
    // inside one mutates the DOM, which re-invokes the callback, which clicks again: the
    // observer and the click chase each other and the poll never yields to its own timeout.
    fireEvent.click(screen.getByRole('button', { name: 'Open ▾' }))
    // `findByText`, not a `waitFor` on store state: the read resolves into the store before
    // React has committed the render that shows it, so waiting on the state and then asserting
    // on the DOM passes or fails on scheduling.
    expect(await screen.findByText(/Nothing saved yet/)).toBeTruthy()
  })

  it('asks before replacing a workflow of the same name, and keeps one entry', async () => {
    render(<App />)
    await saveAs('My sweep')

    // A library entry is a document keyed by its name, so a second save under that name is a
    // new version of it — but never silently.
    fireEvent.click(screen.getByRole('button', { name: 'Save ▾' }))
    fireEvent.click(screen.getByText('Save in this browser'))
    expect(screen.getByText(/Replace “My sweep”/)).toBeTruthy()
    expect(await listWorkflows()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(async () => {
      expect(await listWorkflows()).toHaveLength(1)
    })
  })

  it('makes a second entry once the graph is renamed', async () => {
    render(<App />)
    await saveAs('First')
    await saveAs('Second')

    expect((await listWorkflows()).map((e) => e.name).sort()).toEqual(['First', 'Second'])
  })

  it('opens a stored workflow back onto the canvas', async () => {
    render(<App />)
    await saveAs('Kept')

    act(() => {
      useGraphStore.getState().newGraph()
    })
    expect(useGraphStore.getState().graph.nodes).toHaveLength(0)

    fireEvent.click(within(menu('Open')).getByText('Kept'))
    await waitFor(() => {
      expect(useGraphStore.getState().graph.nodes.length).toBeGreaterThan(0)
    })
    // Through `loadGraph` like every other open, so the history reset and the fit request
    // behave as they do for a file rather than being reimplemented here.
    expect(useGraphStore.getState().past).toEqual([])
    expect(useGraphStore.getState().graph.meta?.name).toBe('Kept')
  })

  it('asks before deleting, and the cancel really cancels', async () => {
    render(<App />)
    await saveAs('Precious')

    fireEvent.click(within(menu('Open')).getByRole('button', { name: 'Delete Precious' }))
    expect(screen.getByText(/Delete “Precious”\?/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await listWorkflows()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete Precious' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(async () => {
      expect(await listWorkflows()).toEqual([])
    })
  })

  it('renames an entry in place, without touching the stored graph', async () => {
    render(<App />)
    await saveAs('Typo')

    fireEvent.click(within(menu('Open')).getByRole('button', { name: 'Rename Typo' }))
    const field = screen.getByRole('textbox', { name: 'Rename Typo' })
    fireEvent.change(field, { target: { value: 'Fixed' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(async () => {
      expect((await listWorkflows()).map((e) => e.name)).toEqual(['Fixed'])
    })
  })

  describe('the start page rail', () => {
    it('is absent until something is saved', async () => {
      act(() => {
        useGraphStore.getState().openStartPage()
      })
      render(<App />)

      // A first visit is exactly when the start page matters most, and a rail explaining that
      // it has nothing on it is noise there.
      await waitFor(() => {
        expect(useGraphStore.getState().libraryLoaded).toBe(true)
      })
      expect(screen.queryByText('Your workflows')).toBeNull()
    })

    it('shows a card per saved workflow, with a tile', async () => {
      await saveWorkflow({
        ...useGraphStore.getState().graph,
        meta: { name: 'Saved earlier' },
      })
      act(() => {
        useGraphStore.getState().openStartPage()
      })
      render(<App />)

      const dialog = await screen.findByRole('dialog')
      await waitFor(() => {
        expect(within(dialog).getByText('Saved earlier')).toBeTruthy()
      })
      const card = within(dialog).getByText('Saved earlier').closest('.start-card')
      // Derived art, never per-item: a card added tomorrow must not ship blank.
      expect(card?.querySelector('.start-card__glyph')).toBeTruthy()
    })

    it('asks before replacing a graph that has work in it', async () => {
      await saveWorkflow({ ...useGraphStore.getState().graph, meta: { name: 'Shelf copy' } })
      act(() => {
        useGraphStore.getState().openStartPage()
      })
      render(<App />)

      const dialog = await screen.findByRole('dialog')
      await waitFor(() => {
        expect(within(dialog).getByText('Shelf copy')).toBeTruthy()
      })
      fireEvent.click(within(dialog).getByText('Shelf copy'))
      // Loading clears the undo history, so the same confirm the example cards get applies.
      expect(within(dialog).getByText(/Replace the current graph\?/)).toBeTruthy()
      expect(useGraphStore.getState().startPageOpen).toBe(true)
    })
  })
})
