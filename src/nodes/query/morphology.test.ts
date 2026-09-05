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
import { defaultParams, makeInferContext } from '../../core/node'
import type { NodeDefinition } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource, GeometryRequest, SourceCapabilities } from '../../data/source'
import { registerSource, requireSource } from '../../data/source'
import { T } from '../../core/types'
import type { SkeletonProvenance } from '../../core/values'
import { MAX_NEURONS } from './morphology'
import { SYNAPSE_UNIT_PARAM } from '../lib/synapseParams'

import '../index'

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
      expect(limitParam(type).help ?? '', type).toMatch(/threshold, not a cap/)
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
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
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

describe('an oversized set', () => {
  it.each(MORPHOLOGY_NODES)('%s names the real constraint, not the viewer', async (type) => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline(type, 1), { mode: 'full' })

    const info = sched.info('geo')
    // The whole change: there is a result under the sentence. It used to be `error`, and
    // everything downstream was blocked by a wait somebody had not been asked about.
    expect(info.error ?? info.state).toBe('ok')
    expect(sched.warning('geo')).toMatch(/neurons is past this node's Warn above \(1\)/)
    expect(sched.warning('geo')).toMatch(/cancel and filter upstream/)
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
