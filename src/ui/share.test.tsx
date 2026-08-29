// @vitest-environment jsdom

/**
 * Share workflow, both ends, driven through the real editor.
 *
 * `data/share/fragment.test.ts` covers the grammar and `gist.test.ts` the requests. What is
 * left is what somebody actually touches, and two of those things fail no type check:
 *
 *  - **the advisories**, which are the whole reason this is a dialog rather than a menu item
 *    that copies a link. Uploaded rows and a token requirement are what a recipient discovers
 *    only after the fact, and a share that silently omits them looks like it worked.
 *  - **the replace question**, which is the destructive half. `loadGraph` resets the undo
 *    history, so a link opened over somebody's canvas is the only unrecoverable thing here.
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import { deserializeGraph, emptyGraph, newId } from '../core/graph'
import { decodePacked, parseShareFragment } from '../data/share/fragment'
import { resetGithubCredentials, setGithubToken } from '../data/share/credentials'
import { shareAdvisories } from './shareAdvisories'
import { useGraphStore } from '../store/graphStore'
import { clearStorage, installJsdomStubs } from '../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetGithubCredentials()
  window.history.replaceState(null, '', '/')
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetGithubCredentials()
})

function menu(label: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `${label} ▾` }))
  const panel = document.querySelector('.dropdown__panel')
  if (!(panel instanceof HTMLElement)) throw new Error(`The ${label} menu did not open`)
  return panel
}

/** Open the dialog the way a user does, and wait for the link to be built. */
async function openShare(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Share workflow' }))
  const dialog = await screen.findByRole('dialog', { name: 'Share workflow' })
  await waitFor(() => {
    expect(within(dialog).getByLabelText('Shareable link')).toBeTruthy()
  })
  return dialog
}

function link(dialog: HTMLElement): string {
  return (within(dialog).getByLabelText('Shareable link') as HTMLInputElement).value
}

/** Records what was sent, so the tests can assert the request and not only the rendering. */
let fetchCalls: Array<[string, RequestInit | undefined]> = []

function stubGithub() {
  fetchCalls = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push([String(input), init])
    return Promise.resolve(
      String(input).endsWith('/user')
        ? new Response(JSON.stringify({ login: 'schlegelp' }), { status: 200 })
        : new Response(JSON.stringify({ id: 'abc123', owner: { login: 'schlegelp' } }), {
            status: 201,
          }),
    )
  })
}

describe('making a link', () => {
  it('packs the graph on the canvas into an address that reads back as the same graph', async () => {
    render(<App />)
    const dialog = await openShare()

    const url = link(dialog)
    expect(url).toContain('#!c1.')

    const ref = parseShareFragment(url.slice(url.indexOf('#')))
    if (ref.kind !== 'packed') throw new Error('expected a packed link')
    const { graph } = deserializeGraph(await decodePacked(ref.blob))
    expect(graph.nodes.map((n) => n.type).sort()).toEqual(
      useGraphStore
        .getState()
        .graph.nodes.map((n) => n.type)
        .sort(),
    )
  })

  /**
   * The button is an icon, so its name lives only in `aria-label` and `title` — the two places
   * a screen reader and a pointer respectively look. Losing either turns it into a control only
   * its author can identify, and nothing about the rendering would say so.
   */
  it('is a named icon button in the toolbar, not an entry under Save', async () => {
    render(<App />)
    const button = screen.getByRole('button', { name: 'Share workflow' })
    expect(button.querySelector('svg')).toBeTruthy()
    expect(button.textContent).toBe('')
    expect(button.getAttribute('title')).toMatch(/^Share workflow —/)
    expect(within(menu('Save')).queryByText(/Share workflow/)).toBeNull()
  })

  it('opens from the command palette as well as the toolbar', async () => {
    render(<App />)
    act(() => useGraphStore.getState().requestShare())
    expect(await screen.findByRole('dialog', { name: 'Share workflow' })).toBeTruthy()
  })

  /** A blank canvas is a perfectly shareable graph — an empty workspace on a dataset. */
  it('is offered on an empty canvas rather than refused', async () => {
    act(() => useGraphStore.getState().newGraph())
    render(<App />)
    expect(link(await openShare())).toContain('#!c1.')
  })
})

describe('dismissing', () => {
  /**
   * The dialog had no Escape handler at all until it started using the shared dismiss hook —
   * every other modal here has one, and nothing about the rendering said this one did not.
   */
  it('closes on Escape', async () => {
    render(<App />)
    await openShare()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Share workflow' })).toBeNull()
    })
  })

  it('closes on a click outside the panel', async () => {
    render(<App />)
    await openShare()
    fireEvent.pointerDown(document.body)
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Share workflow' })).toBeNull()
    })
  })
})

describe('what the dialog admits', () => {
  it('says nothing about tokens for a graph on the synthetic connectome', async () => {
    render(<App />)
    const dialog = await openShare()
    expect(within(dialog).queryByText(/neuPrint token of their own/)).toBeNull()
  })

  it('names the real connectome a recipient will need a token for', async () => {
    act(() => {
      const graph = emptyGraph('Hemibrain sweep')
      graph.nodes.push({
        id: newId('n'),
        type: 'dataset.hemibrain',
        position: { x: 0, y: 0 },
        params: {},
      })
      useGraphStore.getState().loadGraph(graph)
    })
    render(<App />)
    const dialog = await openShare()
    expect(within(dialog).getByText(/neuPrint token of their own/).textContent).toMatch(
      /Hemibrain/i,
    )
  })

  /**
   * The rows live in IndexedDB by content address, so a link carries the reference and not the
   * data — exactly as a `.coda.json` always has. Naming the **file** is the only part of this
   * anybody can act on; the content hash is not.
   */
  it('names the uploaded file that does not travel', async () => {
    act(() => {
      const graph = emptyGraph('With annotations')
      graph.nodes.push({
        id: newId('n'),
        type: 'core.uploadTable',
        position: { x: 0, y: 0 },
        params: { dataId: 'abc123', fileName: 'annotations.csv' },
      })
      useGraphStore.getState().loadGraph(graph)
    })
    render(<App />)
    const dialog = await openShare()
    const note = within(dialog).getByText(/stored in this browser, not in the workflow/)
    expect(note.textContent).toContain('annotations.csv')
    expect(note.textContent).not.toContain('abc123')
  })

  /**
   * The credential is per **backend**, and the sentence names it.
   *
   * It said `neuPrint token` for every dataset, which was true for as long as neuPrint was the
   * only credentialled backend. Left alone it points a FlyWire recipient at the wrong tab of the
   * Connections dialog — worse than saying nothing, since a sentence this specific reads as
   * knowing what it is talking about.
   *
   * Asked of `shareAdvisories` directly rather than through the dialog: it is pure, and the
   * neuPrint case above already proves the wiring.
   */
  describe('the token advisory', () => {
    const graphOf = (...types: string[]) => {
      const graph = emptyGraph('shared')
      for (const type of types) {
        graph.nodes.push({ id: newId('n'), type, position: { x: 0, y: 0 }, params: {} })
      }
      return graph
    }
    const tokenAdvisories = (...types: string[]) =>
      shareAdvisories(graphOf(...types), undefined).filter((a) => a.id.startsWith('token'))
    const tokenNotes = (...types: string[]) => tokenAdvisories(...types).map((a) => a.text)

    it('names CAVE for a CAVE dataset', () => {
      expect(tokenNotes('dataset.flywire')).toEqual([
        expect.stringContaining('a CAVE token of their own'),
      ])
      expect(tokenNotes('dataset.flywire')[0]).toContain('FlyWire FAFB')
    })

    it('names neuPrint for a neuPrint one', () => {
      expect(tokenNotes('dataset.hemibrain')).toEqual([
        expect.stringContaining('a neuPrint token of their own'),
      ])
    })

    it('says both, once each, for a graph holding both', () => {
      // One sentence per backend rather than one compound one: the recipient needs two tokens
      // from two places, and a list that ran them together would name neither properly.
      const notes = tokenNotes('dataset.hemibrain', 'dataset.malecns', 'dataset.flywire')
      expect(notes).toHaveLength(2)
      expect(notes.join(' | ')).toContain('a neuPrint token')
      expect(notes.join(' | ')).toContain('a CAVE token')
      // Two neuPrint datasets, one sentence, both named.
      const neuprint = notes.find((t) => t.includes('neuPrint'))!
      expect(neuprint).toContain('Hemibrain')
      expect(neuprint).toContain('MaleCNS')
      expect(neuprint).toContain('are real connectomes')

      // The id is what the dialog keys the list on, so two sentences must not share one.
      const ids = tokenAdvisories('dataset.hemibrain', 'dataset.flywire').map((a) => a.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('counts the custom nodes, which have no family entry to read a label off', () => {
      // These name their server by hand, so `familyForNodeType` answers nothing — which used to
      // mean a graph built on one got no token advisory at all.
      expect(tokenNotes('dataset.neuprint')).toEqual([
        expect.stringContaining('a neuPrint token of their own'),
      ])
      expect(tokenNotes('dataset.cave')[0]).toContain('Custom CAVE')
    })

    it('says nothing for a connectome generated in the browser', () => {
      // No server to authenticate against — and `BACKENDS.mock` carries an empty label, so a
      // rule that fired here would put `a  token` on screen.
      expect(tokenNotes('dataset.mock.opticlobe')).toEqual([])
    })
  })

  it('warns that a link built on localhost opens nowhere else', async () => {
    render(<App />)
    const dialog = await openShare()
    expect(within(dialog).getByText(/only opens where Coda is running now/)).toBeTruthy()
  })
})

describe('the gist half', () => {
  it('points at Connections instead of a dead button when there is no token', async () => {
    render(<App />)
    const dialog = await openShare()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'GitHub Gist' }))
    expect(within(dialog).getByText(/No GitHub token yet/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /gist$/i })).toBeNull()
  })

  it('uploads and hands back a gh:// link, and remembers the gist on the graph', async () => {
    setGithubToken('ghp_test')
    stubGithub()
    render(<App />)
    const dialog = await openShare()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'GitHub Gist' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Create a gist' }))

    await waitFor(() => {
      expect(link(dialog)).toContain('#!gh://schlegelp/abc123')
    })
    // The filename is the same slug `Download .coda.json` uses — computed once, at the call
    // site, so the gist and the download cannot come to disagree about what a graph is called.
    const post = fetchCalls.find(([, init]) => init?.method === 'POST')?.[1]?.body
    expect(Object.keys(JSON.parse(String(post)).files)).toEqual([
      'fetch-and-group-connectivity-by-type.coda.json',
    ])
    // In the document, which is what lets a second Share update this gist rather than litter a
    // new one — and what a recipient's copy deliberately does not carry.
    expect(useGraphStore.getState().graph.meta?.gist).toEqual({
      id: 'abc123',
      owner: 'schlegelp',
    })
  })

  /**
   * Bookkeeping about a link is not an edit: a graph must not go stale because it was shared,
   * and it must not land in the undo stack either — ⌘Z after sharing has to undo whatever you
   * were actually doing.
   */
  it('costs no run and no undo step', async () => {
    setGithubToken('ghp_test')
    stubGithub()
    render(<App />)
    const dialog = await openShare()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'GitHub Gist' }))
    const before = useGraphStore.getState().graph.nodes.map((n) => n.id)
    const history = useGraphStore.getState().past.length
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Create a gist' }))
    await waitFor(() => expect(useGraphStore.getState().graph.meta?.gist).toBeTruthy())
    expect(useGraphStore.getState().graph.nodes.map((n) => n.id)).toEqual(before)
    expect(useGraphStore.getState().past.length).toBe(history)
  })
})

describe('opening a link somebody sent', () => {
  /**
   * The destructive one. `loadGraph` resets the history, so the autosave is the only copy of
   * what is about to go — which is why this asks and the empty-canvas case does not.
   */
  it('asks before replacing a canvas that has work on it', async () => {
    const shared = emptyGraph('Their sweep')
    shared.nodes.push({
      id: 'x1',
      type: 'core.filterTable',
      position: { x: 0, y: 0 },
      params: {},
    })
    window.history.replaceState(null, '', `/#!${encodeURIComponent(JSON.stringify(shared))}`)

    render(<App />)
    const gate = await screen.findByRole('dialog', { name: 'Shared workflow' })
    expect(within(gate).getByText(/Open “Their sweep”\?/)).toBeTruthy()

    // Declining keeps the canvas — and takes the link out of the address bar, or a reload
    // after ten minutes of editing would silently revert to it.
    fireEvent.click(within(gate).getByRole('button', { name: 'Keep what I have' }))
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(useGraphStore.getState().graph.meta?.name).not.toBe('Their sweep')
  })

  it('opens without asking when there is nothing to lose', async () => {
    const shared = emptyGraph('Their sweep')
    shared.nodes.push({ id: 'x1', type: 'core.filterTable', position: { x: 0, y: 0 }, params: {} })
    act(() => useGraphStore.getState().newGraph())
    window.history.replaceState(null, '', `/#!${encodeURIComponent(JSON.stringify(shared))}`)

    render(<App />)
    await waitFor(() => {
      expect(useGraphStore.getState().graph.meta?.name).toBe('Their sweep')
    })
    expect(screen.queryByRole('dialog', { name: 'Shared workflow' })).toBeNull()
    expect(window.location.hash).toBe('')
  })

  /**
   * Shortening a link is exactly the act of hiding where it goes, so the one form whose
   * destination the recipient cannot see is the one that asks. `gh://` and `gs://` name their
   * host in the link itself and do not.
   */
  it('shows the host before fetching from a bare https link', async () => {
    act(() => useGraphStore.getState().newGraph())
    window.history.replaceState(null, '', '/#!https://lab.example.org/w.coda.json')
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchSpy)

    render(<App />)
    const gate = await screen.findByRole('dialog', { name: 'Shared workflow' })
    expect(within(gate).getByText('lab.example.org')).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()

    fireEvent.click(within(gate).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names the scheme it cannot open rather than failing silently', async () => {
    window.history.replaceState(null, '', '/#!ftp://example.org/w.json')
    render(<App />)
    const gate = await screen.findByRole('dialog', { name: 'Shared workflow' })
    expect(within(gate).getByText(/"ftp:\/\/"/)).toBeTruthy()
  })

  /**
   * The store withholds the welcome modal when the address carries a link — `store/shareLoad`
   * covers that, since it happens in the initialiser. What *this* level can assert is the other
   * half: the gate is mounted after the start page in `App`, so a question about a link is
   * reachable even where the modal is up for some other reason.
   */
  it('is reachable with the start page open', async () => {
    act(() => useGraphStore.getState().openStartPage())
    window.history.replaceState(null, '', '/#!ftp://example.org/w.json')
    render(<App />)

    const dialogs = await screen.findAllByRole('dialog')
    expect(dialogs.at(-1)?.getAttribute('aria-label')).toBe('Shared workflow')
  })
})
