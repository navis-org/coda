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

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
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
})
