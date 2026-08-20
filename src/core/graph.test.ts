import { describe, expect, it } from 'vitest'

import '../nodes'
import {
  addEdge,
  addNode,
  ancestors,
  deserializeGraph,
  descendants,
  emptyGraph,
  reconnectEdge,
  removeNodes,
  serializeGraph,
  topoSort,
  wouldCreateCycle,
} from './graph'
import type { CodaGraph, GraphNode } from './graph'
import { defaultParams } from './node'
import { requireNodeDef } from './registry'

function node(id: string, type: string, x = 0, y = 0): GraphNode {
  return { id, type, position: { x, y }, params: defaultParams(requireNodeDef(type)) }
}

/** dataset -> findNeurons -> filter -> table */
function chain(): CodaGraph {
  let g = emptyGraph('test')
  g = addNode(g, node('ds', 'neuron.dataset'))
  g = addNode(g, node('find', 'neuron.findNeurons'))
  g = addNode(g, node('filter', 'core.filter'))
  g = addNode(g, node('view', 'out.table'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'filter',
    targetHandle: 'in',
  })
  g = addEdge(g, { source: 'filter', sourceHandle: 'out', target: 'view', targetHandle: 'in' })
  return g
}

describe('topoSort', () => {
  it('orders a chain by dependency', () => {
    const { order, cyclic } = topoSort(chain())
    expect(cyclic).toEqual([])
    expect(order).toEqual(['ds', 'find', 'filter', 'view'])
  })

  it('reports nodes on a cycle instead of hanging', () => {
    let g = chain()
    // Force a cycle by hand — addEdge does not itself validate acyclicity.
    g = {
      ...g,
      edges: [
        ...g.edges,
        {
          id: 'bad',
          source: 'view',
          sourceHandle: 'out',
          target: 'filter',
          targetHandle: 'in',
        },
      ],
    }
    const { order, cyclic } = topoSort(g)
    expect(order).toEqual(['ds', 'find'])
    expect(cyclic.sort()).toEqual(['filter', 'view'])
  })

  /*
   * Two wires between the same pair of nodes are not a cycle, and reading them as one is not a
   * hypothetical: `Paths` hands its network *and* its layout to a single `Network` node, and
   * Explore's `Hits` and `Selected` can both land on one Join.
   *
   * It failed in a way that pointed nowhere near the sort. `wouldCreateCycle` is a separate and
   * correct walk, so the link connected; then the target's types vanished from inference and
   * every column picker on it emptied out, while a result cached from before the second wire
   * stayed on screen. It read as the node having lost its schema.
   */
  it('does not read a second wire between the same two nodes as a cycle', () => {
    let g = emptyGraph('two-wires')
    g = addNode(g, node('paths', 'neuron.paths'))
    g = addNode(g, node('net', 'out.network'))
    g = addEdge(g, {
      source: 'paths',
      sourceHandle: 'network',
      target: 'net',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'paths',
      sourceHandle: 'layout',
      target: 'net',
      targetHandle: 'layout',
    })

    const { order, cyclic } = topoSort(g)
    expect(cyclic).toEqual([])
    expect(order).toEqual(['paths', 'net'])
  })

  it('still counts a node fed twice from two different nodes exactly once each', () => {
    // The other half of the same arithmetic: deduplicating per *source* must not collapse two
    // distinct feeders into one, or the target unblocks a round early.
    let g = emptyGraph('two-feeders')
    g = addNode(g, node('a', 'neuron.findNeurons'))
    g = addNode(g, node('b', 'neuron.findNeurons'))
    g = addNode(g, node('join', 'core.join'))
    g = addEdge(g, {
      source: 'a',
      sourceHandle: 'neurons',
      target: 'join',
      targetHandle: 'left',
    })
    g = addEdge(g, {
      source: 'b',
      sourceHandle: 'neurons',
      target: 'join',
      targetHandle: 'right',
    })

    const { order, cyclic } = topoSort(g)
    expect(cyclic).toEqual([])
    expect(order.indexOf('join')).toBe(2)
  })

  it('is deterministic for independent nodes', () => {
    let g = emptyGraph()
    g = addNode(g, node('a', 'neuron.dataset'))
    g = addNode(g, node('b', 'neuron.dataset'))
    expect(topoSort(g).order).toEqual(['a', 'b'])
  })
})

describe('reachability', () => {
  it('computes descendants and ancestors', () => {
    const g = chain()
    expect([...descendants(g, 'find')].sort()).toEqual(['filter', 'view'])
    expect([...ancestors(g, 'filter')].sort()).toEqual(['ds', 'find'])
    expect([...descendants(g, 'view')]).toEqual([])
  })

  it('detects cycles before they are created', () => {
    const g = chain()
    expect(wouldCreateCycle(g, 'view', 'find')).toBe(true)
    expect(wouldCreateCycle(g, 'ds', 'view')).toBe(false)
    expect(wouldCreateCycle(g, 'ds', 'ds')).toBe(true)
  })
})

describe('mutations', () => {
  it('replaces an existing edge on the same input port', () => {
    let g = chain()
    g = addNode(g, node('find2', 'neuron.findNeurons'))
    g = addEdge(g, {
      source: 'find2',
      sourceHandle: 'neurons',
      target: 'filter',
      targetHandle: 'in',
    })
    const intoFilter = g.edges.filter((e) => e.target === 'filter' && e.targetHandle === 'in')
    expect(intoFilter).toHaveLength(1)
    expect(intoFilter[0]!.source).toBe('find2')
  })

  it('removes dangling edges when a node is deleted', () => {
    const g = removeNodes(chain(), ['find'])
    expect(g.nodes.map((n) => n.id)).toEqual(['ds', 'filter', 'view'])
    expect(g.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['filter->view'])
  })
})

describe('reconnectEdge', () => {
  /**
   * The id is the contract. React Flow keys wires by it and the reconnect gesture is still in
   * flight when this runs, so minting a fresh one remounts the element being dragged.
   */
  it('moves the target end and keeps the edge id', () => {
    let g = chain()
    g = addNode(g, node('view2', 'out.table'))
    const link = g.edges.find((e) => e.source === 'filter')!
    g = reconnectEdge(g, link.id, {
      source: 'filter',
      sourceHandle: 'out',
      target: 'view2',
      targetHandle: 'in',
    })
    const moved = g.edges.filter((e) => e.source === 'filter')
    expect(moved).toHaveLength(1)
    expect(moved[0]!.id).toBe(link.id)
    expect(moved[0]!.target).toBe('view2')
  })

  it('moves the source end', () => {
    let g = chain()
    g = addNode(g, node('find2', 'neuron.findNeurons'))
    const link = g.edges.find((e) => e.target === 'filter')!
    g = reconnectEdge(g, link.id, {
      source: 'find2',
      sourceHandle: 'neurons',
      target: 'filter',
      targetHandle: 'in',
    })
    const intoFilter = g.edges.filter((e) => e.target === 'filter')
    expect(intoFilter).toHaveLength(1)
    expect(intoFilter[0]!.id).toBe(link.id)
    expect(intoFilter[0]!.source).toBe('find2')
  })

  /**
   * The removal has to happen before the add, or `addEdge` evicts the link already sitting on
   * the destination port and the moved edge lands beside its own stale self, two edges sharing
   * one id.
   */
  it('evicts whatever occupied the destination port, leaving one edge per id', () => {
    let g = chain()
    g = addNode(g, node('find2', 'neuron.findNeurons'))
    g = addNode(g, node('filter2', 'core.filter'))
    g = addEdge(g, {
      source: 'find2',
      sourceHandle: 'neurons',
      target: 'filter2',
      targetHandle: 'in',
    })
    // Move find -> filter across onto filter2's occupied input.
    const link = g.edges.find((e) => e.source === 'find' && e.target === 'filter')!
    g = reconnectEdge(g, link.id, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'filter2',
      targetHandle: 'in',
    })
    expect(g.edges.filter((e) => e.target === 'filter2')).toHaveLength(1)
    expect(g.edges.filter((e) => e.target === 'filter')).toHaveLength(0)
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length)
  })
})

describe('serialisation', () => {
  it('round-trips a graph', () => {
    const original = chain()
    const { graph, warnings } = deserializeGraph(serializeGraph(original))
    expect(warnings).toEqual([])
    expect(graph.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id))
    expect(graph.edges).toHaveLength(original.edges.length)
    expect(graph.nodes[1]!.params).toEqual(original.nodes[1]!.params)
  })

  it('drops unknown node types with a warning rather than failing', () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        { id: 'a', type: 'neuron.dataset', position: { x: 0, y: 0 }, params: {} },
        { id: 'ghost', type: 'future.node', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [
        { id: 'e1', source: 'a', sourceHandle: 'dataset', target: 'ghost', targetHandle: 'in' },
      ],
    })
    const { graph, warnings } = deserializeGraph(json)
    expect(graph.nodes.map((n) => n.id)).toEqual(['a'])
    expect(graph.edges).toEqual([])
    expect(warnings.join(' ')).toContain('future.node')
  })

  it('rejects structurally invalid files', () => {
    expect(() => deserializeGraph('not json')).toThrow(/valid JSON/)
    expect(() => deserializeGraph('{"version":1}')).toThrow(/nodes/)
  })

  it('warns when the file is from a newer format', () => {
    const json = JSON.stringify({ version: 99, nodes: [], edges: [] })
    expect(deserializeGraph(json).warnings.join(' ')).toContain('newer')
  })

  it('round-trips a folded param band, and treats an absent flag as shown', () => {
    // The band is folded on the card, not in the widget, so it has to survive the file the
    // same way `collapsed` does — otherwise a workspace set up for reading reopens as a
    // stack of forms. Absent means shown, which is what keeps every graph saved before the
    // flag existed looking exactly as it did.
    const json = JSON.stringify({
      version: 1,
      nodes: [
        {
          id: 'folded',
          type: 'out.table',
          position: { x: 0, y: 0 },
          params: {},
          paramsCollapsed: true,
        },
        { id: 'plain', type: 'out.table', position: { x: 0, y: 0 }, params: {} },
      ],
      edges: [],
    })
    const { graph } = deserializeGraph(json)
    const folded = Object.fromEntries(graph.nodes.map((n) => [n.id, n.paramsCollapsed]))
    expect(folded['folded']).toBe(true)
    expect(folded['plain']).toBeUndefined()
    // And back out again through the writer the download and the shelf both use.
    const again = deserializeGraph(serializeGraph(graph)).graph
    expect(again.nodes.find((n) => n.id === 'folded')?.paramsCollapsed).toBe(true)
  })

  it('round-trips a resized card, and refuses a size that cannot be grabbed again', () => {
    // A zero or negative size collapses the node to nothing on the canvas with no handle
    // left to drag, which is unrecoverable from the UI — so a bad one is dropped, not kept.
    const node = (id: string, size: unknown) => ({
      id,
      type: 'out.table',
      position: { x: 0, y: 0 },
      params: {},
      size,
    })
    const json = JSON.stringify({
      version: 1,
      nodes: [
        node('good', { width: 480, height: 360 }),
        node('zero', { width: 0, height: 200 }),
        node('junk', { width: 'wide' }),
        node('none', undefined),
      ],
      edges: [],
    })
    const { graph } = deserializeGraph(json)
    const sizes = Object.fromEntries(graph.nodes.map((n) => [n.id, n.size]))
    expect(sizes['good']).toEqual({ width: 480, height: 360 })
    expect(sizes['zero']).toBeUndefined()
    expect(sizes['junk']).toBeUndefined()
    expect(sizes['none']).toBeUndefined()
  })
})

describe('meta on load', () => {
  /**
   * `meta` used to be passed through whole, which was harmless while nothing acted on it. It is
   * not now: `meta.gist` names a gist the Share dialog will PATCH with the user's token, and a
   * `.coda.json` is a file people mail each other.
   */
  it('keeps a well-formed gist reference', () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [],
      edges: [],
      meta: { name: 'Sweep', gist: { id: 'abc123', owner: 'schlegelp' } },
    })
    expect(deserializeGraph(json).graph.meta).toEqual({
      name: 'Sweep',
      gist: { id: 'abc123', owner: 'schlegelp' },
    })
  })

  it('drops a gist reference that is not one, rather than trusting the file', () => {
    for (const gist of [42, 'abc', null, {}, { owner: 'x' }, { id: 7 }]) {
      const json = JSON.stringify({
        version: 1,
        nodes: [],
        edges: [],
        meta: { name: 'n', gist },
      })
      expect(deserializeGraph(json).graph.meta?.gist).toBeUndefined()
    }
  })

  it('drops an owner that is not text but keeps the id', () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [],
      edges: [],
      meta: { gist: { id: 'abc123', owner: 99 } },
    })
    expect(deserializeGraph(json).graph.meta?.gist).toEqual({ id: 'abc123' })
  })

  it('ignores keys it does not know, and a meta that is not an object', () => {
    const withJunk = JSON.stringify({
      version: 1,
      nodes: [],
      edges: [],
      meta: { name: 'n', evil: { toString: 1 } },
    })
    expect(deserializeGraph(withJunk).graph.meta).toEqual({ name: 'n' })
    const notObject = JSON.stringify({ version: 1, nodes: [], edges: [], meta: 'nope' })
    expect(deserializeGraph(notObject).graph.meta).toBeUndefined()
  })
})

describe('compact serialisation', () => {
  it('is the same document without the indentation', () => {
    const graph = emptyGraph('Sweep')
    const pretty = serializeGraph(graph)
    const compact = serializeGraph(graph, { compact: true })
    expect(compact.length).toBeLessThan(pretty.length)
    expect(compact).not.toContain('\n')
    // Same document, modulo the `modifiedAt` stamp each call mints.
    const strip = (json: string) => {
      const parsed = JSON.parse(json) as { meta?: Record<string, unknown> }
      delete parsed.meta?.['modifiedAt']
      return parsed
    }
    expect(strip(compact)).toEqual(strip(pretty))
  })
})
