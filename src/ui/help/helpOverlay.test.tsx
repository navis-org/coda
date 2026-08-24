// @vitest-environment jsdom

/**
 * The `?` overlay, driven through the real app.
 *
 * Three things here are worth a test and the rest is prose. **A `?` appears on exactly the nodes
 * with a document** — the whole feature is that presence of a file is the switch, and a card that
 * grew the button unconditionally would be a fifth control on every node in the registry. **A
 * figure draws real registry objects** rather than whatever the document's author typed. And
 * **a cross-reference navigates without closing**, which is the one interaction with state of its
 * own.
 *
 * What is *not* asserted is layout. The figure's geometry is computed in `src/help/figures.ts`
 * precisely so it can be tested without a browser; jsdom performs no layout, so anything about
 * where a card ends up on screen would be asserted against nothing.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { helpTypes } from '../../help/registry'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().openHelp(undefined)
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

/** Open the overlay on a type and wait for its document to have loaded. */
async function openHelp(type: string) {
  render(<App />)
  act(() => {
    useGraphStore.getState().openHelp(type)
  })
  const dialog = await screen.findByRole('dialog', { name: /help/i })
  await waitFor(() => expect(within(dialog).queryByText('Loading…')).toBeNull())
  return dialog
}

/**
 * The `?` on a card, which is the feature's front door.
 *
 * Deliberately asserted in both directions. A button that appeared everywhere would be the fifth
 * control in a header that already has four, on the fifty-odd nodes that will never have a
 * document; a button that appeared nowhere is the feature not shipping. Only the pair says the
 * switch is the file.
 */
describe('the ? on a node card', () => {
  async function cardFor(nodeId: string): Promise<HTMLElement> {
    return waitFor(() => {
      const card = document
        .querySelector(`.react-flow__node[data-id="${nodeId}"]`)
        ?.querySelector('.coda-node')
      if (!card) throw new Error(`no card for ${nodeId}`)
      return card as HTMLElement
    })
  }

  it('is there for a documented node and absent for an undocumented one', async () => {
    const store = useGraphStore.getState()
    let documented = ''
    let plain = ''
    act(() => {
      store.closeStartPage()
      documented = store.addNode('neuron.nblast', { x: 0, y: 0 })
      plain = store.addNode('core.filter', { x: 0, y: 220 })
    })
    render(<App />)

    expect((await cardFor(documented)).querySelector('.coda-node__help')).toBeTruthy()
    expect((await cardFor(plain)).querySelector('.coda-node__help')).toBeNull()
  })

  it('opens the overlay on the node’s type', async () => {
    const store = useGraphStore.getState()
    let nodeId = ''
    act(() => {
      store.closeStartPage()
      nodeId = store.addNode('neuron.nblast', { x: 0, y: 0 })
    })
    render(<App />)

    const button = (await cardFor(nodeId)).querySelector(
      '.coda-node__help',
    ) as HTMLButtonElement
    act(() => {
      button.click()
    })
    expect(useGraphStore.getState().helpType).toBe('neuron.nblast')
    await screen.findByRole('dialog', { name: /help/i })
  })
})

describe('the help overlay', () => {
  it('is absent until something opens it', () => {
    render(<App />)
    expect(screen.queryByRole('dialog', { name: /help/i })).toBeNull()
  })

  it('draws the node’s own summary above the document', async () => {
    const dialog = await openHelp('neuron.nblast')
    expect(within(dialog).getByText(/Compare neurons by shape/)).toBeTruthy()
    expect(within(dialog).getByText(/What NBLAST does/)).toBeTruthy()
  })

  it('closes on Escape', async () => {
    await openHelp('neuron.nblast')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /help/i })).toBeNull())
  })

  /*
   * The claim the whole feature rests on. The document names `dataset.hemibrain` and never
   * writes its label — which is `Hemibrain (neuPrint)`, assembled by `familyLabel` from the
   * family and its backend, and exactly the kind of string a document would get subtly wrong.
   * Read from the registry here rather than written out, so this asserts agreement rather than
   * a literal.
   */
  it('draws figures from the registry, not from the document’s text', async () => {
    const dialog = await openHelp('neuron.nblast')
    const label = requireNodeDef('dataset.hemibrain').label
    expect(await loadSource('neuron.nblast')).not.toContain(label)

    expect(dialog.querySelectorAll('.cfig__card').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0)
    // Same for a socket: the Scores port is declared a Matrix, so it draws the matrix family
    // as a diamond — neither of which the document says.
    expect(
      dialog.querySelector('.cfig__pip[data-fam="matrix"][data-shape="diamond"]'),
    ).toBeTruthy()
  })

  it('marks the node the document is about, and only that one', async () => {
    const dialog = await openHelp('neuron.nblast')
    const focused = [...dialog.querySelectorAll('.cfig__card[data-focus="true"]')]
    expect(focused.length).toBeGreaterThan(0)
    expect(dialog.querySelectorAll('.cfig__card').length).toBeGreaterThan(focused.length)
  })

  it('never draws a figure that failed to build', async () => {
    for (const type of helpTypes()) {
      cleanup()
      const dialog = await openHelp(type)
      expect(dialog.querySelector('.cfig__problems'), `${type}`).toBeNull()
    }
  })

  it('follows a cross-reference in place, and comes back', async () => {
    const dialog = await openHelp('neuron.nblast')
    // The document links to the clustering node as the standard follow-on.
    const link = within(dialog).getByRole('button', {
      name: /Linkage/i,
    })
    act(() => {
      link.click()
    })
    await waitFor(() => expect(screen.getByText(/What's a linkage/)).toBeTruthy())
    // The store still holds where the reader came in, so Back has somewhere to go.
    expect(useGraphStore.getState().helpType).toBe('neuron.nblast')

    const back = screen.getByRole('button', { name: /back/i })
    act(() => {
      back.click()
    })
    await waitFor(() => expect(screen.getByText(/What NBLAST does/)).toBeTruthy())
  })

  it('says so rather than blanking, for a node with no document', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().openHelp('core.filter')
    })
    const dialog = await screen.findByRole('dialog', { name: /help/i })
    await waitFor(() =>
      expect(within(dialog).getByText(/no help document for this node yet/i)).toBeTruthy(),
    )
  })
})

/** The document's raw text, for the assertion that a figure is not copied out of it. */
async function loadSource(type: string): Promise<string> {
  const { loadHelpDoc } = await import('../../help/registry')
  return (await loadHelpDoc(type))!.source
}
