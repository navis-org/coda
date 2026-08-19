/**
 * Breaking and re-routing links.
 *
 * Both gestures on the canvas end up here — the wire's right-click menu calls `deleteEdges`,
 * dragging an end off calls `reconnect` or, when it lands on nothing, `deleteEdges` again. The
 * canvas half cannot be tested: React Flow renders no wires for nodes jsdom never measured, and
 * the reconnect anchors are SVG circles driven by pointer capture. So the contract is pinned
 * where it actually lives.
 *
 * Three properties, each of which would be worse than not having the feature:
 *
 * - **A rewire is one undo step.** Two would mean ⌘Z leaves the graph in a state nobody asked
 *   for — the link unplugged, halfway through a gesture that finished.
 * - **A refused rewire changes nothing.** Dropping on a socket that says no is a miss; if it
 *   also cost the connection, every mis-aim would be destructive.
 * - **The edge keeps its id**, which is what makes the first property expressible at all.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

/** dataset → find → filter → table, plus a second table to re-route onto. */
function chain() {
  const store = useGraphStore.getState()
  const ds = store.addNode('neuron.dataset', { x: 0, y: 0 })
  const find = store.addNode('neuron.findNeurons', { x: 200, y: 0 })
  const filter = store.addNode('core.filter', { x: 400, y: 0 })
  const table = store.addNode('out.table', { x: 600, y: 0 })
  const table2 = store.addNode('out.table', { x: 600, y: 200 })
  store.connect({ source: ds, sourceHandle: 'dataset', target: find, targetHandle: 'dataset' })
  store.connect({ source: find, sourceHandle: 'neurons', target: filter, targetHandle: 'in' })
  store.connect({ source: filter, sourceHandle: 'out', target: table, targetHandle: 'in' })
  return { ds, find, filter, table, table2 }
}

const edges = () => useGraphStore.getState().graph.edges
const wiring = () => edges().map((e) => `${e.source}->${e.target}`).sort()

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

describe('deleteEdges', () => {
  it('removes the link and leaves both nodes standing', () => {
    const { filter, table } = chain()
    const link = edges().find((e) => e.source === filter)!

    useGraphStore.getState().deleteEdges([link.id])

    expect(edges().some((e) => e.id === link.id)).toBe(false)
    expect(useGraphStore.getState().graph.nodes.map((n) => n.id)).toContain(table)
    expect(useGraphStore.getState().graph.nodes.map((n) => n.id)).toContain(filter)
  })

  it('is one undo step', () => {
    const { filter } = chain()
    const before = wiring()
    useGraphStore.getState().deleteEdges([edges().find((e) => e.source === filter)!.id])

    useGraphStore.getState().undo()

    expect(wiring()).toEqual(before)
  })

  it('ignores an empty list rather than recording an undo step for nothing', () => {
    chain()
    const before = useGraphStore.getState().graph
    useGraphStore.getState().deleteEdges([])
    expect(useGraphStore.getState().graph).toBe(before)
  })
})

describe('reconnect', () => {
  it('moves the target end onto another node', () => {
    const { filter, table2 } = chain()
    const link = edges().find((e) => e.source === filter)!

    const ok = useGraphStore
      .getState()
      .reconnect(link.id, {
        source: filter,
        sourceHandle: 'out',
        target: table2,
        targetHandle: 'in',
      })

    expect(ok).toBe(true)
    const moved = edges().filter((e) => e.source === filter)
    expect(moved).toHaveLength(1)
    expect(moved[0]!.target).toBe(table2)
    expect(moved[0]!.id).toBe(link.id)
  })

  it('moves the source end, changing what feeds the target', () => {
    const { find, filter, table } = chain()
    const link = edges().find((e) => e.target === table)!

    // Skip the filter: feed the table straight off Find Neurons.
    const ok = useGraphStore
      .getState()
      .reconnect(link.id, {
        source: find,
        sourceHandle: 'neurons',
        target: table,
        targetHandle: 'in',
      })

    expect(ok).toBe(true)
    expect(edges().filter((e) => e.target === table).map((e) => e.source)).toEqual([find])
    expect(edges().some((e) => e.source === filter)).toBe(false)
  })

  it('is one undo step', () => {
    const { filter, table2 } = chain()
    const before = wiring()
    const link = edges().find((e) => e.source === filter)!

    useGraphStore
      .getState()
      .reconnect(link.id, {
        source: filter,
        sourceHandle: 'out',
        target: table2,
        targetHandle: 'in',
      })
    useGraphStore.getState().undo()

    expect(wiring()).toEqual(before)
  })

  /**
   * The wire snaps back. Validation is the same `checkConnection` a fresh drag runs, so the
   * refusal message is the same one the connection would have given — no second vocabulary for
   * the same rejection.
   */
  it('refuses a type mismatch, leaving the graph untouched and saying why', () => {
    const { ds, filter, table } = chain()
    const link = edges().find((e) => e.target === table)!
    const before = useGraphStore.getState().graph

    const ok = useGraphStore
      .getState()
      .reconnect(link.id, {
        source: ds,
        sourceHandle: 'dataset',
        target: filter,
        targetHandle: 'in',
      })

    expect(ok).toBe(false)
    expect(useGraphStore.getState().graph).toBe(before)
    expect(useGraphStore.getState().notice).toBeTruthy()
  })

  /**
   * The link being moved is still in the graph while `createsCycle` runs, and that is fine: the
   * walk goes *forward* from the proposed target, and the old edge points into its old target,
   * so it can never sit on a path back to the source. What must still be caught is a genuine
   * loop — here, feeding the filter from the table it already feeds.
   */
  it('refuses a rewire that would close a cycle', () => {
    const { filter, table } = chain()
    const link = edges().find((e) => e.target === table)!
    const before = useGraphStore.getState().graph

    const ok = useGraphStore
      .getState()
      .reconnect(link.id, {
        source: table,
        sourceHandle: 'out',
        target: filter,
        targetHandle: 'in',
      })

    expect(ok).toBe(false)
    expect(useGraphStore.getState().graph).toBe(before)
  })

  it('accepts a re-drop on the port the link already occupies', () => {
    const { filter, table } = chain()
    const link = edges().find((e) => e.target === table)!

    const ok = useGraphStore
      .getState()
      .reconnect(link.id, {
        source: filter,
        sourceHandle: 'out',
        target: table,
        targetHandle: 'in',
      })

    expect(ok).toBe(true)
    expect(edges().filter((e) => e.target === table)).toHaveLength(1)
    expect(edges().find((e) => e.target === table)!.id).toBe(link.id)
  })
})
