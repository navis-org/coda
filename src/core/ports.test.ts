/**
 * Variadic ports: expansion, the three resolution modes, and the two places a shrinking arity
 * can leave an edge pointing at a socket that is no longer there.
 *
 * The mechanism has no production node yet — `Match Cell Types` is the one it was built for —
 * so everything here is driven through test-only registrations. That is deliberate rather than
 * temporary: these are properties of the *mechanism*, and pinning them to whichever node
 * happens to use it first is how a core rule comes to be tested only incidentally.
 */

import { describe, expect, it } from 'vitest'

import {
  addEdge,
  addNode,
  deserializeGraph,
  emptyGraph,
  serializeGraph,
  setNodeParam,
  updateNode,
} from './graph'
import { inferGraph } from './inference'
import { autoWireDataset } from './autowire'
import {
  allInputPorts,
  defaultInputPorts,
  firstOutputPort,
  hasPortGroups,
  inputPorts,
  outputPorts,
} from './ports'
import { registerNode, requireNodeDef } from './registry'
import { T, column, tableSchema } from './types'
import { Scheduler } from './scheduler'
import { isTableValue, tableFromRows } from './values'

const SCHEMA = tableSchema(column('x', 'i64'))

/**
 * The shape the mapper will have: N dataset inputs and a labels output per input, both sized by
 * one `int` param. Registered at collection because `registerNode` refuses a duplicate type.
 */
registerNode({
  type: 'test.ports.match',
  label: 'Match (test)',
  category: 'analysis',
  cost: 'cheap',
  inputs: [
    { repeat: 'count', ports: [{ id: 'dataset', label: 'Dataset', type: T.table() }] },
    { id: 'extra', label: 'Extra', type: T.table(), required: false },
  ],
  outputs: [
    { repeat: 'count', ports: [{ id: 'labels', label: 'Labels for {n}', type: T.table() }] },
  ],
  params: [{ id: 'count', kind: 'int', label: 'Datasets', default: 2, min: 2, max: 4 }],
  /*
   * Through `ctx.outputPorts()` rather than by concatenating `'labels' + i`. That is the point
   * of the affordance: the ids come from the one expansion in `ports.ts`, so a node body cannot
   * disagree with the card about whether the index is 0- or 1-based.
   */
  inferOutputs: (ctx) =>
    Object.fromEntries(ctx.outputPorts().map((port) => [port.id, T.table(SCHEMA)])),
  evaluate: (ctx) =>
    Object.fromEntries(
      ctx.outputPorts().map((port) => [port.id, tableFromRows(SCHEMA, [{ x: port.group!.index }])]),
    ),
})

/** A group repeating a *tuple*, which is what `Compare Connectivity` needs. */
registerNode({
  type: 'test.ports.pairs',
  label: 'Pairs (test)',
  category: 'analysis',
  cost: 'cheap',
  inputs: [
    {
      repeat: 'n',
      ports: [
        { id: 'edges', label: 'Edges', type: T.table() },
        { id: 'labels', label: 'Labels', type: T.table() },
      ],
    },
  ],
  outputs: [{ id: 'out', label: 'Out', type: T.table() }],
  params: [{ id: 'n', kind: 'int', label: 'Datasets', default: 2, min: 1, max: 3 }],
  evaluate: () => ({ out: tableFromRows(SCHEMA, []) }),
})

/** A plain node, for the identity fast path and as a wiring partner. */
registerNode({
  type: 'test.ports.plain',
  label: 'Plain (test)',
  category: 'utility',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'In', type: T.table(), required: false }],
  outputs: [{ id: 'out', label: 'Out', type: T.table() }],
  evaluate: () => ({ out: tableFromRows(SCHEMA, []) }),
})

const match = () => requireNodeDef('test.ports.match')
const pairs = () => requireNodeDef('test.ports.pairs')
const plain = () => requireNodeDef('test.ports.plain')

describe('expanding a port group', () => {
  it('numbers ports from 1 and keeps the static ones in declared order', () => {
    expect(inputPorts(match(), { count: 3 }).map((p) => p.id)).toEqual([
      'dataset1',
      'dataset2',
      'dataset3',
      'extra',
    ])
  })

  it('repeats a tuple index-major, so a pair stays adjacent on the card', () => {
    expect(inputPorts(pairs(), { n: 2 }).map((p) => p.id)).toEqual([
      'edges1',
      'labels1',
      'edges2',
      'labels2',
    ])
  })

  it('substitutes {n} into a label, and appends the index where there is no placeholder', () => {
    expect(outputPorts(match(), { count: 2 }).map((p) => p.label)).toEqual([
      'Labels for 1',
      'Labels for 2',
    ])
    expect(inputPorts(match(), { count: 2 }).map((p) => p.label)).toEqual([
      'Dataset 1',
      'Dataset 2',
      'Extra',
    ])
  })

  it('carries where each port came from, so a caller need not parse the id', () => {
    /*
     * `base` is the template's own id. It is what lets a group repeating a *tuple* say which of
     * its ports this is — `port.group.base === 'edges'` — where the alternative is a
     * `startsWith` on the resolved id, which also matches a later port sharing the prefix.
     */
    const ports = inputPorts(match(), { count: 2 })
    expect(ports[0]?.group).toEqual({ repeat: 'count', index: 1, base: 'dataset' })
    expect(ports.at(-1)?.group).toBeUndefined()
  })

  it('inherits everything else from the template', () => {
    const [first] = inputPorts(match(), { count: 2 })
    expect(first?.type).toEqual(T.table())
  })
})

describe('resolving the count', () => {
  it('falls back to the param default when no params are given — a fresh node’s shape', () => {
    expect(defaultInputPorts(match()).map((p) => p.id)).toEqual(['dataset1', 'dataset2', 'extra'])
  })

  /*
   * Clamped rather than trusted: the value arrives from a saved file that may have been written
   * by a build with a different `max`, or edited by hand. Same lenient-then-corrected reading
   * `validSize` and `validGroups` give the rest of a loaded document.
   */
  it('clamps a count from outside the declared range', () => {
    expect(inputPorts(match(), { count: 99 })).toHaveLength(5) // 4 datasets + extra
    expect(inputPorts(match(), { count: 0 })).toHaveLength(3) // 2 datasets + extra
  })

  it('ignores a non-numeric count rather than expanding to nothing', () => {
    expect(inputPorts(match(), { count: 'three' }).map((p) => p.id)).toEqual([
      'dataset1',
      'dataset2',
      'extra',
    ])
  })
})

describe('the three resolution modes', () => {
  it('returns the definition’s own array for a node with no groups, allocating nothing', () => {
    expect(inputPorts(plain(), {})).toBe(plain().inputs)
    expect(outputPorts(plain(), {})).toBe(plain().outputs)
  })

  it('expands at max for the structural questions asked with no node in hand', () => {
    expect(allInputPorts(match()).map((p) => p.id)).toEqual([
      'dataset1',
      'dataset2',
      'dataset3',
      'dataset4',
      'extra',
    ])
  })

  it('knows which definitions are variadic at all', () => {
    expect(hasPortGroups(match())).toBe(true)
    expect(hasPortGroups(plain())).toBe(false)
  })
})

describe('what registration refuses', () => {
  const base = {
    label: 'Bad',
    category: 'utility' as const,
    cost: 'cheap' as const,
    inputs: [{ repeat: 'count', ports: [{ id: 'a', label: 'A', type: T.table() }] }],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    evaluate: () => ({ out: tableFromRows(SCHEMA, []) }),
  }
  /** The repeat param, with whatever this case is testing overridden onto it. */
  const count = (over: Record<string, unknown> = {}) => ({
    id: 'count',
    kind: 'int' as const,
    label: 'Count',
    default: 2,
    min: 1,
    max: 3,
    ...over,
  })

  it('a repeat naming no param — the count field would be inert', () => {
    expect(() => registerNode({ ...base, type: 'test.ports.bad1', params: [] })).toThrow(
      /names no param/,
    )
  })

  it('a repeat naming a param that is not an int', () => {
    expect(() =>
      registerNode({
        ...base,
        type: 'test.ports.bad2',
        params: [{ id: 'count', kind: 'string', label: 'Count', default: '2' }],
      }),
    ).toThrow(/must be `int`/)
  })

  /*
   * The range lives on the param and nowhere else, so the spinner the user turns and the
   * expansion cannot disagree. Undeclared, the spinner would run to infinity while the expander
   * stopped at one.
   */
  it('a param that declares no range for the group to repeat over', () => {
    expect(() =>
      registerNode({
        ...base,
        type: 'test.ports.bad3',
        params: [{ id: 'count', kind: 'int', label: 'Count', default: 2 }],
      }),
    ).toThrow(/no `min`\/`max`/)
  })

  it('a default outside the range, which would open at an arity its own field denies', () => {
    expect(() =>
      registerNode({ ...base, type: 'test.ports.bad4', params: [count({ min: 3, max: 4 })] }),
    ).toThrow(/outside \[3, 4\]/)
  })

  it('a group that can vanish entirely', () => {
    expect(() =>
      registerNode({ ...base, type: 'test.ports.bad5', params: [count({ min: 0 })] }),
    ).toThrow(/repeats at least once/)
  })

  it('a group that repeats no ports', () => {
    expect(() =>
      registerNode({
        ...base,
        type: 'test.ports.bad6',
        inputs: [{ repeat: 'count', ports: [] }],
        params: [count()],
      }),
    ).toThrow(/repeats no ports/)
  })

  /*
   * Both of these are invariant-4 failures rather than cosmetic ones: `normalizeParams` drops
   * presentational and hidden params from the provenance key, so an arity change on such a
   * param would not re-key the node and the scheduler would serve a cached result missing the
   * outputs the new ports exist for.
   */
  it('a presentational repeat count, which the provenance key would not see', () => {
    expect(() =>
      registerNode({
        ...base,
        type: 'test.ports.bad8',
        params: [count({ presentational: true })],
      }),
    ).toThrow(/presentational param/)
  })

  it('a repeat count behind visibleIf, which the provenance key drops while hidden', () => {
    expect(() =>
      registerNode({ ...base, type: 'test.ports.bad9', params: [count({ visibleIf: () => true })] }),
    ).toThrow(/visibleIf/)
  })

  /*
   * Checked at `max`, because a collision that only appears at arity three is still a collision
   * and would otherwise ship. `a` repeated gives a1..a3, which the static `a2` walks into.
   */
  it('two ports that collide at some arity, not merely at the default', () => {
    expect(() =>
      registerNode({
        ...base,
        type: 'test.ports.bad7',
        inputs: [...base.inputs, { id: 'a2', label: 'A2', type: T.table() }],
        params: [count()],
      }),
    ).toThrow(/two inputs called "a2" at some arity/)
  })
})

/**
 * A match node at `count`, fed by one `plain` source per repeated input, and optionally read by
 * one `plain` sink per repeated output. The three arity fixtures below are all this graph.
 */
function wired(count: number, withSinks = false) {
  let g = emptyGraph('variadic')
  g = addNode(g, { id: 'm', type: 'test.ports.match', position: { x: 0, y: 0 }, params: { count } })
  for (let i = 1; i <= count; i++) {
    g = addNode(g, { id: `s${i}`, type: 'test.ports.plain', position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: `s${i}`, sourceHandle: 'out', target: 'm', targetHandle: `dataset${i}` })
    if (!withSinks) continue
    g = addNode(g, { id: `d${i}`, type: 'test.ports.plain', position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: 'm', sourceHandle: `labels${i}`, target: `d${i}`, targetHandle: 'in' })
  }
  return g
}

describe('inference over a variadic node', () => {
  it('resolves a type on every repeated input and publishes one output each', () => {
    const result = inferGraph(wired(3))
    expect(Object.keys(result.nodes['m']!.inputs).sort()).toEqual([
      'dataset1',
      'dataset2',
      'dataset3',
      'extra',
    ])
    expect(Object.keys(result.nodes['m']!.outputs).sort()).toEqual(['labels1', 'labels2', 'labels3'])
  })

  it('reports an unconnected repeated input, so a raised count is visible rather than silent', () => {
    const g = setNodeParam(wired(2), 'm', 'count', 3)
    const issues = inferGraph(g).nodes['m']!.issues
    expect(issues.map((i) => i.message)).toContain('Input "Dataset 3" is not connected')
  })
})

describe('a node reading its own ports', () => {
  it('runs and publishes one value per repeated output, keyed by the resolved ids', async () => {
    const g = wired(3)
    const scheduler = new Scheduler({
      resolveSource: () => {
        throw new Error('no source')
      },
    })
    await scheduler.run(g, { mode: 'full' })
    for (let i = 1; i <= 3; i++) {
      const value = scheduler.output('m', `labels${i}`)
      expect(isTableValue(value) ? value.data['x']?.[0] : undefined).toBe(i)
    }
  })
})

describe('an arity that shrinks', () => {
  const three = () => wired(3, true)

  /*
   * Nothing downstream would report such an edge: every walk looks edges up *by* port key, so
   * one on an id nobody asks about is never read. It would survive a save/load round trip and
   * reappear as a live wire the moment the count went back up.
   */
  it('drops the edges into and out of the ports that went away', () => {
    const g = setNodeParam(three(), 'm', 'count', 2)
    expect(g.edges.map((e) => e.targetHandle).filter((h) => h.startsWith('dataset'))).toEqual([
      'dataset1',
      'dataset2',
    ])
    expect(g.edges.filter((e) => e.source === 'm').map((e) => e.sourceHandle)).toEqual([
      'labels1',
      'labels2',
    ])
  })

  it('leaves every other edge alone, and the graph itself when nothing is dangling', () => {
    const before = three()
    const raised = setNodeParam(before, 'm', 'count', 4)
    expect(raised.edges).toHaveLength(before.edges.length)
    const other = setNodeParam(before, 's1', 'anything', 1)
    expect(other.edges).toBe(before.edges)
  })

  it('does not disturb a node with no groups', () => {
    let g = emptyGraph('plain')
    g = addNode(g, { id: 'a', type: 'test.ports.plain', position: { x: 0, y: 0 }, params: {} })
    g = addNode(g, { id: 'b', type: 'test.ports.plain', position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' })
    expect(setNodeParam(g, 'a', 'x', 1).edges).toBe(g.edges)
  })
})

describe('the head of the output list', () => {
  it('answers from the first slot without expanding, when that slot is a plain port', () => {
    expect(firstOutputPort(plain(), {})?.id).toBe('out')
  })

  it('expands only when the first output really is a repeated group', () => {
    expect(firstOutputPort(match(), { count: 3 })?.id).toBe('labels1')
  })
})

describe('the prune reaches every path that writes params', () => {
  /*
   * Not just `setNodeParam`. The assistant patches params straight through `updateNode`, so a
   * plan lowering a variadic count would otherwise leave edges on ports that are no longer
   * drawn — which nothing downstream reports, because every walk looks edges up *by* port key.
   */
  it('drops dangling edges when params are written through updateNode', () => {
    const g = updateNode(wired(3, true), 'm', { params: { count: 2 } })
    expect(g.edges.filter((e) => e.target === 'm').map((e) => e.targetHandle)).toEqual([
      'dataset1',
      'dataset2',
    ])
    expect(g.edges.filter((e) => e.source === 'm').map((e) => e.sourceHandle)).toEqual([
      'labels1',
      'labels2',
    ])
  })

  it('leaves a patch that is not about params alone', () => {
    const before = wired(3, true)
    expect(updateNode(before, 'm', { title: 'Renamed' }).edges).toBe(before.edges)
  })
})

describe('loading a file whose handles the node no longer has', () => {
  function stored(count: number, handle: string) {
    let g = emptyGraph('file')
    g = addNode(g, { id: 'm', type: 'test.ports.match', position: { x: 0, y: 0 }, params: { count } })
    g = addNode(g, { id: 's', type: 'test.ports.plain', position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: 's', sourceHandle: 'out', target: 'm', targetHandle: handle })
    return serializeGraph(g)
  }

  it('keeps an edge the arity still has', () => {
    const { graph, warnings } = deserializeGraph(stored(3, 'dataset3'))
    expect(warnings).toEqual([])
    expect(graph.edges).toHaveLength(1)
  })

  it('drops one naming a socket past the arity, and says which node', () => {
    /*
     * Written at three, re-read at two. Hand-edited or a build whose `max` fell; either way the
     * document names a port that is not drawn, and an inert edge in a re-saved file is worse
     * than a warning.
     */
    const raw = JSON.parse(stored(3, 'dataset3')) as { nodes: { params: { count: number } }[] }
    raw.nodes[0]!.params.count = 2
    const { graph, warnings } = deserializeGraph(JSON.stringify(raw))
    expect(graph.edges).toEqual([])
    expect(warnings).toEqual(['Dropped edge into test.ports.match (m): no input "dataset3"'])
  })

  /*
   * A handle naming a port that is not there and *no handle recorded at all* reach the same
   * branch. Interpolating the stored value described the second as `no output "undefined"`,
   * which the Zoo's validator surfaces verbatim as an error.
   */
  it('says what is wrong when the file records no handle and there is none to heal to', () => {
    const raw = JSON.parse(stored(2, 'dataset1')) as {
      nodes: { id: string; type: string; params: Record<string, unknown> }[]
      edges: { source: string; sourceHandle?: string; targetHandle?: string }[]
    }
    // Source the edge from the match node, which has two outputs, so nothing can be healed to.
    raw.edges[0]!.source = 'm'
    delete raw.edges[0]!.sourceHandle
    const { graph, warnings } = deserializeGraph(JSON.stringify(raw))
    expect(graph.edges).toEqual([])
    expect(warnings).toEqual([
      'Dropped edge from test.ports.match (m): the file records no output port, and it has 2',
    ])
  })

  it('heals a missing handle to the node’s sole port rather than to the historical default', () => {
    const raw = JSON.parse(stored(2, 'dataset1')) as {
      edges: { sourceHandle?: string; targetHandle?: string }[]
    }
    delete raw.edges[0]!.sourceHandle
    const { graph, warnings } = deserializeGraph(JSON.stringify(raw))
    expect(warnings).toEqual([])
    expect(graph.edges[0]?.sourceHandle).toBe('out')
  })
})

describe('auto-wiring a repeated Dataset input', () => {
  registerNode({
    type: 'test.ports.source',
    label: 'Source (test)',
    category: 'dataset',
    cost: 'cheap',
    outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
    evaluate: () => ({ dataset: tableFromRows(SCHEMA, []) }),
  })
  registerNode({
    type: 'test.ports.compare',
    label: 'Compare (test)',
    category: 'analysis',
    cost: 'cheap',
    inputs: [
      { repeat: 'count', ports: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }] },
    ],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [{ id: 'count', kind: 'int', label: 'Datasets', default: 2, min: 2, max: 4 }],
    evaluate: () => ({ out: tableFromRows(SCHEMA, []) }),
  })

  /*
   * Filling every repeated Dataset port from the one dataset node would wire a node built to
   * compare two connectomes to the same connectome twice — a graph that runs, produces an
   * answer, and means nothing. The first is the useful half of the guess.
   */
  it('fills only the first port of the group', () => {
    let g = emptyGraph('autowire')
    g = addNode(g, { id: 'ds', type: 'test.ports.source', position: { x: 0, y: 0 }, params: {} })
    const node = {
      id: 'c',
      type: 'test.ports.compare',
      position: { x: 200, y: 0 },
      params: { count: 3 },
    }
    g = addNode(g, node)
    const wired = autoWireDataset(g, node)
    expect(wired.edges.map((e) => e.targetHandle)).toEqual(['dataset1'])
  })
})
