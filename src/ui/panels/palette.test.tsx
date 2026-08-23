// @vitest-environment jsdom

/**
 * The command palette, driven through the real store.
 *
 * Covers the two things most likely to break quietly: whether a command's `disabled` flag
 * reflects live state (offering "Undo" with an empty history, or "Run All" with nothing
 * stale), and whether the type-filtered variant only offers nodes that can actually
 * connect.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { getNodeDef } from '../../core/registry'
import { T } from '../../core/types'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import {
  peekExportWarnings,
  requestExportWarnings,
  resetExportWarnings,
} from '../exportWarnings'
import { CommandPalette, parsePaletteQuery } from './CommandPalette'
import type { PaletteItem } from './paletteItems'
import { buildCommandItems, buildNodeItems } from './paletteItems'

beforeAll(() => {
  installJsdomStubs()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetExportWarnings()
  act(() => {
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

function commands(): PaletteItem[] {
  return buildCommandItems({ store: useGraphStore.getState(), fitView: () => {} })
}

function byId(items: PaletteItem[], id: string): PaletteItem {
  const found = items.find((i) => i.id === id)
  if (!found) throw new Error(`no palette item "${id}"`)
  return found
}

describe('buildCommandItems', () => {
  it('offers the commands a fresh graph should have', () => {
    const ids = commands().map((i) => i.id)
    expect(ids).toContain('cmd:run-all')
    expect(ids).toContain('cmd:clear-results')
    expect(ids).toContain('cmd:fit')
    expect(ids).toContain('example:matrix')
  })

  it('disables Undo until there is history, then enables it', () => {
    expect(byId(commands(), 'cmd:undo').disabled).toBe(true)
    act(() => {
      useGraphStore.getState().setParam('filter', 'value', '25')
    })
    expect(byId(commands(), 'cmd:undo').disabled).toBe(false)
  })

  /*
   * The bundled examples all run on a synthetic connectome, so a lit "Export as Jupyter Notebook" on
   * a fresh canvas would be a row that closes the palette and does nothing — and it is the
   * *usual* state rather than an edge case, which is why it is asserted here rather than left
   * to the exporter's own suite.
   */
  it('disables Export as Jupyter Notebook on a synthetic dataset, and says which node', () => {
    const item = byId(commands(), 'cmd:export-notebook')
    expect(item.disabled).toBe(true)
    expect(item.hint).toContain('Optic Lobe (mini)')
    expect(item.hint).toContain('swap in a real dataset')
  })

  it('enables Export as Jupyter Notebook once the dataset is a real one', () => {
    act(() => {
      let graph = emptyGraph('Real')
      graph = addNode(graph, {
        id: 'ds',
        type: 'dataset.hemibrain',
        position: { x: 0, y: 0 },
        params: { version: 'v1.2.1' },
      })
      useGraphStore.getState().loadGraph(graph)
    })
    const item = byId(commands(), 'cmd:export-notebook')
    expect(item.disabled).toBe(false)
    expect(item.hint).toContain('Jupyter notebook')
  })

  /*
   * The second refusal, and it is the one that was missing: the emitters skipped a CAVE family
   * while `canExportNotebook` refused on `synthetic` alone, so the row lit, the dataset cell
   * emitted a TODO and every node after it cascaded to "nothing upstream produced a value".
   *
   * It is now asked **per format**, because the two exporters cover different backends: FlyWire
   * emits caveclient in Python and nothing in R. The two rows disagreeing is the point.
   */
  it('offers the notebook and refuses the R document on a CAVE dataset', () => {
    act(() => {
      let graph = emptyGraph('FlyWire')
      graph = addNode(graph, {
        id: 'ds',
        type: 'dataset.flywire',
        position: { x: 0, y: 0 },
        params: { version: '783' },
      })
      useGraphStore.getState().loadGraph(graph)
    })
    expect(byId(commands(), 'cmd:export-notebook').disabled).toBe(false)

    const rmd = byId(commands(), 'cmd:export-rmd')
    expect(rmd.disabled).toBe(true)
    expect(rmd.hint).toContain('no document can be built for this backend yet')
  })

  /*
   * The softer half of the refusal. A graph that exports *with gaps* is still worth exporting,
   * so the row stays live and the hint says how much is missing — and it is asynchronous by
   * construction, since the only honest way to know is to run the walk.
   */
  it('marks the export rows when part of the graph will be left as TODO', async () => {
    act(() => {
      let g = emptyGraph('half-translatable')
      g = addNode(g, {
        id: 'ds',
        type: 'dataset.hemibrain',
        position: { x: 0, y: 0 },
        params: { version: 'v1.2.1' },
      })
      g = addNode(g, {
        id: 'find',
        type: 'neuron.findNeurons',
        position: { x: 1, y: 0 },
        params: { typePattern: 'LC4' },
      })
      // `Paths` with `Collapse types` on has no equivalent in either language.
      g = addNode(g, {
        id: 'paths',
        type: 'neuron.paths',
        position: { x: 2, y: 0 },
        params: { collapseTypes: true },
      })
      g = addEdge(g, {
        source: 'ds',
        sourceHandle: 'dataset',
        target: 'find',
        targetHandle: 'dataset',
      })
      g = addEdge(g, {
        source: 'ds',
        sourceHandle: 'dataset',
        target: 'paths',
        targetHandle: 'dataset',
      })
      g = addEdge(g, {
        source: 'find',
        sourceHandle: 'neurons',
        target: 'paths',
        targetHandle: 'sources',
      })
      g = addEdge(g, {
        source: 'find',
        sourceHandle: 'neurons',
        target: 'paths',
        targetHandle: 'targets',
      })
      useGraphStore.getState().loadGraph(g)
    })

    const graph = useGraphStore.getState().graph

    /*
     * Warmed first, then forgotten, so what follows is a check on the *peek* rather than on how
     * long a dynamic import takes. Without this the assertion below passes whether or not the
     * peek starts work, because the exporter has not been loaded yet either way.
     */
    requestExportWarnings(graph)
    await waitFor(() => expect(peekExportWarnings(graph, 'python')).toBeTruthy())
    resetExportWarnings()

    /*
     * Nothing is known before the exporter has been *asked*, and the row says nothing rather
     * than guessing. The second half is the load-bearing one: `buildCommandItems` runs on every
     * store change while the palette is open, so its peek must start no work — asking it and
     * then waiting has to leave the cache exactly as empty as it found it.
     */
    expect(byId(commands(), 'cmd:export-notebook').warn).toBeFalsy()
    await new Promise((r) => setTimeout(r, 20))
    expect(peekExportWarnings(graph, 'python')).toBeUndefined()

    requestExportWarnings(graph)
    await waitFor(() => expect(peekExportWarnings(graph, 'python')).toBeTruthy())

    const item = byId(commands(), 'cmd:export-notebook')
    expect(item.disabled).toBeFalsy()
    expect(item.warn).toBe(true)
    expect(item.hint).toBe('1 step will be left as TODO')
  })

  it('disables Export as Jupyter Notebook on an empty canvas', () => {
    act(() => useGraphStore.getState().newGraph())
    expect(byId(commands(), 'cmd:export-notebook').disabled).toBe(true)
  })

  it('disables selection commands with nothing selected', () => {
    const withoutSelection = commands()
    expect(byId(withoutSelection, 'cmd:duplicate').disabled).toBe(true)
    expect(byId(withoutSelection, 'cmd:delete').disabled).toBe(true)
    expect(byId(withoutSelection, 'cmd:run-selected').disabled).toBe(true)

    act(() => {
      useGraphStore.getState().setSelection(['filter'])
    })
    const withSelection = commands()
    expect(byId(withSelection, 'cmd:duplicate').disabled).toBe(false)
    expect(byId(withSelection, 'cmd:run-selected').disabled).toBe(false)
  })

  it('offers no evaluation commands for a selected text note', () => {
    // The example carries notes of its own; select one and the Run/Expand pair must go inert,
    // while the editing commands stay live — a note is an ordinary node to move and delete.
    act(() => useGraphStore.getState().setSelection(['step1']))
    const withNote = commands()
    expect(byId(withNote, 'cmd:run-selected').disabled).toBe(true)
    expect(byId(withNote, 'cmd:run-selected').hint).toMatch(/never evaluated/)
    expect(byId(withNote, 'cmd:expand').disabled).toBe(true)
    expect(byId(withNote, 'cmd:duplicate').disabled).toBe(false)
    expect(byId(withNote, 'cmd:delete').disabled).toBe(false)
  })

  it('disables Run All once nothing is stale', async () => {
    expect(byId(commands(), 'cmd:run-all').disabled).toBe(false)
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    expect(byId(commands(), 'cmd:run-all').disabled).toBe(true)
  })

  it('reflects the current theme by disabling that option', () => {
    act(() => useGraphStore.getState().setTheme('dark'))
    expect(byId(commands(), 'cmd:theme-dark').disabled).toBe(true)
    expect(byId(commands(), 'cmd:theme-light').disabled).toBe(false)
  })

  it('labels Mute/Unmute according to the selected node', () => {
    act(() => useGraphStore.getState().setSelection(['filter']))
    expect(byId(commands(), 'cmd:mute').label).toBe('Mute Selection')
    act(() => useGraphStore.getState().toggleDisabled(['filter']))
    expect(byId(commands(), 'cmd:mute').label).toBe('Unmute Selection')
  })

  it('Clear Results drops the cache and makes everything stale again', async () => {
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    expect(useGraphStore.getState().nodeInfo('view').state).toBe('ok')

    act(() => {
      byId(commands(), 'cmd:clear-results').perform!()
    })

    const store = useGraphStore.getState()
    expect(store.nodeOutput('view', 'out')).toBeUndefined()
    expect(store.nodeInfo('view').state).not.toBe('ok')
  })
})

describe('buildNodeItems', () => {
  it('lists every addable node when unfiltered', () => {
    const items = buildNodeItems()
    expect(items.length).toBeGreaterThanOrEqual(15)
    expect(items.map((i) => i.nodeType)).toContain('core.groupBy')
    expect(items.map((i) => i.nodeType)).toContain('dataset.malecns')
  })

  it('leaves out superseded nodes, which stay registered so old files still load', () => {
    // `neuron.dataset` is `hidden`: deserialising a graph that uses it must keep working, but
    // nobody should be offered it for something new.
    expect(getNodeDef('neuron.dataset')).toBeDefined()
    expect(buildNodeItems().map((i) => i.nodeType)).not.toContain('neuron.dataset')
  })

  it('filters to nodes that accept a dragged output type, with the port to connect', () => {
    const items = buildNodeItems({ type: T.matrix(), from: 'source' })
    const types = items.map((i) => i.nodeType)
    // Normalize and Heatmap take a Matrix; Filter does not.
    expect(types).toContain('core.normalize')
    expect(types).toContain('out.heatmap')
    expect(types).not.toContain('core.filter')
    expect(byId(items, 'node:core.normalize').portId).toBe('in')
  })

  it('filters to nodes that can feed a dragged input type', () => {
    const items = buildNodeItems({ type: T.dataset(), from: 'target' })
    const types = items.map((i) => i.nodeType)
    // Every dataset node outputs a Dataset, and nothing else does.
    expect(types).toContain('dataset.malecns')
    expect(types).toContain('dataset.neuprint')
    expect(types.every((t) => t?.startsWith('dataset.'))).toBe(true)
    expect(byId(items, 'node:dataset.malecns').portId).toBe('dataset')
  })

  it('accepts Neurons where a Table is wanted, since Neurons is a subtype', () => {
    const items = buildNodeItems({ type: T.neurons(), from: 'source' })
    expect(items.map((i) => i.nodeType)).toContain('core.filter')
  })
})

describe('CommandPalette', () => {
  const items: PaletteItem[] = [
    {
      id: 'a',
      action: 'Run',
      label: 'Run All',
      hint: 'Evaluate stale nodes',
      shortcut: '⇧R',
      perform: () => {},
    },
    {
      id: 'b',
      action: 'Run',
      label: 'Clear Results',
      hint: 'Drop cached results',
      perform: () => {},
    },
    {
      id: 'c',
      action: 'Add',
      group: 'Table',
      label: 'Group By',
      hint: 'Collapse rows into groups',
      nodeType: 'core.groupBy',
      portId: 'out',
    },
    { id: 'd', action: 'Run', label: 'Disabled Thing', disabled: true, perform: () => {} },
  ]

  function open(overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
    const onPick = vi.fn()
    const onClose = vi.fn()
    const utils = render(
      <CommandPalette
        items={items}
        screenPosition={{ x: 100, y: 100 }}
        onPick={onPick}
        onClose={onClose}
        {...overrides}
      />,
    )
    return { onPick, onClose, ...utils }
  }

  /** Row text as breadcrumb segments, separators stripped. */
  const rowCrumbs = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="option"]')].map((row) =>
      [...row.querySelectorAll('.add-menu__crumb, .add-menu__name, .add-menu__desc')].map(
        (el) => el.textContent,
      ),
    )

  it('renders rows as action ▶ group ▶ name ▶ description breadcrumbs', () => {
    const { container } = open()
    expect(rowCrumbs(container)).toEqual([
      ['Run', 'Run All', 'Evaluate stale nodes'],
      ['Run', 'Clear Results', 'Drop cached results'],
      ['Add', 'Table', 'Group By', 'Collapse rows into groups'],
      ['Run', 'Disabled Thing'],
    ])
    // The old colour-coded dots are gone.
    expect(container.querySelectorAll('.add-menu__dot')).toHaveLength(0)
  })

  it('emphasises only the name segment', () => {
    const { container } = open()
    const row = container.querySelector('[role="option"]')!
    expect(row.querySelector('.add-menu__name')?.textContent).toBe('Run All')
    // action and description share the muted class with each other, not with the name.
    expect(row.querySelector('.add-menu__crumb')?.textContent).toBe('Run')
    expect(row.querySelector('.add-menu__desc')?.textContent).toBe('Evaluate stale nodes')
  })

  it('shows a separator between every segment', () => {
    const { container } = open()
    const addRow = [...container.querySelectorAll('[role="option"]')][2]!
    // Add ▶ Table ▶ Group By ▶ description = three separators.
    expect(addRow.querySelectorAll('.add-menu__sep')).toHaveLength(3)
  })

  it('finds a row by fuzzy query', () => {
    const { container } = open()
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), {
      target: { value: 'gb' },
    })
    // The label is split into highlighted runs across elements, so assert on the
    // concatenated text — the accessibility-name algorithm inserts spaces at element
    // boundaries and would report "G roup B y".
    expect(container.textContent).toContain('Group By')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
  })

  it('fuzzy-finds a node by initials and returns it on Enter', () => {
    const { onPick } = open()
    const input = screen.getByPlaceholderText(/Search commands/)
    fireEvent.change(input, { target: { value: 'gb' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]![0].id).toBe('c')
  })

  it('highlights the matched characters', () => {
    const { container } = open()
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), {
      target: { value: 'gb' },
    })
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toEqual(['G', 'B'])
  })

  it('skips disabled entries when navigating and refuses to pick them', () => {
    const { onPick } = open()
    const input = screen.getByPlaceholderText(/Search commands/)
    fireEvent.change(input, { target: { value: 'disabled' } })
    // The only match is disabled, so Enter must do nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('moves the selection with arrow keys', () => {
    const { onPick } = open()
    const input = screen.getByPlaceholderText(/Search commands/)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick.mock.calls[0]![0].id).toBe('b')
  })

  it('closes on Escape', () => {
    const { onClose } = open()
    fireEvent.keyDown(screen.getByPlaceholderText(/Search commands/), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('reports no matches instead of an empty list', () => {
    open()
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), {
      target: { value: 'zzzz' },
    })
    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('restricts the list to node insertions when prefilled with "Add:"', () => {
    const { container } = open({ initialQuery: 'Add:' })
    expect((screen.getByPlaceholderText('Search nodes…') as HTMLInputElement).value).toBe(
      'Add:',
    )
    // Only the one Add item survives; the three Run commands are filtered out.
    expect(rowCrumbs(container)).toEqual([
      ['Add', 'Table', 'Group By', 'Collapse rows into groups'],
    ])
  })

  it('fuzzy-matches within an active prefix', () => {
    const { container, onPick } = open({ initialQuery: 'Add:' })
    const input = screen.getByPlaceholderText('Search nodes…')
    fireEvent.change(input, { target: { value: 'Add:group' } })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick.mock.calls[0]![0].id).toBe('c')
  })

  it('is case-insensitive about the prefix and tolerates spacing', () => {
    const a = open({ initialQuery: 'add:' })
    expect(a.container.querySelectorAll('[role="option"]')).toHaveLength(1)
    a.unmount()

    const b = open({ initialQuery: 'ADD: ' })
    expect(b.container.querySelectorAll('[role="option"]')).toHaveLength(1)
  })

  it('widens back to everything when the prefix is deleted', () => {
    const { container } = open({ initialQuery: 'Add:' })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    fireEvent.change(screen.getByPlaceholderText('Search nodes…'), { target: { value: '' } })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(4)
  })

  it('removes the whole prefix on backspace rather than leaving a half-typed filter', () => {
    open({ initialQuery: 'Add:' })
    const input = screen.getByPlaceholderText('Search nodes…') as HTMLInputElement
    input.setSelectionRange(4, 4)
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect((screen.getByPlaceholderText(/Search commands/) as HTMLInputElement).value).toBe('')
  })

  it('filters by other action prefixes too', () => {
    const { container } = open({ initialQuery: 'Run:' })
    expect(rowCrumbs(container).every((crumbs) => crumbs[0] === 'Run')).toBe(true)
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(3)
  })

  it('treats an unknown prefix as ordinary search text', () => {
    const { container } = open({ initialQuery: 'nonsense:' })
    // Not a recognised action, so it is matched literally and finds nothing.
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  it('names the required type when opened from a link drag', () => {
    open({
      filterType: T.matrix(),
      items: buildNodeItems({ type: T.matrix(), from: 'source' }),
    })
    expect(screen.getByPlaceholderText('Search nodes…')).toBeTruthy()
    expect(screen.getByText(/Nodes accepting/)).toBeTruthy()
    expect(screen.getByText('Matrix')).toBeTruthy()
  })

  it('keeps itself on screen when opened near a viewport edge', () => {
    const { container } = open({ screenPosition: { x: 99999, y: 99999 } })
    const panel = container.querySelector('.add-menu') as HTMLElement
    expect(Number.parseFloat(panel.style.left)).toBeLessThan(window.innerWidth)
    expect(Number.parseFloat(panel.style.top)).toBeLessThan(window.innerHeight)
    expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8)
  })
})

describe('breadcrumbs on the real item list', () => {
  /**
   * Renders the actual palette contents and reads back one row as plain text.
   *
   * Searched for rather than taken from the unfiltered list, because the palette caps at
   * `MAX_RESULTS` and the registry keeps growing — four annotation nodes pushed `Filter` past
   * row sixty, which failed a test that is about *breadcrumb formatting* and has nothing to say
   * about how long the list is.
   */
  function rowFor(label: string): string {
    const all = [
      ...buildCommandItems({ store: useGraphStore.getState(), fitView: () => {} }),
      ...buildNodeItems(),
    ]
    render(
      <CommandPalette
        items={all}
        initialQuery={label}
        screenPosition={{ x: 10, y: 10 }}
        onPick={() => {}}
        onClose={() => {}}
      />,
    )
    const row = [...document.querySelectorAll('.add-menu [role="option"]')].find(
      (el) => el.querySelector('.add-menu__name')?.textContent === label,
    )
    if (!row) throw new Error(`no row named "${label}"`)
    return [...row.querySelectorAll('.add-menu__crumb, .add-menu__name, .add-menu__desc')]
      .map((el) => el.textContent)
      .join(' ▶ ')
  }

  it('reads as the requested format for a node', () => {
    expect(rowFor('Filter')).toBe(
      'Add ▶ Transform ▶ Filter ▶ Keep rows matching a condition on one column.',
    )
  })

  it('reads sensibly for a command', () => {
    expect(rowFor('Clear Results')).toBe(
      'Run ▶ Clear Results ▶ Drop every cached result so the next run re-fetches from scratch',
    )
  })

  it('uses the middle segment where it earns its place', () => {
    expect(rowFor('Dark')).toBe('View ▶ Theme ▶ Dark')
    expect(rowFor('Find Neurons')).toBe(
      'Add ▶ Query ▶ Find Neurons ▶ Search a dataset for neurons by type, instance, status, size or ROI.',
    )
  })
})

describe('parsePaletteQuery', () => {
  it('splits a recognised action prefix', () => {
    expect(parsePaletteQuery('Add:filter')).toEqual({ action: 'Add', text: 'filter' })
    expect(parsePaletteQuery('run: all')).toEqual({ action: 'Run', text: 'all' })
    expect(parsePaletteQuery('View:')).toEqual({ action: 'View', text: '' })
  })

  it('leaves unrecognised prefixes alone', () => {
    expect(parsePaletteQuery('foo:bar')).toEqual({ action: undefined, text: 'foo:bar' })
    expect(parsePaletteQuery('filter')).toEqual({ action: undefined, text: 'filter' })
    // A colon mid-word is not a prefix.
    expect(parsePaletteQuery('theme add:')).toEqual({ action: undefined, text: 'theme add:' })
  })
})

describe('palette entry points', () => {
  it('opens on Space and inserts a node on pick', async () => {
    const { App } = await import('../../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    const before = useGraphStore.getState().graph.nodes.length
    fireEvent.keyDown(window, { key: ' ' })

    await waitFor(() => expect(screen.getByPlaceholderText(/Search commands/)).toBeTruthy())

    const input = screen.getByPlaceholderText(/Search commands/)
    fireEvent.change(input, { target: { value: 'normalize' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(useGraphStore.getState().graph.nodes.length).toBe(before + 1)
    expect(useGraphStore.getState().graph.nodes.some((n) => n.type === 'core.normalize')).toBe(
      true,
    )
  })

  it('runs a command picked from the palette', async () => {
    const { App } = await import('../../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    expect(useGraphStore.getState().nodeInfo('view').state).toBe('ok')

    fireEvent.keyDown(window, { key: ' ' })
    const input = await waitFor(() => screen.getByPlaceholderText(/Search commands/))
    fireEvent.change(input, { target: { value: 'clear results' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(useGraphStore.getState().nodeOutput('view', 'out')).toBeUndefined()
  })

  it('Space opens the unfiltered palette, which does include commands', async () => {
    const { App } = await import('../../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    fireEvent.keyDown(window, { key: ' ' })
    const input = await waitFor(() => screen.getByPlaceholderText(/Search commands/))
    expect((input as HTMLInputElement).value).toBe('')
    expect(document.querySelector('.add-menu')?.textContent).toContain('Run All')
  })

  it('reopening resets the search box', async () => {
    const { App } = await import('../../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    fireEvent.keyDown(window, { key: ' ' })
    const first = await waitFor(() => screen.getByPlaceholderText(/Search commands/))
    fireEvent.change(first, { target: { value: 'theme' } })
    fireEvent.keyDown(first, { key: 'Escape' })

    fireEvent.keyDown(window, { key: ' ' })
    const second = await waitFor(() => screen.getByPlaceholderText(/Search commands/))
    expect((second as HTMLInputElement).value).toBe('')
  })

  it('double-clicking the canvas still opens the prefilled palette, not the browser', async () => {
    const { App } = await import('../../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    const pane = document.querySelector('.react-flow__pane')!
    fireEvent.doubleClick(pane, { clientX: 400, clientY: 300 })

    const input = await waitFor(() => screen.getByPlaceholderText('Search nodes…'))
    expect((input as HTMLInputElement).value).toBe('Add:')
    // The compact palette, not the big browser.
    expect(screen.queryByRole('dialog', { name: 'Add a node' })).toBeNull()

    // Every listed row is a node insertion — no commands leaked through.
    const rows = [...document.querySelectorAll('.add-menu [role="option"]')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.querySelector('.add-menu__crumb')?.textContent).toBe('Add')
    }
    expect(document.querySelector('.add-menu')?.textContent).not.toContain('Run All')
  })
})
