// @vitest-environment jsdom

/**
 * The Find Neurons card, in the real editor.
 *
 * The node's semantics are pinned in `filterRows.test.ts` and `findNeuronsRows.test.ts`; what is
 * only reachable from here is the **widget's own contract**, and every failure in it is silent
 * rather than thrown:
 *
 *  - `+ Add filter` must draw a row without writing one, or pressing it marks the node stale and
 *    everything downstream with it for a control nobody has filled in yet;
 *  - the field list must be the *dataset's*, which is the entire point of the redesign — a card
 *    offering `size` against a datastack that publishes none is how this node used to answer
 *    "0 neurons" for a datastack full of them;
 *  - a legacy node must show its old params as rows immediately and convert them in one edit,
 *    since nothing else in the app will ever write `filters` for it.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { decodeRows } from '../../data/filterRows'
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

/** `dataset → find`, so the field picker has a real neuron schema to offer. */
function graphWith(params: Record<string, unknown>, connected = true) {
  let g = emptyGraph('find')
  g = addNode(g, node('find', 'neuron.findNeurons', 320, params))
  if (connected) {
    g = addNode(g, node('ds', 'neuron.dataset', 0, { dataset: DATASET }))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
  }
  return g as CodaGraph
}

async function open(params: Record<string, unknown> = {}, connected = true) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, connected))
  })
  return await waitFor(() => {
    const body = document.querySelector('.filter-body__rows')?.closest('.list-body')
    if (!body) throw new Error('no Find Neurons body rendered')
    return body as HTMLElement
  })
}

const paramsOf = () => useGraphStore.getState().graph.nodes.find((n) => n.id === 'find')!.params
const storedRows = () => decodeRows(paramsOf().filters)

const selects = (body: HTMLElement) =>
  Array.from(body.querySelectorAll('select')) as HTMLSelectElement[]
const inputs = (body: HTMLElement) =>
  Array.from(body.querySelectorAll('input')) as HTMLInputElement[]

describe('the rows', () => {
  it('draws one blank row on an unconfigured node without writing it', async () => {
    // The rule this card shares with Rename: a blank row is component state, never a param.
    // Writing it would put a half-filled control in the provenance key.
    const body = await open()
    expect(selects(body)).toHaveLength(2)
    expect(storedRows()).toEqual([])
    expect(paramsOf().filters).toEqual([])
  })

  it('adds a row on demand, still without writing anything', async () => {
    const body = await open()
    fireEvent.click(body.querySelector('.rename-body__add')!)
    await waitFor(() => expect(selects(body)).toHaveLength(4))
    expect(storedRows()).toEqual([])
  })

  it('offers the dataset’s own fields, and nothing else', async () => {
    /*
     * The whole redesign in one assertion. The old card offered `Min size` and `Status` whatever
     * was wired to it; this offers what the dataset publishes, so a field the backend does not
     * have cannot be picked and the wrong-count failures become unreachable rather than caught.
     */
    const body = await open()
    const options = Array.from(selects(body)[0]!.options).map((o) => o.value)
    expect(options).toContain('type')
    expect(options).toContain('size')
    expect(options).not.toContain('hemilineage')
  })

  it('stores a row once it is complete, and not before', async () => {
    const body = await open()
    fireEvent.change(selects(body)[0]!, { target: { value: 'type' } })
    // Field but no value: still nothing worth storing.
    expect(storedRows()).toEqual([])

    fireEvent.change(inputs(body)[0]!, { target: { value: 'LC4' } })
    await waitFor(() =>
      expect(storedRows()).toEqual([{ field: 'type', op: 'is', values: ['LC4'] }]),
    )
  })

  it('follows the field’s type when offering operators', async () => {
    const body = await open()
    fireEvent.change(selects(body)[0]!, { target: { value: 'size' } })
    await waitFor(() => {
      const ops = Array.from(selects(body)[1]!.options).map((o) => o.value)
      expect(ops).toContain('ge')
      // `contains` on a synapse count is not a question anybody is asking.
      expect(ops).not.toContain('contains')
    })
  })

  it('does not leave an operator behind that the new field cannot answer', async () => {
    // Picking `contains` on a name and then switching to a number would otherwise leave a row
    // that reports itself broken the moment somebody fixes it.
    const body = await open()
    fireEvent.change(selects(body)[0]!, { target: { value: 'type' } })
    fireEvent.change(selects(body)[1]!, { target: { value: 'contains' } })
    fireEvent.change(selects(body)[0]!, { target: { value: 'size' } })
    await waitFor(() => expect(selects(body)[1]!.value).not.toBe('contains'))
  })

  it('reads several values for a set operator', async () => {
    const body = await open()
    fireEvent.change(selects(body)[0]!, { target: { value: 'type' } })
    fireEvent.change(selects(body)[1]!, { target: { value: 'isIn' } })
    fireEvent.change(inputs(body)[0]!, { target: { value: 'LC4, LC6 , LPLC2' } })
    await waitFor(() =>
      expect(storedRows()).toEqual([
        { field: 'type', op: 'isIn', values: ['LC4', 'LC6', 'LPLC2'] },
      ]),
    )
  })

  it('removes a stored row', async () => {
    const body = await open({ filters: ['{"f":"type","op":"is","v":["LC4"]}'] })
    fireEvent.click(body.querySelector('.rename-body__remove')!)
    await waitFor(() => expect(storedRows()).toEqual([]))
  })
})

describe('a node saved before this card existed', () => {
  const LEGACY = { typePattern: 'LC.*', status: 'Traced', minSize: 50_000 }

  it('shows the old params as rows straight away', async () => {
    // `rowsFromParams`, not `filters`: drawing the stored param alone would show an empty card
    // for every graph saved before this node had rows.
    const body = await open(LEGACY)
    const fields = selects(body)
      .filter((_, i) => i % 2 === 0)
      .map((s) => s.value)
    expect(fields).toEqual(['type', 'status', 'size'])
  })

  it('converts them in the edit that touches them, and not on load', async () => {
    const body = await open(LEGACY)
    // Untouched, the node still runs off the legacy params exactly as it did before. A file that
    // rewrote itself on load would be a change nobody asked for.
    expect(paramsOf().typePattern).toBe('LC.*')
    expect(storedRows()).toEqual([])

    fireEvent.change(inputs(body)[0]!, { target: { value: 'LC4.*' } })

    await waitFor(() => expect(paramsOf().typePattern).toBe(''))
    expect(paramsOf().status).toBe('')
    expect(paramsOf().minSize).toBe(0)
    // All three survive the conversion, with the edit applied — and the old five cannot now
    // contribute a second time.
    expect(storedRows()).toEqual([
      { field: 'type', op: 'matches', values: ['LC4.*'] },
      { field: 'status', op: 'is', values: ['Traced'] },
      { field: 'size', op: 'ge', values: ['50000'] },
    ])
  })
})

describe('the foot line', () => {
  it('says an empty node means every neuron, rather than saying nothing', async () => {
    const body = await open()
    expect(body.textContent).toContain('every neuron in the dataset')
  })

  it('marks a row naming a field this dataset does not have', async () => {
    // A graph saved against another backend. Marked rather than dropped: dropping it would send
    // a broader query to a shared production server and the too-large answer looks correct.
    const body = await open({ filters: ['{"f":"hemilineage","op":"is","v":["x"]}'] })
    await waitFor(() => expect(body.textContent).toContain('1 not in this dataset'))
    expect(body.querySelector('.filter-body__row--broken')).toBeTruthy()
  })

  it('asks for a dataset when none is wired', async () => {
    const body = await open({}, false)
    expect(body.textContent).toContain('Connect a dataset')
  })
})
