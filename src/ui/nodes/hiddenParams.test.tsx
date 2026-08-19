// @vitest-environment jsdom

/**
 * "… 2 more (1 changed)" — the end of the param band, pointing at the inspector-only params.
 *
 * `advanced` params never reach the card and the inspector is closed by default, so a node with
 * a setting on it and one without looked identical. The starkest case is a card drawing no rows
 * at all: Skeletons has exactly one param and it is advanced, so an empty body was the whole of
 * what it said about itself — which is why the hint is not gated on the band existing.
 *
 * Two counts, and they answer different questions. *How many are hidden* is a fact about the
 * node type and never moves; *how many were set* is about this particular node, which is why it
 * is a second clause rather than a second badge.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import type { NodeDefinition } from '../../core/node'
import { changedParams, hiddenParams } from '../../core/node'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadExample('morphology')
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
    const wrapper = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    const card = wrapper?.querySelector('.coda-node')
    if (!card) throw new Error(`no card for ${nodeId}`)
    return card as HTMLElement
  })
}

const hintOf = (card: HTMLElement) => card.querySelector('.coda-node__more')

describe('what counts as hidden', () => {
  const def = (params: NodeDefinition['params']): NodeDefinition =>
    ({ type: 't', label: 'T', category: 'transform', cost: 'cheap', params }) as NodeDefinition
  const ids = (params: ReadonlyArray<{ id: string }>) => params.map((p) => p.id)

  it('is the advanced params, whether or not anybody has touched them', () => {
    // The general indicator: a card that draws two rows out of six should say so even when the
    // other four are exactly as the definition left them.
    const d = def([
      { id: 'type', kind: 'string', label: 'Type', default: '' },
      { id: 'limit', kind: 'int', label: 'Limit', default: 0, advanced: true },
      { id: 'minSize', kind: 'int', label: 'Min size', default: 0, advanced: true },
    ])
    expect(ids(hiddenParams(d, { type: '', limit: 0, minSize: 0 }))).toEqual([
      'limit',
      'minSize',
    ])
  })

  it('drops one the current values have switched off', () => {
    // Inapplicable, not hidden — otherwise the number moves as unrelated modes are chosen.
    const d = def([
      { id: 'mode', kind: 'string', label: 'Mode', default: 'off' },
      {
        id: 'ramp',
        kind: 'string',
        label: 'Ramp',
        default: 'blues',
        advanced: true,
        visibleIf: (v) => v.mode === 'on',
      },
    ])
    expect(hiddenParams(d, { mode: 'off' })).toEqual([])
    expect(ids(hiddenParams(d, { mode: 'on' }))).toEqual(['ramp'])
  })

  it('leaves the rows the card is merely not drawing to the fold', () => {
    // A folded band has the header's ☰ in its pressed state already saying so; counting those
    // here would be a second signal for a state the user just chose.
    const d = def([{ id: 'rows', kind: 'number', label: 'Rows', default: 10 }])
    expect(hiddenParams(d, { rows: 99 })).toEqual([])
  })
})

describe('what counts as changed', () => {
  const p = (extra: object) => ({ id: 'x', kind: 'int', label: 'X', ...extra }) as never

  it('compares against the declared default', () => {
    expect(changedParams([p({ default: 100 })], { x: 500 })).toHaveLength(1)
    expect(changedParams([p({ default: 100 })], { x: 100 })).toHaveLength(0)
  })

  it('reads an absent value as untouched, not as a change', () => {
    // Loading does not fill missing params with defaults, so a graph saved before a param
    // existed has no key for it. Comparing that to the default reports a change on every
    // older file, on every card.
    expect(changedParams([p({ default: 100 })], {})).toHaveLength(0)
  })

  it('compares array params by contents', () => {
    const cols = p({ kind: 'columns', from: 'in', default: [] })
    expect(changedParams([cols], { x: [] })).toHaveLength(0)
    expect(changedParams([cols], { x: ['bodyId'] })).toHaveLength(1)
  })
})

describe('the hint on the card', () => {
  it('reports the count on a node whose advanced params are all at their defaults', async () => {
    // The general case, and the one the earlier changed-only version stayed silent for.
    render(<App />)
    const card = await cardFor(nodeIdOfType('neuron.findNeurons'))
    expect(hintOf(card)!.textContent).toBe('… 4 more')
  })

  it('adds the changed clause when one carries a value somebody chose', async () => {
    // The morphology example raises Max neurons on both geometry nodes.
    render(<App />)
    const card = await cardFor(nodeIdOfType('neuron.skeletons'))
    expect(hintOf(card)!.textContent).toBe('… 1 more (1 changed)')
    expect(hintOf(card)!.getAttribute('title')).toContain('Max neurons (changed)')
  })

  it('renders on a card that draws no param rows at all', async () => {
    // Skeletons' only param is advanced, so there is no band for the hint to sit at the end of
    // — and this is the card that needs it most, since an empty body is all it otherwise says.
    render(<App />)
    const card = await cardFor(nodeIdOfType('neuron.skeletons'))
    expect(card.querySelectorAll('.coda-node__params .param')).toHaveLength(0)
    expect(hintOf(card)).not.toBeNull()
  })

  it('tracks the changed count as values are set and put back', async () => {
    render(<App />)
    const find = nodeIdOfType('neuron.findNeurons')
    const card = await cardFor(find)

    act(() => useGraphStore.getState().setParam(find, 'limit', 50))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 4 more (1 changed)'))

    act(() => useGraphStore.getState().setParam(find, 'minSize', 10_000))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 4 more (2 changed)'))

    // `Status` is on the card, so changing it is not something the card failed to report.
    act(() => useGraphStore.getState().setParam(find, 'status', 'Any'))
    expect(hintOf(card)!.textContent).toBe('… 4 more (2 changed)')

    act(() => useGraphStore.getState().setParam(find, 'limit', 0))
    act(() => useGraphStore.getState().setParam(find, 'minSize', 0))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 4 more'))
  })

  it('stays away from a node that has nothing hidden', async () => {
    // Every node in this example has an advanced param, which is itself the finding behind the
    // rule: a marker for their mere existence would be on every card here. Filter has none.
    render(<App />)
    act(() => useGraphStore.getState().addNode('core.filter', { x: 0, y: 400 }))
    const card = await cardFor(nodeIdOfType('core.filter'))
    expect(card.querySelectorAll('.coda-node__params .param').length).toBeGreaterThan(0)
    expect(hintOf(card)).toBeNull()
  })

  it('goes away with a fold, which is already saying there is more here', async () => {
    render(<App />)
    const find = nodeIdOfType('neuron.findNeurons')
    const card = await cardFor(find)
    expect(hintOf(card)).not.toBeNull()

    act(() => useGraphStore.getState().toggleParamRows([find]))
    await waitFor(() => expect(card.querySelector('.coda-node__params')).toBeNull())
    expect(hintOf(card)).toBeNull()
  })

  it('opens the inspector on that node, and never closes an open one', async () => {
    render(<App />)
    const skeletons = nodeIdOfType('neuron.skeletons')
    const card = await cardFor(skeletons)
    expect(useGraphStore.getState().panels.inspector).toBe(false)

    fireEvent.click(hintOf(card)!)
    expect(useGraphStore.getState().panels.inspector).toBe(true)
    expect(useGraphStore.getState().selection).toEqual([skeletons])

    // `togglePanel` is the only setter there is, so a second press must not undo the first —
    // a button meaning "show me" that hides the thing on the way back is worse than no button.
    fireEvent.click(hintOf(card)!)
    expect(useGraphStore.getState().panels.inspector).toBe(true)
  })

  it('costs no run', async () => {
    // It writes a selection and a panel flag, neither of which is in the document.
    render(<App />)
    const card = await cardFor(nodeIdOfType('neuron.skeletons'))
    const before = useGraphStore.getState().graph
    fireEvent.click(hintOf(card)!)
    expect(useGraphStore.getState().graph).toBe(before)
    expect(useGraphStore.getState().past).toHaveLength(0)
  })
})
