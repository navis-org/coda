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
import { changedParams, configurableParams, hiddenParams } from '../../core/node'
import { allNodeDefs, requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(demoWorkflow('morphology'))
  })
})

afterEach(cleanup)

/** The first node of a type, or `-1` for the last — a freshly added one is at the end. */
function nodeIdOfType(type: string, which = 0): string {
  const all = useGraphStore.getState().graph.nodes.filter((n) => n.type === type)
  const found = which < 0 ? all.at(which) : all[which]
  if (!found) throw new Error(`no ${type} in the graph`)
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

  it('skips machinery nobody sets by hand', () => {
    // A dataset node's only advanced param is the `refresh` nonce its reload button writes, so
    // the card was announcing "… 1 more" about a counter. Both sides of the "is that all there
    // is" comparison drop it, or a node whose one other param were a nonce would say "more"
    // while drawing nothing.
    const d = def([
      { id: 'version', kind: 'string', label: 'Version', default: '' },
      {
        id: 'refresh',
        kind: 'int',
        label: 'Refresh',
        default: 0,
        advanced: true,
        internal: true,
      },
    ])
    expect(hiddenParams(d, { version: '', refresh: 3 })).toEqual([])
    expect(ids(configurableParams(d, { version: '', refresh: 3 }))).toEqual(['version'])
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
    expect(changedParams([cols], { x: ['neuronId'] })).toHaveLength(1)
  })
})

describe('across the registry', () => {
  it('marks every nonce, so the next one cannot ship un-flagged', () => {
    // Six of them today — one shared by the dataset family, plus Explore, the old generic
    // dataset node and Table from URL. Each is bumped by a button in a body and read by nobody,
    // so a new one arriving without the flag would put "… 1 more" on a card about a counter.
    const nonces = allNodeDefs().flatMap((d) =>
      (d.params ?? []).filter((p) => p.id === 'refresh').map((p) => [d.type, p] as const),
    )
    expect(nonces.length).toBeGreaterThan(5)
    expect(nonces.filter(([, p]) => p.internal !== true).map(([type]) => type)).toEqual([])
  })

  it('leaves the settings that merely sit beside them countable', () => {
    // `Rows per page` is inspector-only for space and is somebody's preference — marking it
    // internal because its neighbour `page` is would make the flag mean "advanced".
    const explore = requireNodeDef('neuron.explore')
    const byId = (id: string) => (explore.params ?? []).find((p) => p.id === id)
    expect(byId('page')?.internal).toBe(true)
    expect(byId('pageSize')?.internal).toBeUndefined()
  })
})

describe('the hint on the card', () => {
  it('reports the count on a node whose advanced params are all at their defaults', async () => {
    // The general case, and the one the earlier changed-only version stayed silent for.
    //
    // Six rather than four, because Find Neurons keeps the four params its filter rows replaced
    // — readable so that older graphs keep working, `advanced` so they stay off the card, and
    // deliberately *not* `visibleIf`-hidden, which would drop them from the provenance key.
    render(<App />)
    /*
     * A freshly added node rather than the one in the graph: a generated morphology workflow caps
     * its search (`GEOMETRY_LIMIT`), so the Find Neurons on the canvas legitimately carries one
     * changed advanced param — which is the *other* case, two tests down.
     */
    act(() => useGraphStore.getState().addNode('neuron.findNeurons', { x: 0, y: 900 }))
    const card = await cardFor(nodeIdOfType('neuron.findNeurons', -1))
    expect(hintOf(card)!.textContent).toBe('… 6 more')
  })

  it('adds the changed clause when one carries a value somebody chose', async () => {
    // Lower Warn above here rather than relying on the graph carrying it: the wizard caps the
    // *search* instead, since a geometry node's Limit warns rather than capping. "More" rather
    // than "hidden" because Skeletons draws its `Source` dropdown, so there is something else
    // on the card.
    render(<App />)
    act(() => useGraphStore.getState().setParam(nodeIdOfType('neuron.skeletons'), 'limit', 30))
    const card = await cardFor(nodeIdOfType('neuron.skeletons'))
    expect(hintOf(card)!.textContent).toBe('… 1 more (1 changed)')
    expect(hintOf(card)!.getAttribute('title')).toContain('Warn above (changed)')
  })

  it('says "hidden" rather than "more" when there is nothing else on the card', async () => {
    /*
     * "More" is a claim about something else being there. Neuroglancer's params are every one of
     * them inspector-only, so the card draws nothing at all and "3 more" would be more than what?
     *
     * It used to be Skeletons, which had exactly one param and it was advanced — until that node
     * grew a `Source` dropdown, at which point this test was asserting something about the card
     * *and* something about that node's param list, and only one of the two was the point.
     */
    render(<App />)
    act(() => useGraphStore.getState().addNode('out.neuroglancer', { x: 0, y: 600 }))
    const skeletons = await cardFor(nodeIdOfType('out.neuroglancer'))
    expect(skeletons.querySelectorAll('.coda-node__params .param')).toHaveLength(0)
    expect(hintOf(skeletons)!.textContent).toContain('hidden')

    // Find Neurons draws its filter rows, so its six hidden params are genuinely *more*. Note
    // what it does **not** draw: it has a body now, so there are no generic `.param` rows to
    // count — which is the case the next test states abstractly. "More" is true because there is
    // something else on the card, not because that something is a param row.
    const find = await cardFor(nodeIdOfType('neuron.findNeurons'))
    expect(find.querySelectorAll('.coda-node__params .param')).toHaveLength(0)
    expect(find.querySelector('.filter-body__rows')).toBeTruthy()
    expect(hintOf(find)!.textContent).toContain('more')
  })

  it('asks the definition, not the card, so a node with a body still says "more"', () => {
    // Explore renders a search box and a pager instead of the generic rows, so its two
    // non-advanced params *are* on the card — nothing here can enumerate them, which is
    // exactly why the question is asked of `configurableParams` rather than of what was drawn.
    const explore = requireNodeDef('neuron.explore')
    const values = Object.fromEntries((explore.params ?? []).map((p) => [p.id, p.default!]))
    expect(hiddenParams(explore, values).length).toBeLessThan(
      configurableParams(explore, values).length,
    )

    // Neuroglancer is the other end: every one of its params is inspector-only.
    const ng = requireNodeDef('out.neuroglancer')
    const ngValues = Object.fromEntries((ng.params ?? []).map((p) => [p.id, p.default!]))
    expect(hiddenParams(ng, ngValues).length).toBe(configurableParams(ng, ngValues).length)
    expect(hiddenParams(ng, ngValues).length).toBeGreaterThan(0)
  })

  it('renders on a card that draws no param rows at all', async () => {
    // Every Neuroglancer param is advanced, so there is no band for the hint to sit at the end
    // of — and this is the card that needs it most, since an empty body is all it otherwise says.
    render(<App />)
    act(() => useGraphStore.getState().addNode('out.neuroglancer', { x: 0, y: 600 }))
    const card = await cardFor(nodeIdOfType('out.neuroglancer'))
    expect(card.querySelectorAll('.coda-node__params .param')).toHaveLength(0)
    expect(hintOf(card)).not.toBeNull()
  })

  it('tracks the changed count as values are set and put back', async () => {
    render(<App />)
    const find = nodeIdOfType('neuron.findNeurons')
    const card = await cardFor(find)

    act(() => useGraphStore.getState().setParam(find, 'limit', 50))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 6 more (1 changed)'))

    act(() => useGraphStore.getState().setParam(find, 'minSize', 10_000))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 6 more (2 changed)'))

    // A legacy param counts as changed like any other — it is a real value that still reaches
    // the query, which is exactly why it is `advanced` rather than hidden.
    act(() => useGraphStore.getState().setParam(find, 'status', 'Traced'))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 6 more (3 changed)'))

    act(() => useGraphStore.getState().setParam(find, 'limit', 0))
    act(() => useGraphStore.getState().setParam(find, 'minSize', 0))
    act(() => useGraphStore.getState().setParam(find, 'status', ''))
    await waitFor(() => expect(hintOf(card)!.textContent).toBe('… 6 more'))
  })

  it('stays away from a dataset card, whose one hidden param is a nonce', async () => {
    // The reload button in the body writes `refresh`; nobody sets it, so nothing advertises it.
    render(<App />)
    const card = await cardFor(nodeIdOfType('dataset.mock.opticlobe'))
    expect(hintOf(card)).toBeNull()
  })

  it('does not report a change when a pager writes its param', async () => {
    // Profile's `page` is the pager's, not a setting — a card claiming a parameter was changed
    // because somebody looked at the next neuron is the same noise, one node along.
    render(<App />)
    act(() => useGraphStore.getState().addNode('out.profile', { x: 400, y: 400 }))
    const profile = nodeIdOfType('out.profile')
    const card = await cardFor(profile)
    const before = hintOf(card)?.textContent
    act(() => useGraphStore.getState().setParam(profile, 'page', 4))
    expect(hintOf(card)?.textContent).toBe(before)
    expect(before ?? '').not.toContain('changed')
  })

  it('stays away from a node that has nothing hidden', async () => {
    // Every node in this example has an advanced param, which is itself the finding behind the
    // rule: a marker for their mere existence would be on every card here. Filter has none.
    render(<App />)
    act(() => useGraphStore.getState().addNode('core.filterTable', { x: 0, y: 400 }))
    const card = await cardFor(nodeIdOfType('core.filterTable'))
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
