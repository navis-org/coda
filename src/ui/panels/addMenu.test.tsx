// @vitest-environment jsdom

/**
 * The canvas's add menu: the **+**, the category rail it opens, and the band of nodes a
 * category opens.
 *
 * Four things here are worth pinning. The rail is **derived** from `nodeDefsByCategory`, so a
 * category or a node added later appears with no edit — the same property `NodeThumbnail` has,
 * and the reason neither carries a hand-written list. A closed surface is **unmounted** rather
 * than hidden, which is what makes these queries mean anything: jsdom computes no styles, so a
 * `visibility: hidden` rail would be findable here and invisible in a browser. Dismissal has
 * two routes and only one of them adds a node. And the lock reaches all of it.
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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import type { NodeDefinition } from '../../core/node'
import { nodeDefsByCategory } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { rowCapacity, snakeRows } from './AddMenu'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    // Its capture-phase Escape swallows the key before the menu's own handler sees it — the
    // launch sequence is a modal over the canvas, so in the app the menu is not reachable
    // underneath it at all. jsdom hit-tests nothing, which is what makes this a test-only trap.
    useGraphStore.getState().closeStartPage()
    // The menu's own state lives on the store now (`setAddMenu`), so unlike component state it
    // outlives a render: a case that leaves a band open hands the next one a canvas with 16
    // extra buttons on it, and `getByText` starts finding two of things.
    useGraphStore.getState().setAddMenu(false)
  })
})

afterEach(cleanup)

const fab = () => screen.getByRole('button', { name: 'Add a node' }) as HTMLButtonElement
const rail = () => document.querySelector('.fab-menu__rail')
const band = () => document.querySelector('.fab-menu__band')

async function ready() {
  render(<App />)
  await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
}

/** Open the rail and then one category. */
async function openCategory(label: string) {
  fireEvent.click(fab())
  fireEvent.click(await screen.findByRole('button', { name: label }))
  return await waitFor(() => {
    const el = band()
    if (!el) throw new Error('no band')
    return el as HTMLElement
  })
}

/*
 * The band's shape is arithmetic, and jsdom lays nothing out — every element there is 0px wide —
 * so the rows are pinned here rather than through the DOM. What the rendering test below can
 * still say is the half that matters for anyone who is not looking at the screen: the DOM order
 * is the alphabetical list whatever the drawing does.
 */
describe('the band snakes', () => {
  const defs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `n${i}` }) as never as NodeDefinition)

  it('draws the bottom row right-to-left and alternates upward', () => {
    const rows = snakeRows(defs(7), 3)
    expect(rows.map((r) => r.reverse)).toEqual([true, false, true])
    expect(rows.map((r) => r.from)).toEqual([0, 3, 6])
  })

  it('gives a partial last row the direction its index says, not the one that looks tidy', () => {
    // Row 1 ran left-to-right and ended at the right edge, so the single leftover above it
    // starts there and runs back — `justify-content` in a `row-reverse` packs it to the right.
    expect(snakeRows(defs(7), 3).at(-1)).toMatchObject({ reverse: true, from: 6 })
  })

  it('keeps the list in order, so the DOM order is never the drawing order', () => {
    const rows = snakeRows(defs(5), 2)
    expect(rows.flatMap((r) => r.defs.map((d) => d.label))).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
    ])
  })

  it('never asks for a row of no buttons, so an unmeasured band still draws', () => {
    expect(rowCapacity(0)).toBe(1)
    expect(rowCapacity(78)).toBe(1)
    // 78 + 4 gap + 78.
    expect(rowCapacity(160)).toBe(2)
  })
})

describe('the add menu', () => {
  it('opens onto the browser and every category, bottom to top', async () => {
    await ready()
    expect(rail()).toBeNull()

    fireEvent.click(fab())
    const buttons = await waitFor(() => {
      const el = rail()
      if (!el) throw new Error('no rail')
      return Array.from(el.children)
    })
    // DOM order is bottom-to-top: the rail is `column-reverse`, so the first child is the one
    // nearest the +. Derived from the registry, hence the six category names rather than a
    // literal list — a seventh category appears here on its own.
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Browse all nodes',
      'Utility nodes',
      'Dataset nodes',
      'Query nodes',
      'Transform nodes',
      'Analysis nodes',
      'Visualisation nodes',
    ])
  })

  it('shows every node in the category it was asked for', async () => {
    await ready()
    const transforms = nodeDefsByCategory().find((g) => g.category === 'transform')!
    const panel = await openCategory('Transform nodes')

    const names = within(panel)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(names).toEqual(transforms.defs.map((d) => d.label))
    // Every one draws something: `glyphShapes` falls back to the category, so a node added
    // later is never a blank circle here.
    for (const button of within(panel).getAllByRole('button')) {
      expect(button.querySelector('svg')?.children.length).toBeGreaterThan(0)
    }
  })

  it('adds the node it was clicked on and closes both surfaces', async () => {
    await ready()
    const before = useGraphStore.getState().graph.nodes.length
    const panel = await openCategory('Analysis nodes')

    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Normalize' }))
    })

    const store = useGraphStore.getState()
    expect(store.graph.nodes.length).toBe(before + 1)
    expect(store.graph.nodes.some((n) => n.type === 'core.normalize')).toBe(true)
    await waitFor(() => expect(band()).toBeNull())
    expect(rail()).toBeNull()
  })

  it('a pointer on the canvas closes it and adds nothing', async () => {
    await ready()
    const before = useGraphStore.getState().graph.nodes.length
    await openCategory('Query nodes')

    fireEvent.pointerDown(document.querySelector('.react-flow__pane') ?? document.body)

    await waitFor(() => expect(rail()).toBeNull())
    expect(band()).toBeNull()
    expect(useGraphStore.getState().graph.nodes.length).toBe(before)
  })

  it('Escape closes it', async () => {
    await ready()
    await openCategory('Query nodes')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(rail()).toBeNull())
  })

  it('the + toggles, and a second press on a category closes its band', async () => {
    await ready()
    const panel = await openCategory('Analysis nodes')
    expect(panel).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Analysis nodes' }))
    await waitFor(() => expect(band()).toBeNull())
    // The rail stays: closing a category is not closing the menu.
    expect(rail()).toBeTruthy()

    fireEvent.click(fab())
    await waitFor(() => expect(rail()).toBeNull())
  })

  /*
   * The reason the nudge's withholding is a store flag rather than a `:has()` rule in the menu's
   * own stylesheet: jsdom computes no styles, so the CSS version of this was untestable, and the
   * decision belonged to the component that already makes it for the start page.
   */
  it('stands the feedback nudge down, which parks in the corner it opens into', async () => {
    await ready()
    expect(useGraphStore.getState().addMenuOpen).toBe(false)

    fireEvent.click(fab())
    await waitFor(() => expect(useGraphStore.getState().addMenuOpen).toBe(true))

    fireEvent.click(fab())
    await waitFor(() => expect(useGraphStore.getState().addMenuOpen).toBe(false))
  })

  /**
   * The alignment measures a *rail button*, and nothing else may answer to that description.
   *
   * jsdom lays nothing out, so the offset itself cannot be checked here — but the way it broke
   * had nothing to do with arithmetic. The band gained a category attribute of its own for the
   * tour, `querySelector` answers in document order, and the band is written before the stack:
   * the measurement started resolving the band and lined it up against itself. A wrong number,
   * no error, and the only symptom is a band that sits somewhere else. So what is pinned is the
   * property that failed — one element per category answers `[data-cat]`, and it is a button.
   */
  it('leaves the rail button the only thing a category lookup can find', async () => {
    await ready()
    await openCategory('Query nodes')

    const tagged = [...document.querySelectorAll('.fab-menu [data-cat]')]
    expect(tagged.length).toBeGreaterThan(0)
    for (const element of tagged) {
      expect(element.classList.contains('fab-menu__cat'), element.outerHTML.slice(0, 80)).toBe(
        true,
      )
    }
    // The band says which category it shows under a name of its own, which is what the tour
    // reads — see `bandFor` in `tour/build.ts`.
    expect(band()?.getAttribute('data-band')).toBe('query')
  })

  it('the lock disables the + and closes whatever is open', async () => {
    await ready()
    await openCategory('Query nodes')

    act(() => {
      useGraphStore.setState({ locked: true })
    })

    await waitFor(() => expect(rail()).toBeNull())
    expect(band()).toBeNull()
    expect(fab().disabled).toBe(true)
  })
})
