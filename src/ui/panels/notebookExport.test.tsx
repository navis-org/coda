// @vitest-environment jsdom

/**
 * Export as Jupyter Notebook, driven through the real toolbar.
 *
 * `src/export/python/export.test.ts` covers what comes out; this covers the two things about
 * the *control* that no golden file can see. The refusal is the important half: a graph on a
 * synthetic dataset cannot be exported at all, and a menu item that silently did nothing —
 * or downloaded an empty file — is exactly how somebody concludes the feature is broken.
 * The bundled examples all use a synthetic dataset, so this is the common case rather than
 * an edge one.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installDownloadCapture, installJsdomStubs } from '../../test/jsdomStubs'
import { resetExportWarnings } from '../exportWarnings'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetExportWarnings()
  act(() => useGraphStore.getState().closeStartPage())
})

afterEach(cleanup)

function openSaveMenu(): void {
  // The trigger's own label, chevron included: a prefix match also finds the "Save in this
  // browser" item once the menu is open.
  fireEvent.click(screen.getByRole('button', { name: 'Save ▾' }))
}

/** A graph on a real dataset, so the export is not refused. */
function realGraph() {
  let g = emptyGraph('LC4 partners')
  g = addNode(g, {
    id: 'ds',
    type: 'dataset.hemibrain',
    position: { x: 0, y: 0 },
    params: { version: 'v1.2.1' },
  })
  g = addNode(g, {
    id: 'find',
    type: 'neuron.findNeurons',
    position: { x: 260, y: 0 },
    params: { typePattern: 'LC4' },
  })
  return addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
}

describe('Export as Jupyter Notebook', () => {
  it('downloads an .ipynb for a graph on a real dataset', async () => {
    const capture = installDownloadCapture()
    try {
      render(<App />)
      act(() => useGraphStore.getState().loadGraph(realGraph()))
      openSaveMenu()
      fireEvent.click(await screen.findByText('Export as Jupyter Notebook'))

      await waitFor(() => expect(capture.downloads).toHaveLength(1))
      const [file] = capture.downloads
      expect(file!.filename).toBe('lc4-partners.ipynb')

      const text = await file!.text()
      const notebook = JSON.parse(text) as { nbformat: number; cells: unknown[] }
      expect(notebook.nbformat).toBe(4)
      // Title, setup, and a cell for each of the two nodes.
      expect(notebook.cells.length).toBeGreaterThanOrEqual(4)
      expect(text).toContain('fetch_neurons')
    } finally {
      capture.restore()
    }
  })

  it('refuses a synthetic dataset in the menu, and writes no file', async () => {
    const capture = installDownloadCapture()
    try {
      render(<App />)
      let g = emptyGraph('Mocked')
      g = addNode(g, {
        id: 'm',
        type: 'dataset.mock.hemibrain',
        position: { x: 0, y: 0 },
        params: {},
      })
      act(() => useGraphStore.getState().loadGraph(g))

      openSaveMenu()
      fireEvent.click(await screen.findByText('Export as Jupyter Notebook'))

      // The message has to name what to do about it — "cannot export" alone reads as a bug.
      expect(await screen.findByText(/Replace them with a real dataset node/)).toBeTruthy()
      expect(capture.downloads).toHaveLength(0)
      // And the menu stays open, so the sentence is still there to read.
      expect(screen.queryByText('Download .coda.json')).toBeTruthy()
    } finally {
      capture.restore()
    }
  })

  /*
   * The warning, which is the softer half of the refusal beside it. A graph that exports with
   * gaps in it is still worth exporting — so this says so *on* the item, before the click,
   * rather than replacing the row the way a refusal does.
   *
   * It is asynchronous by construction: the only honest way to know how much of a graph the
   * walk cannot translate is to run the exporter, and the exporter is lazily loaded. So the
   * menu opens without it and the sentence arrives.
   */
  it('warns on the item when part of the graph will be left as TODO', async () => {
    render(<App />)
    // `Paths` with `Collapse types` on has no notebook equivalent — Cypher cannot walk a
    // derived graph — so its cell is a TODO on a graph that otherwise exports perfectly well.
    let g = realGraph()
    g = addNode(g, {
      id: 'paths',
      type: 'neuron.paths',
      position: { x: 520, y: 0 },
      params: { collapseTypes: true },
    })
    for (const [handle, port] of [
      ['dataset', 'dataset'],
      ['neurons', 'sources'],
      ['neurons', 'targets'],
    ] as const) {
      g = addEdge(g, {
        source: handle === 'dataset' ? 'ds' : 'find',
        sourceHandle: handle,
        target: 'paths',
        targetHandle: port,
      })
    }
    act(() => useGraphStore.getState().loadGraph(g))

    openSaveMenu()
    // One per format, because the two exporters answer separately — `Paths` with collapse on
    // has no equivalent in either, so here they agree.
    const warnings = await screen.findAllByText(/will be left as TODO comments/)
    expect(warnings).toHaveLength(2)
    for (const warning of warnings) {
      // Named, and honest about what is left: the export is still worth making.
      expect(warning.textContent).toContain('Paths')
      expect(warning.textContent).toContain('The rest of the graph exports normally')
    }
    // On the item rather than in place of it — the row still works.
    expect(screen.queryByText('Export as Jupyter Notebook')).toBeTruthy()
  })

  it('says nothing about a graph that exports whole', async () => {
    render(<App />)
    act(() => useGraphStore.getState().loadGraph(realGraph()))
    openSaveMenu()
    await screen.findByText('Export as Jupyter Notebook')
    // The answer lands a tick later, so waiting on the item alone would pass either way.
    await waitFor(() => expect(screen.queryByText(/left as TODO/)).toBeNull())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(/left as TODO/)).toBeNull()
  })
})
