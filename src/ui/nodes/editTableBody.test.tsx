// @vitest-environment jsdom

/**
 * The Edit Table card, in the real editor.
 *
 * The op's semantics are pinned in `tableEdits.test.ts`; what is only reachable from here is
 * the **widget's own contract**, which is `RenameBody`'s with one thing added and every failure
 * in it silent rather than thrown:
 *
 *  - `+ Add` must draw a row without writing one, or pressing it marks the node stale and
 *    everything downstream with it for a control nobody has used yet;
 *  - a filled row must reach the store as one JSON object, since that is the only route the
 *    `edits` param has — nothing else in the app writes it;
 *  - the column field must stay a **text** field with completions rather than becoming a
 *    picker. Naming a column the table does not have is not a mistake on this node, it is how
 *    a column gets added, and a `select` makes that unreachable.
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

/** `dataset → find → edit`, so the completions have a real neuron schema to offer. */
function graphWith(params: Record<string, unknown>, upstream: 'neurons' | 'none') {
  let g = emptyGraph('edit')
  g = addNode(g, node('ed', 'core.editTable', 640, params))
  if (upstream === 'neurons') {
    g = addNode(g, node('ds', 'neuron.dataset', 0, { dataset: DATASET }))
    g = addNode(g, node('find', 'neuron.findNeurons', 320, { typePattern: 'LC.*' }))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'ed',
      targetHandle: 'in',
    })
  }
  return g as CodaGraph
}

async function open(
  params: Record<string, unknown> = {},
  upstream: 'neurons' | 'none' = 'neurons',
) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, upstream))
  })
  return await waitFor(() => {
    const body = document.querySelector('.edit-body__row')?.closest('.list-body')
    if (!body) throw new Error('no Edit Table body rendered')
    return body as HTMLElement
  })
}

const stored = () =>
  useGraphStore.getState().graph.nodes.find((n) => n.id === 'ed')!.params.edits as string[]

const rows = (body: HTMLElement) => [...body.querySelectorAll('.edit-body__row')]

const fields = (row: Element) => [...row.querySelectorAll('input')]

const addButton = (body: HTMLElement) =>
  [...body.querySelectorAll('button')].find((b) => b.textContent?.trim() === '+ Add')!

describe('Edit Table card', () => {
  it('opens on one empty rule rather than a bare button', async () => {
    const body = await open()
    expect(rows(body)).toHaveLength(1)
    expect(fields(rows(body)[0]!)).toHaveLength(3)
    expect(stored()).toEqual([])
  })

  it('adds a row without writing one to the graph', async () => {
    const body = await open()
    const before = useGraphStore.getState().graph
    await act(async () => {
      fireEvent.click(addButton(body))
    })
    await waitFor(() => expect(rows(body)).toHaveLength(2))
    expect(stored()).toEqual([])
    expect(useGraphStore.getState().graph).toBe(before)
  })

  it('stores a filled rule as one JSON object', async () => {
    const body = await open()
    /*
     * Re-queried per step rather than captured once, and one field per `act`. The card is
     * inside a React Flow node, which re-mounts it when the node's params change — so a field
     * held across a commit is a detached element that fires into nothing. Two commits inside
     * one batch would also both read the `stored` the card was rendered with, and the second
     * would overwrite the first; neither is a fact about this card, but both make a test that
     * fails for the wrong reason.
     */
    const field = (i: number) => fields(rows(body)[0]!)[i]!
    const type = async (i: number, text: string) => {
      await act(async () => {
        fireEvent.change(field(i), { target: { value: text } })
        fireEvent.blur(field(i))
      })
    }

    await type(0, 'type=LC4')
    await waitFor(() => expect(stored()).toEqual(['{"w":"type=LC4","c":"","v":""}']))

    await type(1, 'type')
    await waitFor(() => expect(stored()).toEqual(['{"w":"type=LC4","c":"type","v":""}']))

    await type(2, 'LC4a')
    await waitFor(() => expect(stored()).toEqual(['{"w":"type=LC4","c":"type","v":"LC4a"}']))
  })

  it('offers the input’s columns as completions, not as a picker', async () => {
    // A `select` would make "name a column that does not exist" unreachable, and that is the
    // gesture that adds one.
    const body = await open()
    const column = fields(rows(body)[0]!)[1]!
    expect(column.tagName).toBe('INPUT')
    const list = document.getElementById(column.getAttribute('list')!)!
    const options = [...list.querySelectorAll('option')].map((o) => o.value)
    expect(options).toContain('type')
    expect(options).toContain('neuronId')
  })

  it('renders one datalist for the card, not one per rule', async () => {
    /*
     * A wide pivot names a column per label value, so per-row lists would be the column count
     * times the number of rules — thousands of `<option>` elements re-reconciled on every
     * render, for a popup that shows about fifteen.
     */
    const body = await open({
      edits: ['{"w":"","c":"a","v":"1"}', '{"w":"","c":"b","v":"2"}'],
    })
    expect(rows(body)).toHaveLength(2)
    expect(body.querySelectorAll('datalist')).toHaveLength(1)
    const ids = rows(body).map((r) => fields(r)[1]!.getAttribute('list'))
    expect(new Set(ids).size).toBe(1)
  })

  it('marks a rule that changes nothing, on the field carrying the reason', async () => {
    // A bare term is refused rather than matched against every column — the one place this node
    // is stricter than the Table viewer's header cells, and for the reason in `tableEdits.ts`.
    const body = await open({ edits: ['{"w":"LC4","c":"type","v":"x"}'] })
    await waitFor(() => expect(body.querySelector('.edit-body__row--broken')).not.toBeNull())
    expect(body.textContent).toContain('1 not applied')
  })

  it('counts the columns it adds', async () => {
    const body = await open({ edits: ['{"w":"type=LC4","c":"group","v":"A"}'] })
    await waitFor(() => expect(body.textContent).toContain('+1 column'))
  })

  it('removes a stored row, and a blank one without touching the graph', async () => {
    const body = await open({ edits: ['{"w":"","c":"type","v":"x"}'] })
    await act(async () => {
      fireEvent.click(addButton(body))
    })
    await waitFor(() => expect(rows(body)).toHaveLength(2))

    await act(async () => {
      fireEvent.click(rows(body)[1]!.querySelector('.rename-body__remove') as HTMLButtonElement)
    })
    await waitFor(() => expect(rows(body)).toHaveLength(1))
    expect(stored()).toEqual(['{"w":"","c":"type","v":"x"}'])

    await act(async () => {
      fireEvent.click(rows(body)[0]!.querySelector('.rename-body__remove') as HTMLButtonElement)
    })
    await waitFor(() => expect(stored()).toEqual([]))
  })

  it('asks for a wire when there is none, rather than reporting an empty table', async () => {
    const body = await open({}, 'none')
    expect(body.textContent).toContain('Connect a table')
  })
})
