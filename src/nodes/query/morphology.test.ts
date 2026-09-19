/**
 * The morphology fetch nodes' `Warn above` guard rail.
 *
 * Worth pinning because the number and the reason have drifted apart twice. The mesh limit was
 * 25, picked before levels of detail existed and never re-derived: with detail selection doing
 * the real work, that refused thirty neurons that would have arrived as a few hundred
 * kilobytes. And the message blamed "this viewer", which has no cap of its own and was not what
 * refused.
 *
 * The second drift is the one these tests are now about. The number said "refuse", and a
 * refusal is a claim that there is no useful answer — which for a count is almost never true.
 * So the same threshold now says what the fetch will cost and then fetches: `ctx.warn`, and the
 * result underneath it. See `core/limits.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { defaultParams, makeInferContext, validateColumnParams } from '../../core/node'
import type { NodeDefinition } from '../../core/node'
import { meshDetailRequest } from '../lib/meshDetailParams'
import { fetchMeshesFor } from '../../data/source'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource, GeometryRequest, SourceCapabilities } from '../../data/source'
import { registerSource, requireSource } from '../../data/source'
import { T, column, columnNames, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type {
  MeshesValue,
  PointsValue,
  SkeletonProvenance,
  SkeletonsValue,
} from '../../core/values'
import { MAX_NEURONS } from './morphology'
import { SYNAPSE_UNIT_PARAM } from '../lib/synapseParams'
import { CARRY_PARAM_ID } from '../lib/carryParams'

import '../index'
import { searchFor } from '../../test/findNeurons'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

/**
 * A dynamic enum param's options, for the two controls that build theirs from the wired source.
 *
 * Both `Source` (Skeletons) and `Rows` (Synapses) declare `options` as a function of the
 * `InferContext`, and asserting on one meant the same four lines each time — find the param,
 * check it is a function-valued enum, build a context with the chosen value in it.
 */
function enumOptions(
  def: NodeDefinition,
  paramId: string,
  type: ReturnType<typeof T.dataset>,
  chosen = '',
) {
  const param = (def.params ?? []).find((p) => p.id === paramId)
  if (!param || param.kind !== 'enum' || typeof param.options !== 'function') {
    throw new Error(`${def.type} has no dynamic ${paramId} enum`)
  }
  return param.options(
    makeInferContext(def, { ...defaultParams(def), [paramId]: chosen }, { dataset: type }),
  )
}

const MORPHOLOGY_NODES = ['neuron.skeletons', 'neuron.meshes', 'neuron.synapses'] as const

function limitParam(type: string) {
  const def = requireNodeDef(type)
  const param = (def.params ?? []).find((p) => p.id === 'limit')
  if (!param || param.kind !== 'int') throw new Error(`${type} has no int limit param`)
  return param
}

describe('Warn above', () => {
  it('shares one threshold across all three morphology nodes', () => {
    for (const type of MORPHOLOGY_NODES) {
      expect(limitParam(type).max, type).toBe(MAX_NEURONS)
      expect(defaultParams(requireNodeDef(type)).limit, type).toBe(MAX_NEURONS)
    }
  })

  it('is ten thousand, which is where every backend is into tens of minutes', () => {
    // Pinned as a literal in exactly one place. The three nodes above are pinned to *each
    // other*, so raising the shared number moves all of them and lands here.
    expect(MAX_NEURONS).toBe(10000)
  })

  it('is a threshold rather than a cap, and says so on the card', () => {
    // The label carried "Max" while the behaviour was a refusal, and kept it for a while
    // afterwards — which is the one way this control can lie about what it does.
    for (const type of MORPHOLOGY_NODES) {
      expect(limitParam(type).label, type).toBe('Warn above')
      expect(limitParam(type).help ?? '', type).toMatch(/Nothing is capped/)
    }
  })

  it('keeps a Detail budget alongside it, since that is what bounds mesh weight', () => {
    // Raising the count without a weight control would just move the cliff.
    const def = requireNodeDef('neuron.meshes')
    expect((def.params ?? []).some((p) => p.id === 'detail')).toBe(true)
  })
})

/** dataset → find → geometry, with the geometry node's limit forced below the neuron count. */
function pipeline(geometryType: string, limit: number): CodaGraph {
  const node = (id: string, type: string, params: Record<string, unknown> = {}): GraphNode => ({
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  })

  let g = emptyGraph('limit-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: 'LC4', status: 'Traced' })),
  )
  g = addNode(g, node('geo', geometryType))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'geo',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'geo',
    targetHandle: 'neurons',
  })
  return setNodeParam(g, 'geo', 'limit', limit)
}

describe('Synapses Between', () => {
  /** dataset → find → synapsesBetween, the found table on each of `ports`. */
  function between(
    ports: ReadonlyArray<'sources' | 'targets'>,
    params: Record<string, unknown> = {},
  ): CodaGraph {
    const def = requireNodeDef('neuron.synapsesBetween')
    let g = pipeline('neuron.skeletons', MAX_NEURONS)
    g = addNode(g, {
      id: 'syn',
      type: def.type,
      position: { x: 0, y: 0 },
      params: { ...defaultParams(def), ...params } as GraphNode['params'],
    })
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'syn',
      targetHandle: 'dataset',
    })
    for (const port of ports) {
      g = addEdge(g, {
        source: 'find',
        sourceHandle: 'neurons',
        target: 'syn',
        targetHandle: port,
      })
    }
    return g
  }

  it('declares the oriented schema before anything runs, so pickers downstream fill', () => {
    const def = requireNodeDef('neuron.synapsesBetween')
    const inferred = def.inferOutputs!(makeInferContext(def, defaultParams(def), {}))
    // A points type carries its attribute schema, but is not tabular, so `schemaOf` declines it.
    const points = inferred.points
    expect(columnNames(points?.kind === 'points' ? points.schema : undefined)).toEqual([
      'neuronId',
      'type',
      'partnerId',
      'partnerType',
      'polarity',
      'confidence',
    ])
  })

  it('is expensive, since it is a backend query', () => {
    expect(requireNodeDef('neuron.synapsesBetween').cost).toBe('expensive')
  })

  it.each(['pre', 'post'] as const)(
    'runs with Location %s and delivers what it declared',
    async (location) => {
      const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
      await sched.run(between(['sources', 'targets'], { location }), { mode: 'full' })
      const info = sched.info('syn')
      expect(info.error ?? info.state).toBe('ok')
      const points = sched.output('syn', 'points') as PointsValue
      expect(points.kind).toBe('points')
      expect(columnNames(points.attributes.schema)).toEqual([
        'neuronId',
        'type',
        'partnerId',
        'partnerType',
        'polarity',
        'confidence',
      ])
      for (const polarity of points.attributes.data.polarity ?? [])
        expect(polarity).toBe(location)
    },
  )

  it('asks for Sources, Targets or both, and is satisfied by either alone', () => {
    const def = requireNodeDef('neuron.synapsesBetween')
    const issues = (inputs: Record<string, ReturnType<typeof T.neurons>>) =>
      def.validate!(makeInferContext(def, defaultParams(def), inputs)).join(' ')
    expect(issues({})).toMatch(/Wire Sources, Targets or both/)
    expect(issues({ sources: T.neurons() })).toBe('')
    expect(issues({ targets: T.neurons() })).toBe('')
  })

  it.each(['sources', 'targets'] as const)(
    'runs with only %s wired, the other side open',
    async (port) => {
      const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
      await sched.run(between([port], { includeFragments: true }), { mode: 'full' })
      const info = sched.info('syn')
      expect(info.error ?? info.state).toBe('ok')
      const points = sched.output('syn', 'points') as PointsValue
      expect(points.attributes.length).toBeGreaterThan(0)
      // The bound side is the found set; the open side is whoever the edges name.
      const found = new Set(
        (
          sched.output('find', 'neurons') as { data: Record<string, unknown[]> }
        ).data.neuronId!.map(String),
      )
      const bound =
        port === 'sources' ? points.attributes.data.neuronId : points.attributes.data.partnerId
      for (const id of bound ?? []) expect(found.has(String(id))).toBe(true)
    },
  )

  it('drops fragments on the open side unless Include fragments is on, and never on the bound side', async () => {
    /*
     * A dataset that publishes only even-numbered bodies as neurons when asked by id — which is
     * the only way `publishedNeurons` asks. Find Neurons asks by rows, so the bound set is
     * untouched and any odd id left in the bound column would be the filter reaching too far.
     */
    class HalfPublished extends MockSource {
      override findNeurons(req: Parameters<MockSource['findNeurons']>[0]) {
        if (!req.neuronIds) return super.findNeurons(req)
        return super.findNeurons({
          ...req,
          neuronIds: req.neuronIds.filter((id) => Number(id) % 2 === 0),
        })
      }
    }
    const halfPublished = new HalfPublished({ latencyMs: 0 })
    const run = async (includeFragments: boolean) => {
      const sched = new Scheduler({ resolveSource: () => halfPublished })
      await sched.run(between(['sources'], { includeFragments }), { mode: 'full' })
      expect(sched.info('syn').error ?? sched.info('syn').state).toBe('ok')
      return (sched.output('syn', 'points') as PointsValue).attributes.data
    }
    const filtered = await run(false)
    const everything = await run(true)
    expect((everything.partnerId ?? []).some((id) => Number(id) % 2 === 1)).toBe(true)
    expect((filtered.partnerId ?? []).every((id) => Number(id) % 2 === 0)).toBe(true)
    expect((filtered.partnerId ?? []).length).toBeLessThan((everything.partnerId ?? []).length)
    expect(new Set(filtered.neuronId)).toEqual(new Set(everything.neuronId))
  })

  it('refuses a source that publishes synapses but cannot narrow them to a pair of sets', () => {
    const def = requireNodeDef('neuron.synapsesBetween')
    const capable = { synapses: true } as Partial<SourceCapabilities>
    registerSource({
      ...new MockSource({ latencyMs: 0 }),
      id: 'no-between',
      label: 'No Between',
      capabilities: { ...new MockSource({ latencyMs: 0 }).capabilities, ...capable },
      fetchSynapsesBetween: undefined,
    } as unknown as DataSource)
    const issues = def.validate!(
      makeInferContext(def, defaultParams(def), {
        dataset: T.dataset('no-between', 'optic-lobe-mini'),
        sources: T.neurons(),
      }),
    )
    expect(issues.join(' ')).toMatch(/cannot fetch the synapses between two neuron sets/)
  })
})

describe('an oversized set', () => {
  it.each(MORPHOLOGY_NODES)('%s names the real constraint, not the viewer', async (type) => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline(type, 1), { mode: 'full' })

    const info = sched.info('geo')
    // The whole change: there is a result under the sentence. It used to be `error`, and
    // everything downstream was blocked by a wait somebody had not been asked about.
    expect(info.error ?? info.state).toBe('ok')
    expect(sched.warning('geo')).toMatch(/neurons is past this node's Warn above \(1\)/)
    expect(sched.warning('geo')).toMatch(/cancel if that is not what you wanted/)
    // The message used to say this, and both halves of it were wrong.
    expect(sched.warning('geo')).not.toMatch(/this viewer can draw/)
  })

  it('explains the cost in terms specific to each node', async () => {
    const costs: Record<string, RegExp> = {
      'neuron.skeletons': /separate request/,
      'neuron.meshes': /full resolution/,
      'neuron.synapses': /row per synapse/,
    }
    for (const [type, pattern] of Object.entries(costs)) {
      const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
      await sched.run(pipeline(type, 1), { mode: 'full' })
      expect(sched.warning('geo'), type).toMatch(pattern)
    }
  })

  it('keeps the warning with the result, not with the run that produced it', async () => {
    // A second Run answers from the provenance cache without evaluating, and the caveat is
    // about the value rather than about the run — see `CacheEntry.warnings`.
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    const graph = pipeline('neuron.skeletons', 1)
    await sched.run(graph, { mode: 'full' })
    await sched.run(graph, { mode: 'full' })
    expect(sched.warning('geo')).toMatch(/Warn above/)
  })

  it('says nothing when the set fits', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline('neuron.meshes', 500), { mode: 'full' })
    expect(sched.info('geo').state).toBe('ok')
    expect(sched.warning('geo')).toBeUndefined()
  })
})

/**
 * The per-dataset capability.
 *
 * `SourceCapabilities` is per **source**, and one source can serve datasets that genuinely
 * differ: a CAVE datastack's skeletons depend on whether its chunkedgraph has a level-2 cache,
 * which six of thirteen do. A flat answer is wrong for somebody whichever way it is set.
 */
describe('a capability that differs per dataset', () => {
  const def = requireNodeDef('neuron.skeletons')

  function withCapabilities(id: string, per: Record<string, Partial<SourceCapabilities>>) {
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id,
        capabilities: { ...base.capabilities, skeletons: false },
        capabilitiesFor: (datasetId: string) => per[datasetId],
      }),
    )
  }

  const issues = (sourceId: string, datasetId: string) =>
    (
      def.validate?.(
        makeInferContext(def, defaultParams(def), { dataset: T.dataset(sourceId, datasetId) }),
      ) ?? []
    ).join(' ')

  it('lets a dataset answer for itself where the source cannot', () => {
    withCapabilities('per-dataset', { 'has:1': { skeletons: true } })
    // The source says no; this dataset says yes and wins.
    expect(issues('per-dataset', 'has:1')).toBe('')
  })

  it('falls back to the source for a dataset with nothing to say', () => {
    withCapabilities('per-dataset-2', { 'has:1': { skeletons: true } })
    // `undefined` is "same as the source", which is every dataset of every other backend — and
    // the safe answer while a peek has not landed.
    expect(issues('per-dataset-2', 'other:1')).toContain('no skeletons')
  })

  it('blames the dataset rather than the backend', () => {
    withCapabilities('per-dataset-3', {})
    // "This data source has no skeletons" told a FlyWire-production user something false about
    // a datastack that can perfectly well answer.
    expect(issues('per-dataset-3', 'other:1')).toContain('This dataset')
  })
})

/**
 * Which route the skeletons came from, and who chooses.
 *
 * A dataset does not have one skeleton source — male-CNS publishes a precomputed layer beside
 * its segmentation *and* serves neuPrint's SWC, minnie65 has a level-2 cache *and* a populated
 * CAVE skeleton service — and those are different products, tens of nodes against tens of
 * thousands, radii or none. Until this control existed the node picked and said nothing.
 */
describe('Carry fields', () => {
  /*
   * The control exists on the two nodes whose attribute table is one row per neuron, and not on
   * Synapses, whose rows are connectors — a neuron-level column there repeats per synapse, so a
   * Group By over it would count synapses rather than neurons.
   */
  it('is on both collection nodes and not on the point cloud', () => {
    for (const type of ['neuron.skeletons', 'neuron.meshes']) {
      const param = (requireNodeDef(type).params ?? []).find((p) => p.id === CARRY_PARAM_ID)
      expect(param?.kind, type).toBe('columns')
      expect(param?.kind === 'columns' && param.from, type).toBe('neurons')
    }
    const synapses = (requireNodeDef('neuron.synapses').params ?? []).map((p) => p.id)
    expect(synapses).not.toContain(CARRY_PARAM_ID)
  })

  /* Edit time: the promise a downstream picker is configured against, before any Run. */
  it('widens the advertised attribute schema before anything is fetched', () => {
    const def = requireNodeDef('neuron.skeletons')
    const dataset = T.dataset('mock', 'optic-lobe-mini')
    const neurons = T.neurons(tableSchema(column('neuronId', 'str'), column('pre', 'i64')))
    const types = def.inferOutputs!(
      makeInferContext(
        def,
        { ...defaultParams(def), [CARRY_PARAM_ID]: ['pre'] },
        { dataset, neurons },
      ),
    )
    const schema = types.skeletons?.kind === 'skeletons' ? types.skeletons.schema : undefined
    expect(columnNames(schema)).toContain('pre')
    // Still the fetch's own fields, with the carried one added rather than replacing them.
    expect(columnNames(schema)).toContain('cableLength')
  })

  /** The pipeline above with a carry list on the geometry node. */
  const carrying = (type: string, carry: string[]) =>
    setNodeParam(pipeline(type, MAX_NEURONS), 'geo', CARRY_PARAM_ID, carry)

  it('carries the column onto the fetched geometry, matched by neuronId', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(carrying('neuron.skeletons', ['status']), { mode: 'full' })
    const skeletons = sched.output('geo', 'skeletons') as SkeletonsValue
    expect(skeletons.items.length).toBeGreaterThan(0)
    expect(columnNames(skeletons.attributes.schema)).toContain('status')
    expect(skeletons.attributes.length).toBe(skeletons.items.length)
    // Every row filled from the table one wire back, not left null by a join that missed.
    expect(skeletons.attributes.data.status?.every((v) => v !== null)).toBe(true)
  })

  it('does the same for meshes', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(carrying('neuron.meshes', ['status']), { mode: 'full' })
    const meshes = sched.output('geo', 'meshes') as MeshesValue
    expect(columnNames(meshes.attributes.schema)).toContain('status')
    expect(meshes.attributes.length).toBe(meshes.items.length)
  })

  /*
   * A column that has gone upstream is the framework's message, not this node's:
   * `validateColumnParams` reports it on the card before anything runs, and `resolveColumns`
   * has already dropped the name by the time `evaluate` reads it. A bespoke `ctx.warn` here was
   * written first and was dead code twice over — unreachable, and a second spelling of a
   * sentence the machinery owns.
   */
  it('leaves a column that has gone upstream to the generic report', () => {
    const def = requireNodeDef('neuron.skeletons')
    const ctx = makeInferContext(
      def,
      { ...defaultParams(def), [CARRY_PARAM_ID]: ['hemilineage'] },
      {
        dataset: T.dataset('mock', 'optic-lobe-mini'),
        neurons: T.neurons(tableSchema(column('neuronId', 'str'), column('pre', 'i64'))),
      },
    )
    expect(validateColumnParams(def, ctx)).toEqual(['Missing column(s): hemilineage'])
    // And the schema half does not promise what the join will not carry.
    const types = def.inferOutputs!(ctx)
    const schema = types.skeletons?.kind === 'skeletons' ? types.skeletons.schema : undefined
    expect(columnNames(schema)).not.toContain('hemilineage')
  })

  it('says nothing and changes nothing with an empty list', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(carrying('neuron.skeletons', []), { mode: 'full' })
    const skeletons = sched.output('geo', 'skeletons') as SkeletonsValue
    expect(columnNames(skeletons.attributes.schema)).toEqual([
      'neuronId',
      'type',
      'instance',
      'status',
      'size',
      'points',
      'cableLength',
    ])
  })

  /*
   * It is in the provenance key, because it changes what `evaluate` returns. `pre` rather than
   * `status`, which the morphology schema already carries — a column the fetch publishes anyway
   * would pass this test with the param doing nothing.
   */
  it('re-runs the node when the list changes', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(carrying('neuron.skeletons', []), { mode: 'full' })
    const first = sched.output('geo', 'skeletons') as SkeletonsValue
    await sched.run(carrying('neuron.skeletons', ['pre']), { mode: 'full' })
    const second = sched.output('geo', 'skeletons') as SkeletonsValue
    expect(columnNames(first.attributes.schema)).not.toContain('pre')
    expect(columnNames(second.attributes.schema)).toContain('pre')
    expect(second.attributes.data.pre?.length).toBe(second.items.length)
  })
})

describe('the Source control', () => {
  const def = requireNodeDef('neuron.skeletons')

  /** A source whose route list is whatever the test says, including "not known yet". */
  function withRoutes(id: string, routes: readonly SkeletonProvenance[] | undefined) {
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id,
        skeletonSourcesFor: () => routes,
      }),
    )
    return T.dataset(id, 'ds:1')
  }

  const optionsFor = (type: ReturnType<typeof T.dataset>, chosen = '') =>
    enumOptions(def, 'skeletonSource', type, chosen)

  it('names the route Automatic will take, even where there is only one', () => {
    // This is the whole of what the control does on a single-route dataset, and it is the point:
    // "Automatic" on its own is a provenance question mark on every graph anyone shares.
    const type = withRoutes('one-route', [{ id: 'neuprint', label: 'neuPrint SWC' }])
    expect(optionsFor(type)).toEqual([{ value: '', label: 'Automatic (neuPrint SWC)' }])
  })

  it('offers each route once there is a choice, in the order the fetch would take them', () => {
    const type = withRoutes('two-routes', [
      { id: 'published', label: 'published skeletons' },
      { id: 'l2', label: 'level-2 chunk graph' },
    ])
    expect(optionsFor(type).map((o) => o.value)).toEqual(['', 'published', 'l2'])
    expect(optionsFor(type)[0]!.label).toBe('Automatic (published skeletons)')
  })

  it('keeps a stored choice while the peeks are still in flight, without calling it broken', () => {
    /*
     * `undefined` is "not known yet" rather than "none" — the routes arrive from probes that
     * `inferOutputs` may not await (invariant 2). Labelling a perfectly good pinned choice "not
     * available" for the first second of every session is how a control teaches people to
     * ignore it.
     */
    const type = withRoutes('unknown-yet', undefined)
    expect(optionsFor(type, 'published')).toEqual([
      { value: '', label: 'Automatic' },
      { value: 'published', label: 'published' },
    ])
    expect(
      def.validate?.(
        makeInferContext(
          def,
          { ...defaultParams(def), skeletonSource: 'published' },
          { dataset: type },
        ),
      ),
    ).toEqual([])
  })

  it('reports a pinned route this dataset does not have, rather than substituting one', () => {
    /*
     * The substitution is the failure: answering with a chunk-graph skeleton because the
     * published bucket is absent would silently change every cable length downstream, under a
     * card that still said "published". Same rule a column picker follows.
     */
    const type = withRoutes('l2-only', [{ id: 'l2', label: 'level-2 chunk graph' }])
    const issues =
      def.validate?.(
        makeInferContext(
          def,
          { ...defaultParams(def), skeletonSource: 'published' },
          { dataset: type },
        ),
      ) ?? []
    expect(issues.join(' ')).toMatch(/no “published” skeletons.*level-2 chunk graph/s)
    // Still listed, so the card shows what the graph actually says.
    expect(optionsFor(type, 'published').map((o) => o.value)).toContain('published')
  })

  it('is empty by default and reaches the request only when set', async () => {
    /*
     * Empty means *nobody chose* rather than "the first one", which is what lets a source fall
     * back when its preferred route turns out to answer for nothing — CAVE's skeleton service
     * against a datastack whose cache is empty. A node that always sent a route id would take
     * that fallback away.
     */
    const asked: Array<string | undefined> = []
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id: 'records-route',
        fetchSkeletons: (req: GeometryRequest) => {
          asked.push(req.skeletonSource)
          return base.fetchSkeletons(req)
        },
      }),
    )

    const graph = pipeline('neuron.skeletons', 500)
    const withSource = { ...graph, nodes: graph.nodes.map(routedToRecorder) }
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(withSource, { mode: 'full' })
    await sched.run(setNodeParam(withSource, 'geo', 'skeletonSource', 'l2'), { mode: 'full' })
    expect(asked).toEqual([undefined, 'l2'])
  })

  it('refuses a route the backend has never had, on a source that only ever has one', async () => {
    /*
     * The gap this closes. Three of the five sources read no route at all, so a node pinned to
     * `published` and repointed at CATMAID — or at the mock — got that backend's own skeletons,
     * labelled as its own, with nothing saying the choice had been dropped. `validate` does not
     * cover it: it is deliberately silent while the routes are unknown, and a badge does not stop
     * a run.
     *
     * The refusal is `requireSkeletonRoute`'s, shared, so all five say it in one sentence — the
     * two that *did* have the check had already worded it two ways.
     */
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    const graph = setNodeParam(pipeline('neuron.skeletons', 500), 'geo', 'skeletonSource', 'l2')
    await sched.run(graph, { mode: 'full' })
    expect(sched.info('geo').error).toMatch(/no "l2" skeletons.*synthetic/s)
  })

  it('is in the provenance key, because the route changes the geometry', () => {
    /*
     * Not `presentational`. A chunk-graph skeleton and a traced one are different points with
     * different cable lengths, so a route change that left a cached result standing would show
     * one route's skeletons under a card claiming the other — invariant 4's failure exactly.
     */
    const param = (def.params ?? []).find((p) => p.id === 'skeletonSource')
    expect(param?.presentational).not.toBe(true)
  })
})

/**
 * The Synapses node's two controls, which used to be one and meant something else.
 *
 * `Min weight` was an integer floored at 1, and every backend read it as its own per-synapse
 * confidence column — so the *default* compiled to `s.confidence >= 1` against neuPrint's 0..1
 * score. On `male-cns:v1.0` body 10001 that returned 13,617 of 19,597 synapses and not one
 * presynaptic site; on MANC and optic-lobe it returned no presynaptic site anywhere. It is now
 * `Min confidence`, a float defaulting to 0, which is off.
 *
 * `Rows` is the other half. The three backends enumerate synapses differently — see
 * `data/synapseUnits.ts` for the measurements — and until this control existed the node passed
 * whichever one along with nothing on the card to say which.
 */
describe('the Synapses node’s controls', () => {
  const def = requireNodeDef('neuron.synapses')
  const param = (id: string) => (def.params ?? []).find((p) => p.id === id)

  /** A source whose unit list is whatever the test says. */
  function withUnits(id: string, units: readonly string[] | undefined) {
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, { id, synapseUnits: units }),
    )
    return T.dataset(id, 'ds:1')
  }

  const optionsFor = (type: ReturnType<typeof T.dataset>, chosen = '') =>
    enumOptions(def, SYNAPSE_UNIT_PARAM, type, chosen)

  it('starts Min confidence at zero, which excludes nothing', () => {
    /*
     * The number that matters in this file. A default of 1 against a 0..1 score is not a
     * conservative setting — it is a filter nobody asked for, and it kept a thousandth of the
     * cloud on hemibrain.
     */
    const p = param('minConfidence')
    expect(p?.kind).toBe('number')
    expect(p && 'default' in p ? p.default : undefined).toBe(0)
    expect(p && 'min' in p ? p.min : undefined).toBe(0)
    // No `max`: the scale is the backend's own and the three do not agree — 0..1 on neuPrint,
    // a tracer's 1..5 on CATMAID, `cleft_score`'s few hundred on FlyWire.
    expect(p && 'max' in p ? p.max : undefined).toBeUndefined()
    expect(p?.advanced).toBe(true)
  })

  it('no longer carries the control it was renamed from', () => {
    // Renaming the id is what carries stored graphs across: `normalizeParams` reads only declared
    // params, so an old `minWeight: 1` leaves the provenance key and the absent `minConfidence`
    // falls to its default of off. A shim keeping both spellings would have kept the filter.
    expect(param('minWeight')).toBeUndefined()
  })

  it('names the unit Automatic will take, even where there is only one', () => {
    const type = withUnits('links-only', ['links'])
    expect(optionsFor(type)).toEqual([
      { value: '', label: 'Automatic (one row per connection)' },
    ])
  })

  it('offers both units where the backend has both, in the order the fetch would take them', () => {
    const type = withUnits('both-units', ['sites', 'links'])
    expect(optionsFor(type).map((o) => o.value)).toEqual(['', 'sites', 'links'])
    expect(optionsFor(type)[0]!.label).toBe('Automatic (one row per site)')
  })

  it('reports a pinned unit this source cannot deliver, rather than substituting one', () => {
    /*
     * The substitution is the failure. A CAVE table has no presynaptic-site identity, so
     * answering `sites` with its links would change what a row counts under a card still saying
     * "one row per site" — which a syNBLAST and every density measure read.
     *
     * Asserted in **labels**, not ids, and that is the point of the shared `synapseUnitRefusal`:
     * the node's edit-time complaint and the run-time throw were written separately at first and
     * promptly said `“sites”` and `“one row per site”` about the same refusal, which is
     * `UNIT_LABELS`' own rule broken between its own two layers.
     */
    const type = withUnits('links-only-2', ['links'])
    const issues =
      def.validate?.(
        makeInferContext(
          def,
          { ...defaultParams(def), synapseUnit: 'sites' },
          { dataset: type },
        ),
      ) ?? []
    expect(issues.join(' ')).toContain('cannot return synapses as “one row per site”')
    expect(issues.join(' ')).toContain('it offers one row per connection')
  })

  it('keeps its own label for a pinned unit the source serves but did not list', () => {
    /*
     * The regression this exists for. A lone unit is never pushed into the options — Automatic
     * already says the whole of it — so a graph pinned to a single-unit source's *only* unit fell
     * through to the "chosen but unlisted" branch and was drawn `links (not available here)`,
     * while `validate` correctly said nothing was wrong. Two halves of one decision disagreeing on
     * the card, which is exactly what sharing `UNIT_LABELS` is supposed to prevent. Reachable by
     * picking "one row per connection" on neuPrint and repointing the Dataset node at FlyWire.
     */
    const type = withUnits('links-only-3', ['links'])
    expect(optionsFor(type, 'links')).toEqual([
      { value: '', label: 'Automatic (one row per connection)' },
      { value: 'links', label: 'one row per connection' },
    ])
    expect(
      def.validate?.(
        makeInferContext(
          def,
          { ...defaultParams(def), synapseUnit: 'links' },
          { dataset: type },
        ),
      ),
    ).toEqual([])
  })

  it('resolves the unit once, at the node, and refuses there rather than in each backend', async () => {
    /*
     * `fetchSynapses` has exactly one caller, and a unit varies with nothing — so the check used
     * to sit in all four backends, three of which discarded its answer. `SynapseRequest.unit` is
     * required instead, which makes the single door the only way in and a forgotten declaration a
     * compile error rather than a silent substitution.
     */
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    const graph = setNodeParam(
      pipeline('neuron.synapses', 10),
      'geo',
      SYNAPSE_UNIT_PARAM,
      'sites',
    )
    await sched.run(graph, { mode: 'full' })
    // The mock serves `links` only, and says so in the same sentence `validate` shows.
    expect(sched.info('geo').error).toMatch(/cannot return synapses as “one row per site”/)
  })

  it('keeps a stored choice while nothing is wired, without calling it broken', () => {
    const type = withUnits('no-units', undefined)
    expect(optionsFor(type, 'sites')).toEqual([
      { value: '', label: 'Automatic' },
      { value: 'sites', label: 'sites' },
    ])
    expect(
      def.validate?.(
        makeInferContext(
          def,
          { ...defaultParams(def), synapseUnit: 'sites' },
          { dataset: type },
        ),
      ),
    ).toEqual([])
  })

  it('puts both controls in the provenance key, because both change what comes back', () => {
    // Not `presentational`. A deduplicated cloud is 1,015 points where the other is 4,491 of
    // them, and a confidence cut removes rows — invariant 4's failure either way.
    expect(param('synapseUnit')?.presentational).not.toBe(true)
    expect(param('minConfidence')?.presentational).not.toBe(true)
  })
})

/** Points the pipeline's dataset node at the recording source above. */
function routedToRecorder(node: GraphNode): GraphNode {
  return node.type === 'neuron.dataset'
    ? { ...node, params: { ...node.params, source: 'records-route' } }
    : node
}

describe('the two reduction controls', () => {
  const def = requireNodeDef('neuron.meshes')

  /** A source whose answer to "does this dataset have mesh levels" is whatever the test says. */
  function withLevels(id: string, levels: boolean | undefined) {
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, { id, meshLevelsFor: () => levels }),
    )
    return T.dataset(id, 'ds:1')
  }

  it('offers the budget where the source has levels to spend it among', () => {
    const options = enumOptions(def, 'detail', withLevels('levelled', true))
    expect(options.map((o) => o.value)).toEqual(['150000', '1500000', '6000000'])
  })

  it('draws Detail dead where the source publishes one level', () => {
    /*
     * The control used to be live here and to mean something else: `triangleBudget`'s contract
     * says a single-level source ignores it, so the CAVE source honoured it by clustering
     * vertices instead — one dropdown picking a published level on neuPrint and recomputing the
     * geometry on FlyWire.
     *
     * **No options**, which is how `ParamField` already draws a dead control: a genuinely
     * `disabled` select carrying `EnumParam.empty`. One inert-looking option was the first shape
     * and is worse than it sounds — a `select` with a single entry is operable, focusable and
     * indistinguishable from a real choice until you open it.
     */
    expect(enumOptions(def, 'detail', withLevels('flat', false))).toEqual([])
    const param = def.params?.find((p) => p.id === 'detail')
    expect(param?.kind === 'enum' && param.empty).toMatch(/one level of detail/)
  })

  it('keeps a stored budget while the control is dead, so swapping back finds it', () => {
    // The reason this is not `visibleIf`, beyond `visibleIf` being handed params alone: a hidden
    // param leaves the provenance key and its value stops being anybody's.
    const param = def.params?.find((p) => p.id === 'detail')
    expect(param?.visibleIf).toBeUndefined()
    expect(param?.presentational).toBeUndefined()
  })

  it('leaves Detail alone while no peek has landed', () => {
    // `undefined` is "nobody has looked", which is most of a fresh session. A control that greys
    // itself out for the first second every time is one people learn to distrust.
    expect(enumOptions(def, 'detail', withLevels('unknown', undefined))).toHaveLength(3)
  })

  it('defaults to full resolution, and reads absence as the automatic it used to be', () => {
    /*
     * Two different answers about a picture, which is what `absentMeans` is for. The **default**
     * is full resolution: a full-resolution mesh drew nothing until `drawRanges` split it across
     * draw calls, and that was a drawing bug — reducing the geometry by default would have been
     * papering over it. **Absence** is automatic, because a workflow saved before this control
     * existed was drawn by a build that reduced graphene meshes out of `triangleBudget`, so
     * opening it at full resolution would silently make it several times heavier than the picture
     * it was saved as.
     */
    const param = def.params?.find((p) => p.id === 'downsample')
    expect(param?.default).toBe(1)
    expect(param?.absentMeans).toBe(0)
  })

  it('sends automatic for 0, and full resolution for 1', () => {
    // Three values, three meanings: 1 is what a source publishes, 0 asks for as much as a scene
    // can draw, and above 1 is a ratio.
    expect(meshDetailRequest({ detail: '1500000', downsample: 0 })).toEqual({
      triangleBudget: 1_500_000,
      downsample: 'auto',
    })
    expect(meshDetailRequest({ detail: '1500000', downsample: 1 })).toEqual({
      triangleBudget: 1_500_000,
    })
    expect(meshDetailRequest({ detail: '1500000', downsample: 4 })).toEqual({
      triangleBudget: 1_500_000,
      downsample: 4,
    })
  })

  it('keeps the budget and the factor independent', () => {
    // They compose on a pyramid: the budget picks which published level to read, the factor
    // reduces what came back. Somebody already at the coarsest level can still go further.
    expect(meshDetailRequest({ detail: '150000', downsample: 8 })).toEqual({
      triangleBudget: 150_000,
      downsample: 8,
    })
  })
})

/**
 * `fetchMeshesFor`: the seam that makes `downsample` a request a source cannot silently decline.
 *
 * It exists because the contract was otherwise honoured by hand at four leaves, which is exactly
 * how `triangleBudget` came to mean two different things — and `MockSource` declines it, so the
 * failure is in the tree rather than hypothetical.
 */
describe('the downsample seam', () => {
  /** A source that hands back a fixed mesh and records what it was asked for. */
  function meshSource(
    id: string,
    build: (req: GeometryRequest) => MeshesValue,
  ): { type: ReturnType<typeof T.dataset>; seen: GeometryRequest[] } {
    const seen: GeometryRequest[] = []
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id,
        fetchMeshes: (req: GeometryRequest) => {
          seen.push(req)
          return Promise.resolve(build(req))
        },
      }),
    )
    return { type: T.dataset(id, 'ds:1'), seen }
  }

  /** A square grid of `n` triangles, which reduces predictably. */
  function meshValue(triangles: number, detail?: MeshesValue['detail']): MeshesValue {
    const positions = new Float32Array((triangles + 2) * 3)
    for (let i = 0; i < triangles + 2; i++) {
      positions[i * 3] = (i % 64) * 100
      positions[i * 3 + 1] = Math.floor(i / 64) * 100
      positions[i * 3 + 2] = (i % 7) * 50
    }
    const indices = new Uint32Array(triangles * 3)
    for (let t = 0; t < triangles; t++) {
      indices[t * 3] = t
      indices[t * 3 + 1] = t + 1
      indices[t * 3 + 2] = t + 2
    }
    return {
      kind: 'meshes',
      items: [{ id: '1', positions, indices }],
      attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1'] }),
      bounds: { min: [0, 0, 0], max: [6400, 6400, 350] },
      ...(detail ? { detail } : {}),
    }
  }

  it('reduces a source that ignored the request, and says so', async () => {
    // `MockSource` declines `downsample` outright, which is the case the wrapper exists for.
    const { type } = meshSource('declines', () => meshValue(40_000))
    const source = requireSource('declines')
    const out = await fetchMeshesFor(source, {
      datasetId: 'ds:1',
      neuronIds: ['1'],
      downsample: 4,
    })
    expect(out.items[0]!.indices.length / 3).toBeLessThan(40_000)
    // The receipt, without which a reduction is invisible — `core/values.ts` on `downsample`.
    expect(out.detail?.downsample).toBeGreaterThanOrEqual(2)
    void type
  })

  it('does not reduce a second time over a source that already did', async () => {
    /*
     * The bug this pins. The seam's opt-out is the receipt, and for one round only the graphene
     * route wrote it — so the flat, pyramid and neuPrint routes reduced at the fetch and were
     * reduced **again** here, delivering a sixteenth for a requested quarter.
     */
    const { type } = meshSource('already', () =>
      meshValue(10_000, { lod: 0, levels: 1, triangles: 10_000, downsample: 4 }),
    )
    const source = requireSource('already')
    const out = await fetchMeshesFor(source, {
      datasetId: 'ds:1',
      neuronIds: ['1'],
      downsample: 4,
    })
    expect(out.items[0]!.indices.length / 3).toBe(10_000)
    expect(out.detail?.downsample).toBe(4)
    void type
  })

  it('leaves a set alone where nothing was asked for, and claims nothing', async () => {
    const { type } = meshSource('full', () => meshValue(10_000))
    const source = requireSource('full')
    const out = await fetchMeshesFor(source, { datasetId: 'ds:1', neuronIds: ['1'] })
    expect(out.items[0]!.indices.length / 3).toBe(10_000)
    expect(out.detail?.downsample).toBeUndefined()
    void type
  })
})
