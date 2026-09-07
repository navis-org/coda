// @vitest-environment jsdom

/**
 * The Split Neurons card, in the real editor.
 *
 * The rows themselves are `FilterRowsEditor`'s and pinned by `findNeuronsBody.test.tsx` — this
 * covers the three things that are only true of *this* caller, and each fails silently:
 *
 *  - the field list is the **collection's attribute table**, reached through `ctx.attributes`
 *    rather than `ctx.schema`, because a skeleton collection carries its table beside the
 *    geometry rather than being one. A card reading `schema` would offer nothing at all here,
 *    which looks exactly like a dataset whose listing has not landed;
 *  - the foot line has to say *which port* an empty card leaves empty. Getting that wrong reads
 *    as a working filter that found nothing, which is the one thing this node must never look
 *    like;
 *  - a kind this node refuses gets the refusal's own sentence, not a row count — being told
 *    "0 filters" about a neuron table is an answer to the wrong question.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { encodeRows } from '../../data/filterRows'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { searchFor } from '../../test/findNeurons'

const DATASET = mockDatasetIds()[0]!

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
})

afterEach(cleanup)

function node(id: string, type: string, x: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    position: { x, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  }
}

/**
 * `dataset → find → skeletons → split`, so the split's field picker has a real *morphology*
 * schema on its wire — which is what a collection's attribute table carries.
 *
 * `wrongKind` wires the neuron table straight in instead, which is the case the card has to name
 * rather than count.
 */
function graphWith(
  params: Record<string, unknown>,
  { connected = true, wrongKind = false } = {},
) {
  let g = emptyGraph('split')
  g = addNode(g, node('split', 'neuron.splitNeurons', 960, params))
  if (!connected) return g as CodaGraph

  g = addNode(g, node('ds', 'neuron.dataset', 0, { dataset: DATASET }))
  g = addNode(g, node('find', 'neuron.findNeurons', 320, searchFor({ type: 'LC4' })))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  if (wrongKind) {
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'split',
      targetHandle: 'in',
    })
    return g as CodaGraph
  }

  g = addNode(g, node('skel', 'neuron.skeletons', 640))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'skel',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'skel',
    targetHandle: 'neurons',
  })
  g = addEdge(g, {
    source: 'skel',
    sourceHandle: 'skeletons',
    target: 'split',
    targetHandle: 'in',
  })
  return g as CodaGraph
}

async function open(
  params: Record<string, unknown> = {},
  options: { connected?: boolean; wrongKind?: boolean } = {},
) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, options))
  })
  return await waitFor(() => {
    const card = document.querySelector('[data-id="split"] .filter-body__rows')
    const body = card?.closest('.list-body')
    if (!body) throw new Error('no Split Neurons body rendered')
    return body as HTMLElement
  })
}

const selects = (body: HTMLElement) =>
  Array.from(body.querySelectorAll('select')) as HTMLSelectElement[]

describe('the field list', () => {
  it('is the collection’s attribute columns, off the geometry wire', async () => {
    const body = await open()
    const options = Array.from(selects(body)[0]!.options).map((o) => o.value)
    expect(options).toContain('type')
    expect(options).toContain('neuronId')
    // A morphology attribute, which is what says this read `attributes` and not `schema`.
    expect(options).toContain('cableLength')
    expect(options).not.toContain('hemilineage')
  })
})

describe('the foot line', () => {
  /*
   * "nothing matches" rather than "no neurons": on this node an empty set of rows is a decision
   * about *where the rows go*, and the port that ends up empty is the one somebody cannot see
   * from an unrun card.
   */
  it('says an unconfigured card matches nothing', async () => {
    const body = await open()
    expect(body.textContent).toContain('no filters — nothing matches')
  })

  it('counts the rows once there are some', async () => {
    const body = await open({
      filters: encodeRows([{ field: 'type', op: 'is', values: ['LC4'] }]),
    })
    expect(body.textContent).toContain('1 filter, all must match')
  })

  it('asks for geometry when nothing is wired', async () => {
    const body = await open({}, { connected: false })
    expect(body.textContent).toContain('Connect skeletons or meshes')
  })

  /*
   * The refusal is `validate`'s and the card already renders it as an issue, so the foot must not
   * say it a second time — one refusal, printed once. Which is also why this reads the issue line
   * rather than the foot: that is the mechanism that owns the sentence.
   */
  it('leaves the wrong kind to the issue line rather than repeating it', async () => {
    const body = await open({}, { wrongKind: true })
    const card = body.closest('.coda-node')!
    expect(card.querySelector('.coda-node__issue')?.textContent).toContain(
      'Filter Table keeps the rows',
    )
    expect(body.textContent).not.toContain('Filter Table keeps the rows')
  })

  /* The same analysis `validate` reads, so the badge and the card cannot disagree. */
  it('marks a row naming a column these neurons do not carry', async () => {
    const body = await open({
      filters: encodeRows([{ field: 'hemilineage', op: 'is', values: ['x'] }]),
    })
    await waitFor(() => expect(body.textContent).toContain('1 not on these neurons'))
    expect(body.querySelector('.filter-body__row--broken')).toBeTruthy()
  })
})
