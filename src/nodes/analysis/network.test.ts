/**
 * BuildNetwork and the viewer selection round-trip.
 *
 * The selection tests matter most: this is the one place data flows *back* from a viewer
 * into the graph, so the selection must survive a save/load, must invalidate the node (it
 * is not presentational), and must produce a downstream-usable table.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import {
  addEdge,
  addNode,
  deserializeGraph,
  emptyGraph,
  serializeGraph,
  setNodeParam,
} from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { EvalContext, NodeDefinition, ParamValues } from '../../core/node'
import {
  defaultParams,
  findParam,
  makeInferContext,
  resolveColumn,
  resolveColumns,
} from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { CodaType } from '../../core/types'
import { T, attributeSchema, column, tableSchema } from '../../core/types'
import type { TableValue, Value } from '../../core/values'
import { getColumn, isNetworkValue, isTableValue, tableFromRows } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import '../index'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find → connectivity → build network → network view */
function pipeline(overrides: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('network-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'outputs', minWeight: 5 }))
  g = addNode(
    g,
    node('net', 'net.build', {
      source: 'preType',
      target: 'postType',
      weight: 'weight',
      ...overrides,
    }),
  )
  g = addNode(g, node('view', 'out.network'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'conn',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'conn',
    targetHandle: 'neurons',
  })
  g = addEdge(g, {
    source: 'conn',
    sourceHandle: 'connections',
    target: 'net',
    targetHandle: 'edges',
  })
  g = addEdge(g, { source: 'net', sourceHandle: 'network', target: 'view', targetHandle: 'in' })
  return g
}

function scheduler() {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

describe('BuildNetwork', () => {
  it('derives nodes from the edge list with degree and weight attributes', async () => {
    const sched = scheduler()
    await sched.run(pipeline(), { mode: 'full' })

    const network = sched.output('net', 'network')
    if (!isNetworkValue(network)) throw new Error('expected a network')

    expect(network.directed).toBe(true)
    expect(network.nodes.length).toBeGreaterThan(1)
    expect(network.nodes.schema.columns.map((c) => c.name)).toEqual([
      'id',
      'degreeIn',
      'degreeOut',
      'weightIn',
      'weightOut',
    ])
    /*
     * The link's own four columns, then every attribute of the incoming connectivity table
     * that the link does not already represent. Those extra columns are the point: without
     * them a categorical *link* colour has nothing to bind to.
     */
    expect(network.edges.schema.columns.map((c) => c.name)).toEqual([
      'source',
      'target',
      'weight',
      'edges',
      'preId',
      'postId',
      'hop',
      'direction',
    ])
    // Merged across many neuron pairs, so there is no single body id behind this link. It is
    // emphatically *not* the sum of them, which is what summing numerics used to produce.
    expect(network.edges.data['preId']?.[0]).toBeNull()

    // LC4 is the only source type, so it has out-degree and no in-degree.
    const ids = network.nodes.data.id as string[]
    const lc4 = ids.indexOf('LC4')
    expect(lc4).toBeGreaterThanOrEqual(0)
    expect((network.nodes.data.degreeOut as number[])[lc4]).toBeGreaterThan(0)
    expect((network.nodes.data.degreeIn as number[])[lc4]).toBe(0)
  })

  it('merges parallel links and counts how many rows each represents', async () => {
    const sched = scheduler()
    await sched.run(pipeline(), { mode: 'full' })
    const network = sched.output('net', 'network')
    if (!isNetworkValue(network)) throw new Error('expected a network')

    // Type-level source/target means many rows collapse into one link per pair.
    const pairs = (network.edges.data.source as string[]).map(
      (s, i) => `${s}->${(network.edges.data.target as string[])[i]}`,
    )
    expect(new Set(pairs).size).toBe(pairs.length)
    expect(Math.max(...(network.edges.data.edges as number[]))).toBeGreaterThan(1)
  })

  it('keeps parallel links separate when merging is switched off', async () => {
    const sched = scheduler()
    await sched.run(pipeline({ aggregate: false }), { mode: 'full' })
    const network = sched.output('net', 'network')
    if (!isNetworkValue(network)) throw new Error('expected a network')
    expect(Math.max(...(network.edges.data.edges as number[]))).toBe(1)
  })

  it('drops links below the minimum weight', async () => {
    const sched = scheduler()
    await sched.run(pipeline({ minWeight: 1e9 }), { mode: 'full' })
    const network = sched.output('net', 'network')
    if (!isNetworkValue(network)) throw new Error('expected a network')
    expect(network.edges.length).toBe(0)
    // With no surviving links there are no nodes either — nodes are derived from edges.
    expect(network.nodes.length).toBe(0)
  })

  it('canonicalises pairs when undirected, so A→B and B→A are one link', async () => {
    const sched = scheduler()
    await sched.run(pipeline({ directed: false }), { mode: 'full' })
    const network = sched.output('net', 'network')
    if (!isNetworkValue(network)) throw new Error('expected a network')
    expect(network.directed).toBe(false)
    const pairs = (network.edges.data.source as string[]).map((s, i) => {
      const t = (network.edges.data.target as string[])[i]!
      return [s, t].sort().join('|')
    })
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('advertises the node and edge schemas at edit time', () => {
    const inference = inferGraph(pipeline())
    const networkType = inference.nodes.net?.outputs.network
    expect(networkType?.kind).toBe('network')
    // This is what lets the viewer's "colour by" picker populate before anything runs.
    expect(attributeSchema(networkType, 'nodes')?.columns.map((c) => c.name)).toContain(
      'weightOut',
    )
    expect(attributeSchema(networkType, 'edges')?.columns.map((c) => c.name)).toContain(
      'weight',
    )
  })

  it('warns when source and target are the same column', () => {
    const graph = setNodeParam(pipeline(), 'net', 'target', 'preType')
    const issues = inferGraph(graph).nodes.net?.issues ?? []
    expect(issues.some((i) => /self-loop/.test(i.message))).toBe(true)
  })
})

describe('network viewer selection', () => {
  it('emits an empty selection until something is picked', async () => {
    const sched = scheduler()
    await sched.run(pipeline(), { mode: 'full' })
    const selected = sched.output('view', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')
    expect(selected.length).toBe(0)
    expect(selected.kind).toBe('neurons')
  })

  it('turns picked node ids into a downstream-usable table', async () => {
    const sched = scheduler()
    let graph = pipeline()
    await sched.run(graph, { mode: 'full' })

    const network = sched.output('net', 'network')
    if (!isNetworkValue(network)) throw new Error('expected a network')
    const firstId = (network.nodes.data.id as string[])[0]!

    graph = setNodeParam(graph, 'view', 'selection', [firstId])
    await sched.run(graph, { mode: 'full' })

    const selected = sched.output('view', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')
    expect(selected.length).toBe(1)
    // Node attributes travel with the selection, so a downstream Filter sees the same
    // columns the viewer coloured by.
    expect(selected.schema.columns.map((c) => c.name)).toContain('weightOut')
  })

  it('nulls bodyId for a type-level selection rather than faking neurons', async () => {
    const sched = scheduler()
    let graph = pipeline()
    await sched.run(graph, { mode: 'full' })
    graph = setNodeParam(graph, 'view', 'selection', ['LC4'])
    await sched.run(graph, { mode: 'full' })

    const selected = sched.output('view', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')
    // "LC4" is not a body id. Emitting null is honest; a fabricated id would fail silently
    // three nodes downstream.
    expect(selected.data.bodyId?.[0]).toBeNull()
  })

  it('is NOT presentational — a selection change invalidates the node', async () => {
    const sched = scheduler()
    const graph = pipeline()
    await sched.run(graph, { mode: 'full' })
    expect(sched.info('view').state).toBe('ok')

    const changed = setNodeParam(graph, 'view', 'selection', ['LC4'])
    sched.refreshStates(changed)
    // A viewer's selection feeds a real output, so it must take part in the cache key.
    expect(sched.info('view').state).toBe('stale')
  })

  it('but restyling the same viewer does not', async () => {
    const sched = scheduler()
    const graph = pipeline()
    await sched.run(graph, { mode: 'full' })

    const restyled = setNodeParam(graph, 'view', 'layout', 'circular')
    sched.refreshStates(restyled)
    expect(sched.info('view').state).toBe('ok')
  })

  it('and neither does turning arrows or link labels on', async () => {
    const sched = scheduler()
    const graph = pipeline()
    await sched.run(graph, { mode: 'full' })

    for (const [param, value] of [
      ['arrows', false],
      ['edgeLabels', true],
      ['edgeLabelColumn', 'edges'],
    ] as const) {
      sched.refreshStates(setNodeParam(graph, 'view', param, value))
      expect(sched.info('view').state, param).toBe('ok')
    }
  })
})

describe('network viewer link labels', () => {
  /** The context a viewer resolves its column params through. */
  function viewContext(graph: CodaGraph) {
    const node = graph.nodes.find((n) => n.id === 'view')!
    const inputs = inferGraph(graph).nodes.view?.inputs ?? {}
    return makeInferContext(requireNodeDef(node.type), node.params, inputs)
  }

  const labelling = () => setNodeParam(pipeline(), 'view', 'edgeLabels', true)

  it('leaves the picker unset, so the viewer can default to the weight column', () => {
    // Optional means "off", not "first column" — otherwise switching link labels on would
    // label them with whatever happened to sort first.
    expect(viewContext(labelling()).column('edgeLabelColumn')).toBeUndefined()
  })

  it('offers the link columns, not the node columns', () => {
    const graph = setNodeParam(labelling(), 'view', 'edgeLabelColumn', 'weight')
    expect(viewContext(graph).column('edgeLabelColumn')).toBe('weight')
  })

  it('rejects a column that only exists on the nodes', () => {
    // "degreeOut" is a node attribute. Reading the wrong half of the network type would
    // offer it here and then silently draw nothing.
    const graph = setNodeParam(labelling(), 'view', 'edgeLabelColumn', 'degreeOut')
    const issues = inferGraph(graph).nodes.view?.issues ?? []
    expect(issues.some((i) => /degreeOut/.test(i.message))).toBe(true)
  })

  it('survives a save/load round trip', () => {
    const graph = setNodeParam(pipeline(), 'view', 'selection', ['LC4', 'DNp02'])
    const { graph: loaded, warnings } = deserializeGraph(serializeGraph(graph))
    expect(warnings).toEqual([])
    expect(loaded.nodes.find((n) => n.id === 'view')?.params.selection).toEqual([
      'LC4',
      'DNp02',
    ])
  })
})

describe('the viewer filters its own output', () => {
  /*
   * The design decision worth guarding: the network viewer's filters are *not* presentational
   * — they change what the `out` port carries, so the picture and everything wired downstream
   * of it can never disagree. Asserted through the scheduler because dropping that would fail
   * no type check, and the symptom (a viewer showing one graph while the next node sees
   * another) reads as a caching bug rather than as a param flag.
   */

  async function run(params: Record<string, unknown>) {
    const sched = scheduler()
    let graph = pipeline()
    for (const [id, value] of Object.entries(params)) {
      graph = setNodeParam(graph, 'view', id, value as never)
    }
    await sched.run(graph, { mode: 'full' })
    const before = sched.output('net', 'network')
    const after = sched.output('view', 'out')
    if (!isNetworkValue(before) || !isNetworkValue(after)) throw new Error('expected networks')
    return { before, after }
  }

  it('passes the network straight through when nothing is filtered', async () => {
    const { before, after } = await run({})
    expect(after).toBe(before)
  })

  it('drops links below the threshold from the output, not merely from the drawing', async () => {
    const { before, after } = await run({ minLinkWeight: 1e9 })
    expect(before.edges.length).toBeGreaterThan(0)
    expect(after.edges.length).toBe(0)
  })

  it('keeps only the requested number of nodes', async () => {
    const { before, after } = await run({ topNodes: 2 })
    expect(before.nodes.length).toBeGreaterThan(2)
    expect(after.nodes.length).toBe(2)
  })

  it('resolves the selection against the filtered network', async () => {
    // A node the filter removed cannot be selected, so it drops out of `Selected` too.
    const { after } = await run({ topNodes: 1 })
    const kept = getColumn(after.nodes, 'id').map(String)
    expect(kept).toHaveLength(1)

    const sched = scheduler()
    let graph = setNodeParam(pipeline(), 'view', 'topNodes', 1)
    graph = setNodeParam(graph, 'view', 'selection', [...kept, 'filtered-away'])
    await sched.run(graph, { mode: 'full' })

    const selected = sched.output('view', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')
    expect(selected.length).toBe(1)
  })
})

/**
 * Drive one node's `evaluate` directly, with column params resolved the way the editor
 * resolves them. Small controlled fixtures say more here than the mock connectome does.
 */
function evalContext(def: NodeDefinition, params: ParamValues, edges: TableValue): EvalContext {
  const types: Record<string, CodaType | undefined> = { edges: T.table(edges.schema) }
  return {
    params,
    input: (portId) => (portId === 'edges' ? edges : undefined),
    column: (paramId) => {
      const p = findParam(def, paramId)
      return p && p.kind === 'column' ? resolveColumn(p, params, types) : undefined
    },
    columns: (paramId) => {
      const p = findParam(def, paramId)
      return p && p.kind === 'columns' ? resolveColumns(p, params, types) : []
    },
    resolveSource: () => requireSource('mock'),
    signal: new AbortController().signal,
    progress: () => {},
  }
}

describe('edge attributes riding along', () => {
  /*
   * `net.build` used to emit exactly source/target/weight/edges, so every other column of the
   * incoming edge table was lost — which is also why a categorical *link* colour had almost
   * nothing to offer. Carrying them is opt-in, because merging parallel links means deciding
   * what a merged value even is.
   */

  const EDGE_SCHEMA = tableSchema(
    column('from', 'str'),
    column('to', 'str'),
    column('w', 'f64'),
    column('roi', 'str'),
    column('syn', 'i64'),
  )

  const def = requireNodeDef('net.build')

  function build(
    rows: Array<{ from: string; to: string; w: number; roi?: string | null; syn?: number }>,
    params: Record<string, unknown> = {},
  ) {
    const table = tableFromRows(
      EDGE_SCHEMA,
      rows.map((r) => ({ roi: 'LO', syn: 1, ...r })),
    )
    const full = {
      ...defaultParams(def),
      source: 'from',
      target: 'to',
      weight: 'w',
      ...params,
    } as ParamValues
    const out = def.evaluate(evalContext(def, full, table)) as Record<string, Value | undefined>
    if (!isNetworkValue(out.network)) throw new Error('expected a network')
    return { network: out.network, params: full, schema: table.schema }
  }

  const cols = (n: ReturnType<typeof build>['network']) =>
    n.edges.schema.columns.map((c) => c.name)

  it('carries everything by default, like the node half of this same node always has', () => {
    // Empty means "all", not "none" — the `chips` idiom. An opt-in here would have been
    // inconsistent with `nodeSchemaFor`, which has always taken every joined column.
    const { network } = build([{ from: 'a', to: 'b', w: 1, roi: 'LO' }])
    expect(cols(network)).toEqual(['source', 'target', 'weight', 'edges', 'roi', 'syn'])
    expect(network.edges.data['roi']).toEqual(['LO'])
  })

  it('never carries the columns the links already represent', () => {
    // from/to/w are source/target/weight; repeating them under their original names would
    // put the same values on a link twice.
    const { network } = build([{ from: 'a', to: 'b', w: 1 }])
    expect(cols(network)).not.toContain('from')
    expect(cols(network)).not.toContain('to')
    expect(cols(network)).not.toContain('w')
  })

  it('takes a non-empty list literally, and in the order given', () => {
    const { network } = build([{ from: 'a', to: 'b', w: 1, roi: 'LO' }], {
      keep: ['syn', 'roi'],
    })
    expect(cols(network)).toEqual(['source', 'target', 'weight', 'edges', 'syn', 'roi'])
  })

  it('does not sum a numeric attribute — nothing in a dtype says it is a measure', () => {
    /*
     * The case that settled this: on a real male-CNS table, summing turned `preId` into
     * 24093454514 — noise, and noise offered to the numeric pickers where it could have driven
     * a size encoding. `weight` is the one additive channel; a second additive quantity
     * belongs in a `groupBy` upstream, which names its result honestly.
     */
    const { network } = build(
      [
        { from: 'a', to: 'b', w: 1, syn: 10 },
        { from: 'a', to: 'b', w: 1, syn: 5 },
      ],
      { keep: ['syn'] },
    )
    expect(network.edges.data['syn']).toEqual([null])
    // Weight, by contrast, is exactly what does add up.
    expect(network.edges.data['weight']).toEqual([2])
  })

  it('keeps a numeric attribute the merged rows do agree on', () => {
    const { network } = build(
      [
        { from: 'a', to: 'b', w: 1, syn: 7 },
        { from: 'a', to: 'b', w: 1, syn: 7 },
      ],
      { keep: ['syn'] },
    )
    expect(network.edges.data['syn']).toEqual([7])
  })

  it('keeps a non-numeric value where the merged rows agree', () => {
    const { network } = build(
      [
        { from: 'a', to: 'b', w: 1, roi: 'LO' },
        { from: 'a', to: 'b', w: 1, roi: 'LO' },
      ],
      { keep: ['roi'] },
    )
    expect(network.edges.data['roi']).toEqual(['LO'])
    expect(network.edges.data['edges']).toEqual([2])
  })

  it('empties a non-numeric value where they disagree, rather than picking one', () => {
    // A link standing for two ROIs has no ROI. Naming the first would be a confident lie,
    // and `edges` is there to say how many rows are behind it.
    const { network } = build(
      [
        { from: 'a', to: 'b', w: 1, roi: 'LO' },
        { from: 'a', to: 'b', w: 1, roi: 'ME' },
      ],
      { keep: ['roi'] },
    )
    expect(network.edges.data['roi']).toEqual([null])
    expect(network.edges.data['edges']).toEqual([2])
  })

  it('passes every row through untouched when links are not merged', () => {
    const { network } = build(
      [
        { from: 'a', to: 'b', w: 1, roi: 'LO' },
        { from: 'a', to: 'b', w: 1, roi: 'ME' },
      ],
      { keep: ['roi'], aggregate: false },
    )
    expect(network.edges.data['roi']).toEqual(['LO', 'ME'])
  })

  it('refuses to collide with the columns it owns, or to duplicate a key', () => {
    // `w` is already carried as `weight`; `source` is this node's own; `nope` does not exist.
    const { network } = build([{ from: 'a', to: 'b', w: 1 }], {
      keep: ['w', 'roi', 'roi', 'source', 'from', 'nope'],
    })
    expect(cols(network)).toEqual(['source', 'target', 'weight', 'edges', 'roi'])
  })

  it('carries attributes for a graph saved before the param existed', () => {
    // Loading does not fill missing params with defaults, so an older file has no `keep` key
    // at all. It must read as "all", not crash and not silently carry nothing.
    const table = tableFromRows(EDGE_SCHEMA, [{ from: 'a', to: 'b', w: 1, roi: 'LO', syn: 1 }])
    const legacy = {
      source: 'from',
      target: 'to',
      weight: 'w',
      directed: true,
      aggregate: true,
    }
    const out = def.evaluate(
      evalContext(def, legacy as unknown as ParamValues, table),
    ) as Record<string, Value | undefined>
    if (!isNetworkValue(out.network)) throw new Error('expected a network')
    expect(out.network.edges.schema.columns.map((c) => c.name)).toContain('roi')
  })

  it('agrees with what inferOutputs promised', () => {
    // Invariant 3's shape: the schema half and the value half are one resolution, so a column
    // picker downstream cannot offer something the run will not produce.
    const { network, params, schema } = build([{ from: 'a', to: 'b', w: 1 }], {
      keep: ['roi', 'syn'],
    })
    const promised = attributeSchema(
      def.inferOutputs!(makeInferContext(def, params, { edges: T.table(schema) })).network,
      'edges',
    )
    expect(network.edges.schema.columns.map((c) => c.name)).toEqual(
      (promised?.columns ?? []).map((c) => c.name),
    )
  })

  it('survives the viewer, which passes the network through rather than rebuilding it', async () => {
    // The other half of the diagnosis: `out.network` was never the thing dropping them.
    const sched = scheduler()
    await sched.run(pipeline(), { mode: 'full' })
    const before = sched.output('net', 'network')
    const after = sched.output('view', 'out')
    if (!isNetworkValue(before) || !isNetworkValue(after)) throw new Error('expected networks')
    expect(after.edges.schema.columns.map((c) => c.name)).toEqual(
      before.edges.schema.columns.map((c) => c.name),
    )
  })
})
