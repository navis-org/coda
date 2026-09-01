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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { getNodeDef } from '../../core/registry'
import { starterFamilies } from '../../nodes/lib/datasetFamilies'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { loadStartPageDismissed } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { StartPage } from './StartPage'
import { buildCommandItems } from './paletteItems'
import { DOOR_CARDS, WIZARD_CARD, ZOO_CARD, datasetCards } from './startCards'
import type * as TourState from '../tour/tourState'
import { TOURS } from '../tour/tourState'

/*
 * `startTour` is stubbed, and only `startTour`. It is the one call on this page that would
 * `import()` driver.js — which `tour.test.tsx` deliberately never loads, since the steps are
 * data and the library is the half that cannot go stale. `TOURS` comes through untouched,
 * because the rail's copy is the thing being asserted.
 */
const tours = vi.hoisted(() => ({ started: [] as string[] }))
vi.mock('../tour/tourState', async (importOriginal) => ({
  ...(await importOriginal<typeof TourState>()),
  startTour: (id: string) => {
    tours.started.push(id)
    return Promise.resolve()
  },
}))

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  // Node 26 shadows jsdom's localStorage, so without this the dismissal round-trip below
  // cannot be observed at all.
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  tours.started.length = 0
  act(() => {
    // The store is a module singleton, so state set by one case would otherwise decide the
    // next one's answer.
    /*
     * `guidesOpen: false` is the second visit onwards, which is every visit this file is about:
     * the launch sequence shows the guides dialog first and this page behind it, and the two
     * read the same pair of booleans through `useLaunchStage`. `guides.test.tsx` owns the
     * first-visit half.
     */
    useGraphStore.setState({
      startPageOpen: true,
      guidesOpen: false,
      startPageDismissed: false,
      zooOpen: false,
      // The wizard is a module-singleton flag like the other three: one case opens it, and
      // without this the next case renders with a dialog nobody in it asked for.
      wizardOpen: false,
    })
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

const cardTitles = () =>
  [...document.querySelectorAll('.start-card__name')].map((el) => el.textContent)

/** The card names on one rail, in the order they are drawn, found by the rail's label. */
function deckNames(label: string): string[] {
  const deck = [...document.querySelectorAll('.start__deck')].find((el) =>
    el.querySelector('.start__deck-label')?.textContent?.startsWith(label),
  )
  if (!deck) throw new Error(`No rail called "${label}"`)
  return [...deck.querySelectorAll('.start-card__name')].map((el) => el.textContent ?? '')
}

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
    it('shows every live dataset worth starting from', () => {
      render(<StartPage />)
      const titles = cardTitles()
      for (const family of starterFamilies().filter((f) => f.sourceId !== 'mock')) {
        expect(titles).toContain(family.label)
      }
      // Plus the doors, which are not graphs at all — see the rail below. The rail of bundled
      // examples that used to sit here is gone: the wizard on the doors rail replaced it.
      expect(titles).toHaveLength(datasetCards().length + DOOR_CARDS.length)
    })

    /*
     * A rail of its own rather than cards among the datasets, because the two differ in the one
     * way a first-time reader cares about: a dataset card builds a graph and replaces the canvas
     * on the click. Nothing on this rail does — the wizard and the Zoo each ask their own
     * question where it can be answered, and a tour announces itself in its first step.
     *
     * The wizard leads, because it is the one that produces *their* graph.
     */
    it('gathers the doors on one rail: the wizard, the tours, then the Zoo', () => {
      render(<StartPage />)
      expect(deckNames('Start & learn')).toEqual([
        WIZARD_CARD.title,
        ...TOURS.map((tour) => tour.label),
        ZOO_CARD.title,
      ])
      // And none of them is also sitting on a rail that loads a graph.
      const datasets = datasetCards().map((c) => c.title)
      for (const door of DOOR_CARDS) expect(datasets).not.toContain(door.title)
    })

    /*
     * The blurbs are `TOURS`' own. Three surfaces launch these — this rail, the `?` menu and the
     * palette — and each used to carry its own wording, which had already drifted before the
     * table existed. A card that restates one is that drift starting again.
     */
    it('takes the tour copy from the one table, not a second spelling of it', () => {
      render(<StartPage />)
      for (const tour of TOURS) {
        expect(card(tour.label).textContent).toContain(tour.blurb)
      }
    })

    /*
     * The rail is the offer now, so the row under it is not. Both together is the same three
     * things twice in one dialog — the `?` menu is what still lists them for the visit somebody
     * ticked "Don't show again" on.
     */
    it('drops the tours from the credits row, keeping the links a rail cannot hold', () => {
      render(<StartPage />)
      const credits = document.querySelector('.start__credits')
      expect(credits?.textContent).not.toContain('Guided Tour')
      expect(credits?.textContent).toContain('Give feedback')
      expect(credits?.textContent).toContain('Node guide')
    })

    it('keeps the synthetic dataset off the live rail', () => {
      render(<StartPage />)
      // The rail says "live neuPrint"; the mock family is what the examples already run on.
      expect(cardTitles()).not.toContain('Demo Data')
      expect(cardTitles()).toContain('Hemibrain')
    })

    /*
     * Named rather than derived from the flag, deliberately. Asserting `starter !== false` here
     * would be the rail checked against the same expression it is built from, which is not an
     * assertion — it passes whatever the table says. These three are the decision.
     */
    it('holds the specialist volumes back, without unregistering them', () => {
      render(<StartPage />)
      const titles = cardTitles()
      for (const label of ['Optic Lobe', 'FIB-19', 'Mushroom Body']) {
        expect(titles).not.toContain(label)
      }
      // Still nodes, still addable: what the flag decides is where somebody *begins*.
      for (const key of ['opticlobe', 'fib19', 'mushroombody']) {
        expect(getNodeDef(`dataset.${key}`)).toBeDefined()
      }
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

    it('says which build it is', () => {
      render(<StartPage />)
      expect(screen.getByText(`v${__APP_VERSION__}`)).toBeTruthy()
      expect(screen.getByText('Beta')).toBeTruthy()
    })

    it('points at the repository without an issue tracker link', () => {
      render(<StartPage />)
      const repo = screen.getByRole('link', { name: 'github.com/navis-org/coda' })
      expect(repo.getAttribute('href')).toBe('https://github.com/navis-org/coda')
      expect(screen.queryByRole('link', { name: 'issue' })).toBeNull()
      // A target="_blank" without this hands the opened page a handle on this one.
      expect(repo.getAttribute('rel')).toContain('noopener')
    })

    /*
     * "Docs" is the field guide, not the repository's docs folder: it is the
     * document somebody on the welcome screen actually wants. A second vite entry
     * is not a route, so nothing else would catch this link going missing.
     */
    it('points Docs at the field guide, through BASE_URL rather than an absolute path', () => {
      render(<StartPage />)
      const guide = screen.getByRole('link', { name: 'Docs' })
      /*
       * Against BASE_URL rather than a literal: `base` is './' in the build, so a
       * hardcoded '/tutorial.html' would resolve to the domain root and 404 under
       * the subpath GitHub Pages serves this from. (Vitest leaves BASE_URL at '/',
       * so the literal cannot be asserted here — the composition is the point.)
       */
      expect(guide.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}tutorial.html`)
      expect(guide.getAttribute('rel')).toContain('noopener')
    })

    /*
     * The reference half of the pair, and a third vite entry with the same standing as the
     * second: not a route, so nothing else catches it going missing.
     */
    it('offers the node guide beside Docs, composed the same way', () => {
      render(<StartPage />)
      const guide = screen.getByRole('link', { name: 'Node guide' })
      expect(guide.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}nodes.html`)
      expect(guide.getAttribute('rel')).toContain('noopener')
    })

    /* The fourth entry, and the one somebody reaches for before either of the others. */
    it('offers the overview, composed the same way', () => {
      render(<StartPage />)
      const overview = screen.getByRole('link', { name: 'Overview' })
      expect(overview.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}overview.html`)
      expect(overview.getAttribute('rel')).toContain('noopener')
    })

    /* The group that develops this — an external site, so the same rel applies. */
    it('links the group to its own site', () => {
      render(<StartPage />)
      const group = screen.getByRole('link', { name: 'Fly Connectomics Group' })
      expect(group.getAttribute('href')).toBe('https://flyconnecto.me/')
      expect(group.getAttribute('rel')).toContain('noopener')
    })

    /*
     * The funder logos. Which *ink* shows is CSS, across the same three scopes `theme.css`
     * uses, and jsdom loads no stylesheet — so that part is checked in a browser, not here.
     * What this pins is the half jsdom can see and that a refactor would quietly drop: both
     * marks are present, each in both inks, and every one carries the institution's name as
     * `alt`. A logo whose only label is its filename is one no screen reader can attribute.
     */
    it('credits both funders, in both inks, each named', () => {
      render(<StartPage />)
      for (const name of ['MRC Laboratory of Molecular Biology', 'University of Cambridge']) {
        const marks = screen.getAllByAltText(name)
        expect(marks).toHaveLength(2)
        expect(marks.map((m) => m.className)).toEqual([
          expect.stringContaining('start__logo--light'),
          expect.stringContaining('start__logo--dark'),
        ])
        // Every one resolves to a real emitted asset rather than an empty src.
        for (const mark of marks) expect(mark.getAttribute('src')).toBeTruthy()
      }
    })

    /*
     * One anchor per institution, wrapping both inks — so a mark is clickable whichever ink is
     * showing, and neither link doubles up.
     *
     * Found by `alt` and walked up to the anchor rather than by role and name: jsdom loads no
     * stylesheet, so the ink that CSS hides is still in its accessibility tree here and the
     * link's computed name is both `alt`s concatenated. That is a jsdom artifact, not a bug in
     * the markup — in a browser exactly one is `display: none` and the name is the single one.
     */
    it('makes each funder mark a link to that institution', () => {
      render(<StartPage />)
      const target = (alt: string) => {
        const links = screen.getAllByAltText(alt).map((m) => m.closest('a'))
        // Both inks hang off the *same* anchor, so the pair collapses to one link.
        expect(new Set(links).size).toBe(1)
        const link = links[0]!
        expect(link.getAttribute('rel')).toContain('noopener')
        return link.getAttribute('href')
      }
      expect(target('MRC Laboratory of Molecular Biology')).toBe('https://mrclmb.ac.uk/')
      expect(target('University of Cambridge')).toBe(
        'https://www.zoo.cam.ac.uk/research/groups/connectomics',
      )
    })

    /*
     * Each mark is a link to its institution, and *one* anchor wraps both inks rather than one
     * per image — which is what leaves the link named once in a browser, where the unused ink
     * is `display: none` and so out of the accessibility tree. Asserted through `closest`
     * rather than by accessible name on purpose: jsdom loads no stylesheet, so both inks are
     * live to it and the name it computes is the alt text twice over. The wrapping is the
     * property that matters and the one a refactor to a link-per-image would break.
     */
    it('links each funder mark to its institution, one anchor per pair', () => {
      render(<StartPage />)
      const links = [
        ['MRC Laboratory of Molecular Biology', 'https://mrclmb.ac.uk/'],
        ['University of Cambridge', 'https://www.zoo.cam.ac.uk/research/groups/connectomics'],
      ] as const
      for (const [name, href] of links) {
        const anchors = screen.getAllByAltText(name).map((mark) => mark.closest('a'))
        expect(anchors).toHaveLength(2)
        // Both inks hang off the same anchor — not two anchors that happen to agree.
        expect(anchors[0]).not.toBeNull()
        expect(anchors[1]).toBe(anchors[0])
        expect(anchors[0]!.getAttribute('href')).toBe(href)
        expect(anchors[0]!.getAttribute('rel')).toContain('noopener')
      }
    })
  })

  describe('picking something', () => {
    /*
     * The wizard card opens a dialog and touches nothing, which is the whole difference between
     * it and the four example cards it replaced: those loaded a graph on the click, so the page
     * had to ask about replacing one first. The wizard asks on its own summary screen, over the
     * chain it is about to build.
     */
    it('opens the wizard without touching the graph', () => {
      act(() => {
        useGraphStore.getState().loadGraph(demoWorkflow('partners'))
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)
      const before = useGraphStore.getState().graph.meta?.name

      fireEvent.click(card(WIZARD_CARD.title))
      expect(screen.queryByText(/Replace the current graph/)).toBeNull()
      expect(useGraphStore.getState().wizardOpen).toBe(true)
      // `openWizard` closes this page on the way in: two full-screen modals is one too many.
      expect(useGraphStore.getState().startPageOpen).toBe(false)
      expect(useGraphStore.getState().graph.meta?.name).toBe(before)
    })

    it('loads a dataset starter pointed at that dataset', () => {
      render(<StartPage />)
      fireEvent.click(card('Hemibrain'))

      const { graph } = useGraphStore.getState()
      expect(graph.nodes.map((n) => n.type)).toContain('dataset.hemibrain')
      expect(graph.nodes.map((n) => n.type)).toContain('neuron.explore')
    })

    /*
     * The Zoo replaces nothing until somebody picks a workflow inside it, and it asks there —
     * over the preview, which is where the question is answerable. Asking twice, the first time
     * about a graph nobody has chosen yet, is the regression this guards.
     */
    it('opens the Zoo without asking, even over a graph that has nodes', () => {
      act(() => {
        useGraphStore.getState().loadGraph(demoWorkflow('partners'))
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)

      fireEvent.click(card(ZOO_CARD.title))
      expect(screen.queryByText(/Replace the current graph/)).toBeNull()
      expect(useGraphStore.getState().zooOpen).toBe(true)
      // `openZoo` closes this page on the way in: two full-screen modals is one too many.
      expect(useGraphStore.getState().startPageOpen).toBe(false)
      expect(useGraphStore.getState().graph.nodes.some((n) => n.id === 'conn')).toBe(true)
    })

    /*
     * A tour is announced and undoable — the two that touch the canvas say so in their first
     * step and go through `setGraph` — so a yes/no here would ask about something the tour has
     * not done yet and will explain before it does. The page has to close either way: a tour
     * whose first stop is the canvas cannot begin under a modal.
     */
    it('starts a tour and closes, without asking about the graph', () => {
      act(() => {
        useGraphStore.getState().loadGraph(demoWorkflow('partners'))
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)

      fireEvent.click(card('Learn to Build'))
      expect(screen.queryByText(/Replace the current graph/)).toBeNull()
      expect(tours.started).toEqual(['build'])
      expect(useGraphStore.getState().startPageOpen).toBe(false)
      // The tour empties the canvas itself, a step later and with a warning. Not here.
      expect(useGraphStore.getState().graph.nodes.length).toBeGreaterThan(0)
    })

    it('does not ask before replacing an empty canvas', () => {
      render(<StartPage />)
      fireEvent.click(card('Hemibrain'))
      expect(useGraphStore.getState().startPageOpen).toBe(false)
    })

    it('asks before replacing a graph that has nodes', () => {
      act(() => {
        useGraphStore.getState().loadGraph(demoWorkflow('partners'))
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)

      fireEvent.click(card('Hemibrain'))
      expect(screen.getByText(/Replace the current graph/)).toBeTruthy()
      // Nothing has happened yet — the question is the whole point.
      expect(useGraphStore.getState().graph.nodes.some((n) => n.id === 'conn')).toBe(true)
      expect(useGraphStore.getState().startPageOpen).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
      expect(useGraphStore.getState().graph.nodes.map((n) => n.type)).toContain(
        'dataset.hemibrain',
      )
      expect(useGraphStore.getState().startPageOpen).toBe(false)
    })

    it('cancel leaves the graph and the page alone', () => {
      act(() => {
        useGraphStore.getState().loadGraph(demoWorkflow('partners'))
        useGraphStore.getState().openStartPage()
      })
      render(<StartPage />)

      fireEvent.click(card('Hemibrain'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByText(/Replace the current graph/)).toBeNull()
      expect(useGraphStore.getState().graph.nodes.some((n) => n.id === 'conn')).toBe(true)
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
    /**
     * Opens the `?` menu, and the named submenu inside it if one is given.
     *
     * The three documents moved a level down when the menu was reorganised into submenus, and
     * these cases went red — which is the point of them. Written as a helper rather than
     * repeated, so the *next* rearrangement is one edit here rather than four.
     */
    const openHelp = (submenu?: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Help' }))
      if (submenu) fireEvent.click(screen.getByRole('button', { name: new RegExp(submenu) }))
    }

    it('reopens from the toolbar', async () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)
      expect(screen.queryByRole('dialog')).toBeNull()

      openHelp()
      fireEvent.click(screen.getByRole('button', { name: /Welcome Dialog/ }))
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    })

    it('offers the field guide under Documentation, as a link so a tab can be opened', async () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)

      openHelp('Documentation')
      const guide = await screen.findByRole('link', { name: /Field Guide/ })
      expect(guide.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}tutorial.html`)
      // A button here would lose the graph on the canvas; a link opens a tab.
      expect(guide.tagName).toBe('A')
    })

    it('offers the node guide in the same submenu, as a separate item', async () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)

      openHelp('Documentation')
      const guide = await screen.findByRole('link', { name: /Node Guide/ })
      expect(guide.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}nodes.html`)
      expect(guide.tagName).toBe('A')
    })

    it('offers the overview in the same submenu, ahead of both guides', async () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)

      openHelp('Documentation')
      const overview = await screen.findByRole('link', { name: /Overview/ })
      expect(overview.getAttribute('href')).toBe(`${import.meta.env.BASE_URL}overview.html`)
      expect(overview.tagName).toBe('A')
    })

    /*
     * The shape itself, which is what the four cases above now depend on and none of them
     * states: four rows at the top level, and nothing from either submenu visible until it is
     * opened. Without this, a regression that flattened the menu again would leave all four
     * green (the links would simply be there already) and the reorganisation would be gone
     * with nothing to say so.
     */
    it('keeps the documents behind Documentation until it is opened', () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)

      openHelp()
      expect(screen.queryByRole('link', { name: /Field Guide/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Basics/ })).toBeNull()
      // The parent rows say they lead somewhere, in the accessibility tree and not only in ▸.
      const docs = screen.getByRole('button', { name: /Documentation/ })
      expect(docs.getAttribute('aria-haspopup')).toBe('true')
      expect(docs.getAttribute('aria-expanded')).toBe('false')

      fireEvent.click(docs)
      expect(docs.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByRole('link', { name: /Field Guide/ })).toBeTruthy()
    })

    /* The tours take their short names under a heading that already says "Guides". */
    it('offers both tours under Guides, by their short names', () => {
      act(() => useGraphStore.getState().closeStartPage())
      render(<App />)

      openHelp('Guides')
      expect(screen.getByRole('button', { name: /Basics/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Learn to Build/ })).toBeTruthy()
    })

    it('reopens from the palette, and that command is disabled while it is open', () => {
      const items = () =>
        buildCommandItems({
          store: useGraphStore.getState(),
          fitView: () => {},
          fitSelected: () => {},
        })
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
