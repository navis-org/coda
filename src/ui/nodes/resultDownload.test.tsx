// @vitest-environment jsdom

/**
 * The ⤓ in a node card's foot.
 *
 * Downloading a node's result used to mean wiring a Download node beside it, which is a fine
 * answer for a repeatable pipeline and a poor one for "let me have that table" — a download is
 * a verb people look for on the thing. So every card whose result can be written to a file
 * carries one, driven by the same `planExport` the Download node uses so the two cannot
 * disagree about what a value supports or what the file is called.
 *
 * Two properties are worth pinning beyond "it appears". It must **not** appear on a card that
 * is already drawing a viewer, which has its own ⤓ an inch above and a better one — it can
 * offer the picture. And it must be absent before a run rather than present and broken: a
 * button that writes nothing is worse than no button, and `formatsFor(undefined)` is what makes
 * that true by construction.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import {
  clearStorage,
  installDownloadCapture,
  installJsdomStubs,
} from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    // Both halves of this feature's subject in one graph: `net.build`, which has no viewer and
    // is the reason the button exists, and `out.network`, which has one and must not grow a
    // second.
    useGraphStore.getState().loadExample('network')
  })
})

afterEach(cleanup)

function nodeIdOfType(type: string): string {
  const found = useGraphStore.getState().graph.nodes.find((n) => n.type === type)
  if (!found) throw new Error(`no ${type} in the example`)
  return found.id
}

async function cardFor(nodeId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const card = document
      .querySelector(`.react-flow__node[data-id="${nodeId}"]`)
      ?.querySelector('.coda-node')
    if (!card) throw new Error(`no card for ${nodeId}`)
    return card as HTMLElement
  })
}

const footDownload = (card: HTMLElement) =>
  card.querySelector('.coda-node__footer .download-button')

async function runGraph() {
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
}

describe('the card foot download', () => {
  it('is absent until the node has a result', async () => {
    render(<App />)
    const card = await cardFor(nodeIdOfType('net.build'))
    // `formatsFor(undefined)` is empty, so this is a property of the rule rather than a guard
    // somebody has to remember to write.
    expect(footDownload(card)).toBeNull()
  })

  it('appears on a card with no viewer once it has one', async () => {
    render(<App />)
    await runGraph()
    const card = await cardFor(nodeIdOfType('net.build'))
    await waitFor(() => expect(footDownload(card)).not.toBeNull())
  })

  it('stays off a viewer card, which already carries a better one', async () => {
    render(<App />)
    await runGraph()
    const card = await cardFor(nodeIdOfType('out.network'))
    // The preview's own ⤓ can export the picture as SVG and PNG; a second one in the foot
    // would offer strictly less, an inch below.
    expect(footDownload(card)).toBeNull()
    await waitFor(() => {
      expect(card.querySelector('.coda-node__preview .download-button')).not.toBeNull()
    })
  })

  it('offers exactly what planExport can write for a network', async () => {
    render(<App />)
    await runGraph()
    const card = await cardFor(nodeIdOfType('net.build'))
    await waitFor(() => expect(footDownload(card)).not.toBeNull())

    fireEvent.click(footDownload(card)!.querySelector('button')!)
    const rows = [...card.querySelectorAll('.viewer-actions__item')].map((r) =>
      r.textContent?.trim(),
    )
    expect(rows).toEqual(['CSV data.csv', 'GraphML graph.graphml', 'JSON data.json'])
  })

  it('writes GraphML that names the node and parses', async () => {
    const capture = installDownloadCapture()
    try {
      render(<App />)
      await runGraph()
      const card = await cardFor(nodeIdOfType('net.build'))
      await waitFor(() => expect(footDownload(card)).not.toBeNull())

      fireEvent.click(footDownload(card)!.querySelector('button')!)
      const graphml = [...card.querySelectorAll('.viewer-actions__item')].find((r) =>
        r.textContent?.includes('GraphML'),
      )
      fireEvent.click(graphml!)

      await waitFor(() => expect(capture.downloads).toHaveLength(1))
      const file = capture.downloads[0]!
      // Named after the node, like every other download here — `exportBaseName`.
      expect(file.filename).toMatch(/\.graphml$/)
      expect(file.blob.type).toBe('application/graphml+xml')

      const doc = new DOMParser().parseFromString(await file.text(), 'application/xml')
      expect(doc.querySelector('parsererror')).toBeNull()
      expect(doc.documentElement.tagName).toBe('graphml')
      // A real connectome-shaped graph, not an empty document.
      expect(doc.querySelectorAll('node').length).toBeGreaterThan(1)
      expect(doc.querySelectorAll('edge').length).toBeGreaterThan(0)
      // The roll-ups Build Network derives travel with their types.
      const keys = [...doc.querySelectorAll('key')].map((k) => k.getAttribute('attr.name'))
      expect(keys).toContain('weightOut')
    } finally {
      capture.restore()
    }
  })

  it('reaches a dataset card too, which is the one rule biting rather than an oversight', async () => {
    /*
     * `formatsFor` never comes back empty for a real value — JSON is the universal fallback —
     * so "any node whose result is downloadable" means every node with a result, dataset
     * handles included. Recorded rather than special-cased: the file is a small, valid and
     * meaningful one (it names the *resolved* version, which is the provenance question an
     * unpinned "Latest" leaves open), so this is a control that delivers rather than one that
     * promises something it cannot.
     *
     * The alternative is a one-line narrowing to `defaultFormat(value) !== 'json'`. If the ⤓
     * on nine dataset cards ever reads as noise, that is the change, and this test is where it
     * would be inverted.
     */
    render(<App />)
    await runGraph()
    const card = await cardFor(nodeIdOfType('dataset.mock.opticlobe'))
    await waitFor(() => expect(footDownload(card)).not.toBeNull())

    fireEvent.click(footDownload(card)!.querySelector('button')!)
    // One format, so there is no menu at all — the button writes directly.
    expect(card.querySelectorAll('.viewer-actions__item')).toHaveLength(0)
    expect(footDownload(card)!.querySelector('button')?.getAttribute('title')).toBe(
      'Download JSON data',
    )
  })

  it('writes both CSVs from one press, as the Download node does', async () => {
    const capture = installDownloadCapture()
    try {
      render(<App />)
      await runGraph()
      const card = await cardFor(nodeIdOfType('net.build'))
      await waitFor(() => expect(footDownload(card)).not.toBeNull())

      fireEvent.click(footDownload(card)!.querySelector('button')!)
      fireEvent.click(card.querySelector('.viewer-actions__item')!)

      await waitFor(() => expect(capture.downloads).toHaveLength(2))
      expect(capture.downloads.map((d) => d.filename)).toEqual([
        expect.stringMatching(/-nodes\.csv$/),
        expect.stringMatching(/-links\.csv$/),
      ])
    } finally {
      capture.restore()
    }
  })
})
