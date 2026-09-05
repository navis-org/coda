// @vitest-environment jsdom

/**
 * `spliceNode` — the store half of dropping a card on a wire.
 *
 * One assertion carries this: **⌘Z undoes the whole gesture.** The move and the rewire go in one
 * `commit` under the drag's own gesture tag, so undo lands on the graph as it was before the drag
 * began. Two commits would be two steps, the first of which leaves the graph rewired around a
 * card in its new position — a state nobody was ever in and nobody asked for.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

/** `Find Neurons → Table`, plus a loose Filter at the origin. */
function setup() {
  const store = useGraphStore.getState()
  const find = store.addNode('neuron.findNeurons', { x: 0, y: 0 })
  const table = store.addNode('out.table', { x: 400, y: 0 })
  useGraphStore
    .getState()
    .connect({ source: find, sourceHandle: 'neurons', target: table, targetHandle: 'in' })
  const loose = useGraphStore.getState().addNode('core.filterTable', { x: 0, y: 300 })
  const edgeId = useGraphStore.getState().graph.edges.find((e) => e.target === table)!.id
  return { find, table, loose, edgeId }
}

const links = () =>
  useGraphStore
    .getState()
    .graph.edges.map((e) => `${e.source}:${e.sourceHandle}→${e.target}:${e.targetHandle}`)

describe('spliceNode', () => {
  it('rewires and moves in one go', () => {
    const { find, table, loose, edgeId } = setup()
    useGraphStore
      .getState()
      .spliceNode(loose, edgeId, [{ id: loose, position: { x: 200, y: 0 } }])

    expect(links()).toContain(`${find}:neurons→${loose}:in`)
    expect(links()).toContain(`${loose}:out→${table}:in`)
    expect(links()).not.toContain(`${find}:neurons→${table}:in`)
    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === loose)?.position).toEqual({
      x: 200,
      y: 0,
    })
  })

  it('undoes to before the drag, not to the middle of it', () => {
    const { find, table, loose, edgeId } = setup()
    const before = links()

    // Mid-drag frames, as `onNodesChange` emits them: no history, same gesture tag.
    useGraphStore.getState().moveNodes([{ id: loose, position: { x: 100, y: 100 } }], false)
    useGraphStore.getState().moveNodes([{ id: loose, position: { x: 200, y: 10 } }], false)
    useGraphStore
      .getState()
      .spliceNode(loose, edgeId, [{ id: loose, position: { x: 200, y: 0 } }])

    useGraphStore.getState().undo()
    expect(links()).toEqual(before)
    expect(links()).toContain(`${find}:neurons→${table}:in`)
    // And the card is back where the drag started, not at its last frame.
    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === loose)?.position).toEqual({
      x: 0,
      y: 300,
    })
  })

  it('is an ordinary move when the node does not fit', () => {
    /*
     * The re-check inside the commit. A candidate is computed on a pointer move and the graph
     * could have changed under it by the drop — and a splice that could not be honoured must
     * still leave the card where it was let go, rather than snapping back.
     */
    const store = useGraphStore.getState()
    const find = store.addNode('neuron.findNeurons', { x: 0, y: 0 })
    const table = useGraphStore.getState().addNode('out.table', { x: 400, y: 0 })
    useGraphStore
      .getState()
      .connect({ source: find, sourceHandle: 'neurons', target: table, targetHandle: 'in' })
    // A Dataset node has no input a neuron table could land on.
    const ds = useGraphStore.getState().addNode('neuron.dataset', { x: 0, y: 300 })
    const edgeId = useGraphStore.getState().graph.edges.find((e) => e.target === table)!.id

    const before = links()
    useGraphStore.getState().spliceNode(ds, edgeId, [{ id: ds, position: { x: 200, y: 0 } }])
    expect(links()).toEqual(before)
    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === ds)?.position).toEqual({
      x: 200,
      y: 0,
    })
  })
})
