// @vitest-environment jsdom

/**
 * Runtime smoke test: mounts the real App, with the real store, node pack and mock
 * source, and drives it the way a user would.
 *
 * Unit tests cover the engine; this covers the wiring — hook order, module init order,
 * selector subscriptions, and whether pressing Run actually puts numbers on screen. Those
 * are the failures a headless engine suite cannot see.
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

import { App } from '../App'
import { isAnnotation } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import { useGraphStore } from '../store/graphStore'
import { demoWorkflow } from '../wizard/build'
import { clearStorage, installJsdomStubs } from '../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 360, height: 220 })
  // Zero-latency source so Run resolves promptly under test.
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // Auto-run is on by default and is an opt-out of the hybrid model two cases below are about,
    // so it is pinned off here rather than left to whatever the module singleton was built with.
    // `autoRun.test.tsx` is where the default itself is pinned.
    useGraphStore.setState({ autoRun: false })
    // Past the guides dialog, the launch sequence's first stage — what a *returning* visitor
    // opens on is the welcome page, and that is what the case below is about. The first-visit
    // ordering is `guides.test.tsx`'s.
    useGraphStore.setState({ guidesOpen: false })
    // The start page opens over everything on a fresh visit, which is its whole job — but it
    // would sit in front of every assertion below. One test opens it deliberately instead.
    useGraphStore.getState().closeStartPage()
    // Start from a known graph rather than whatever the previous test left behind.
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(cleanup)

describe('App', () => {
  it('mounts and renders the shell', () => {
    render(<App />)
    expect(screen.getByText('Coda')).toBeTruthy()
    expect(screen.getByTitle(/Graph name/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run all stale nodes' })).toBeTruthy()
  })

  it('puts the start page over the editor when it has not been dismissed', () => {
    act(() => {
      useGraphStore.getState().openStartPage()
    })
    render(<App />)

    // The real mount, not the component in isolation: the welcome page is what the launch
    // sequence lands on, and it is among the last children of the app for exactly that reason.
    const dialog = screen.getByRole('dialog')
    // By accessible name, not text: the heading renders as "C", the mark, "da", and the
    // dialog takes its own name from it.
    expect(within(dialog).getByRole('heading', { name: 'Coda' })).toBeTruthy()
    expect(within(dialog).getByRole('checkbox', { name: /Don’t show again/ })).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the loaded example graph as nodes with typed sockets', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Find Neurons')).toBeTruthy()
    })
    expect(screen.getByText('Connectivity')).toBeTruthy()
    expect(screen.getByText('Group By')).toBeTruthy()

    // Sockets advertise their inferred type in the tooltip. Both ends of the
    // FindNeurons → Connectivity link report the same resolved schema, which is exactly
    // what edit-time propagation is supposed to achieve.
    const sockets = screen.getAllByTitle(/Neurons: Neurons\{neuronId, type, instance/)
    expect(sockets.length).toBeGreaterThanOrEqual(2)
  })

  it('populates column pickers from the upstream schema', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Group By')).toBeTruthy())

    /*
     * Group By's pickers should list connectivity's columns, which only exist because the query
     * node declared them statically. Two pickers rather than one, because they are filtered by
     * what they can accept — `value` aggregates and so offers the numeric columns, `by` groups
     * and offers the categorical ones — so a single dropdown holding both would be the wrong
     * assertion to make.
     *
     * `hidden: true` because React Flow marks nodes `visibility: hidden` until it has measured
     * them, which it cannot do in jsdom.
     */
    const selects = screen.getAllByRole('combobox', { hidden: true })
    const optionSets = selects.map((s) =>
      within(s)
        .queryAllByRole('option', { hidden: true })
        .map((o) => (o as HTMLOptionElement).value),
    )
    expect(optionSets.some((opts) => opts.includes('weight'))).toBe(true)
    expect(optionSets.some((opts) => opts.includes('postType'))).toBe(true)
  })

  it('defers expensive nodes until Run, then produces results', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    // Auto-evaluation runs the cheap Dataset node but leaves the queries stale.
    await waitFor(() => {
      expect(useGraphStore.getState().nodeInfo('ds').state).toBe('ok')
    })
    expect(useGraphStore.getState().nodeInfo('find').state).toBe('stale')

    const runButton = screen.getByRole('button', { name: 'Run all stale nodes' })
    await act(async () => {
      fireEvent.click(runButton)
    })

    await waitFor(() => {
      const store = useGraphStore.getState()
      expect(store.nodeInfo('find').state).toBe('ok')
      expect(store.nodeInfo('view').state).toBe('ok')
    })

    // A real answer reached the table viewer inside the output node.
    await waitFor(() => {
      expect(screen.getAllByText('DNp02').length).toBeGreaterThan(0)
    })
    expect(screen.getByText(/up to date/)).toBeTruthy()
  })

  it('re-runs cheap nodes live when a threshold changes, without re-querying', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    const rowsBefore = tableLength('sort')
    expect(rowsBefore).toBeGreaterThan(2)

    /*
     * Cap the ranked table; the query stays cached and only the cheap tail recomputes. A cheap
     * node's param, deliberately: that is the whole distinction being tested, and the generated
     * workflow puts its weight threshold on the *expensive* Connectivity node, where the server
     * applies it rather than the browser.
     */
    await act(async () => {
      useGraphStore.getState().setParam('sort', 'limit', 2)
    })
    await waitFor(() => {
      expect(useGraphStore.getState().nodeInfo('sort').state).toBe('ok')
    })

    expect(useGraphStore.getState().nodeInfo('find').state).toBe('ok')
    expect(tableLength('sort')).toBeLessThan(rowsBefore)
  })

  it('shows an error on the node when a param is invalid', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    await act(async () => {
      useGraphStore.getState().setParam('find', 'typePattern', '[bad')
    })

    await waitFor(() => {
      expect(screen.getByText(/Invalid regex for "type"/)).toBeTruthy()
    })
  })

  it('rejects a type-incompatible link and says why', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    act(() => {
      const ok = useGraphStore.getState().connect({
        source: 'ds',
        sourceHandle: 'dataset',
        target: 'group',
        targetHandle: 'in',
      })
      expect(ok).toBe(false)
    })

    await waitFor(() => {
      expect(screen.getByText(/does not fit/)).toBeTruthy()
    })
  })

  it('undoes a param change and restores the cached result for free', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    await act(async () => {
      await useGraphStore.getState().runAll()
    })

    act(() => {
      useGraphStore.getState().setParam('find', 'typePattern', 'T4.*')
    })
    expect(useGraphStore.getState().nodeInfo('find').state).toBe('stale')

    act(() => {
      useGraphStore.getState().undo()
    })
    // Provenance-keyed cache: reverting revalidates the old entry with no re-query.
    expect(useGraphStore.getState().nodeInfo('find').state).toBe('ok')
  })

  it('gives each node a Run button, enabled only when it would do work', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    const runButtons = screen.getAllByRole('button', { name: 'Run this node', hidden: true })
    // Every node that computes something — the example's text notes are not evaluated and draw
    // no header, so they have no button to offer.
    const computing = useGraphStore.getState().graph.nodes.filter((n) => !isAnnotation(n.type))
    expect(runButtons.length).toBe(computing.length)

    // Stale nodes offer a live button.
    await waitFor(() => {
      expect(useGraphStore.getState().nodeInfo('find').state).toBe('stale')
    })
    expect(runButtons.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true)

    // Once everything is up to date, every per-node button goes inert — a node whose
    // provenance key is current has nothing to recompute.
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    await waitFor(() => {
      const after = screen.getAllByRole('button', { name: 'Run this node', hidden: true })
      expect(after.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    })
  })

  it('runs only the clicked node and its inputs', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    // The Connectivity node's button should pull the dataset + query, but leave the
    // downstream table alone.
    const connectivityNode = screen
      .getByText('Connectivity')
      .closest('.coda-node') as HTMLElement
    const runButton = within(connectivityNode).getByRole('button', {
      name: 'Run this node',
      hidden: true,
    })

    await act(async () => {
      fireEvent.click(runButton)
    })

    await waitFor(() => {
      expect(useGraphStore.getState().nodeInfo('conn').state).toBe('ok')
    })
    const store = useGraphStore.getState()
    expect(store.nodeInfo('find').state).toBe('ok')
    expect(store.nodeInfo('view').state).not.toBe('ok')
  })

  it('switches examples and rebuilds the graph', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())

    await act(async () => {
      useGraphStore.getState().loadGraph(demoWorkflow('matrix'))
    })

    await waitFor(() => expect(screen.getByText('Adjacency')).toBeTruthy())
    expect(screen.getByText('Heatmap')).toBeTruthy()
    expect(screen.queryByText('Connectivity')).toBeNull()
  })
})

/** Row count of a node's first output, for assertions about filtering. */
function tableLength(nodeId: string): number {
  const store = useGraphStore.getState()
  const value = store.nodeOutput(nodeId, 'out')
  if (!value || (value.kind !== 'table' && value.kind !== 'neurons')) {
    throw new Error(`${nodeId} has no table output`)
  }
  return value.length
}
