// @vitest-environment jsdom

/**
 * The add-node browser.
 *
 * Two things here are easy to get subtly wrong and are pinned down: the chip/search
 * exclusivity rule (whose whole purpose is that a search can never come up empty because
 * of a forgotten filter), and that thumbnails are derived from node metadata rather than
 * hand-maintained — the latter is what stops future nodes shipping with a blank preview.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import {
  allNodeDefs,
  listableNodeDefs,
  nodeDefsByCategory,
  requireNodeDef,
} from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { NodeBrowser } from './NodeBrowser'
import { NodeThumbnail } from './NodeThumbnail'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

function open() {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const utils = render(<NodeBrowser onPick={onPick} onClose={onClose} />)
  return { onPick, onClose, ...utils }
}

/**
 * The node the browser lists last: bottom of the last category in registry order.
 *
 * Derived rather than named, because two tests here are about the *ends* of the list and a
 * literal turns "someone added a utility node" into a failure that reads as a layout bug.
 */
const lastListedDef = () => {
  const groups = nodeDefsByCategory()
  return groups[groups.length - 1]!.defs.at(-1)!
}

/** The nodes the browser lists under one chip, in the order it lists them. */
const defsIn = (category: string) =>
  nodeDefsByCategory().find((g) => g.category === category)?.defs ?? []

const rowNames = () =>
  [...document.querySelectorAll('.node-row')].map(
    (row) => row.querySelector('.node-row__name')?.textContent,
  )

describe('NodeBrowser layout', () => {
  it('lists every addable node, grouped in registry order', () => {
    open()
    // `listableNodeDefs`, not `allNodeDefs`: a superseded type stays registered so old files
    // load, and must not be offered here. The gap between the two is the whole point.
    expect(rowNames()).toHaveLength(listableNodeDefs().length)
    expect(allNodeDefs().length).toBeGreaterThan(listableNodeDefs().length)
    // Dataset first, utility last — the registry's category order. Both ends are derived
    // rather than named, so adding a node to either category is not a failing test.
    expect(rowNames()[0]).toBe('Custom neuPrint')
    expect(lastListedDef().category).toBe('utility')
    expect(rowNames().at(-1)).toBe(lastListedDef().label)
  })

  it('shows a search box, category chips with counts, and a footer', () => {
    open()
    expect(screen.getByLabelText('Search nodes')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /All/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Transform/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Visualisation/ })).toBeTruthy()
    expect(screen.getByText(`${listableNodeDefs().length} nodes`)).toBeTruthy()
  })

  it('gives every row a thumbnail', () => {
    const { container } = open()
    const rows = container.querySelectorAll('.node-row')
    expect(rows).toHaveLength(listableNodeDefs().length)
    for (const row of rows) {
      expect(row.querySelector('svg.node-thumb')).toBeTruthy()
    }
  })

  it('shows each node port signature and category', () => {
    const { container } = open()
    const filterRow = [...container.querySelectorAll('.node-row')].find(
      (r) => r.querySelector('.node-row__name')?.textContent === 'Filter',
    )!
    expect(filterRow.querySelector('.node-row__signature')?.textContent).toBe('Table → Table')
    expect(filterRow.querySelector('.node-row__category')?.textContent).toContain('Transform')

    const adjacencyRow = [...container.querySelectorAll('.node-row')].find(
      (r) => r.querySelector('.node-row__name')?.textContent === 'Adjacency',
    )!
    expect(adjacencyRow.querySelector('.node-row__signature')?.textContent).toBe(
      'Dataset + Neurons + Neurons → Matrix',
    )
    // Expensive nodes advertise that they wait for Run.
    expect(adjacencyRow.querySelector('.node-row__cost')?.textContent).toBe('needs run')
  })

  it('marks cheap nodes without a needs-run badge', () => {
    const { container } = open()
    const sortRow = [...container.querySelectorAll('.node-row')].find(
      (r) => r.querySelector('.node-row__name')?.textContent === 'Sort',
    )!
    expect(sortRow.querySelector('.node-row__cost')).toBeNull()
  })
})

describe('NodeBrowser filtering', () => {
  it('narrows to one category when a chip is picked', () => {
    open()
    fireEvent.click(screen.getByRole('tab', { name: /Visualisation/ }))
    expect(rowNames().sort()).toEqual([
      '3D View',
      'Bar Chart',
      'Dataset Summary',
      'Heatmap',
      'Network',
      'Neuroglancer',
      'Profile',
      'ROIs',
      'Scatter Plot',
      'Table',
    ])
    expect(screen.getByText('10 nodes')).toBeTruthy()
  })

  it('fuzzy-searches across every category, best match first', () => {
    open()
    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'gb' } })
    // Other rows can match too — "gb" is a subsequence of several descriptions — but the
    // initials of a node name must win.
    expect(rowNames()[0]).toBe('Group By')
  })

  it('searches descriptions as well as names', () => {
    open()
    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'synapse' } })
    expect(rowNames().length).toBeGreaterThan(0)
    expect(rowNames()).toContain('Adjacency')
  })

  it('typing clears the active chip, so a search never dead-ends behind a filter', () => {
    open()
    fireEvent.click(screen.getByRole('tab', { name: /Transform/ }))
    expect(rowNames()).not.toContain('Heatmap')

    // Heatmap is not in Transform; the chip must give way rather than show nothing.
    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'heat' } })
    expect(rowNames()[0]).toBe('Heatmap')
    expect(screen.getByRole('tab', { name: /All/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('picking a chip clears the query, the other half of the same rule', () => {
    open()
    const input = screen.getByLabelText('Search nodes') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'heat' } })
    expect(rowNames()[0]).toBe('Heatmap')

    fireEvent.click(screen.getByRole('tab', { name: /Query/ }))
    expect(input.value).toBe('')
    // Exactly the Query category and nothing else. Counted from the registry rather than
    // written down: the assertion is that the chip filters to one category, and a literal
    // turns "somebody added a query node" into a failure that reads as a filtering bug.
    expect(rowNames()).toHaveLength(defsIn('query').length)
    expect(rowNames()).toEqual(defsIn('query').map((d) => d.label))
    expect(rowNames()).toContain('Cypher')
    expect(rowNames()).toContain('Explore')
    expect(rowNames()).toContain('IDs from Label')
  })

  it('reports no matches rather than an empty list', () => {
    open()
    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'zzzz' } })
    expect(rowNames()).toEqual([])
    expect(screen.getByText(/No nodes match/)).toBeTruthy()
  })

  it('highlights the matched characters in the name', () => {
    const { container } = open()
    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'gb' } })
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['G', 'B'])
  })
})

describe('NodeBrowser selection', () => {
  it('picks a node on click', () => {
    const { onPick, container } = open()
    const heatmap = [...container.querySelectorAll('.node-row')].find(
      (r) => r.querySelector('.node-row__name')?.textContent === 'Heatmap',
    )!
    fireEvent.click(heatmap)
    expect(onPick).toHaveBeenCalledWith('out.heatmap')
  })

  it('navigates with arrows and picks with Enter', () => {
    const { onPick } = open()
    const input = screen.getByLabelText('Search nodes')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Second row in registry order: the Dataset category, alphabetically after Custom neuPrint.
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]![0]).toBe(requireNodeDef('dataset.description').type)
  })

  it('wraps around at the ends', () => {
    const { onPick } = open()
    const input = screen.getByLabelText('Search nodes')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Wrapped to the last row of the last category, whichever node that currently is.
    expect(onPick.mock.calls[0]![0]).toBe(lastListedDef().type)
  })

  it('resets the highlight when the result set changes', () => {
    open()
    const input = screen.getByLabelText('Search nodes')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.change(input, { target: { value: 'table' } })
    const selected = [...document.querySelectorAll('.node-row')].findIndex(
      (r) => r.getAttribute('aria-selected') === 'true',
    )
    expect(selected).toBe(0)
  })

  it('closes on Escape, the close button, and a backdrop click', () => {
    const first = open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first.onClose).toHaveBeenCalled()
    cleanup()

    const second = open()
    fireEvent.click(screen.getByLabelText('Close node browser'))
    expect(second.onClose).toHaveBeenCalled()
    cleanup()

    const third = open()
    fireEvent.pointerDown(document.querySelector('.overlay')!)
    expect(third.onClose).toHaveBeenCalled()
  })

  it('does not close when clicking inside the panel', () => {
    const { onClose } = open()
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Add a node' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('NodeThumbnail', () => {
  it('draws one dot per port, using the socket colour and shape grammar', () => {
    const { container } = render(<NodeThumbnail def={requireNodeDef('neuron.adjacency')} />)
    // 3 inputs (Dataset square, 2× Neurons circle) + 1 output (Matrix diamond).
    const dots = [...container.querySelectorAll('circle, rect')].filter((el) => {
      const fill = el.getAttribute('fill') ?? ''
      const stroke = el.getAttribute('stroke') ?? ''
      return fill.includes('--socket-') || stroke.includes('--socket-')
    })
    expect(dots).toHaveLength(4)
    const colours = dots.map((d) => d.getAttribute('fill') ?? d.getAttribute('stroke'))
    expect(colours).toContain('var(--socket-dataset)')
    expect(colours).toContain('var(--socket-table)')
    expect(colours).toContain('var(--socket-matrix)')
  })

  it('tints the header by category', () => {
    const { container } = render(<NodeThumbnail def={requireNodeDef('core.filter')} />)
    expect(container.querySelector('path[fill="var(--cat-transform)"]')).toBeTruthy()
  })

  it('describes itself for assistive tech', () => {
    render(<NodeThumbnail def={requireNodeDef('core.join')} />)
    expect(screen.getByLabelText('Join: 2 inputs, 1 output')).toBeTruthy()
  })

  it('renders for every registered node, so no node ships without a preview', () => {
    // This is the point of deriving thumbnails from metadata: adding a node cannot leave a
    // blank row behind, and no per-node artwork is required.
    for (const def of allNodeDefs()) {
      const { container, unmount } = render(<NodeThumbnail def={def} />)
      const svg = container.querySelector('svg.node-thumb')
      expect(svg, def.type).toBeTruthy()
      // A glyph group is always present, from the per-node map or the category fallback.
      expect(svg!.querySelector('.node-thumb__glyph')?.children.length, def.type).toBeGreaterThan(0)
      unmount()
    }
  })
})

describe('browser entry points', () => {
  it('Tab opens the browser rather than the palette', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    fireEvent.keyDown(window, { key: 'Tab' })
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add a node' })).toBeTruthy())
    expect(screen.queryByPlaceholderText(/Search commands/)).toBeNull()
  })

  it('⇧A opens the browser too', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'A', shiftKey: true })
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add a node' })).toBeTruthy())
  })

  it('the + Add button opens the browser', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Browse nodes (Tab)'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add a node' })).toBeTruthy())
  })

  it('inserts the picked node into the graph', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    const before = useGraphStore.getState().graph.nodes.length

    fireEvent.keyDown(window, { key: 'Tab' })
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Add a node' }))
    fireEvent.change(within(dialog).getByLabelText('Search nodes'), {
      target: { value: 'normalize' },
    })
    await act(async () => {
      fireEvent.keyDown(within(dialog).getByLabelText('Search nodes'), { key: 'Enter' })
    })

    const store = useGraphStore.getState()
    expect(store.graph.nodes.length).toBe(before + 1)
    expect(store.graph.nodes.some((n) => n.type === 'core.normalize')).toBe(true)
    // Closes after inserting.
    expect(screen.queryByRole('dialog', { name: 'Add a node' })).toBeNull()
  })

  it('is reachable from the command palette', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    fireEvent.keyDown(window, { key: ' ' })
    const input = await waitFor(() => screen.getByPlaceholderText(/Search commands/))
    fireEvent.change(input, { target: { value: 'browse' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Add a node' })).toBeTruthy())
  })
})
