// @vitest-environment jsdom

/**
 * The Select One card, in the real editor.
 *
 * What this file is actually guarding is the **gap between what is shown and what is emitted**.
 * With `Live` off those are two different elements for as long as somebody is browsing, and
 * every failure mode here is silent: an arrow that also commits costs a full run per press on an
 * expensive chain, a commit that does not costs the node its entire purpose, and a foot line
 * that does not say which element is on the port leaves the graph disagreeing with the card with
 * nothing to explain it. None of the three throws.
 *
 * The pager reads the node's **input**, so all of it works before anything has run — which is
 * the assertion that would break first if somebody pointed it at the output instead.
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

/** dataset → find → selectOne, or the pick node on its own when `wired` is false. */
function graphWith(params: Record<string, unknown>, wired: boolean): CodaGraph {
  let g = emptyGraph('pick')
  g = addNode(g, node('pick', 'core.selectOne', 640, params))
  if (wired) {
    g = addNode(g, node('ds', 'neuron.dataset', 0, { dataset: DATASET }))
    g = addNode(g, node('find', 'neuron.findNeurons', 320, { typePattern: 'LC.*' }))
    g = addEdge(g, {
      source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset',
    })
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'pick', targetHandle: 'in' })
  }
  return g
}

async function open(params: Record<string, unknown> = {}, wired = true) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, wired))
  })
  return await waitFor(() => {
    const body = document.querySelector('.step-body__pager')?.closest('.list-body')
    if (!body) throw new Error('no Select One body rendered')
    return body as HTMLElement
  })
}

async function run() {
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
}

function params() {
  return useGraphStore.getState().graph.nodes.find((n) => n.id === 'pick')!.params
}

function button(body: HTMLElement, label: string): HTMLButtonElement {
  const found = [...body.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no "${label}" button on the card`)
  return found as HTMLButtonElement
}

describe('Select One card', () => {
  it('renders every non-advanced param exactly once', async () => {
    // A body owns the whole area, so a control it forgets is reachable only from the inspector,
    // which on screen is indistinguishable from one that was never added.
    const body = await open()
    const labels = [...body.querySelectorAll('.param__label')].map((el) => el.textContent)
    expect(labels).toEqual(['Live'])
  })

  it('counts the collection from the wire, before anything has run', async () => {
    // The pager reads the *input*, which is what makes it usable at all: reading the output
    // would answer "what did you commit last time" and be empty until somebody committed.
    const body = await open()
    await run()
    await waitFor(() => expect(body.textContent).toMatch(/1 \/ \d+/))
  })

  it('labels the Live checkbox once', async () => {
    /*
     * Found in a browser, not here. `ParamField`'s checkbox draws its own label under the
     * default `node` variant, and the generic card suppresses the row's label in CSS instead —
     * so a body that renders both got "Live Live". jsdom applies no CSS, which is exactly why
     * the count has to be asserted rather than looked at.
     */
    const body = await open()
    const live = [...body.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === 'Live',
    )
    expect(live).toHaveLength(1)
  })

  it('says it has not run rather than asking for a wire that is already there', async () => {
    /*
     * The other browser finding. Whether something is *connected* comes off the inferred type
     * and is true the moment the link is drawn; what is *on the wire* comes off the last run.
     * Reading the second for the first printed "Connect a table" at a socket with a wire in it,
     * which sends somebody to fix a link that is already there.
     */
    const body = await open()
    expect(body.textContent).toContain('Not run yet')
    expect(body.textContent).not.toContain('Connect a table')
  })

  it('says what to connect when nothing is wired', async () => {
    const body = await open({}, false)
    expect(body.textContent).toContain('Connect a table')
    // "item", not "row": with nothing on the wire the card does not know what it would be
    // stepping through, and guessing "row" would be a claim about a collection nobody has seen.
    expect(button(body, 'Next item').disabled).toBe(true)
  })

  it('stepping moves the view and leaves the port alone', async () => {
    const body = await open()
    await run()
    await waitFor(() => expect(body.textContent).toMatch(/1 \/ \d+/))

    fireEvent.click(button(body, 'Next row'))
    await waitFor(() => expect(body.textContent).toMatch(/2 \/ \d+/))
    // The whole design in one assertion: browsing is free, so the committed index has not moved.
    expect(params()['index']).toBe(1)
    expect(params()['selected']).toBe(0)
    await waitFor(() => expect(body.textContent).toContain('emitting 1'))
  })

  it('“Use this” commits the element on screen', async () => {
    const body = await open()
    await run()
    fireEvent.click(button(body, 'Next row'))
    await waitFor(() => expect(button(body, 'Use this').disabled).toBe(false))

    fireEvent.click(button(body, 'Use this'))
    await waitFor(() => expect(params()['selected']).toBe(1))
    // Nothing left to commit, so the button stands down rather than disappearing — a missing
    // control reads as "this node cannot commit", which is a different and untrue statement.
    await waitFor(() => expect(button(body, 'Use this').disabled).toBe(true))
    expect(body.textContent).toContain('emitting this one')
  })

  it('Live makes the arrows write both indices', async () => {
    const body = await open({ live: true })
    await run()
    await waitFor(() => expect(body.textContent).toContain('live'))

    fireEvent.click(button(body, 'Next row'))
    await waitFor(() => expect(params()['selected']).toBe(1))
    expect(params()['index']).toBe(1)
    // The commit button has nothing to do in this mode and says so rather than vanishing.
    expect(button(body, 'Use this').disabled).toBe(true)
  })

  it('admits when the committed element is past the end', async () => {
    /*
     * The state an upstream filter leaves behind. The node emits nothing there rather than
     * clamping, so the card has to say so — "emitting nothing" alone would read as a broken
     * node, which is why the line carries the number *and* the length.
     */
    const body = await open({ selected: 99_999 })
    await run()
    await waitFor(() => {
      const missing = body.querySelector('.list-body__missing')
      expect(missing?.textContent).toContain('emitting nothing')
    })
    expect(body.querySelector('.list-body__missing')?.textContent).toMatch(/row 100,000 of \d+/)
  })

  it('names the element it is showing', async () => {
    // Derived headlessly by `elementLabel`, so the card can say which neuron rather than only
    // which position — a bare "3 / 41" is not something anybody can act on.
    const body = await open()
    await run()
    await waitFor(() => {
      const name = body.querySelector('.step-body__name')
      expect(name?.textContent?.length).toBeGreaterThan(0)
    })
  })
})
