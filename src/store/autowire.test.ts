/**
 * A new node's Dataset socket arrives fed.
 *
 * The behaviour is a single edge; what is easy to get wrong is when it must *not* appear.
 * A guess made where the canvas holds two connectomes, or one made while a saved graph is being
 * opened, is worse than the empty socket it replaces — both read as the editor having wired
 * something the user did not, with nothing on screen to say which dataset it picked or why.
 *
 * Driven through the store rather than the pure function, because the properties that matter
 * are the ones the two compose: that the wire and the node are one undo step, and that the
 * Description companion is still wired to its own host.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

const graph = () => useGraphStore.getState().graph
const add = (type: string, at = { x: 100, y: 100 }) =>
  useGraphStore.getState().addNode(type, at)

/** The node feeding `nodeId`'s Dataset input, if anything does. */
function datasetFeeding(nodeId: string): string | undefined {
  return graph().edges.find((e) => e.target === nodeId && e.targetHandle === 'dataset')?.source
}

describe('adding a node with a Dataset input', () => {
  it('wires it to the one dataset on the canvas', () => {
    const ds = add('neuron.dataset', { x: 0, y: 0 })

    const find = add('neuron.findNeurons', { x: 300, y: 0 })

    expect(datasetFeeding(find)).toBe(ds)
  })

  it('is not specific to one node type', () => {
    const ds = add('neuron.dataset', { x: 0, y: 0 })

    expect(datasetFeeding(add('neuron.explore', { x: 300, y: 0 }))).toBe(ds)
    expect(datasetFeeding(add('dataset.description', { x: 300, y: 300 }))).toBe(ds)
    expect(datasetFeeding(add('out.neuroglancer', { x: 600, y: 0 }))).toBe(ds)
  })

  it('leaves the socket empty when two datasets make the question ambiguous', () => {
    add('neuron.dataset', { x: 0, y: 0 })
    add('neuron.dataset', { x: 0, y: 200 })

    expect(datasetFeeding(add('neuron.findNeurons', { x: 300, y: 0 }))).toBeUndefined()
  })

  it('leaves the socket empty when there is no dataset at all', () => {
    expect(datasetFeeding(add('neuron.findNeurons'))).toBeUndefined()
    expect(graph().edges).toHaveLength(0)
  })

  it('touches nothing but Dataset sockets', () => {
    add('neuron.dataset', { x: 0, y: 0 })
    const find = add('neuron.findNeurons', { x: 300, y: 0 })

    // Neurons, Table and the rest stay for the user to wire: one table on a canvas is a
    // canvas half built, not an answer.
    expect(graph().edges.filter((e) => e.target === find)).toHaveLength(1)
  })

  it('is one undo step with the node itself', () => {
    add('neuron.dataset', { x: 0, y: 0 })
    const before = graph()

    add('neuron.findNeurons', { x: 300, y: 0 })
    useGraphStore.getState().undo()

    expect(graph().nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id))
    expect(graph().edges.map((e) => e.id)).toEqual(before.edges.map((e) => e.id))
  })
})

describe('what it refuses to do', () => {
  it('does not wire a socket while a saved graph is being opened', () => {
    const def = requireNodeDef('neuron.findNeurons')
    let saved = addNode(emptyGraph('saved'), {
      id: 'ds',
      type: 'neuron.dataset',
      position: { x: 0, y: 0 },
      params: defaultParams(requireNodeDef('neuron.dataset')),
    })
    saved = addNode(saved, {
      id: 'find',
      type: 'neuron.findNeurons',
      position: { x: 300, y: 0 },
      params: defaultParams(def),
    })

    useGraphStore.getState().loadGraph(saved)

    // Somebody unplugged that wire, or never made it. Reproducing the file is the only
    // acceptable behaviour; a graph that grows an edge every time it opens is unusable.
    expect(datasetFeeding('find')).toBeUndefined()
  })

  it('does not steal a Dataset input from the companion it belongs to', () => {
    add('neuron.dataset', { x: 0, y: 0 })

    const hemibrain = add('dataset.hemibrain', { x: 300, y: 0 })
    const card = graph().nodes.find((n) => n.type === 'dataset.description')!

    // The card is wired by its own companion spec, to the node it was added with — not by
    // the auto-wire, which would have had two candidates and refused anyway.
    expect(datasetFeeding(card.id)).toBe(hemibrain)
  })

  it('does not displace a wire the user already made', () => {
    const ds = add('neuron.dataset', { x: 0, y: 0 })
    const other = add('neuron.dataset', { x: 0, y: 200 })
    const find = add('neuron.findNeurons', { x: 300, y: 0 })
    useGraphStore.getState().connect({
      source: other,
      sourceHandle: 'dataset',
      target: find,
      targetHandle: 'dataset',
    })

    // Deleting one of the two leaves a single dataset on the canvas, but nothing re-runs:
    // the auto-wire happens on add and never repairs the graph afterwards.
    useGraphStore.getState().deleteNodes([ds])

    expect(datasetFeeding(find)).toBe(other)
  })
})

describe('the dataset node itself', () => {
  it('arrives with its card and nothing else', () => {
    add('neuron.dataset', { x: 0, y: 0 })
    const before = graph().edges.length

    add('neuron.dataset', { x: 0, y: 200 })

    // A dataset node has no Dataset input, so a second one is not wired to the first.
    expect(graph().edges).toHaveLength(before)
  })
})
