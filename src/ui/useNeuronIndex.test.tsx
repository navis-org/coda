// @vitest-environment jsdom
/**
 * The shared neuron-index hook.
 *
 * `data/neuronIndex.ts` already deduplicates the download; what this file is about is the layer
 * above it, which used to live inside Explore's body and is now shared by every widget that
 * wants a dataset's index. The three cases below are the three things that were wrong while the
 * state was per-component, and each of them is invisible until a *second* consumer exists —
 * which is exactly what the Dataset Summary is.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import { makeTable } from '../core/values'
import type { TableValue } from '../core/values'
import { resetCache } from '../data/cache'
import { MockSource } from '../data/mock/MockSource'
import { resetIndexLoads } from '../data/neuronIndex'
import type { DataSource } from '../data/source'
import { registerSource } from '../data/source'
import { installJsdomStubs } from '../test/jsdomStubs'
import { resetNeuronIndexState, useNeuronIndex } from './useNeuronIndex'

const DATASET = 'hemibrain-mini'

const TABLE: TableValue = makeTable(
  tableSchema(column('bodyId', 'i64'), column('type', 'str')),
  { bodyId: [1, 2], type: ['LC4', 'LC6'] },
  'neurons',
)

let calls = 0
let resolveIndex: ((table: TableValue) => void) | undefined

/** A source whose index load can be held open, so "in flight" is observable. */
function slowSource(): DataSource {
  const base: DataSource = new MockSource({ latencyMs: 0 })
  return Object.assign(Object.create(base) as DataSource, {
    id: 'mock-slow',
    neuronIndex: () => {
      calls++
      return new Promise<TableValue>((resolve) => {
        resolveIndex = resolve
      })
    },
  })
}

beforeAll(() => {
  installJsdomStubs({ width: 400, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
  registerSource(slowSource())
})

afterEach(cleanup)

beforeEach(() => {
  resetCache()
  resetIndexLoads()
  resetNeuronIndexState()
  calls = 0
  resolveIndex = undefined
})

function Consumer({ label, sourceId = 'mock-slow' }: { label: string; sourceId?: string }) {
  const { state } = useNeuronIndex(sourceId, DATASET)
  return (
    <div data-testid={label}>
      {state.status === 'ready' ? `${state.table.length} rows` : state.status}
    </div>
  )
}

describe('useNeuronIndex', () => {
  it('loads once for two widgets on the same dataset', async () => {
    render(
      <>
        <Consumer label="a" />
        <Consumer label="b" />
      </>,
    )
    await waitFor(() => expect(calls).toBe(1))

    resolveIndex?.(TABLE)
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('2 rows'))
    // Both, from one load — the whole point. Per-component state gave each its own request and
    // its own spinner over data the other already had.
    expect(screen.getByTestId('b').textContent).toBe('2 rows')
    expect(calls).toBe(1)
  })

  it('gives a widget mounted after the load a table on its first paint', async () => {
    render(<Consumer label="a" />)
    await waitFor(() => expect(calls).toBe(1))
    resolveIndex?.(TABLE)
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('2 rows'))

    // No spinner flash. The state is in the module, so the newcomer's very first render reads
    // `ready` — where per-component state set `loading` before awaiting a call that resolves
    // from memory, and painted a spinner over a table it already had.
    cleanup()
    render(<Consumer label="late" />)
    expect(screen.getByTestId('late').textContent).toBe('2 rows')
    expect(calls).toBe(1)
  })

  it('does not start a second load when one widget unmounts and another arrives', async () => {
    /*
     * Nothing is aborted on unmount, deliberately. With shared state an AbortController torn
     * down by the first widget would cancel the fetch the second is still waiting for — the
     * same trap the Profile widget's paging documents. And there is nothing to save: the result
     * is cached, so a download finishing after the last widget has gone is kept rather than
     * wasted.
     */
    const first = render(<Consumer label="a" />)
    await waitFor(() => expect(calls).toBe(1))
    first.unmount()

    render(<Consumer label="b" />)
    resolveIndex?.(TABLE)
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('2 rows'))
    expect(calls).toBe(1)
  })

  it('keeps datasets apart', async () => {
    function Other() {
      const { state } = useNeuronIndex('mock', DATASET)
      return <div data-testid="other">{state.status}</div>
    }
    render(
      <>
        <Consumer label="a" />
        <Other />
      </>,
    )
    // Two sources, two entries: the slow one is still waiting while the mock has answered.
    await waitFor(() => expect(screen.getByTestId('other').textContent).toBe('ready'))
    expect(screen.getByTestId('a').textContent).toBe('loading')
  })

  it('reports a source that cannot list a dataset, rather than hanging', async () => {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id: 'mock-no-index',
        neuronIndex: undefined,
      }),
    )
    render(<Consumer label="a" sourceId="mock-no-index" />)
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('error'))
  })

  it('answers "none" with no dataset, without allocating a fresh snapshot', () => {
    // `useSyncExternalStore` compares snapshots by identity, so a new object per call is an
    // infinite render loop rather than a wasted allocation — invariant 7.
    const seen: unknown[] = []
    function Unwired() {
      const { state } = useNeuronIndex(undefined, undefined)
      seen.push(state)
      return <div data-testid="unwired">{state.status}</div>
    }
    const view = render(<Unwired />)
    view.rerender(<Unwired />)
    expect(screen.getByTestId('unwired').textContent).toBe('none')
    expect(new Set(seen).size).toBe(1)
  })
})

describe('reload', () => {
  it('re-downloads for every widget, not only the one it was pressed on', async () => {
    function WithReload({ label }: { label: string }) {
      const { state, reload } = useNeuronIndex('mock-slow', DATASET)
      return (
        <div>
          <div data-testid={label}>
            {state.status === 'ready' ? `${state.table.length} rows` : state.status}
          </div>
          <button type="button" onClick={reload}>
            reload {label}
          </button>
        </div>
      )
    }

    render(
      <>
        <WithReload label="a" />
        <WithReload label="b" />
      </>,
    )
    await waitFor(() => expect(calls).toBe(1))
    resolveIndex?.(TABLE)
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('2 rows'))

    fireEvent.click(screen.getByRole('button', { name: 'reload a' }))
    // Both go back to loading: two widgets on one dataset showing different data is worse than
    // not offering a reload at all.
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('loading'))
    expect(screen.getByTestId('a').textContent).toBe('loading')
    expect(calls).toBe(2)
  })

  it('asks the source to ignore its cache', async () => {
    const refreshes: Array<boolean | undefined> = []
    const base: DataSource = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id: 'mock-refresh',
        neuronIndex: (req: { refresh?: boolean }) => {
          refreshes.push(req.refresh)
          return Promise.resolve(TABLE)
        },
      }),
    )

    function WithReload() {
      const { state, reload } = useNeuronIndex('mock-refresh', DATASET)
      return (
        <button type="button" onClick={reload}>
          {state.status}
        </button>
      )
    }
    render(<WithReload />)
    await waitFor(() => expect(refreshes).toEqual([false]))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(refreshes).toEqual([false, true]))
  })
})

describe('the loading note', () => {
  it('carries the source phase through to every subscriber', async () => {
    const base: DataSource = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id: 'mock-progress',
        neuronIndex: (req: { onProgress?: (f: number, note?: string) => void }) => {
          req.onProgress?.(0.1, 'downloading index')
          return new Promise<TableValue>(() => {})
        },
      }),
    )
    function Noted() {
      const { state } = useNeuronIndex('mock-progress', DATASET)
      return <div data-testid="note">{state.status === 'loading' ? state.note : ''}</div>
    }
    render(<Noted />)
    // One download, so one note — not one per card.
    await waitFor(() =>
      expect(screen.getByTestId('note').textContent).toBe('downloading index'),
    )
  })
})
