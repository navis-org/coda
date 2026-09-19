import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import {
  EDGE_LABEL_AUTO_MAX,
  flowGraph,
  foldFlowGraph,
  foldedBoxId,
  showsEdgeLabels,
} from './flowChartOps'

const NODE_SCHEMA = tableSchema(
  column('id', 'str'),
  column('type', 'str'),
  column('hops', 'i64'),
)
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function network(
  nodes: Array<{ id: string; type?: string | null; hops?: number | null }>,
  edges: Array<[string, string, number?]>,
): NetworkValue {
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      NODE_SCHEMA,
      nodes.map((n) => ({ id: n.id, type: n.type ?? null, hops: n.hops ?? null })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      edges.map(([source, target, weight]) => ({ source, target, weight: weight ?? 1 })),
    ),
  }
}

/** Layer by id, for readable assertions. */
function layers(graph: ReturnType<typeof flowGraph>): Record<string, number> {
  return Object.fromEntries(graph.nodes.map((node) => [node.id, node.layer]))
}

function kinds(graph: ReturnType<typeof flowGraph>): Record<string, string> {
  return Object.fromEntries(graph.edges.map((e) => [`${e.source}->${e.target}`, e.kind]))
}

describe('flowGraph layering', () => {
  it('lays a chain out one layer per hop', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
      ),
    )
    expect(layers(graph)).toEqual({ a: 0, b: 1, c: 2 })
    expect(graph.layerCount).toBe(3)
    expect(graph.layerSource).toBe('longest-path')
  })

  it('puts a node at the far end of its longest route in, not its shortest', () => {
    // a -> c directly, and a -> b -> c. Longest path is what keeps the direct edge pointing
    // forwards; shortest would put c in layer 1 and make a->b->c run backwards out of b.
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [
          ['a', 'c'],
          ['a', 'b'],
          ['b', 'c'],
        ],
      ),
    )
    expect(layers(graph)).toEqual({ a: 0, b: 1, c: 2 })
    expect(kinds(graph)).toEqual({ 'a->c': 'forward', 'a->b': 'forward', 'b->c': 'forward' })
  })

  it('terminates on a cycle and marks one edge of it as feedback', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'a'],
        ],
      ),
    )
    expect(layers(graph)).toEqual({ a: 0, b: 1, c: 2 })
    // Exactly one of the three closes the loop, and it is the one running back to the root.
    const back = graph.edges.filter((e) => e.kind === 'back')
    expect(back).toHaveLength(1)
    expect(`${back[0]!.source}->${back[0]!.target}`).toBe('c->a')
  })

  it('marks one half of a reciprocal pair as feedback and keeps the other forward', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
      ),
    )
    expect(kinds(graph)).toEqual({ 'a->b': 'forward', 'b->a': 'back' })
  })

  it('calls an autapse self rather than within', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }],
        [
          ['a', 'a'],
          ['a', 'b'],
        ],
      ),
    )
    expect(kinds(graph)).toEqual({ 'a->a': 'self', 'a->b': 'forward' })
  })

  it('calls an edge between two nodes of one layer within', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [
          ['a', 'b'],
          ['a', 'c'],
          ['b', 'c'],
        ],
      ),
    )
    // b and c both hang off a, but b -> c pushes c to layer 2, so nothing is `within` here…
    expect(layers(graph)).toEqual({ a: 0, b: 1, c: 2 })
    // …whereas layering by a column that puts them together does make it one.
    const byColumn = flowGraph(
      network(
        [
          { id: 'a', hops: 0 },
          { id: 'b', hops: 1 },
          { id: 'c', hops: 1 },
        ],
        [
          ['a', 'b'],
          ['a', 'c'],
          ['b', 'c'],
        ],
      ),
      { layerColumn: 'hops' },
    )
    expect(kinds(byColumn)['b->c']).toBe('within')
  })

  it('drops an edge naming an unknown endpoint and counts it', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }],
        [
          ['a', 'b'],
          ['a', 'ghost'],
        ],
      ),
    )
    expect(graph.edges).toHaveLength(1)
    expect(graph.dangling).toBe(1)
  })

  it('is empty for an empty network rather than throwing', () => {
    const graph = flowGraph(network([], []))
    expect(graph.nodes).toEqual([])
    expect(graph.layerCount).toBe(0)
  })
})

describe('flowGraph layering from a column', () => {
  it('renumbers the column densely, keeping its order', () => {
    // 0, 2 and 5 hops: three adjacent columns, not six with gaps.
    const graph = flowGraph(
      network(
        [
          { id: 'a', hops: 0 },
          { id: 'b', hops: 2 },
          { id: 'c', hops: 5 },
        ],
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
      ),
      { layerColumn: 'hops' },
    )
    expect(layers(graph)).toEqual({ a: 0, b: 1, c: 2 })
    expect(graph.layerSource).toBe('column')
  })

  it('answers a different layering from longest path, which is why the control exists', () => {
    // One synapse from the seed, but reachable the long way round too. Longest path says 2;
    // `hops` says 1, which is the fact somebody asked about.
    const wiring = network(
      [
        { id: 'seed', hops: 0 },
        { id: 'via', hops: 1 },
        { id: 'near', hops: 1 },
      ],
      [
        ['seed', 'near'],
        ['seed', 'via'],
        ['via', 'near'],
      ],
    )
    expect(layers(flowGraph(wiring))['near']).toBe(2)
    expect(layers(flowGraph(wiring, { layerColumn: 'hops' }))['near']).toBe(1)
  })

  /**
   * The picker is an unrestricted `column`, so the useful axis is often words rather than
   * numbers — a `class` running sensory to motor, an ROI ordering. Ranked by `Number()` alone
   * every one of those coerces to NaN and the whole network collapses into one column, which
   * reads as a layering that did not run. `layersFromValues` has had this rule all along.
   */
  it('ranks a categorical column lexically rather than collapsing it', () => {
    const wiring: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str'), column('class', 'str')), [
        { id: 'a', class: 'sensory' },
        { id: 'b', class: 'interneuron' },
        { id: 'c', class: 'motor' },
      ]),
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), [
        { source: 'a', target: 'b' },
      ]),
    }
    const graph = flowGraph(wiring, { layerColumn: 'class' })
    // Alphabetical: interneuron, motor, sensory. Three columns, not one.
    expect(layers(graph)).toEqual({ a: 2, b: 0, c: 1 })
    expect(graph.layerCount).toBe(3)
  })

  it('puts an unmeasured row after every measured one, never in layer 0', () => {
    const graph = flowGraph(
      network(
        [
          { id: 'a', hops: 0 },
          { id: 'b', hops: 1 },
          { id: 'unknown', hops: null },
        ],
        [],
      ),
      { layerColumn: 'hops' },
    )
    expect(layers(graph)).toEqual({ a: 0, b: 1, unknown: 2 })
  })
})

describe('flowGraph labels and weights', () => {
  it('labels from a column and falls back to the id', () => {
    const graph = flowGraph(
      network(
        [
          { id: '1', type: 'LC4' },
          { id: '2', type: null },
        ],
        [],
      ),
      { labelColumn: 'type' },
    )
    expect(graph.nodes.map((n) => n.label)).toEqual(['LC4', '2'])
  })

  it('reads weight when the network has one and null when it does not', () => {
    const graph = flowGraph(network([{ id: 'a' }, { id: 'b' }], [['a', 'b', 42]]))
    expect(graph.edges[0]!.weight).toBe(42)

    const unweighted: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), [{ id: 'a' }, { id: 'b' }]),
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), [
        { source: 'a', target: 'b' },
      ]),
    }
    expect(flowGraph(unweighted).edges[0]!.weight).toBeNull()
  })
})

describe('foldFlowGraph', () => {
  const fan = network(
    [
      { id: 'seed', hops: 0 },
      { id: 'big', hops: 1 },
      { id: 'mid', hops: 1 },
      { id: 'small', hops: 1 },
      { id: 'tiny', hops: 1 },
    ],
    [
      ['seed', 'big', 100],
      ['seed', 'mid', 50],
      ['seed', 'small', 5],
      ['seed', 'tiny', 1],
    ],
  )

  it('returns the graph by identity when nothing needs folding', () => {
    const graph = flowGraph(fan, { layerColumn: 'hops' })
    expect(foldFlowGraph(graph, 4)).toBe(graph)
    expect(foldFlowGraph(graph, 0)).toBe(graph)
  })

  it('keeps the busiest boxes and folds the tail into one', () => {
    const graph = foldFlowGraph(flowGraph(fan, { layerColumn: 'hops' }), 2)
    expect(graph.nodes.map((n) => n.id)).toEqual(['seed', 'big', 'mid', foldedBoxId(1)])
    const box = graph.nodes.find((n) => n.id === foldedBoxId(1))!
    expect(box.label).toBe('+2 others')
    expect(box.folded).toEqual(['small', 'tiny'])
    // No attribute row: two rows cannot both be it. See `FlowNode.row`.
    expect(box.row).toBe(-1)
  })

  it('sums the weights of the edges it merges and says how many', () => {
    const graph = foldFlowGraph(flowGraph(fan, { layerColumn: 'hops' }), 2)
    const merged = graph.edges.find((e) => e.target === foldedBoxId(1))!
    expect(merged.weight).toBe(6)
    expect(merged.merged).toBe(2)
    expect(merged.row).toBe(-1)
    // The edges that were not touched keep their own row and weight.
    const kept = graph.edges.find((e) => e.target === 'big')!
    expect(kept.weight).toBe(100)
    expect(kept.merged).toBe(1)
    expect(kept.row).toBeGreaterThanOrEqual(0)
  })

  it('reclassifies a merged edge against the folded box it now lands on', () => {
    // `tail` is in the same layer as `mid`, so folding both into one box turns the edge
    // between them into a self loop rather than leaving it pointing sideways at nothing.
    const wiring = network(
      [
        { id: 'a', hops: 0 },
        { id: 'keep', hops: 1 },
        { id: 'x', hops: 1 },
        { id: 'y', hops: 1 },
      ],
      [
        ['a', 'keep', 10],
        ['a', 'x', 2],
        ['a', 'y', 1],
        ['x', 'y', 1],
      ],
    )
    const graph = foldFlowGraph(flowGraph(wiring, { layerColumn: 'hops' }), 1)
    const loop = graph.edges.find((e) => e.kind === 'self')
    expect(loop?.source).toBe(foldedBoxId(1))
    expect(loop?.target).toBe(foldedBoxId(1))
  })

  it('leaves the within-layer order as the table order, not the ranking', () => {
    // `mid` arrives before `big` in the table but ranks below it; the survivors come back in
    // table order, because the ranking decides which boxes stay and never where they sit.
    const wiring = network(
      [
        { id: 'a', hops: 0 },
        { id: 'mid', hops: 1 },
        { id: 'big', hops: 1 },
        { id: 'tiny', hops: 1 },
      ],
      [
        ['a', 'mid', 5],
        ['a', 'big', 99],
        ['a', 'tiny', 1],
      ],
    )
    const graph = foldFlowGraph(flowGraph(wiring, { layerColumn: 'hops' }), 2)
    expect(graph.nodes.map((n) => n.id)).toEqual(['a', 'mid', 'big', foldedBoxId(1)])
  })
})

describe('showsEdgeLabels', () => {
  it('honours an explicit choice at every size', () => {
    expect(showsEdgeLabels('on', 5000)).toBe(true)
    expect(showsEdgeLabels('off', 2)).toBe(false)
  })

  it('draws them automatically up to the threshold and not past it', () => {
    expect(showsEdgeLabels('auto', EDGE_LABEL_AUTO_MAX)).toBe(true)
    expect(showsEdgeLabels('auto', EDGE_LABEL_AUTO_MAX + 1)).toBe(false)
  })
})
