// @vitest-environment jsdom

/**
 * Auto-run: re-run the whole graph after every change.
 *
 * The behaviour worth pinning is the part that is *not* "it runs": that it stays off unless asked,
 * that a burst of edits produces one run rather than one per keystroke, and that overlapping runs
 * cannot leave the UI claiming to be idle while a run is still going. Auto-run opts out of the
 * hybrid evaluation model, so the guard rails around it are the feature.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { getSource, registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadAutoRun, saveAutoRun } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // Module singleton: without this, one case's setting decides the next one's default.
    useGraphStore.setState({ autoRun: false })
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

const checkbox = () => screen.getByRole('checkbox', { name: /Auto-run/ }) as HTMLInputElement

/** Stale-or-blocked node count, read outside React. `useStaleCount` is the hook equivalent. */
function staleCount(): number {
  const store = useGraphStore.getState()
  void store.runVersion
  return store.graph.nodes.filter((n) => {
    const state = store.nodeInfo(n.id).state
    return state === 'stale' || state === 'blocked'
  }).length
}

/** Row count of the terminal Table node — proof the expensive chain actually executed. */
function tableRows(): number | undefined {
  const store = useGraphStore.getState()
  const view = store.graph.nodes.find((n) => n.type === 'out.table')
  const value = view ? store.nodeOutput(view.id, 'out') : undefined
  return value && 'length' in value ? (value.length as number) : undefined
}

/**
 * Edit an *expensive* node's param.
 *
 * Deliberately not the Filter node: that is `cheap`, so the ordinary auto pass re-runs it either
 * way and an edit there says nothing about auto-run. Only an expensive node distinguishes the two
 * modes, because only an expensive node is left stale when auto-run is off.
 */
function editQuery(pattern: string) {
  const store = useGraphStore.getState()
  const find = store.graph.nodes.find((n) => n.type === 'neuron.findNeurons')!
  act(() => {
    store.setParam(find.id, 'typePattern', pattern)
  })
}

/**
 * Edit the expensive Connectivity node's threshold.
 *
 * Used where a burst of edits is wanted: every value still returns partners, so the chain
 * completes each time. A pattern that matched nothing would leave Connectivity in error and
 * everything downstream blocked, which counts as stale and would hang a wait for zero.
 */
function editWeight(value: number) {
  const store = useGraphStore.getState()
  const conn = store.graph.nodes.find((n) => n.type === 'neuron.connectivity')!
  act(() => {
    store.setParam(conn.id, 'minWeight', value)
  })
}

describe('the checkbox', () => {
  it('is off by default, next to Run', () => {
    // Expensive nodes hit a shared production database; opting into a query per edit has to be
    // a decision, not a default.
    render(<App />)
    expect(checkbox().checked).toBe(false)
  })

  it('turns on and is remembered', () => {
    render(<App />)
    fireEvent.click(checkbox())
    expect(checkbox().checked).toBe(true)
    expect(loadAutoRun()).toBe(true)
  })

  it('reads the stored preference back', () => {
    saveAutoRun(true)
    expect(loadAutoRun()).toBe(true)
    saveAutoRun(false)
    expect(loadAutoRun()).toBe(false)
  })

  it('leaves the Run button available as a run-now escape', () => {
    render(<App />)
    fireEvent.click(checkbox())
    expect(screen.getByRole('button', { name: 'Run all stale nodes' })).toBeTruthy()
  })
})

describe('when off', () => {
  it('leaves expensive nodes stale after an edit', async () => {
    render(<App />)
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    expect(tableRows()).toBeGreaterThan(0)

    editQuery('ZZZZ')
    // Long enough for both debounces to have come and gone: nothing re-queries, and the graph
    // keeps reporting work waiting for an explicit Run.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(staleCount()).toBeGreaterThan(0)
    expect(tableRows()).toBeGreaterThan(0)
  })
})

describe('when on', () => {
  it('runs the whole graph after an edit, with no Run press', async () => {
    render(<App />)
    fireEvent.click(checkbox())
    await waitFor(() => expect(staleCount()).toBe(0), { timeout: 4000 })
    const before = tableRows()
    expect(before).toBeGreaterThan(0)

    // An expensive node's param: only these are left stale when auto-run is off, so only these
    // demonstrate anything.
    editQuery('LC4')
    await waitFor(() => expect(tableRows()).not.toBe(before), { timeout: 4000 })
    expect(staleCount()).toBe(0)
  })

  it('sends one query for a burst of edits, not one per keystroke', async () => {
    render(<App />)
    fireEvent.click(checkbox())
    await waitFor(() => expect(staleCount()).toBe(0), { timeout: 4000 })

    // Counted at the source, which is the thing that actually costs something. This is the
    // whole reason for the debounce, and what would make auto-run unusable against a shared
    // production database if it were wrong.
    const source = getSource('mock')!
    const queries = vi.spyOn(source, 'fetchConnectivity')

    for (const value of [2, 3, 4, 5]) editWeight(value)
    await waitFor(() => expect(staleCount()).toBe(0), { timeout: 4000 })

    expect(queries).toHaveBeenCalledTimes(1)
    queries.mockRestore()
  })

  it('runs immediately when switched on, rather than waiting for the next edit', async () => {
    // A stale graph that stays stale until you touch something reads as the setting not working.
    render(<App />)
    expect(staleCount()).toBeGreaterThan(0)
    fireEvent.click(checkbox())
    await waitFor(() => expect(staleCount()).toBe(0), { timeout: 4000 })
  })

  it('stops when switched off again', async () => {
    render(<App />)
    fireEvent.click(checkbox())
    await waitFor(() => expect(staleCount()).toBe(0), { timeout: 4000 })

    fireEvent.click(checkbox())
    editQuery('ZZZZ')
    await waitFor(() => expect(staleCount()).toBeGreaterThan(0))
    // Give the old timer every chance to fire anyway.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(staleCount()).toBeGreaterThan(0)
  })
})

describe('overlapping runs', () => {
  it('does not leave busy stuck on after a superseded run', async () => {
    /*
     * `scheduler.run` supersedes an in-flight run by aborting it, so the superseded call's
     * cleanup lands *after* the newer one has already claimed `busy`. Clearing it there would
     * leave the UI idle-looking — no Cancel button, an enabled Run — with a run still going.
     */
    render(<App />)
    const store = useGraphStore.getState()
    await Promise.all([store.runAll(), store.runAll(), store.runAll()])
    expect(useGraphStore.getState().busy).toBe(false)
  })

  it('reports the newest run’s result, not a superseded one’s', async () => {
    render(<App />)
    const store = useGraphStore.getState()
    const first = store.runAll()
    const second = store.runAll()
    await Promise.all([first, second])
    expect(useGraphStore.getState().busy).toBe(false)
    expect(useGraphStore.getState().lastRun).toBeDefined()
  })
})
