// @vitest-environment jsdom

/**
 * The Zoo browser.
 *
 * What is pinned here is everything about the surface that is *not* the list: the questions the
 * reader gets asked before their canvas is replaced, what happens when the network is not there,
 * and that a downloaded graph goes through the same lenient loading a file does. The list itself
 * is `fuzzyRank`, which has its own tests.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyGraph, serializeGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { registerBuiltinSources } from '../../data/builtins'
import { resetCache } from '../../data/cache'
import type { ZooEntry } from '../../data/zoo/format'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { resetDocuments } from '../../test/storeReset'
import { ZooBrowser } from './ZooBrowser'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerBuiltinSources({ mockLatencyMs: 0 })
})

beforeEach(() => {
  clearStorage()
  resetCache()
  act(() => resetDocuments())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const RAW = 'https://raw.githubusercontent.com/navis-org/coda-zoo/main'

function graphText(name: string) {
  const graph = emptyGraph(name)
  const types = ['dataset.mock.opticlobe', 'neuron.findNeurons', 'out.table']
  graph.nodes = types.map((type, i) => ({
    id: `n${i}`,
    type,
    position: { x: i * 400, y: 0 },
    params: defaultParams(requireNodeDef(type)),
  }))
  return serializeGraph(graph)
}

function entry(overrides: Partial<ZooEntry> = {}): ZooEntry {
  return {
    slug: 'lc-network',
    name: 'LC circuit network',
    summary: 'Type-level connectivity as a node-link diagram.',
    tags: ['connectivity'],
    authors: [{ name: 'Someone', github: 'someone' }],
    requires: ['mock'],
    graph: 'workflows/lc-network/graph.coda.json',
    readme: 'workflows/lc-network/README.md',
    nodeCount: 3,
    layout: {
      nodes: [
        [0, 0, 'dataset.mock.opticlobe'],
        [400, 0, 'neuron.findNeurons'],
        [800, 0, 'out.table'],
      ],
      edges: [
        [0, 1],
        [1, 2],
      ],
    },
    updatedAt: '2026-08-26T10:00:00Z',
    ...overrides,
  }
}

/** Serve the zoo from a map of repo-relative path → body; anything else 404s. */
function serve(files: Record<string, string>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const body = files[url.replace(`${RAW}/`, '')]
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      statusText: '',
      text: () => Promise.resolve(body ?? ''),
    } as Response)
  })
  return calls
}

function zoo(entries: ZooEntry[] = [entry()], extra: Record<string, string> = {}) {
  return serve({
    'index.json': JSON.stringify({
      version: 1,
      updatedAt: '2026-08-26T10:00:00Z',
      repo: 'navis-org/coda-zoo',
      ref: 'main',
      workflows: entries,
    }),
    'workflows/lc-network/graph.coda.json': graphText('LC circuit network'),
    'workflows/lc-network/README.md': '## What it does\n\nGroups before it builds.',
    ...extra,
  })
}

function open() {
  const onClose = vi.fn()
  return { onClose, ...render(<ZooBrowser onClose={onClose} />) }
}

/**
 * The names in the *list*, which is not the same query as "on screen": the selected entry's name
 * is also the detail panel's heading, so an unscoped `getByText` matches twice on a one-entry
 * zoo and reads as a duplicate-render bug.
 */
function rows(): string[] {
  return [...document.querySelectorAll('.zoo-row__text strong')].map(
    (el) => el.textContent ?? '',
  )
}

const listed = (name: string) => waitFor(() => expect(rows()).toContain(name))

describe('the list', () => {
  it('shows what the index carries', async () => {
    zoo()
    open()
    await listed('LC circuit network')
    expect(screen.getAllByText(/node-link diagram/).length).toBeGreaterThan(0)
  })

  it('says a workflow on the synthetic data needs no token', async () => {
    // The single most useful thing a row can say, and "Requires: mock" says the opposite of it
    // to anybody who does not already know what the mock source is.
    zoo()
    open()
    expect((await screen.findAllByText('Runs with no token')).length).toBeGreaterThan(0)
  })

  it('names the backends a live workflow needs instead', async () => {
    zoo([entry({ requires: ['neuprint', 'mock'] })])
    open()
    expect((await screen.findAllByText('Needs neuPrint')).length).toBeGreaterThan(0)
  })

  it('filters on the search field', async () => {
    zoo([entry(), entry({ slug: 'kc-rois', name: 'Kenyon cells by ROI' })])
    open()
    await listed('LC circuit network')
    fireEvent.change(screen.getByLabelText('Search workflows'), { target: { value: 'kenyon' } })
    await waitFor(() => expect(rows()).toEqual(['Kenyon cells by ROI']))
  })

  it('clears an active tag as soon as somebody types', async () => {
    // The rule the node browser follows, for the same reason: a search must never come up empty
    // because of a chip the reader forgot was on.
    zoo([entry(), entry({ slug: 'kc-rois', name: 'Kenyon cells by ROI', tags: ['rois'] })])
    open()
    await listed('LC circuit network')
    fireEvent.click(screen.getByRole('button', { name: /rois/ }))
    await waitFor(() => expect(rows()).toEqual(['Kenyon cells by ROI']))
    fireEvent.change(screen.getByLabelText('Search workflows'), {
      target: { value: 'circuit' },
    })
    await listed('LC circuit network')
  })
})

describe('the detail panel', () => {
  it('renders the entry README', async () => {
    zoo()
    open()
    expect(await screen.findByText('What it does')).toBeTruthy()
  })

  it('does not render the extended markdown kinds', async () => {
    // A deposited README is third-party text. Fences, tables and images stay off, the same rule
    // a dataset blurb from a Custom node gets — an image in one is a tracking pixel.
    zoo([entry()], {
      'workflows/lc-network/README.md': '![tracker](https://elsewhere.example/pixel.png)',
    })
    const { container } = open()
    await listed('LC circuit network')
    await waitFor(() => expect(container.querySelector('.zoo__readme')).toBeTruthy())
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('opening one', () => {
  it('puts it on an empty canvas without asking', async () => {
    zoo()
    const { onClose } = open()
    await listed('LC circuit network')
    fireEvent.click(screen.getByRole('button', { name: 'Open on the canvas' }))
    await waitFor(() => expect(useGraphStore.getState().graph.nodes).toHaveLength(3))
    expect(onClose).toHaveBeenCalled()
  })

  /*
   * This used to ask "replace the current graph?" and wait. A Zoo workflow now opens in a
   * document of its own, so there is nothing to replace and nothing to ask — the assertion that
   * matters is that the work already on the canvas is still open beside it, which is the whole
   * of what the question was protecting.
   */
  it('opens beside work already there rather than replacing it', async () => {
    zoo()
    act(() => useGraphStore.getState().loadGraph(demoWorkflow('partners')))
    const before = useGraphStore.getState().graph.nodes.length
    const mine = useGraphStore.getState().activeTabId
    open()
    await listed('LC circuit network')

    fireEvent.click(screen.getByRole('button', { name: 'Open on the canvas' }))
    await waitFor(() => expect(useGraphStore.getState().graph.nodes).toHaveLength(3))

    const { tabs, activeTabId, switchDocument } = useGraphStore.getState()
    expect(tabs).toHaveLength(2)
    expect(activeTabId).not.toBe(mine)
    // And the graph it opened over is intact, undo stack and all, one switch away.
    act(() => switchDocument(mine))
    expect(useGraphStore.getState().graph.nodes).toHaveLength(before)
  })

  it('keeps the canvas when the fetch fails, and says why', async () => {
    zoo([entry({ graph: 'workflows/lc-network/missing.json' })])
    open()
    await listed('LC circuit network')
    fireEvent.click(screen.getByRole('button', { name: 'Open on the canvas' }))
    expect(await screen.findByText(/404/)).toBeTruthy()
    expect(useGraphStore.getState().graph.nodes).toHaveLength(0)
  })

  it('loads a graph with an unknown node type, dropping it with a warning', async () => {
    // The same lenient path a file gets. A zoo entry deposited against a node this build no
    // longer has should open with a hole and a notice, not refuse.
    const drifted = JSON.parse(graphText('Drifted')) as { nodes: { type: string }[] }
    drifted.nodes[1]!.type = 'core.thisNeverExisted'
    zoo([entry()], { 'workflows/lc-network/graph.coda.json': JSON.stringify(drifted) })
    open()
    await listed('LC circuit network')
    fireEvent.click(screen.getByRole('button', { name: 'Open on the canvas' }))
    await waitFor(() => expect(useGraphStore.getState().graph.nodes).toHaveLength(2))
    expect(useGraphStore.getState().notice).toMatch(/core.thisNeverExisted/)
  })
})

describe('when the Zoo cannot be reached', () => {
  it('says so, and names the repository', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    open()
    expect(await screen.findByText(/Could not fetch/i)).toBeTruthy()
    expect(screen.getByText('github.com/navis-org/coda-zoo')).toBeTruthy()
  })

  it('leaves the canvas alone', async () => {
    act(() => useGraphStore.getState().loadGraph(demoWorkflow('partners')))
    const before = useGraphStore.getState().graph.nodes.length
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    open()
    await screen.findByText(/Could not fetch/i)
    expect(useGraphStore.getState().graph.nodes).toHaveLength(before)
  })

  it('shows a cached copy and discloses that it is one', async () => {
    zoo()
    const first = open()
    await listed('LC circuit network')
    first.unmount()

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    open()
    await listed('LC circuit network')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText(/Offline — showing a copy/)).toBeTruthy()
  })
})

describe('the empty states', () => {
  it('always says something when the list has no rows', async () => {
    // The guard chain this replaced had a combination that rendered nothing at all: a refresh
    // in flight, over a zoo that is not empty, whose query matches none of it. A blank panel is
    // the one answer a reader cannot act on.
    zoo()
    open()
    await listed('LC circuit network')
    fireEvent.change(screen.getByLabelText('Search workflows'), { target: { value: 'zzzz' } })
    await waitFor(() => expect(rows()).toEqual([]))
    expect(screen.getByText('Nothing matches.')).toBeTruthy()

    // Now with a refresh in flight over that same empty result.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(document.querySelector('.zoo__empty')?.textContent).toBeTruthy()
  })

  it('keeps the rows and moves a failed refresh to the footer', async () => {
    // An error must not take the list away when a previous copy is still in hand — the rows are
    // still the best answer available, and the failure belongs beside the age.
    zoo()
    open()
    await listed('LC circuit network')
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText(/showing the copy from|Offline — showing a copy/)
    expect(rows()).toContain('LC circuit network')
  })
})

describe('an index with a bad entry in it', () => {
  it('lists the rest and reports the count', async () => {
    zoo([entry(), { name: 'no slug' } as unknown as ZooEntry])
    open()
    await listed('LC circuit network')
    expect(screen.getByText('1 entry could not be read')).toBeTruthy()
  })
})
