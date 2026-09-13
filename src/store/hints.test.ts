/**
 * Writing a hint, at the store: `setHints` and the `editingHint` it is opened through.
 *
 * Dismissing a hint is pinned in `ui/nodes/nodeHints.test.tsx`, and the property there is that it
 * is *not* an edit. This is the other half, and the property is that writing one *is*: an undo
 * step, the same repair rules a loaded file gets, and no field left behind when the last hint
 * goes. The lock line is `lock.test.ts`'s, which classifies every store action.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { NodeHint } from '../core/graph'
import { MAX_HINTS } from '../core/graph'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

let id = ''

beforeEach(() => {
  clearStorage()
  useGraphStore.setState({ locked: false })
  useGraphStore.getState().newGraph()
  id = useGraphStore.getState().addNode('core.filterTable', { x: 0, y: 0 })
})

const store = () => useGraphStore.getState()
const node = () => store().graph.nodes.find((n) => n.id === id)!

describe('setHints', () => {
  it('is one undo step, and undo takes it back', () => {
    const steps = store().past.length
    store().setHints(id, [{ text: 'Tick a few neurons here first.', tone: 'tip' }])

    expect(node().hints).toEqual([{ text: 'Tick a few neurons here first.', tone: 'tip' }])
    expect(store().past.length).toBe(steps + 1)

    store().undo()
    expect(node().hints).toBeUndefined()
  })

  it('records nothing for a list the node already carries', () => {
    store().setHints(id, [{ text: 'Same.' }])
    const before = store().graph
    const steps = store().past.length

    store().setHints(id, [{ text: 'Same.' }])
    expect(store().graph).toBe(before)
    // An explicit default draws the same box, whatever order its keys arrive in.
    store().setHints(id, [{ side: 'bottom', text: 'Same.', tone: 'note' }])
    expect(store().graph).toBe(before)
    expect(store().past.length).toBe(steps)
  })

  it('removes the field, rather than leaving an empty list, when the last hint goes', () => {
    store().setHints(id, [{ text: 'Going.' }])
    store().setHints(id, [])
    expect('hints' in node()).toBe(false)
  })

  it('applies the loader’s rules: no empty hint, no unknown tone, no more than the cap', () => {
    const many: NodeHint[] = Array.from({ length: MAX_HINTS + 2 }, (_, i) => ({ text: `${i}` }))
    store().setHints(id, [
      { text: '   ' },
      { text: 'Styled.', tone: 'url(evil)' as NodeHint['tone'] },
      ...many,
    ])
    const hints = node().hints!
    expect(hints).toHaveLength(MAX_HINTS)
    expect(hints[0]).toEqual({ text: 'Styled.' })
  })

  it('ignores a node that is not there', () => {
    const before = store().graph
    store().setHints('nope', [{ text: 'Nowhere.' }])
    expect(store().graph).toBe(before)
  })
})

describe('editingHint', () => {
  it('is session state, dropped when the document changes', () => {
    const before = store().graph
    store().editHint({ nodeId: id })
    expect(store().editingHint).toEqual({ nodeId: id })
    // Not a graph edit: opening the editor records nothing.
    expect(store().graph).toBe(before)

    store().newGraph()
    expect(store().editingHint).toBeUndefined()
  })
})
