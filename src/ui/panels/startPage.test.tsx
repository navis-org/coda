// @vitest-environment jsdom

/**
 * The start page.
 *
 * Three things here fail silently if they regress, which is why they are the bulk of this
 * file: that every card draws *something* (a rail of blank tiles is what per-item artwork
 * eventually produces), that a card cannot quietly replace a graph someone is working on, and
 * that closing is not dismissing — the last one being the difference between "I'll look later"
 * and "I never see this again".
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { EXAMPLES } from '../../examples'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadStartPageDismissed } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { StartPage } from './StartPage'
import { buildCommandItems } from './paletteItems'
import { datasetCards, exampleCards } from './startCards'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  // Node 26 shadows jsdom's localStorage, so without this the dismissal round-trip below
  // cannot be observed at all.
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // The store is a module singleton, so state set by one case would otherwise decide the
    // next one's answer.
    useGraphStore.setState({ startPageOpen: true, startPageDismissed: false })
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

const cardTitles = () =>
  [...document.querySelectorAll('.start-card__name')].map((el) => el.textContent)

/** The clickable half of a card, found by the name it shows. */
function card(title: string): HTMLElement {
  const name = [...document.querySelectorAll('.start-card__name')].find(
    (el) => el.textContent === title,
  )
  const main = name?.closest('.start-card')?.querySelector('.start-card__main')
  if (!(main instanceof HTMLElement)) throw new Error(`No card called "${title}"`)
  return main
}

describe('Start page', () => {
  describe('what it offers', () => {
    it('shows every example and every live dataset', () => {
      render(<StartPage />)
      const titles = cardTitles()
      for (const example of EXAMPLES) expect(titles).toContain(example.name)
      for (const family of DATASET_FAMILIES.filter((f) => f.sourceId !== 'mock')) {
        expect(titles).toContain(family.label)
      }
      expect(titles).toHaveLength(exampleCards().length + datasetCards().length)
    })

    it('keeps the synthetic datasets off the live rail', () => {
      render(<StartPage />)
      // The rail says "live neuPrint"; the mock families are what the examples already run on.
      expect(cardTitles()).not.toContain('Hemibrain (mini)')
      expect(cardTitles()).toContain('Hemibrain')
    })

    it('draws a tile for every card, so a new example is never blank', () => {
      render(<StartPage />)
      const cards = [...document.querySelectorAll('.start-card')]
      expect(cards.length).toBeGreaterThan(0)
      for (const el of cards) {
        const art = el.querySelector('.start-card__glyph, .start-card__img')
        expect(art).toBeTruthy()
        // A glyph with no children is an empty box wearing the right class.
        if (art?.classList.contains('start-card__glyph')) {
          expect(art.childElementCount).toBeGreaterThan(0)
        }
      }
    })

    it('derives an example tile from its terminal viewer, not from a hand-drawn list', () => {
      // Every example ends in a different viewer, so five distinct glyph sources.
      const nodeTypes = exampleCards().map((c) => c.nodeType)
      expect(new Set(nodeTypes).size).toBe(nodeTypes.length)
      expect(nodeTypes).toContain('out.network')
      expect(nodeTypes).toContain('out.viewer3d')
    })

    it('says which alpha it is', () => {
      render(<StartPage />)
      expect(screen.getByText(`v${__APP_VERSION__}`)).toBeTruthy()
      expect(screen.getByText('Alpha')).toBeTruthy()
    })

    it('points at the repository and the issue tracker', () => {
      render(<StartPage />)
      const repo = screen.getByRole('link', { name: 'github.com/navis-org/coda' })
      expect(repo.getAttribute('href')).toBe('https://github.com/navis-org/coda')
      const issues = screen.getByRole('link', { name: 'issue' })
      expect(issues.getAttribute('href')).toBe('https://github.com/navis-org/coda/issues')
      // A target="_blank" without this hands the opened page a handle on this one.
      expect(repo.getAttribute('rel')).toContain('noopener')
    })
  })

  describe('picking something', () => {
    it('loads an example and closes', () => {
      render(<StartPage />)
      fireEvent.click(card('LC circuit network'))

      const { graph, startPageOpen } = useGraphStore.getState()
      expect(startPageOpen).toBe(false)
      expect(graph.meta?.name).toBe('LC circuit network')
      expect(graph.nodes.some((n) => n.type === 'net.build')).toBe(true)
    })

    it('loads a dataset starter pointed at that dataset', () => {
      render(<StartPage />)
      fireEvent.click(card('Hemibrain'))

      const { graph } = useGraphStore.getState()
      expect(graph.nodes.map((n) => n.type)).toContain('dataset.hemibrain')
      expect(graph.nodes.map((n) => n.type)).toContain('neuron.explore')
    })

    it('does not ask before replacing an empty canvas', () => {
      render(<StartPage />)
      fireEvent.click(card('LC circuit network'))
      expect(useGraphStore.getState().startPageOpen).toBe(false)
    })

    it('asks before replacing a graph that has nodes', () => {
      act(() => {
        useGraphStore.getState().loadExample('partners')
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)

      fireEvent.click(card('LC circuit network'))
      expect(screen.getByText(/Replace the current graph/)).toBeTruthy()
      // Nothing has happened yet — the question is the whole point.
      expect(useGraphStore.getState().graph.meta?.name).toBe('LC outputs by partner type')
      expect(useGraphStore.getState().startPageOpen).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
      expect(useGraphStore.getState().graph.meta?.name).toBe('LC circuit network')
      expect(useGraphStore.getState().startPageOpen).toBe(false)
    })

    it('cancel leaves the graph and the page alone', () => {
      act(() => {
        useGraphStore.getState().loadExample('partners')
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)

      fireEvent.click(card('LC circuit network'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByText(/Replace the current graph/)).toBeNull()
      expect(useGraphStore.getState().graph.meta?.name).toBe('LC outputs by partner type')
      expect(useGraphStore.getState().startPageOpen).toBe(true)
    })
  })

  describe('closing and dismissing', () => {
    it('closes on the Close button without dismissing', () => {
      render(<StartPage />)
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(useGraphStore.getState().startPageOpen).toBe(false)
      expect(useGraphStore.getState().startPageDismissed).toBe(false)
      expect(loadStartPageDismissed()).toBe(false)
    })

    it('closes on Escape', () => {
      render(<StartPage />)
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(useGraphStore.getState().startPageOpen).toBe(false)
    })

    it('closes on a click outside the panel, but not inside it', () => {
      render(<StartPage />)
      fireEvent.pointerDown(screen.getByRole('dialog'))
      expect(useGraphStore.getState().startPageOpen).toBe(true)

      fireEvent.pointerDown(document.querySelector('.start')!)
      expect(useGraphStore.getState().startPageOpen).toBe(false)
    })

    it('the checkbox dismisses, persists, and can be unticked', () => {
      render(<StartPage />)
      const box = screen.getByRole('checkbox', { name: /Don’t show again/ })

      fireEvent.click(box)
      expect(useGraphStore.getState().startPageDismissed).toBe(true)
      expect(loadStartPageDismissed()).toBe(true)
      // Ticking is not closing: it stays undoable in the same visit.
      expect(useGraphStore.getState().startPageOpen).toBe(true)

      fireEvent.click(box)
      expect(useGraphStore.getState().startPageDismissed).toBe(false)
      expect(loadStartPageDismissed()).toBe(false)
    })

    it('renders nothing while closed', () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<StartPage />)
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  describe('the way back', () => {
    it('reopens from the toolbar', async () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)
      expect(screen.queryByRole('dialog')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Help' }))
      fireEvent.click(screen.getByRole('button', { name: /Show Welcome Dialog/ }))
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    })

    it('reopens from the palette, and that command is disabled while it is open', () => {
      const items = () => buildCommandItems({ store: useGraphStore.getState(), fitView: () => {} })
      const welcome = () => items().find((i) => i.id === 'cmd:welcome')!

      expect(welcome().action).toBe('Help')
      expect(welcome().disabled).toBe(true)

      act(() => useGraphStore.getState().closeStartPage())
      expect(welcome().disabled).toBe(false)

      act(() => welcome().perform?.())
      expect(useGraphStore.getState().startPageOpen).toBe(true)
    })
  })
})
