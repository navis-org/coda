/**
 * The Connectivity node, driven through the real scheduler against the mock connectome.
 *
 * `connectivityOps.test.ts` pins the traversal against a hand-written graph. This covers the
 * half that file cannot: that the schema the node *advertises* at edit time is the schema it
 * *builds* at run time (invariant 3), and that the params reach the source — a `hops` that
 * quietly never left the node would still produce a perfectly valid one-hop table.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
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
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: seedType, status: 'Traced' }))
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
  return declared && 'schema' in declared ? declared.schema?.columns.map((c) => c.name) : undefined
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
