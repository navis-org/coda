/**
 * The headless half of automatic layout: the mapping into ELK, and where the answer lands.
 *
 * Two things here are worth more than the rest. The **port index convention** is checked against
 * the real algorithm rather than against a comment, because ELK numbers ports clockwise around a
 * node and getting that backwards mirrors every card's sockets while still producing a layout
 * that looks perfectly reasonable — it just crosses more. And the **option keys** are checked the
 * same way, because ELK *ignores* an option it does not recognise instead of rejecting it, so a
 * typo in one of these strings is invisible to a type check, a lint pass and the eye.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import type { CodaGraph, GraphNode } from '../core/graph'
import type { NetworkValue } from '../core/values'
import { tableFromRows } from '../core/values'
import { column, tableSchema } from '../core/types'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'

import type { MeasuredSizes, NodeSize } from './elkGraph'
import {
  FALLBACK_NODE_SIZE,
  arrangeScope,
  arrangeable,
  elkPortId,
  portIndices,
  positionsFrom,
  resolveSize,
  toElkGraph,
} from './elkGraph'
import { runLayout } from './engine'
import { NETWORK_NODE_SIZE, layoutNetwork } from './network'
import { DEFAULT_LAYOUT_OPTIONS, coerceLayoutOptions, elkOptionsFor } from './options'
import { DODGE_GAP, anchorTo, boundsOf, dodge, noteRects, structureKey } from './place'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function node(
  id: string,
  type: string,
  x = 0,
  y = 0,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    position: { x, y },
    params: defaultParams(requireNodeDef(type)),
    ...extra,
  }
}

/** Dataset → Find Neurons → Filter → Table, which is the shape of every bundled example. */
function chain(): CodaGraph {
  let graph = emptyGraph('chain')
  graph = addNode(graph, node('ds', 'dataset.hemibrain', 0, 0))
  graph = addNode(graph, node('find', 'neuron.findNeurons', 300, 0))
  graph = addNode(graph, node('filter', 'core.filter', 600, 0))
  graph = addNode(graph, node('table', 'out.table', 900, 0))
  graph = addEdge(graph, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  graph = addEdge(graph, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'filter',
    targetHandle: 'in',
  })
  graph = addEdge(graph, {
    source: 'filter',
    sourceHandle: 'out',
    target: 'table',
    targetHandle: 'in',
  })
  return graph
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

describe('resolveSize', () => {
  it('prefers what the canvas measured over anything the document says', () => {
    const measured: MeasuredSizes = new Map([['a', { width: 311, height: 417 }]])
    const withSize = node('a', 'out.table', 0, 0, { size: { width: 100, height: 100 } })
    expect(resolveSize(withSize, measured)).toEqual({ width: 311, height: 417 })
  })

  it('falls back through the user size, then the definition, then a constant', () => {
    expect(
      resolveSize(node('a', 'out.table', 0, 0, { size: { width: 100, height: 90 } })),
    ).toEqual({ width: 100, height: 90 })
    // out.profile is one of the nodes that asks for a bigger card.
    expect(resolveSize(node('p', 'out.profile'))).toEqual(
      requireNodeDef('out.profile').defaultSize,
    )
    expect(resolveSize(node('f', 'core.filter'))).toEqual(FALLBACK_NODE_SIZE)
  })

  it('treats a zero measurement as no measurement', () => {
    // React Flow reports 0x0 for a card it has mounted but not yet measured. Taking that
    // literally arranges a tidy grid of points.
    const measured: MeasuredSizes = new Map([['f', { width: 0, height: 0 }]])
    expect(resolveSize(node('f', 'core.filter'), measured)).toEqual(FALLBACK_NODE_SIZE)
  })
})

// ---------------------------------------------------------------------------
// What takes part
// ---------------------------------------------------------------------------

describe('arrangeable', () => {
  it('drops text notes and keeps everything else', () => {
    const nodes = [node('a', 'core.filter'), node('n', 'note.text'), node('t', 'out.table')]
    expect(arrangeable(nodes).map((n) => n.id)).toEqual(['a', 't'])
  })

  it('keeps a Description card, which is a connected node and not an annotation', () => {
    // It has a Dataset input and no outputs, so ELK gives it an ordinary slot. That is the
    // decided behaviour, not an oversight — see the module note.
    expect(arrangeable([node('d', 'dataset.description')])).toHaveLength(1)
  })
})

describe('arrangeScope', () => {
  it('takes the whole graph when nothing useful is selected', () => {
    const graph = chain()
    for (const selection of [[], ['find']]) {
      const scope = arrangeScope(graph, selection)
      expect(scope.scoped).toBe(false)
      expect(scope.nodes).toHaveLength(4)
      expect(scope.edges).toHaveLength(3)
    }
  })

  it('takes only the selection, and only edges with both ends inside it', () => {
    const scope = arrangeScope(chain(), ['find', 'filter'])
    expect(scope.scoped).toBe(true)
    expect(scope.nodes.map((n) => n.id)).toEqual(['find', 'filter'])
    // find→filter is in; ds→find and filter→table leave the set. An edge with one end outside
    // has no port for ELK to attach to and makes it reject the whole graph.
    expect(scope.edges.map((e) => e.id)).toHaveLength(1)
    expect(scope.edges[0]?.source).toBe('find')
  })

  it('never scopes to a note, however it was selected', () => {
    let graph = chain()
    graph = addNode(graph, node('n', 'note.text', 0, -200))
    const scope = arrangeScope(graph, ['n', 'find'])
    // One arrangeable node left, so this is the whole-graph case rather than a one-node scope.
    expect(scope.scoped).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

describe('portIndices', () => {
  it('numbers clockwise from the top-left: outputs in order, inputs reversed after them', () => {
    // Two outputs and three inputs. Clockwise with no north or south ports means east top to
    // bottom (0, 1), then west *bottom to top* (2, 3, 4) — so the first-declared input, which
    // the card draws at the top, takes the last index.
    expect(portIndices(3, 2)).toEqual({ outputs: [0, 1], inputs: [4, 3, 2] })
    expect(portIndices(1, 1)).toEqual({ outputs: [0], inputs: [1] })
    expect(portIndices(0, 0)).toEqual({ outputs: [], inputs: [] })
  })
})

describe('toElkGraph', () => {
  it('gives every socket a side and an index, keyed the way the graph keys ports', () => {
    const graph = chain()
    const elk = toElkGraph(graph.nodes, graph.edges, DEFAULT_LAYOUT_OPTIONS)
    const filter = elk.children?.find((c) => c.id === 'filter')
    const def = requireNodeDef('core.filter')

    expect(filter?.layoutOptions?.['elk.portConstraints']).toBe('FIXED_ORDER')
    const sides = Object.fromEntries(
      (filter?.ports ?? []).map((p) => [p.id, p.layoutOptions?.['elk.port.side']]),
    )
    for (const port of defaultInputPorts(def))
      expect(sides[elkPortId('filter', port.id)]).toBe('WEST')
    for (const port of defaultOutputPorts(def))
      expect(sides[elkPortId('filter', port.id)]).toBe('EAST')
  })

  it('wires edges to ports rather than to nodes', () => {
    const graph = chain()
    const elk = toElkGraph(graph.nodes, graph.edges, DEFAULT_LAYOUT_OPTIONS)
    const edge = elk.edges?.find((e) => e.sources[0]?.startsWith('find'))
    // Node-to-node edges would make FIXED_ORDER meaningless: ELK would not know which socket
    // each wire belongs to, which is the entire point of declaring the order.
    expect(edge?.sources).toEqual([elkPortId('find', 'neurons')])
    expect(edge?.targets).toEqual([elkPortId('filter', 'in')])
  })

  it('drops edges leaving the given node set', () => {
    const graph = chain()
    const only = graph.nodes.filter((n) => n.id === 'find' || n.id === 'filter')
    const elk = toElkGraph(only, graph.edges, DEFAULT_LAYOUT_OPTIONS)
    expect(elk.edges).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('elkOptionsFor', () => {
  it('sends the layered keys for layered', () => {
    const options = elkOptionsFor({ ...DEFAULT_LAYOUT_OPTIONS, layerSpacing: 140 })
    expect(options['elk.algorithm']).toBe('layered')
    expect(options['elk.layered.spacing.nodeNodeBetweenLayers']).toBe('140')
    expect(options['elk.layered.nodePlacement.strategy']).toBe('BRANDES_KOEPF')
  })

  it('folds the layer gap into the node gap for the algorithms that have no layers', () => {
    // Otherwise switching to force silently disconnects a slider that is still on screen.
    const options = elkOptionsFor({
      ...DEFAULT_LAYOUT_OPTIONS,
      algorithm: 'force',
      nodeSpacing: 40,
      layerSpacing: 120,
    })
    expect(options['elk.layered.spacing.nodeNodeBetweenLayers']).toBeUndefined()
    expect(options['elk.spacing.nodeNode']).toBe('120')
  })
})

describe('coerceLayoutOptions', () => {
  it('falls back per field rather than all at once', () => {
    const coerced = coerceLayoutOptions({
      algorithm: 'no-such-algorithm',
      direction: 'DOWN',
      nodeSpacing: 64,
    })
    // The good fields survive a bad neighbour: a build that adds a control must not throw away
    // the ones somebody has already set.
    expect(coerced.direction).toBe('DOWN')
    expect(coerced.nodeSpacing).toBe(64)
    expect(coerced.algorithm).toBe(DEFAULT_LAYOUT_OPTIONS.algorithm)
  })

  it('clamps spacings and reads a missing checkbox as on', () => {
    expect(coerceLayoutOptions({ nodeSpacing: 100000 }).nodeSpacing).toBe(240)
    expect(coerceLayoutOptions({ layerSpacing: -5 }).layerSpacing).toBe(16)
    expect(coerceLayoutOptions({}).packComponents).toBe(true)
    expect(coerceLayoutOptions(null).packComponents).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const sizesFor = (ids: string[], size: NodeSize = { width: 200, height: 100 }) =>
  new Map(ids.map((id) => [id, size]))

describe('anchorTo', () => {
  it('puts the block back where the block was', () => {
    // ELK lays out from the origin. Without this, arranging a graph on a canvas panned away
    // from (0,0) teleports it off screen, which reads as having deleted it.
    const raw = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 300, y: 50 }],
    ])
    const anchored = anchorTo(raw, sizesFor(['a', 'b']), { x: 1000, y: -400 })
    expect(anchored.get('a')).toEqual({ x: 1000, y: -400 })
    expect(anchored.get('b')).toEqual({ x: 1300, y: -350 })
  })

  it('rounds, because these coordinates are written into the saved file', () => {
    const anchored = anchorTo(new Map([['a', { x: 0.4, y: 0 }]]), sizesFor(['a']), {
      x: 10.3,
      y: 20.7,
    })
    expect(anchored.get('a')).toEqual({ x: 10, y: 21 })
  })
})

describe('dodge', () => {
  const sizes = sizesFor(['a'])

  it('leaves the block alone when nothing is in the way', () => {
    const positions = new Map([['a', { x: 0, y: 400 }]])
    expect(dodge(positions, sizes, [{ x: 0, y: 0, width: 300, height: 100 }]).get('a')).toEqual(
      {
        x: 0,
        y: 400,
      },
    )
  })

  it('pushes below the note it collides with, and only downwards', () => {
    const positions = new Map([['a', { x: 0, y: 50 }]])
    const moved = dodge(positions, sizes, [{ x: 0, y: 0, width: 300, height: 120 }])
    expect(moved.get('a')).toEqual({ x: 0, y: 120 + DODGE_GAP })
  })

  it('resolves note by note rather than against one union rectangle', () => {
    // A note above the chain and another far below is the shape every bundled example has. The
    // union of those two spans the whole canvas, and clearing *that* would fling the pipeline
    // hundreds of units down past empty space it never touched.
    const positions = new Map([['a', { x: 0, y: 50 }]])
    const notes = [
      { x: 0, y: 0, width: 300, height: 120 },
      { x: 0, y: 2000, width: 300, height: 120 },
    ]
    expect(dodge(positions, sizes, notes).get('a')?.y).toBe(120 + DODGE_GAP)
  })
})

describe('noteRects', () => {
  it('reports the notes and nothing else', () => {
    let graph = chain()
    graph = addNode(
      graph,
      node('n', 'note.text', 20, -300, { size: { width: 400, height: 120 } }),
    )
    const rects = noteRects(graph)
    expect(rects).toEqual([{ x: 20, y: -300, width: 400, height: 120 }])
  })
})

describe('boundsOf', () => {
  it('is undefined for nothing, and a union otherwise', () => {
    expect(boundsOf([])).toBeUndefined()
    const bounds = boundsOf([
      node('a', 'core.filter', 0, 0, { size: { width: 100, height: 50 } }),
      node('b', 'core.filter', 200, 100, { size: { width: 100, height: 50 } }),
    ])
    expect(bounds).toEqual({ x: 0, y: 0, width: 300, height: 150 })
  })
})

// ---------------------------------------------------------------------------
// What auto mode watches
// ---------------------------------------------------------------------------

describe('structureKey', () => {
  it('ignores position, so a drag never asks for a new arrangement', () => {
    const graph = chain()
    const moved = {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, position: { x: n.position.x + 500, y: 42 } })),
    }
    expect(structureKey(moved)).toBe(structureKey(graph))
  })

  it('ignores params, so typing never moves anything', () => {
    const graph = chain()
    const edited = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'filter' ? { ...n, params: { ...n.params, value: 'LC4' } } : n,
      ),
    }
    expect(structureKey(edited)).toBe(structureKey(graph))
  })

  it('changes on a wire, a collapse, a new node and a resize', () => {
    const graph = chain()
    const base = structureKey(graph)

    const unwired = { ...graph, edges: graph.edges.slice(1) }
    expect(structureKey(unwired)).not.toBe(base)

    const collapsed = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'find' ? { ...n, collapsed: true } : n)),
    }
    expect(structureKey(collapsed)).not.toBe(base)

    expect(structureKey(addNode(graph, node('t2', 'out.table', 900, 400)))).not.toBe(base)

    // A resize reaches it through the *measured* size, which is also how a param edit that
    // changes a card's height gets to count as structural without anyone listing which params do.
    const measured: MeasuredSizes = new Map([['find', { width: 232, height: 400 }]])
    expect(structureKey(graph, measured)).not.toBe(base)
  })
})

// ---------------------------------------------------------------------------
// The real algorithm
// ---------------------------------------------------------------------------

describe('runLayout, against ELK itself', () => {
  it('lays a chain out left to right, in pipeline order', async () => {
    const graph = chain()
    const { positions } = await runLayout(graph.nodes, graph.edges, DEFAULT_LAYOUT_OPTIONS)
    expect(positions.size).toBe(4)
    const x = (id: string) => positions.get(id)!.x
    expect(x('ds')).toBeLessThan(x('find'))
    expect(x('find')).toBeLessThan(x('filter'))
    expect(x('filter')).toBeLessThan(x('table'))
  })

  it('honours the direction option', async () => {
    const graph = chain()
    const { positions: down } = await runLayout(graph.nodes, graph.edges, {
      ...DEFAULT_LAYOUT_OPTIONS,
      direction: 'DOWN',
    })
    // The keys reach the algorithm, which is the thing being checked: ELK ignores an option it
    // does not recognise rather than complaining, so a mistyped key fails nothing else.
    expect(down.get('ds')!.y).toBeLessThan(down.get('find')!.y)
    expect(down.get('find')!.y).toBeLessThan(down.get('table')!.y)
  })

  it('gives a vertical direction a column rather than a staircase', async () => {
    /*
     * The measured half of `elkNodeOptions`. With the sockets pinned east and west, ELK
     * reserves room for a wire leaving a card's right edge and re-entering the left edge of the
     * one below, and a four-node chain laid out DOWN comes back as a diagonal — 756 units of
     * horizontal travel for a graph that should be a column. Freeing the ports under a vertical
     * direction is what fixes it, and this is the number that says whether it still does.
     */
    const graph = chain()
    const { positions: down } = await runLayout(graph.nodes, graph.edges, {
      ...DEFAULT_LAYOUT_OPTIONS,
      direction: 'DOWN',
    })
    const xs = [...down.values()].map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(120)
  })

  it('honours the spacing options', async () => {
    const graph = chain()
    const { positions: tight } = await runLayout(graph.nodes, graph.edges, {
      ...DEFAULT_LAYOUT_OPTIONS,
      layerSpacing: 20,
    })
    const { positions: loose } = await runLayout(graph.nodes, graph.edges, {
      ...DEFAULT_LAYOUT_OPTIONS,
      layerSpacing: 200,
    })
    expect(loose.get('table')!.x).toBeGreaterThan(tight.get('table')!.x)
  })

  it('puts the first-declared input at the top of the card', async () => {
    /*
     * The convention, checked against the algorithm rather than against the comment describing
     * it. `portIndices` claims ELK numbers clockwise from the top-left, which makes a WEST
     * port's index run bottom to top. If that is backwards, every card's sockets are mirrored
     * against the wires arriving at them — nothing throws, and the layout merely crosses more.
     */
    const withTwoInputs = requireNodeDef('out.neuroglancer')
    expect(defaultInputPorts(withTwoInputs).length).toBeGreaterThanOrEqual(2)

    const nodes = [node('ngl', 'out.neuroglancer')]
    const elk = toElkGraph(nodes, [], DEFAULT_LAYOUT_OPTIONS)
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
    const laid = await new ELK().layout(elk)

    const ports = laid.children?.[0]?.ports ?? []
    const yOf = (portId: string) => ports.find((p) => p.id === elkPortId('ngl', portId))?.y ?? 0
    const declared = defaultInputPorts(withTwoInputs).map((p) => yOf(p.id))
    for (let i = 1; i < declared.length; i++) {
      expect(declared[i]!).toBeGreaterThan(declared[i - 1]!)
    }
  })

  it('returns nothing for nothing, without waking the engine', async () => {
    expect(await runLayout([], [], DEFAULT_LAYOUT_OPTIONS)).toEqual({
      positions: new Map(),
      routes: new Map(),
    })
  })
})

describe('positionsFrom', () => {
  it('reads a laid-out graph, defaulting a missing coordinate to zero', () => {
    const positions = positionsFrom({
      id: 'root',
      children: [{ id: 'a', x: 10, y: 20 }, { id: 'b' }],
    })
    expect(positions.get('a')).toEqual({ x: 10, y: 20 })
    expect(positions.get('b')).toEqual({ x: 0, y: 0 })
  })
})

/**
 * A network's layout, against the real algorithm.
 *
 * The mapping is nearly all *decisions* — a box size nothing measures, centres rather than
 * corners, dangling endpoints dropped — and every one of them fails silently: a layout that
 * uses corners is off by half a box, which reads as a rendering quirk, and a dangling endpoint
 * makes ELK reject the entire graph, which reads as the layout being broken rather than as one
 * bad row.
 */
describe('layoutNetwork, against ELK itself', () => {
  const NODE_SCHEMA = tableSchema(column('id', 'str'))
  const EDGE_SCHEMA = tableSchema(
    column('source', 'str'),
    column('target', 'str'),
    column('weight', 'f64'),
  )

  function network(ids: string[], edges: Array<[string, string]>): NetworkValue {
    return {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(
        NODE_SCHEMA,
        ids.map((id) => ({ id })),
      ),
      edges: tableFromRows(
        EDGE_SCHEMA,
        edges.map(([source, target]) => ({ source, target, weight: 1 })),
      ),
    }
  }

  it('lays a feed-forward chain out along the flow axis, one node per layer', async () => {
    const positions = await layoutNetwork(
      network(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
        ],
      ),
    )
    const xs = ['a', 'b', 'c', 'd'].map((id) => positions[id]?.x ?? 0)
    // Strictly increasing x, and every node on one row: the shape a pathway should arrive in.
    for (let i = 1; i < xs.length; i++) expect(Number(xs[i])).toBeGreaterThan(Number(xs[i - 1]))
    const ys = new Set(['a', 'b', 'c', 'd'].map((id) => positions[id]?.y))
    expect(ys.size).toBe(1)
  })

  it('spreads a layer across the other axis', async () => {
    const positions = await layoutNetwork(
      network(
        ['s', 'x', 'y', 't'],
        [
          ['s', 'x'],
          ['s', 'y'],
          ['x', 't'],
          ['y', 't'],
        ],
      ),
    )
    expect(positions['x']?.x).toBe(positions['y']?.x)
    expect(positions['x']?.y).not.toBe(positions['y']?.y)
  })

  it('reports centres, not corners', async () => {
    const positions = await layoutNetwork(network(['only'], []))
    const only = positions['only']
    expect(only).toBeDefined()
    /*
     * ELK pads the root by the same amount on both axes, so a *corner* has x equal to y and a
     * *centre* is offset by half the difference between the box's sides. Asserting the
     * difference rather than the absolute position keeps this about the thing being tested —
     * sigma places a node at its centre, so corners put the whole picture half a box out —
     * without also pinning ELK's default padding.
     */
    expect(Number(only?.x) - Number(only?.y)).toBe(
      (NETWORK_NODE_SIZE.width - NETWORK_NODE_SIZE.height) / 2,
    )
  })

  it('drops a dangling edge rather than letting it reject the whole graph', async () => {
    const value = network(['a', 'b'], [['a', 'b']])
    const withGhost: NetworkValue = {
      ...value,
      edges: tableFromRows(EDGE_SCHEMA, [
        { source: 'a', target: 'b', weight: 1 },
        // A target the node table never mentions — what an upstream filter leaves behind.
        { source: 'b', target: 'gone', weight: 1 },
        // And a self-link, which ELK layered has nowhere to put.
        { source: 'a', target: 'a', weight: 1 },
      ]),
    }
    const positions = await layoutNetwork(withGhost)
    expect(Object.keys(positions).sort()).toEqual(['a', 'b'])
  })

  it('places every node it was given, and nothing else', async () => {
    const positions = await layoutNetwork(network(['a', 'b', 'orphan'], [['a', 'b']]))
    expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'orphan'])
  })

  it('has nothing to say about an empty network', async () => {
    expect(await layoutNetwork(network([], []))).toEqual({})
  })
})
