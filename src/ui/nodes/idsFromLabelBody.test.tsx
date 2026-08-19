// @vitest-environment jsdom

/**
 * The IDs from Label card, in the real editor.
 *
 * This is where the whole "warn on the node" decision lives, and both halves of it fail
 * silently. The readout is *derived* from the node's own output rather than reported by the
 * run, so nothing throws if it never appears — the card simply looks like a node with no
 * opinion about a lookup that found nothing. And a custom body replaces the generic param
 * rows outright, so a control this body forgets to render exists only in the inspector, which
 * is indistinguishable from a control that was never added.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
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

function graphWith(params: Record<string, unknown>) {
  const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
    id,
    type,
    position: { x: id === 'ds' ? 0 : 320, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  })
  let g = emptyGraph('labels')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('lookup', 'neuron.idsFromLabel', params))
  return addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'lookup',
    targetHandle: 'dataset',
  })
}

async function open(params: Record<string, unknown> = {}) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params))
  })
  return await waitFor(() => {
    const body = document.querySelector('.labels-body')
    if (!body) throw new Error('no IDs from Label body rendered')
    return body as HTMLElement
  })
}

async function run() {
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
}

describe('IDs from Label card', () => {
  it('renders every non-advanced param exactly once', async () => {
    const body = await open()
    // The generic card would have shown these four; a body owns the whole area, so it has to
    // show the same set, in declaration order. Advanced ones stay inspector-only.
    const labels = [...body.querySelectorAll('.param__label')].map((el) => el.textContent)
    expect(labels).toEqual(['Field', 'Labels', 'Label column', 'Match'])
  })

  it('says it has not run rather than reporting an empty lookup', async () => {
    const body = await open({ labels: 'T4a' })
    expect(body.textContent).toContain('Not run yet')
  })

  it('reports the neurons found and that every label matched', async () => {
    const body = await open({ labels: 'T4a, T4b' })
    await run()
    await waitFor(() => expect(body.textContent).toMatch(/\d+ neurons/))
    expect(body.textContent).toContain('2/2 labels')
    expect(body.querySelector('.labels-body__missing')).toBeNull()
  })

  it('names the labels that matched nothing', async () => {
    const body = await open({ labels: 'T4a, Nonexistent1, Nonexistent2' })
    await run()
    await waitFor(() => expect(body.querySelector('.labels-body__missing')).toBeTruthy())
    const missing = body.querySelector('.labels-body__missing')!
    expect(missing.textContent).toContain('Nonexistent1')
    expect(missing.textContent).toContain('Nonexistent2')
    expect(body.textContent).toContain('1/3 labels')
    // The full list is in the title, because the visible text is capped on a card.
    expect(missing.getAttribute('title')).toBe('No neuron carries: Nonexistent1, Nonexistent2')
  })

  it('asks for labels rather than claiming a result when nothing is configured', async () => {
    const body = await open()
    await run()
    await waitFor(() => expect(body.textContent).toContain('No labels yet'))
    // Specifically not "0 neurons", which reads as a lookup that failed.
    expect(body.textContent).not.toContain('0 neurons')
  })
})
