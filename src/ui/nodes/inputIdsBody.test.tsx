// @vitest-environment jsdom

/**
 * The Input IDs card, in the real editor.
 *
 * Two things here fail silently, which is what this file is for. The readout is *derived* from
 * the node's own output rather than reported by the run, so nothing throws if it never appears —
 * the card just looks like a node with no opinion about ids that do not exist. And a custom body
 * replaces the generic param rows outright, so a control this body forgets exists only in the
 * inspector, which on screen is indistinguishable from one that was never added.
 *
 * The assertion worth reading twice is the one about the **Dataset being unwired**: with nothing
 * to check the ids against, every id "matches" by construction, and a card reporting that would
 * be stating a fact about nothing.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

const DATASET = mockDatasetIds()[0]!

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
})

afterEach(cleanup)

function node(id: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    position: { x: id === 'ds' ? 0 : 320, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  }
}

function graphWith(params: Record<string, unknown>, withDataset: boolean): CodaGraph {
  let g = emptyGraph('ids')
  g = addNode(g, node('ids', 'neuron.inputIds', params))
  if (withDataset) {
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'ids', targetHandle: 'dataset' })
  }
  return g
}

async function open(params: Record<string, unknown> = {}, withDataset = true) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, withDataset))
  })
  return await waitFor(() => {
    const body = document.querySelector('.list-body')
    if (!body) throw new Error('no Input IDs body rendered')
    return body as HTMLElement
  })
}

async function run() {
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
}

/** Real ids from the mock connectome, so a lookup has something to find. */
async function realIds(count: number): Promise<number[]> {
  const table = await new MockSource({ latencyMs: 0 }).findNeurons({ datasetId: DATASET })
  return (table.data['bodyId'] ?? []).slice(0, count).map(Number)
}

describe('Input IDs card', () => {
  it('renders every non-advanced param exactly once', async () => {
    const body = await open()
    // The generic card would have shown these two; a body owns the whole area, so it has to
    // show the same set in declaration order rather than a chosen few.
    const labels = [...body.querySelectorAll('.param__label')].map((el) => el.textContent)
    expect(labels).toEqual(['IDs', 'ID column'])
  })

  it('asks for ids rather than claiming a result when nothing is typed', async () => {
    const body = await open()
    expect(body.textContent).toContain('No IDs yet')
  })

  it('counts the ids it collected before anything has run', async () => {
    // Derived from the params, so it is right immediately — the count is not a result.
    const body = await open({ ids: '1234, 5678, 1234' })
    // Deduplicated: a neuron listed twice is one neuron.
    await waitFor(() => expect(body.textContent).toContain('2 IDs'))
  })

  it('reports the neurons found and says nothing about misses', async () => {
    const ids = await realIds(2)
    const body = await open({ ids: ids.join(', ') })
    await run()
    await waitFor(() => expect(body.textContent).toMatch(/2 neurons/))
    expect(body.querySelector('.list-body__missing')).toBeNull()
  })

  it('names the ids the dataset does not have', async () => {
    const ids = await realIds(1)
    const body = await open({ ids: `${ids[0]}, 99999998, 99999999` })
    await run()
    await waitFor(() => expect(body.querySelector('.list-body__missing')).toBeTruthy())
    const missing = body.querySelector('.list-body__missing')!
    expect(missing.textContent).toContain('99999998')
    expect(missing.textContent).toContain('99999999')
    // The full list is in the title, because the visible text is capped on a card.
    expect(missing.getAttribute('title')).toBe('Not in this dataset: 99999998, 99999999')
  })

  it('claims nothing about misses with no Dataset wired', async () => {
    // Nothing checked these ids against anything, so every one of them "matched" by
    // construction. Reporting that would be a fact about nothing.
    const body = await open({ ids: '99999998, 99999999' }, false)
    await run()
    await waitFor(() => expect(body.textContent).toMatch(/2 neurons/))
    expect(body.querySelector('.list-body__missing')).toBeNull()
  })

  it('shows the refusal where the text that caused it is', async () => {
    // Also on the node's badge, but the field is two inches above this line, which is where
    // somebody who just pasted a spreadsheet column is actually looking.
    const body = await open({ ids: 'bodyId\n1234' })
    await waitFor(() => expect(body.querySelector('.list-body__missing')).toBeTruthy())
    expect(body.textContent).toContain('"bodyId"')
    expect(body.textContent).toContain('delete its header line')
  })
})
