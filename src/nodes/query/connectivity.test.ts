/**
 * The Connectivity node, driven through the real scheduler against the mock connectome.
 *
 * `connectivityOps.test.ts` pins the traversal against a hand-written graph. This covers the
 * half that file cannot: that the schema the node *advertises* at edit time is the schema it
 * *builds* at run time (invariant 3), and that the params reach the source — a `hops` that
 * quietly never left the node would still produce a perfectly valid one-hop table.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, deserializeGraph, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { isTableValue } from '../../core/values'
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

/** dataset → find → connectivity */
function pipeline(params: Record<string, unknown> = {}, seedType = 'LC4'): CodaGraph {
  let g = emptyGraph('connectivity-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', { typePattern: seedType, status: 'Traced' }),
  )
  g = addNode(g, node('conn', 'neuron.connectivity', params))
  const wire = (source: string, handle: string, target: string, into: string) => {
    g = addEdge(g, { source, sourceHandle: handle, target, targetHandle: into })
  }
  wire('ds', 'dataset', 'find', 'dataset')
  wire('ds', 'dataset', 'conn', 'dataset')
  wire('find', 'neurons', 'conn', 'neurons')
  return g
}

function scheduler() {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

async function connections(params: Record<string, unknown> = {}, seedType?: string) {
  const sched = scheduler()
  await sched.run(pipeline(params, seedType), { mode: 'full' })
  const table = sched.output('conn', 'connections')
  if (!isTableValue(table)) throw new Error(`expected a table, got ${JSON.stringify(table)}`)
  return table
}

/** What the card promises before a Run, which every shape test compares against. */
function advertised(params: Record<string, unknown> = {}): string[] | undefined {
  const declared = inferGraph(pipeline(params)).nodes.conn?.outputs.connections
  return declared && 'schema' in declared
    ? declared.schema?.columns.map((c) => c.name)
    : undefined
}

describe('Connectivity output shape', () => {
  it('advertises the columns it actually builds', async () => {
    expect(advertised()).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
      'hop',
      'direction',
    ])

    const table = await connections()
    expect(table.schema.columns.map((c) => c.name)).toEqual(advertised())
  })

  it('carries hop and direction even at the default one hop downstream', async () => {
    const table = await connections()
    expect(table.length).toBeGreaterThan(0)
    expect(new Set(table.data.hop)).toEqual(new Set([1]))
    expect(new Set(table.data.direction)).toEqual(new Set(['downstream']))
  })
})

describe('direction', () => {
  it('orients an upstream row pre → post, so preId is the partner', async () => {
    const seeds = new Set((await connections()).data.preId?.map(Number))
    const upstream = await connections({ direction: 'inputs' })
    // Every row is an edge *into* a seed: the seeds are on the post side now.
    for (const id of upstream.data.postId ?? []) expect(seeds.has(Number(id))).toBe(true)
    expect(new Set(upstream.data.direction)).toEqual(new Set(['upstream']))
  })

  it('queries both ways for "both" and returns strictly more than either alone', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchConnectivity')
    try {
      const both = await connections({ direction: 'both' })
      expect(spy.mock.calls.map((c) => c[0].direction).sort()).toEqual(['inputs', 'outputs'])

      const out = await connections({ direction: 'outputs' })
      const inn = await connections({ direction: 'inputs' })
      expect(both.length).toBeGreaterThan(Math.max(out.length, inn.length))
      expect(both.length).toBeLessThanOrEqual(out.length + inn.length)
    } finally {
      spy.mockRestore()
    }
  })

  it('never emits the same edge twice, whatever the direction', async () => {
    const table = await connections({ direction: 'both', hops: 2 })
    const pairs = (table.data.preId ?? []).map((pre, i) => `${pre}>${table.data.postId?.[i]}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})

describe('hops', () => {
  it('reaches the source as a second round of queries', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchConnectivity')
    try {
      await connections({ hops: 2 })
      expect(spy.mock.calls.length).toBe(2)
      // The second round asks about the neurons the first one found, not the seeds again.
      const first = new Set(spy.mock.calls[0]?.[0].neuronIds)
      const second = spy.mock.calls[1]?.[0].neuronIds ?? []
      expect(second.length).toBeGreaterThan(0)
      expect(second.some((id) => !first.has(id))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('adds hop-2 rows without dropping the hop-1 ones', async () => {
    const one = await connections()
    const two = await connections({ hops: 2 })
    expect(new Set(two.data.hop)).toEqual(new Set([1, 2]))
    expect(two.length).toBeGreaterThan(one.length)

    const oneHopPairs = new Set(
      (one.data.preId ?? []).map((pre, i) => `${pre}>${one.data.postId?.[i]}`),
    )
    const twoHopPairs = new Set(
      (two.data.preId ?? []).map((pre, i) => `${pre}>${two.data.postId?.[i]}`),
    )
    for (const pair of oneHopPairs) expect(twoHopPairs.has(pair)).toBe(true)
  })

  it('changes the cache key, so lifting Hops does not reuse the shallow result', async () => {
    const sched = scheduler()
    await sched.run(pipeline({ hops: 1 }), { mode: 'full' })
    const shallow = sched.output('conn', 'connections')
    await sched.run(pipeline({ hops: 2 }), { mode: 'full' })
    const deep = sched.output('conn', 'connections')
    if (!isTableValue(shallow) || !isTableValue(deep)) throw new Error('expected tables')
    expect(deep.length).toBeGreaterThan(shallow.length)
  })
})

describe('warnings', () => {
  it('says so when the hop count and the weight cut multiply badly', () => {
    const quiet = inferGraph(pipeline({ hops: 3, minWeight: 10 })).nodes.conn?.issues ?? []
    expect(quiet).toEqual([])

    const loud = inferGraph(pipeline({ hops: 3, minWeight: 1 })).nodes.conn?.issues ?? []
    expect(loud.some((i) => /Raise Min weight/.test(i.message))).toBe(true)
    // A warning, never a refusal — the graph stays runnable.
    expect(loud.every((i) => i.severity === 'warning')).toBe(true)
  })
})

/**
 * The region and normalisation controls, end to end against the mock.
 *
 * `connectivityOps.test.ts` pins the arithmetic against hand-written tables. What only the real
 * scheduler can show is that the params reach the source at all — a `splitByRoi` that never left
 * the node still returns a perfectly valid unsplit table — and that the schema the card
 * advertises before a Run is the one the run produces (invariant 3), which is now conditional on
 * two switches and so has two more ways to come apart.
 */
describe('split by region', () => {
  it('advertises and builds the roi column together', async () => {
    expect(advertised({ splitByRoi: true })).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
      'roi',
      'hop',
      'direction',
    ])
    const table = await connections({ splitByRoi: true })
    expect(table.schema.columns.map((c) => c.name)).toEqual(advertised({ splitByRoi: true }))
  })

  /*
   * `Dm8`, not the `LC4` the rest of this file uses, and the difference is anatomy rather than
   * convenience: an LC4's targets concentrate their input in one region, so every one of its
   * connections is already a single-region connection and a split over them would be a test
   * that passes against a source ignoring the flag. Dm8's outputs split 19 rows into 37.
   */
  const SPLITTING_TYPE = 'Dm8'

  it('decomposes rather than adds: the parts sum to the unsplit weights', async () => {
    const whole = await connections({}, SPLITTING_TYPE)
    const split = await connections({ splitByRoi: true }, SPLITTING_TYPE)

    const totalOf = (t: typeof whole): Map<string, number> => {
      const sums = new Map<string, number>()
      for (let row = 0; row < t.length; row++) {
        const key = `${t.data.preId?.[row]}>${t.data.postId?.[row]}`
        sums.set(key, (sums.get(key) ?? 0) + Number(t.data.weight?.[row]))
      }
      return sums
    }
    const before = totalOf(whole)
    const after = totalOf(split)

    // Same connections — a split must not change which partners are found, which is why
    // `minWeight` is applied before it.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [pair, weight] of before) expect(after.get(pair)).toBe(weight)
    // …and strictly more rows, or nothing was split at all and the assertion above is vacuous.
    expect(split.length).toBeGreaterThan(whole.length)
    expect(split.data.roi?.every((roi) => typeof roi === 'string' && roi !== '')).toBe(true)
  })

  it('restricts weights to the named regions rather than passing whole connections', async () => {
    const whole = await connections({}, SPLITTING_TYPE)
    const split = await connections({ splitByRoi: true }, SPLITTING_TYPE)
    const roi = String(split.data.roi?.[0])
    const restricted = await connections({ rois: [roi] }, SPLITTING_TYPE)

    expect(restricted.length).toBeGreaterThan(0)
    const sum = (t: typeof whole) =>
      (t.data.weight ?? []).reduce((a: number, b) => a + Number(b), 0)
    // Fewer synapses, because only the ones inside that one region are counted. A source that
    // ignored `rois` and passed the connections through whole would match `whole` exactly.
    expect(sum(restricted)).toBeLessThan(sum(whole))
  })

  it('reaches the source as request fields rather than being applied afterwards', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchConnectivity')
    try {
      await connections({ splitByRoi: true, rois: ['LO'] })
      expect(spy.mock.calls[0]?.[0].splitByRoi).toBe(true)
      expect(spy.mock.calls[0]?.[0].rois).toEqual(['LO'])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('normalize', () => {
  it('advertises and builds weightNorm with the denominator beside it', async () => {
    expect(advertised({ normalize: true })).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
      'hop',
      'direction',
      'weightNorm',
      'weightTotal',
    ])
    const table = await connections({ normalize: true })
    expect(table.schema.columns.map((c) => c.name)).toEqual(advertised({ normalize: true }))
  })

  it('publishes the denominator it actually divided by', async () => {
    const table = await connections({ normalize: true })
    expect(table.length).toBeGreaterThan(0)
    for (let row = 0; row < table.length; row++) {
      const total = Number(table.data.weightTotal?.[row])
      const weight = Number(table.data.weight?.[row])
      // The transparency claim, checkable from the table alone: the fraction is the two
      // published columns divided, with nothing else folded in.
      expect(Number(table.data.weightNorm?.[row])).toBeCloseTo(weight / total, 12)
    }
  })

  it('asks the source for the side the mode names', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchSynapseTotals')
    try {
      await connections({ normalize: true, normalizeBy: 'postsynaptic' })
      // Dividing by the *target's input* means totalling incoming synapses. The words on the
      // control and the word on the wire are opposites, which is the flip worth pinning.
      expect(spy.mock.calls[0]?.[0].side).toBe('inputs')
      spy.mockClear()
      await connections({ normalize: true, normalizeBy: 'presynaptic' })
      expect(spy.mock.calls[0]?.[0].side).toBe('outputs')
    } finally {
      spy.mockRestore()
    }
  })

  it('reaches the source as the basis it was given', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchSynapseTotals')
    try {
      await connections({ normalize: true, normalizeBasis: 'connected' })
      expect(spy.mock.calls[0]?.[0].basis).toBe('connected')
    } finally {
      spy.mockRestore()
    }
  })

  /*
   * The two bases agreeing is the *expected* answer on this connectome and not a sign the
   * control does nothing: a synthetic dataset has no unreconstructed fragments, so every
   * synapse it contains is on a connection between two neurons it knows and the two
   * denominators count the same set. See `MockSource.fetchSynapseTotals` — on male-cns the
   * same pair answers 23,423 and 9,324. Asserted rather than left unsaid, because a mock that
   * quietly grew a gap here would mean the generator had started inventing synapses.
   */
  it('agrees between bases on a connectome with no unreconstructed fragments', async () => {
    const all = await connections({ normalize: true, normalizeBasis: 'all' })
    const connected = await connections({ normalize: true, normalizeBasis: 'connected' })
    const totals = (t: typeof all) => (t.data.weightTotal ?? []).map(Number)
    expect(totals(connected)).toEqual(totals(all))
  })

  it('changes the cache key, so turning it on does not serve the un-normalised result', async () => {
    const sched = scheduler()
    await sched.run(pipeline({ normalize: false }), { mode: 'full' })
    const plain = sched.output('conn', 'connections')
    await sched.run(pipeline({ normalize: true }), { mode: 'full' })
    const scaled = sched.output('conn', 'connections')
    if (!isTableValue(plain) || !isTableValue(scaled)) throw new Error('expected tables')
    expect(plain.schema.columns.map((c) => c.name)).not.toContain('weightNorm')
    expect(scaled.schema.columns.map((c) => c.name)).toContain('weightNorm')
  })
})

/**
 * The `Neuron Set` port.
 *
 * `connectivityOps.test.ts` pins the derivation against a hand-written edge list. What is left
 * for here is what only the real node and the real scheduler can answer: that the card
 * advertises the schema it builds under both settings (invariant 3), that `full` actually
 * reaches the source, and that the setting reaches the provenance key — a control that changed
 * the output without re-keying would serve the derived table for a graph asking for full rows.
 */
describe('the Neuron Set port', () => {
  async function neurons(params: Record<string, unknown> = {}) {
    const sched = scheduler()
    await sched.run(pipeline(params), { mode: 'full' })
    const table = sched.output('conn', 'neuronSet')
    if (!isTableValue(table)) throw new Error(`expected a table, got ${JSON.stringify(table)}`)
    return table
  }

  function advertisedNeurons(params: Record<string, unknown> = {}): string[] | undefined {
    const declared = inferGraph(pipeline(params)).nodes.conn?.outputs.neuronSet
    return declared && 'schema' in declared
      ? declared.schema?.columns.map((c) => c.name)
      : undefined
  }

  it('advertises the columns it builds, derived', async () => {
    expect(advertisedNeurons()).toEqual(['neuronId', 'type'])
    const table = await neurons()
    expect(table.schema.columns.map((c) => c.name)).toEqual(advertisedNeurons())
    expect(table.kind).toBe('neurons')
  })

  it('advertises the columns it builds, full', async () => {
    const columns = advertisedNeurons({ neuronRows: 'full' })
    expect(columns).toContain('status')
    expect(columns?.length).toBeGreaterThan(2)

    const table = await neurons({ neuronRows: 'full' })
    expect(table.schema.columns.map((c) => c.name)).toEqual(columns)
    expect(table.kind).toBe('neurons')
  })

  it('holds both ends of the edge list, and the seeds', async () => {
    const edges = await connections()
    const table = await neurons()
    const ids = new Set((table.data.neuronId ?? []).map(String))

    for (const end of ['preId', 'postId'] as const) {
      for (const cell of edges.data[end] ?? []) expect(ids.has(String(cell))).toBe(true)
    }
    expect(ids.size).toBe(table.length)

    // The seeds are in it whether or not they are in the edges — here they are, since a
    // downstream traversal puts every seed on a `preId`.
    const sched = scheduler()
    await sched.run(pipeline(), { mode: 'full' })
    const seeds = sched.output('find', 'neurons')
    if (!isTableValue(seeds)) throw new Error('expected the seed table')
    for (const cell of seeds.data.neuronId ?? []) expect(ids.has(String(cell))).toBe(true)
  })

  /*
   * The left join, which is the property the port is for: `findNeurons` answers only about
   * published neurons, so a lookup keyed by an endpoint list comes back shorter than the list.
   * Asserted with fragments included as well, because that is the setting under which the two
   * can differ — unticked, the filter has already removed everything the lookup would miss.
   */
  it('is the same neuron set either way — full only changes the columns', async () => {
    for (const includeFragments of [false, true]) {
      const derived = await neurons({ includeFragments })
      const full = await neurons({ includeFragments, neuronRows: 'full' })
      expect(full.length).toBe(derived.length)
      expect(full.data.neuronId).toEqual(derived.data.neuronId)
    }
  })

  it('changes the cache key, so switching to full does not serve the derived table', async () => {
    const sched = scheduler()
    await sched.run(pipeline(), { mode: 'full' })
    const first = sched.output('conn', 'neuronSet')
    await sched.run(pipeline({ neuronRows: 'full' }), { mode: 'full' })
    const second = sched.output('conn', 'neuronSet')
    if (!isTableValue(first) || !isTableValue(second)) throw new Error('expected tables')
    expect(first.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type'])
    expect(second.schema.columns.map((c) => c.name)).toContain('status')
  })
})

/**
 * `Partners`: which bodies on the far end of an edge count as partners.
 *
 * The mock connectome publishes every body it wires, so the *result* is the same either way here
 * and nothing about the filtering itself can be asserted against it — `connectivityOps.test.ts`
 * owns that, against a hand-written graph. What only this layer can show is that the setting
 * reaches the source at all, and that it reaches the provenance key.
 */
describe('include fragments', () => {
  /*
   * Lookups **by id**, which is what the filter issues. The `Find Neurons` node upstream calls
   * the same method on the same source with a pattern instead, and counting those too would make
   * every assertion here about a different node.
   */
  function idLookups(spy: { mock: { calls: Array<[{ neuronIds?: readonly string[] }]> } }) {
    return spy.mock.calls.filter((call) => call[0]?.neuronIds !== undefined)
  }

  it('looks the far end up by default, and does not when asked for every partner', async () => {
    const source = requireSource('mock')
    const spy = vi.spyOn(source, 'findNeurons')

    spy.mockClear()
    await connections()
    // Once per hop. `Neuron Set` is derived by default, so this is the filter and nothing else.
    expect(idLookups(spy).length).toBeGreaterThan(0)

    spy.mockClear()
    await connections({ includeFragments: true })
    expect(idLookups(spy)).toEqual([])
    spy.mockRestore()
  })

  it('asks about the partners rather than the seeds', async () => {
    const source = requireSource('mock')
    const spy = vi.spyOn(source, 'findNeurons')
    spy.mockClear()
    const edges = await connections()
    const seeds = new Set((edges.data.preId ?? []).map(String))

    const asked = idLookups(spy).flatMap((call) => [...(call[0].neuronIds ?? [])].map(String))
    expect(asked.length).toBeGreaterThan(0)
    // A seed was named explicitly; narrowing it would delete a neuron somebody asked for.
    for (const id of asked) expect(seeds.has(id)).toBe(false)
    spy.mockRestore()
  })

  it('changes the cache key, so widening it does not serve the restricted result', async () => {
    const sched = scheduler()
    const source = requireSource('mock')
    const spy = vi.spyOn(source, 'findNeurons')

    await sched.run(pipeline(), { mode: 'full' })
    spy.mockClear()
    await sched.run(pipeline({ includeFragments: true }), { mode: 'full' })
    // Re-run rather than answered from the cache under the old key — and this time with no
    // lookup, which is what says the second run actually took the other branch.
    expect(idLookups(spy)).toEqual([])
    spy.mockRestore()
  })

  /*
   * The third state. A graph saved before this control existed queried every partner, which is
   * *not* the default — so absence has to be written in on load or every stored workflow silently
   * returns a different number of partners after an update. `graph.test.ts` owns the mechanism;
   * this is the claim about this param.
   */
  it('reads a stored node with no key for it as every partner', () => {
    const { graph } = deserializeGraph(
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'c',
            type: 'neuron.connectivity',
            position: { x: 0, y: 0 },
            params: { hops: 1 },
          },
        ],
        edges: [],
      }),
    )
    expect(graph.nodes[0]!.params.includeFragments).toBe(true)
  })

  it('leaves a stored value alone', () => {
    const { graph } = deserializeGraph(
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: 'c',
            type: 'neuron.connectivity',
            position: { x: 0, y: 0 },
            params: { includeFragments: false },
          },
        ],
        edges: [],
      }),
    )
    expect(graph.nodes[0]!.params.includeFragments).toBe(false)
  })
})
