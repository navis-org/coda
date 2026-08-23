// @vitest-environment jsdom

/**
 * The Rename Columns card, in the real editor.
 *
 * The node's semantics are pinned in `rename.test.ts`; what is only reachable from here is the
 * **widget's own contract**, and every failure in it is silent rather than thrown:
 *
 *  - `+ Add` must draw a row without writing one, or pressing it marks the node stale and
 *    everything downstream with it for a control nobody has used yet;
 *  - a filled row must reach the store as a JSON pair, since that is the only route the param
 *    has — nothing else in the app writes `renames`;
 *  - the column picker must not go *disabled* where the upstream schema has not arrived, which
 *    is `Table from URL`'s ordinary state on a fresh session and therefore the commonest chain
 *    this node has. That is `columnField.test.tsx`'s finding, reached from a second widget.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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

function node(id: string, type: string, x: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    position: { x, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  }
}

/**
 * `dataset → find → rename`, so the picker has a real neuron schema to offer — or the rename
 * node alone, which is the not-connected state, or behind a `Table from URL`, which is the
 * connected-but-no-schema one.
 */
function graphWith(params: Record<string, unknown>, upstream: 'neurons' | 'url' | 'none') {
  let g = emptyGraph('rename')
  g = addNode(g, node('rn', 'core.rename', 640, params))
  if (upstream === 'neurons') {
    g = addNode(g, node('ds', 'neuron.dataset', 0, { dataset: DATASET }))
    g = addNode(g, node('find', 'neuron.findNeurons', 320, { typePattern: 'LC.*' }))
    g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'rn', targetHandle: 'in' })
  } else if (upstream === 'url') {
    g = addNode(g, node('url', 'core.tableFromUrl', 320, { url: 'https://example.org/a.csv' }))
    g = addEdge(g, { source: 'url', sourceHandle: 'out', target: 'rn', targetHandle: 'in' })
  }
  return g as CodaGraph
}

async function open(params: Record<string, unknown> = {}, upstream: 'neurons' | 'url' | 'none' = 'neurons') {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, upstream))
  })
  return await waitFor(() => {
    const body = document.querySelector('.rename-body__rows')?.closest('.list-body')
    if (!body) throw new Error('no Rename body rendered')
    return body as HTMLElement
  })
}

const stored = () =>
  useGraphStore.getState().graph.nodes.find((n) => n.id === 'rn')!.params.renames as string[]

const rows = (body: HTMLElement) => [...body.querySelectorAll('.rename-body__row')]

const addButton = (body: HTMLElement) =>
  [...body.querySelectorAll('button')].find((b) => b.textContent?.trim() === '+ Add')!

describe('Rename Columns card', () => {
  it('opens on one empty row rather than a bare button', async () => {
    // A card whose whole content is `+ Add` says less about what the node does than one showing
    // the shape of a rename.
    const body = await open()
    expect(rows(body)).toHaveLength(1)
    expect(stored()).toEqual([])
  })

  it('adds a row without writing one to the graph', async () => {
    /*
     * The reason a blank row is component state. `renames` is in the provenance key, so a row
     * that renames nothing would mark the node stale and every node after it — for a control
     * that has not been used. What the store holds is what the run will do.
     */
    const body = await open()
    const before = useGraphStore.getState().graph
    await act(async () => {
      fireEvent.click(addButton(body))
    })
    await waitFor(() => expect(rows(body)).toHaveLength(2))
    expect(stored()).toEqual([])
    expect(useGraphStore.getState().graph).toBe(before)
  })

  it('stores a filled row as a JSON pair', async () => {
    const body = await open()
    const select = rows(body)[0]!.querySelector('select')!
    await act(async () => {
      fireEvent.change(select, { target: { value: 'type' } })
    })
    await waitFor(() => expect(stored()).toEqual(['["type",""]']))

    const text = rows(body)[0]!.querySelector('input')!
    await act(async () => {
      fireEvent.change(text, { target: { value: 'cell_type' } })
      fireEvent.blur(text)
    })
    await waitFor(() => expect(stored()).toEqual(['["type","cell_type"]']))
  })

  it('removes a stored row, and a blank one without touching the graph', async () => {
    const body = await open({ renames: ['["type","cell_type"]'] })
    await act(async () => {
      fireEvent.click(addButton(body))
    })
    await waitFor(() => expect(rows(body)).toHaveLength(2))

    // The blank one first: it is not in the param, so removing it must not commit.
    await act(async () => {
      fireEvent.click(rows(body)[1]!.querySelector('.rename-body__remove') as HTMLButtonElement)
    })
    await waitFor(() => expect(rows(body)).toHaveLength(1))
    expect(stored()).toEqual(['["type","cell_type"]'])

    await act(async () => {
      fireEvent.click(rows(body)[0]!.querySelector('.rename-body__remove') as HTMLButtonElement)
    })
    await waitFor(() => expect(stored()).toEqual([]))
  })

  it('offers the columns the input actually publishes', async () => {
    const body = await open()
    const options = [...rows(body)[0]!.querySelectorAll('option')].map((o) => o.value)
    expect(options).toContain('neuronId')
    expect(options).toContain('type')
    // A way back to unset, so a row can be cleared without being removed.
    expect(options[0]).toBe('')
  })

  it('never draws the picker disabled where the schema has not arrived', async () => {
    /*
     * `Table from URL` keeps its schema per URL in a session-scoped map, so a fresh session
     * publishes none — and this node sits directly behind it on its own documented chain. A
     * disabled select there hides the one thing worth knowing, which is what the row will use.
     */
    const body = await open({ renames: ['["root_id","neuronId"]'] }, 'url')
    const select = rows(body)[0]!.querySelector('select')!
    expect(select.disabled).toBe(false)
    // Offered plainly, never as "(missing)": unknown is not missing.
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toContain('root_id')
    expect(body.textContent).not.toContain('(missing)')
    expect(body.textContent).toContain('Columns are not known until this has run')
  })

  it('says a column is missing only where the schema is known enough to say so', async () => {
    const body = await open({ renames: ['["gone","x"]'] })
    await waitFor(() => expect(body.textContent).toContain('(missing)'))
    expect(body.textContent).toContain('1 not in the table')
  })

  it('asks for a wire when there is none, rather than reporting an empty table', async () => {
    const body = await open({}, 'none')
    expect(body.textContent).toContain('Connect a table')
  })
})
