/**
 * The two nodes wired together, against the mock connectome.
 *
 * `similarityOps.test.ts` and `partnerVectors.test.ts` cover the arithmetic against scipy and
 * against a hand-checked fixture. What only a pipeline can see is the part in between: that a
 * real Connectivity result has the columns Partner Vectors names, that the long table it emits
 * has a schema the Similarity pickers can resolve against, and that the matrix arrives with the
 * `measure` a Linkage reads — which is the whole of why `Similarity Matrix → Linkage` needs
 * nothing configured.
 *
 * Run through a real `Scheduler` rather than by calling `evaluate`, because the other thing at
 * stake is the *provenance key*: Euclidean hides the Output param, and a hidden param that
 * still invalidated would make a run happen for a setting the run could not have read.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { inferGraph } from '../../core/inference'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { T, column, tableSchema } from '../../core/types'
import { getColumn, isMatrixValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import '../index'

const source: DataSource = new MockSource({ latencyMs: 0 })

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/**
 * dataset → find(LC*) → connectivity(both) → partner vectors → similarity.
 *
 * `both` deliberately: it is the traversal whose output has the query neuron in `preId` on some
 * rows and `postId` on others, which is the shape this pair exists to unpick. The Neurons
 * output is wired across as well, so the run takes the authoritative route.
 */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('similarity-pipeline')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(
    g,
    node('conn', 'neuron.connectivity', { direction: 'both', hops: 1, minWeight: 1 }),
  )
  g = addNode(g, node('vec', 'neuron.partnerVectors', { partnerBy: 'type' }))
  g = addNode(
    g,
    node('sim', 'core.similarity', {
      layout: 'long',
      observations: 'neuronId',
      features: 'feature',
      value: 'weight',
      metric: 'cosine',
      ...params,
    }),
  )
  const wire = (s: string, sh: string, t: string, th: string) => {
    g = addEdge(g, { source: s, sourceHandle: sh, target: t, targetHandle: th })
  }
  wire('ds', 'dataset', 'find', 'dataset')
  wire('ds', 'dataset', 'conn', 'dataset')
  wire('find', 'neurons', 'conn', 'neurons')
  wire('conn', 'connections', 'vec', 'in')
  wire('find', 'neurons', 'vec', 'neurons')
  wire('vec', 'out', 'sim', 'in')
  return g
}

describe('a real connectivity result, through to a matrix', () => {
  it('runs end to end and comes out square over the queried neurons', async () => {
    const scheduler = makeScheduler()
    const graph = pipeline()
    const summary = await scheduler.run(graph, { mode: 'full' })
    expect(summary.failed).toEqual([])

    const found = scheduler.output('find', 'neurons')
    const vectors = scheduler.output('vec', 'out')
    const matrix = scheduler.output('sim', 'matrix')
    if (!isTableValue(found) || !isTableValue(vectors) || !isMatrixValue(matrix)) {
      throw new Error('pipeline produced the wrong kinds')
    }

    expect(vectors.length).toBeGreaterThan(0)
    // Every observation is one of the neurons that was asked about — nothing leaks in from the
    // partner side of an edge, which is exactly what a `both` traversal makes easy to get wrong.
    const queried = new Set(getColumn(found, 'neuronId').map(String))
    for (const id of new Set(getColumn(vectors, 'neuronId').map(String))) {
      expect(queried.has(id)).toBe(true)
    }
    expect(matrix.rowLabels).toEqual(matrix.colLabels)
    expect(matrix.rowLabels.length).toBe(
      new Set(getColumn(vectors, 'neuronId').map(String)).size,
    )
  })

  it('keeps both directions in the feature space', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })
    const vectors = scheduler.output('vec', 'out')
    if (!isTableValue(vectors)) throw new Error('not a table')
    const directions = new Set(getColumn(vectors, 'direction').map(String))
    expect(directions).toEqual(new Set(['in', 'out']))
    // And the prefix is on the feature, so the two cannot collide on one partner.
    expect(getColumn(vectors, 'feature').every((f) => /^(in|out):/.test(String(f)))).toBe(true)
  })

  /*
   * The reason Linkage takes this with nothing set. A matrix that says nothing is treated as a
   * similarity there, which for a Euclidean result would build a tree on `1 − distance`.
   */
  it('hands Linkage a matrix that says which kind of cells it holds', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })
    const cosine = scheduler.output('sim', 'matrix')
    expect(isMatrixValue(cosine) && cosine.measure).toBe('similarity')

    const other = makeScheduler()
    await other.run(pipeline({ metric: 'euclidean' }), { mode: 'full' })
    const euclid = other.output('sim', 'matrix')
    expect(isMatrixValue(euclid) && euclid.measure).toBe('distance')
  })
})

describe('the params, at edit time', () => {
  /*
   * Invariant 4's half of the layout switch. Euclidean hides Output, hidden params are excluded
   * from the provenance key, and `evaluate` reaches the same answer through `effectiveOutput` —
   * so moving that control has to cost nothing at all.
   */
  it('does not re-run when a hidden param moves', async () => {
    const scheduler = makeScheduler()
    const graph = pipeline({ metric: 'euclidean', output: 'similarity' })
    await scheduler.run(graph, { mode: 'full' })

    const edited: CodaGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'sim' ? { ...n, params: { ...n.params, output: 'distance' } } : n,
      ),
    }
    const again = await scheduler.run(edited, { mode: 'full' })
    expect(again.executed).not.toContain('sim')
  })

  it('re-runs when a visible one does', async () => {
    const scheduler = makeScheduler()
    const graph = pipeline({ metric: 'cosine', output: 'similarity' })
    await scheduler.run(graph, { mode: 'full' })
    const edited: CodaGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'sim' ? { ...n, params: { ...n.params, output: 'distance' } } : n,
      ),
    }
    expect((await scheduler.run(edited, { mode: 'full' })).executed).toContain('sim')
  })

  /*
   * Through `makeInferContext` and a real schema, not a hand-rolled context: invariant 5 is
   * that infer, validate, evaluate and the cache key share **one** resolution, and a stub
   * `column` that just reads the param back pins `validate` against a rule the app never uses —
   * it would keep passing if the two drifted, which is the failure the invariant was written
   * after. `a`/`b` here are real columns, so `resolveColumn` has something to resolve against.
   */
  it('asks for what each layout needs, and only that', () => {
    const def = requireNodeDef('core.similarity')
    const schema = tableSchema(column('a', 'str'), column('b', 'str'), column('n', 'f64'))
    const issues = (params: Record<string, unknown>) =>
      def.validate?.(makeInferContext(def, params as ParamValues, { in: T.table(schema) })) ??
      []

    /*
     * Both pickers unset resolve to the *first compatible column* — the same one — so a node
     * nobody has touched says they collide rather than saying they are empty. That is
     * `core.pivot`'s behaviour on exactly the same pair of fields, arrived at here through the
     * shared resolver rather than restated; the stub context this used to build could not see
     * it at all.
     */
    expect(issues({ layout: 'long' })[0]).toMatch(/same column/)
    expect(issues({ layout: 'long', observations: 'a', features: 'a' })[0]).toMatch(
      /same column/,
    )
    expect(issues({ layout: 'long', observations: 'a', features: 'b' })).toEqual([])
    // And with no schema to resolve against there is nothing to be the first column, which is
    // the state the other message is for.
    expect(
      def.validate?.(makeInferContext(def, { layout: 'long' } as ParamValues, {})) ?? [],
    ).toEqual(['Pick an Observations and a Features column'])

    // The wide pickers are what matters in the other layout, and the long ones are not asked for.
    expect(issues({ layout: 'wide' })[0]).toMatch(/feature column/)
    expect(issues({ layout: 'wide', idColumn: 'a', wideFeatures: ['n'] })).toEqual([])
    expect(
      def.validate?.(makeInferContext(def, { layout: 'wide' } as ParamValues, {})) ?? [],
    ).toEqual(['Pick the column naming each row'])
  })

  it('is expensive, because it is quadratic and blocks the tab while it runs', () => {
    expect(requireNodeDef('core.similarity').cost).toBe('expensive')
    // The reshape is one pass over the edges into a map, and its input is the expensive node.
    expect(requireNodeDef('neuron.partnerVectors').cost).toBe('cheap')
  })

  it('publishes a schema for the long table before anything has run', () => {
    // Which is what lets the Similarity pickers offer `feature` and `weight` on a cold graph —
    // `observesOutputSchema` would leave them empty until the first Run and again after a reload.
    const inference = inferGraph(pipeline())
    const out = inference.nodes['vec']?.outputs?.out
    expect(out?.kind === 'table' && out.schema?.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'direction',
      'partner',
      'feature',
      'weight',
      // Unconditional, so the schema does not change shape with whether the Labels port is
      // wired — see `partnerVectorSchema`.
      'cnFrac',
    ])
  })
})
