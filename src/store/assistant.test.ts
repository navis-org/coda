/**
 * The store seam: an assistant's plan reaching the document.
 *
 * `applyPlan` is covered exhaustively in `assistant/assistant.test.ts` — what plans are refused,
 * what a refusal says. None of that is repeated here. What this file pins is the half only the
 * store can get wrong: that the whole edit is **one** undo step, that a refusal changes nothing,
 * and that a plan which asks for nothing leaves no trace.
 *
 * Each of those reads as a bug in something else when it breaks. Six nodes that take six Ctrl-Zs
 * to remove reads as a broken undo stack; an undo step for a plan the model declined reads as the
 * assistant having silently done something.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { AssistantPlan } from '../assistant/planShape'
import { emptyPlan } from '../assistant/planShape'
import { emptyGraph } from '../core/graph'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

function plan(patch: Partial<AssistantPlan>): AssistantPlan {
  return { ...emptyPlan(), summary: 'a test edit', ...patch }
}

/** `Dataset → Find Neurons → Table`: three nodes and two wires, in one plan. */
const PIPELINE = plan({
  summary: 'Chart the LC4 neurons.',
  add: [
    { ref: 'ds', type: 'dataset.mock.hemibrain' },
    { ref: 'find', type: 'neuron.findNeurons', params: { typePattern: 'LC4' } },
    { ref: 'table', type: 'out.table' },
  ],
  connect: [
    { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
    { from: { node: 'find', port: 'neurons' }, to: { node: 'table', port: 'in' } },
  ],
})

const store = () => useGraphStore.getState()

beforeEach(() => {
  clearStorage()
  useGraphStore.setState({ graph: emptyGraph(), past: [], future: [], selection: [] })
})

describe('applying a plan', () => {
  it('lands the whole edit as one undo step', () => {
    const before = store().graph
    const result = store().applyAssistantPlan(PIPELINE)

    expect(result.ok).toBe(true)
    expect(store().graph.nodes).toHaveLength(3)
    expect(store().graph.edges).toHaveLength(2)

    // Six things changed; one Ctrl-Z takes all of them back.
    expect(store().past).toHaveLength(1)
    store().undo()
    expect(store().graph).toBe(before)
  })

  it('selects what it made, so the answer is on the canvas', () => {
    const result = store().applyAssistantPlan(PIPELINE)
    if (!result.ok) expect.fail(result.errors.join('\n'))

    expect(store().selection.sort()).toEqual(Object.values(result.created).sort())
    expect(store().selection).toHaveLength(3)
  })

  it('selects only what the plan named, not a companion that came along', () => {
    // A published dataset node arrives with its Description card. Selecting it too would
    // misreport the edit — nobody asked for it.
    const result = store().applyAssistantPlan(
      plan({ add: [{ ref: 'ds', type: 'dataset.hemibrain' }] }),
    )
    if (!result.ok) expect.fail(result.errors.join('\n'))

    expect(store().graph.nodes).toHaveLength(2)
    expect(store().selection).toEqual([result.created.ds])
  })

  it('goes through the ordinary commit path, so the edit is autosaved and re-inferred', () => {
    store().applyAssistantPlan(PIPELINE)
    // Inference ran against the committed graph rather than the one before it.
    const findId = Object.values(store().graph.nodes).find(
      (n) => n.type === 'neuron.findNeurons',
    )!.id
    expect(store().inference.nodes[findId]).toBeDefined()
  })
})

describe('when the plan cannot be applied', () => {
  it('changes nothing and records no history', () => {
    const before = store().graph
    const result = store().applyAssistantPlan(
      plan({ add: [{ ref: 'x', type: 'core.doesNotExist' }] }),
    )

    expect(result.ok).toBe(false)
    expect(store().graph).toBe(before)
    expect(store().past).toHaveLength(0)
  })

  it('hands the refusals back rather than throwing, so they can go to the model', () => {
    const result = store().applyAssistantPlan(
      plan({ add: [{ ref: 'x', type: 'core.doesNotExist' }] }),
    )
    if (result.ok) expect.fail('expected a refusal')
    expect(result.errors.join('\n')).toContain('core.doesNotExist')
  })

  it('leaves the selection alone on a refusal', () => {
    store().applyAssistantPlan(PIPELINE)
    const chosen = store().selection

    store().applyAssistantPlan(plan({ add: [{ ref: 'x', type: 'core.doesNotExist' }] }))
    expect(store().selection).toEqual(chosen)
  })
})

describe('when the plan asks for nothing', () => {
  it('leaves no undo step behind', () => {
    /*
     * "I cannot do that" is a real answer — the model returns an empty plan whose summary says
     * so. Every graph operation rebuilds the object, so without `applyPlan` handing the same one
     * back this would push an undo step for an edit nobody made, and Ctrl-Z would appear to do
     * nothing.
     */
    store().applyAssistantPlan(PIPELINE)
    const after = store().graph
    const history = store().past.length

    const result = store().applyAssistantPlan(
      plan({ summary: 'Coda has no statistical-testing node.' }),
    )

    expect(result.ok).toBe(true)
    expect(store().graph).toBe(after)
    expect(store().past).toHaveLength(history)
  })
})

describe('editing what is already there', () => {
  it('applies a second plan on top of the first, each undoing separately', () => {
    /*
     * Two requests are two undo steps, and this ran back-to-back on purpose. The commit
     * originally passed `tag: 'assistant'`, and a tag is purely `pushHistory`'s coalescing key
     * — so two plans landing inside `HISTORY_COALESCE_MS` merged, and undoing the second threw
     * away the first as well. Both plans here commit within a millisecond of each other, which
     * is exactly the window that was wrong.
     */
    store().applyAssistantPlan(PIPELINE)
    const afterFirst = store().graph
    expect(store().past).toHaveLength(1)

    const findId = afterFirst.nodes.find((n) => n.type === 'neuron.findNeurons')!.id
    const result = store().applyAssistantPlan(
      plan({ setParams: [{ node: findId, param: 'limit', value: 50 }] }),
    )
    expect(result.ok).toBe(true)
    expect(store().graph.nodes.find((n) => n.id === findId)!.params.limit).toBe(50)
    expect(store().past).toHaveLength(2)

    store().undo()
    expect(store().graph).toBe(afterFirst)
  })

  it('removes nodes the plan names, taking their wires with them', () => {
    store().applyAssistantPlan(PIPELINE)
    const tableId = store().graph.nodes.find((n) => n.type === 'out.table')!.id

    const result = store().applyAssistantPlan(plan({ remove: [tableId] }))
    expect(result.ok).toBe(true)
    expect(store().graph.nodes).toHaveLength(2)
    expect(store().graph.edges).toHaveLength(1)
  })
})
