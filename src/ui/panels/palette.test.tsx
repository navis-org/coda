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
import { GEOMETRY_KINDS, T } from '../../core/types'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { isAnnotation } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import {
  peekExportWarnings,
  requestExportWarnings,
  resetExportWarnings,
} from '../exportWarnings'
import { CommandPalette, parsePaletteQuery } from './CommandPalette'
import type { PaletteItem } from './paletteItems'
import { buildCommandItems, buildNodeItems } from './paletteItems'
import { searchFor } from '../../test/findNeurons'

beforeAll(() => {
  installJsdomStubs()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetExportWarnings()
  act(() => {
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(cleanup)

function commands(): PaletteItem[] {
  return buildCommandItems({
    store: useGraphStore.getState(),
    fitView: () => {},
    fitSelected: () => {},
  })
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
    // The two ways to get a workflow that is not a file: generate one, or fetch one.
    expect(ids).toContain('wizard:open')
    expect(ids).toContain('zoo:browse')
  })

  it('disables Undo until there is history, then enables it', () => {
    expect(byId(commands(), 'cmd:undo').disabled).toBe(true)
    act(() => {
      useGraphStore.getState().setParam('sort', 'limit', 25)
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
    expect(item.hint).toContain('Demo Data')
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
        params: searchFor({ type: 'LC4' }),
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
      useGraphStore.getState().setSelection(['sort'])
    })
    const withSelection = commands()
    expect(byId(withSelection, 'cmd:duplicate').disabled).toBe(false)
    expect(byId(withSelection, 'cmd:run-selected').disabled).toBe(false)
  })

  it('offers no evaluation commands for a selected text note', () => {
    /*
     * A generated workflow carries notes of its own; select one and the Run/Expand pair must go
     * inert, while the editing commands stay live — a note is an ordinary node to move and
     * delete. Found by *being* an annotation rather than by its id: note ids come from the note
     * array's index, a detail of how the wizard stacks them, and naming one here would make this
     * case select a node that does not exist the day a note is added — quietly, since most of
     * these assertions also hold for an empty selection.
     */
    const note = useGraphStore.getState().graph.nodes.find((n) => isAnnotation(n.type))!
    act(() => useGraphStore.getState().setSelection([note.id]))
    const withNote = commands()
    expect(byId(withNote, 'cmd:run-selected').disabled).toBe(true)
    expect(byId(withNote, 'cmd:run-selected').hint).toMatch(/never evaluated/)
    expect(byId(withNote, 'cmd:expand').disabled).toBe(true)
    expect(byId(withNote, 'cmd:duplicate').disabled).toBe(false)
    expect(byId(withNote, 'cmd:delete').disabled).toBe(false)
  })

  /*
   * The pin row and the `P` key describe one gesture, and the badge is the promise that they
   * agree. `P` toggles against the *selected* node, so with one node docked and another selected
   * it moves the dock — a row reading "Unpin" and badging `P` there would advertise the opposite.
   * The same rule `cmd:fit` follows by moving its badge between two rows.
   */
  it('keeps the pin row saying what P would do, and badges it only when P would do it', () => {
    act(() => useGraphStore.getState().pinNode(undefined))
    act(() => useGraphStore.getState().setSelection(['view']))
    expect(byId(commands(), 'cmd:pin').label).toMatch(/^Pin/)
    expect(byId(commands(), 'cmd:pin').shortcut).toBeTruthy()

    // Docked and still selected: the key unpins, so the row does too.
    act(() => useGraphStore.getState().pinNode('view'))
    expect(byId(commands(), 'cmd:pin').label).toMatch(/^Unpin/)

    // Docked, a *different* node selected: the key moves the dock, so the row offers the move.
    act(() => useGraphStore.getState().setSelection(['table']))
    expect(byId(commands(), 'cmd:pin').label).toMatch(/^Pin/)
    expect(byId(commands(), 'cmd:pin').disabled).toBe(false)

    // Nothing selected: the key is inert, so the row keeps the unpin and drops the badge.
    act(() => useGraphStore.getState().setSelection([]))
    expect(byId(commands(), 'cmd:pin').label).toMatch(/^Unpin/)
    expect(byId(commands(), 'cmd:pin').disabled).toBe(false)
    expect(byId(commands(), 'cmd:pin').shortcut).toBeUndefined()
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
    act(() => useGraphStore.getState().setSelection(['sort']))
    expect(byId(commands(), 'cmd:mute').label).toBe('Mute Selection')
    act(() => useGraphStore.getState().toggleDisabled(['sort']))
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
    expect(types).not.toContain('core.filterTable')
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
    expect(items.map((i) => i.nodeType)).toContain('core.filterTable')
  })

  /*
   * The reported case, which is what `PortDef.kinds` was added for.
   *
   * Dropping a `Tree` wire on empty canvas opened on `Mirror Neurons`, then `Select One`,
   * `Split Neurons`, `Stack Neurons` and `Transform Neurons` — five ports declared `T.any()` to
   * stand in for a union `CodaType` cannot spell, every one of which its own `validate` would
   * have refused the moment the wire landed — with `Cut Tree` and `Dendrogram`, the only two
   * nodes in the registry that take a linkage, sixth and seventh.
   */
  it('drops the passthroughs a Linkage cannot actually feed, and leads with the two that take one', () => {
    const types = buildNodeItems({ type: T.linkage(), from: 'source' }).map((i) => i.nodeType)
    expect(types.slice(0, 2)).toEqual(['cluster.cut', 'out.dendrogram'])
    expect(types).not.toContain('neuron.mirror')
    expect(types).not.toContain('neuron.stack')
    expect(types).not.toContain('core.selectOne')
    // Download is the one port that really does take anything, and it is offered last.
    expect(types.at(-1)).toBe('out.download')
  })

  /*
   * The narrowing a named union type could not have expressed, and the reason `Geometries` is a
   * label rather than a `CodaType`: `Split Neurons` takes skeletons and meshes and refuses
   * points, because a points collection's attribute rows are synapses. It still *draws* as
   * Geometries — see `socketStyle.test.ts` — and it is still absent here.
   */
  it('honours a set narrower than the family it draws as', () => {
    const points = buildNodeItems({ type: T.points(), from: 'source' }).map((i) => i.nodeType)
    expect(points).toContain('neuron.mirror')
    expect(points).not.toContain('neuron.splitNeurons')

    const skeletons = buildNodeItems({ type: T.skeletons(), from: 'source' }).map(
      (i) => i.nodeType,
    )
    expect(skeletons).toContain('neuron.splitNeurons')
  })

  /*
   * Order, with nothing removed: exact kind, then a widening `isAssignable` allows, then a named
   * union, then a bare `any`. Asserted as an ordering over one drag rather than as four rows,
   * because the rows move whenever a node is registered and the *relation* is the rule.
   */
  it('ranks an exact port above a widened one, a union above a bare any', () => {
    const types = buildNodeItems({ type: T.skeletons(), from: 'source' }).map((i) => i.nodeType)
    const at = (type: string) => {
      const index = types.indexOf(type)
      expect(index, type).toBeGreaterThanOrEqual(0)
      return index
    }
    // `Clean Skeletons` takes Skeletons; `Mirror` takes the family; `Download` takes anything.
    expect(at('neuron.cleanSkeletons')).toBeLessThan(at('neuron.mirror'))
    expect(at('neuron.mirror')).toBeLessThan(at('out.download'))
  })

  /*
   * A required port before an optional one, which is the key that stopped a neuron table opening
   * on eight dataset cards: every dataset has an optional `annotations` socket taking a table,
   * and `dataset` sorts first in the registry. Wiring one is a real thing to do and stays
   * offered — it is just not what somebody dragging a neuron table usually means.
   */
  it('puts a node built for the wire above one that merely has an optional socket for it', () => {
    const types = buildNodeItems({ type: T.neurons(), from: 'source' }).map((i) => i.nodeType)
    expect(types.indexOf('core.filterTable')).toBeLessThan(types.indexOf('dataset.flywire'))
    expect(types).toContain('dataset.flywire')
  })

  /*
   * Backwards out of a port typed `any`. `dragPortSocket` reports the declaration on an input,
   * so
   * without the set this asked "what produces anything?" and answered with every producer in the
   * registry — for a socket that takes three kinds.
   */
  it('reads a declared set on the dragged end too, not only on the candidate', () => {
    const types = buildNodeItems({
      type: T.any(),
      kinds: GEOMETRY_KINDS,
      from: 'target',
    }).map((i) => i.nodeType)
    expect(types).toContain('neuron.skeletons')
    expect(types).toContain('neuron.meshes')
    expect(types).not.toContain('neuron.findNeurons')
    expect(types).not.toContain('core.filterTable')
  })

  /*
   * Best rather than first. `find` handed back whichever port was declared earliest, so a node
   * with an exact socket after a widened one was wired to the wrong half of itself.
   */
  it("picks the node's best port rather than its first", () => {
    const items = buildNodeItems({ type: T.neurons(), from: 'source' })
    // `Connectivity` has a Dataset, then `neurons`, then an optional `labels` table.
    expect(byId(items, 'node:neuron.connectivity').portId).toBe('neurons')
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
      filterSocket: { type: T.matrix() },
      items: buildNodeItems({ type: T.matrix(), from: 'source' }),
    })
    expect(screen.getByPlaceholderText('Search nodes…')).toBeTruthy()
    expect(screen.getByText(/Nodes accepting/)).toBeTruthy()
    expect(screen.getByText('Matrix')).toBeTruthy()
  })

  /*
   * The header names the *socket*, and this case is why the prop is one.
   *
   * Dragging backwards out of a geometry port reports `any` — the port is typed `T.any()` for a
   * union `CodaType` cannot spell — so a header built from the type alone read "Nodes accepting
   * Any" over a list narrowed to six rows. It also stands where a rename went silent once: the
   * prop was `filterType` and `Editor` began passing `filterSocket`, which a conditional JSX
   * spread lets past `tsc` and which this suite could not see, because it called the component
   * directly with the old name.
   */
  it('names the declared set, not the `any` a geometry port is typed as', () => {
    open({
      filterSocket: { type: T.any(), kinds: GEOMETRY_KINDS },
      items: buildNodeItems({ type: T.any(), kinds: GEOMETRY_KINDS, from: 'target' }),
    })
    expect(screen.getByText('Geometries')).toBeTruthy()
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
      ...buildCommandItems({
        store: useGraphStore.getState(),
        fitView: () => {},
        fitSelected: () => {},
      }),
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
    expect(rowFor('Filter Table')).toBe(
      'Add ▶ Transform ▶ Filter Table ▶ Keep rows matching a condition on one column.',
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
      'Add ▶ Query ▶ Find Neurons ▶ Search a dataset for neurons, by any field the dataset publishes.',
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
