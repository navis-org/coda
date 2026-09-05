/**
 * Bounded influence, and the wrong answers that look exactly like right ones.
 *
 * Everything guarded here fails quietly. A traversal written as a breadth-first search returns
 * plausible scores — just with every recurrent contribution missing, which on a connectome is
 * most of what the metric was invented to capture. A forward pass normalised by the presynaptic
 * neuron's output total returns a beautifully behaved distribution that is not the influence
 * score. A meet-in-the-middle that decomposes each hop count more than once returns scores that
 * are simply too big, uniformly, so nothing about the shape of the result looks wrong. And a
 * frontier limit that silently keeps whichever neurons a `Map` happened to hold returns a
 * different answer on a second run of the same query.
 *
 * The fetch is a fake connectome rather than a source — the point of taking it as a callback —
 * so every hop's frontier is observable and the arithmetic can be checked against numbers
 * worked out by hand.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection } from '../../data/source'
import {
  adjustInfluence,
  summedVector,
  batched,
  combineHalves,
  influenceSchema,
  influenceTable,
  propagate,
  spreadMass,
  splitHops,
  truncation,
} from './influenceOps'

/** `pre`, `post`, synapses. */
type Edge = [string, string, number]

/**
 * Str ids throughout, because the fixtures are letters — and because a `str` id column is the
 * case invariant 8 is about. The shape is `CANONICAL_SCHEMAS.connectivity`.
 */
const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('neuronType', 'str'),
  column('partnerId', 'str'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

/**
 * The worked fixture.
 *
 *   A -10-> B     B -5-> C     A -2-> C     C -3-> A     D -30-> B     B -1-> D
 *
 * Input totals: A 3, B 40, C 7, D 1 — so every neuron has a complete input list and mass is
 * conserved exactly on an inputs walk, which is what lets the conservation test assert 1
 * rather than "no more than 1".
 */
const FIXTURE: Edge[] = [
  ['A', 'B', 10],
  ['B', 'C', 5],
  ['A', 'C', 2],
  ['C', 'A', 3],
  ['D', 'B', 30],
  ['B', 'D', 1],
]

function fakeSource(edges: Edge[] = FIXTURE) {
  const calls: Array<{ ids: NeuronId[]; direction: ConnectionDirection }> = []
  const fetch = async (
    neuronIds: NeuronId[],
    direction: ConnectionDirection,
  ): Promise<TableValue> => {
    calls.push({ ids: [...neuronIds], direction })
    const wanted = new Set(neuronIds)
    const rows = edges
      .filter(([pre, post]) => wanted.has(direction === 'outputs' ? pre : post))
      .map(([pre, post, weight]) => {
        const near = direction === 'outputs' ? pre : post
        const far = direction === 'outputs' ? post : pre
        return {
          neuronId: near,
          neuronType: `type-${near}`,
          partnerId: far,
          partnerType: `type-${far}`,
          weight,
        }
      })
    return tableFromRows(SCHEMA, rows)
  }
  return { fetch, calls }
}

/** Input totals over the whole fixture — the denominator an `outputs` walk cannot compute. */
function totalsOf(edges: Edge[] = FIXTURE) {
  const totals = new Map<NeuronId, number>()
  for (const [, post, weight] of edges) totals.set(post, (totals.get(post) ?? 0) + weight)
  return async (ids: NeuronId[]) => {
    const out = new Map<NeuronId, number>()
    for (const id of ids) {
      const value = totals.get(id)
      if (value !== undefined) out.set(id, value)
    }
    return out
  }
}

describe('propagate', () => {
  it('accumulates the truncated Neumann series, hop by hop', async () => {
    const { fetch } = fakeSource()
    const result = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 2,
      gain: 0.5,
      fetch,
    })

    const total = summedVector(result.total)
    // Worked by hand against the fixture. A picks up 2/7 at one hop and 5/28 at two, scaled by
    // 1/2 and 1/4 — 1/7 + 5/112 = 21/112 exactly.
    expect(total.get('A')).toBeCloseTo(21 / 112, 12)
    expect(total.get('B')).toBeCloseTo(0.5 * (5 / 7), 12)
    // The seed keeps its own k=0 term, and picks up the loop C -> A -> C at two hops.
    expect(total.get('C')).toBeCloseTo(1 + 0.25 * (2 / 7), 12)
    expect(total.get('D')).toBeCloseTo(0.25 * ((5 / 7) * 0.75), 12)
    expect(result.firstHop.get('D')).toBe(2)
    expect(result.firstHop.get('C')).toBe(0)
  })

  it('conserves mass on an inputs walk, which is what makes a discarded fraction readable', async () => {
    const { fetch } = fakeSource()
    const result = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 3,
      // Gain 1 so the terms are the raw distributions rather than a decayed copy of them.
      gain: 1,
      fetch,
    })
    for (const term of result.terms) expect(spreadMass(term)).toBeCloseTo(1, 12)
  })

  it('re-propagates from a neuron on every hop rather than expanding it once', async () => {
    // The not-a-BFS property. C -> A -> C is a two-cycle, so mass must return to C at hop 2 and
    // again at hop 4. A traversal that skipped visited nodes would leave both terms empty and
    // still look like a working influence calculation.
    const { fetch, calls } = fakeSource()
    const result = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 4,
      gain: 1,
      fetch,
    })
    expect(summedVector(result.terms[2]!).get('C')).toBeCloseTo(2 / 7, 12)
    expect(summedVector(result.terms[4]!).get('C')!).toBeGreaterThan(0)

    // ...and it costs one fetch per neuron, not one per neuron per hop.
    const asked = calls.flatMap((call) => call.ids)
    expect(asked.length).toBe(new Set(asked).size)
    expect(result.fetched).toBe(4)
  })

  it('refuses an outputs walk with no denominator lookup', async () => {
    const { fetch } = fakeSource()
    await expect(
      propagate({ seeds: ['A'], direction: 'outputs', hops: 2, gain: 0.5, fetch }),
    ).rejects.toThrow(/denominator/)
  })

  it('gives the same score whichever end it walks from', async () => {
    // The strongest statement available about the normalisation: W is the same matrix read two
    // ways, so the influence of A on C must not depend on which end was seeded. It would differ
    // the moment an outputs walk normalised by the presynaptic neuron's output total, which is
    // the plausible wrong implementation.
    const { fetch } = fakeSource()
    const backward = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 3,
      gain: 0.5,
      fetch,
    })
    const forward = await propagate({
      seeds: ['A'],
      direction: 'outputs',
      hops: 3,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    expect(summedVector(forward.total).get('C')).toBeCloseTo(
      summedVector(backward.total).get('A')!,
      12,
    )
  })

  it('reads the same denominator from a lookup as it sums from a complete input list', async () => {
    const { fetch } = fakeSource()
    const summed = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 3,
      gain: 0.5,
      fetch,
    })
    const looked = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 3,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    for (const [id, score] of summedVector(summed.total)) {
      expect(summedVector(looked.total).get(id)).toBeCloseTo(score, 12)
    }
  })

  it('is a lower bound that only ever rises with the hop budget', async () => {
    const { fetch } = fakeSource()
    const scores: number[] = []
    for (const hops of [1, 2, 3, 4, 5, 6]) {
      const result = await propagate({
        seeds: ['C'],
        direction: 'inputs',
        hops,
        gain: 0.5,
        fetch,
      })
      scores.push(summedVector(result.total).get('A') ?? 0)
    }
    for (let i = 1; i < scores.length; i++)
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!)
  })

  it('bounds what the unwalked hops could have added, and refuses to bound the other direction', async () => {
    const { fetch } = fakeSource()
    const short = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 2,
      gain: 0.5,
      fetch,
    })
    const long = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 20,
      gain: 0.5,
      fetch,
    })
    const bound = truncation(short)
    expect(bound).not.toBeNull()

    // The bound has to actually contain the gap it claims to bound.
    const gap = spreadMass(long.total) - spreadMass(short.total)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThanOrEqual(bound! + 1e-12)

    const forward = await propagate({
      seeds: ['A'],
      direction: 'outputs',
      hops: 2,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    // No bound travelling outputs: a neuron's outgoing input-fractions sum to whatever they
    // sum to, so there is nothing to multiply the last term by.
    expect(truncation(forward)).toBeNull()
    // Nor at a gain the series does not converge at.
    const hot = await propagate({ seeds: ['C'], direction: 'inputs', hops: 2, gain: 1, fetch })
    expect(truncation(hot)).toBeNull()
  })

  it('reports what the frontier limit cost, and drops the same neurons twice running', async () => {
    const { fetch } = fakeSource()
    const options = {
      seeds: ['C'] as NeuronId[],
      direction: 'inputs' as const,
      hops: 2,
      gain: 1,
      frontierLimit: 1,
      fetch,
    }
    const first = await propagate(options)
    const second = await propagate(options)

    // Hop 1 reaches B (5/7) and A (2/7); a limit of one keeps B and reports A's mass.
    expect(first.droppedMass[0]).toBeCloseTo(2 / 7, 12)
    expect(summedVector(first.terms[1]!).has('A')).toBe(false)
    expect([...summedVector(second.total).keys()]).toEqual([
      ...summedVector(first.total).keys(),
    ])
  })

  it('loses the drive that went to a fragment rather than reassigning it', async () => {
    // `Include fragments` unticked drops D, but D still received 30 of B's 40 input synapses.
    // The honest consequence is that A's share of B stays 10/40 and the other 30/40 is gone.
    // Inflating A to 10/10 would be the same wrong answer the denominator debate is about.
    const { fetch } = fakeSource()
    const result = await propagate({
      seeds: ['B'],
      direction: 'inputs',
      hops: 1,
      gain: 1,
      fetch,
      published: async (ids) => new Set(ids.filter((id) => id !== 'D')),
    })
    expect(summedVector(result.total).get('A')).toBeCloseTo(10 / 40, 12)
    expect(summedVector(result.total).has('D')).toBe(false)
    expect(result.fragmentMass[0]).toBeCloseTo(30 / 40, 12)
  })
})

describe('splitHops', () => {
  it('gives the whole budget to the backward half when there is no forward half', () => {
    expect(splitHops(4, 10, 10, false)).toEqual({ forward: 0, backward: 4 })
  })

  it('sends the deeper half towards the smaller set', () => {
    expect(splitHops(5, 3, 400, true)).toEqual({ forward: 3, backward: 2 })
    expect(splitHops(5, 400, 3, true)).toEqual({ forward: 2, backward: 3 })
  })

  it('does not split a budget with one end unnamed', () => {
    expect(splitHops(4, 0, 12, true)).toEqual({ forward: 0, backward: 4 })
  })
})

describe('combineHalves', () => {
  it('reproduces the single-pass answer at the same total depth', async () => {
    // The property the whole bidirectional mode rests on: z_0' W^k s = z_b' W^a s for any
    // a + b = k, so meeting in the middle is a cheaper route to the same number and not an
    // approximation of it. A decomposition counted twice, or one that lets b exceed the
    // backward depth, breaks this and nothing else would notice.
    const { fetch } = fakeSource()
    const sources: NeuronId[] = ['A', 'D']
    const single = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 3,
      gain: 0.5,
      fetch,
    })

    for (const [forwardDepth, backwardDepth] of [
      [0, 3],
      [1, 2],
      [2, 1],
      [3, 0],
    ]) {
      const forward = await propagate({
        seeds: sources,
        perSeedChannels: true,
        direction: 'outputs',
        hops: forwardDepth!,
        gain: 0.5,
        fetch,
        denominators: totalsOf(),
      })
      const backward = await propagate({
        seeds: ['C'],
        direction: 'inputs',
        hops: backwardDepth!,
        gain: 0.5,
        fetch,
      })
      const combined = combineHalves(forward, backward, sources)
      for (const source of sources) {
        expect(combined.get(source) ?? 0).toBeCloseTo(
          summedVector(single.total).get(source) ?? 0,
          12,
        )
      }
    }
  })

  it('scores the backward seeds when the backward half is the channelled one', async () => {
    /*
     * The downstream-with-candidates case, and the reason this takes the channelled half rather
     * than the forward one. Travelling downstream the scored set is postsynaptic, so it seeds
     * the *backward* walk — a signature naming the directions would have returned the seed set's
     * scores here and been right in the other direction, which is the worst shape a bug can have.
     */
    const { fetch } = fakeSource()
    const scored: NeuronId[] = ['C', 'D']
    const single = await propagate({
      seeds: ['A'],
      direction: 'outputs',
      hops: 3,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    const channelled = await propagate({
      seeds: scored,
      perSeedChannels: true,
      direction: 'inputs',
      hops: 2,
      gain: 0.5,
      fetch,
    })
    const pooled = await propagate({
      seeds: ['A'],
      direction: 'outputs',
      hops: 1,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    const combined = combineHalves(channelled, pooled, scored)
    for (const id of scored) {
      expect(combined.get(id) ?? 0).toBeCloseTo(summedVector(single.total).get(id) ?? 0, 12)
    }
  })

  it('keeps the seeds apart, so the answer is per source rather than per set', async () => {
    const { fetch } = fakeSource()
    const forward = await propagate({
      seeds: ['A', 'D'],
      perSeedChannels: true,
      direction: 'outputs',
      hops: 2,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    const backward = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 1,
      gain: 0.5,
      fetch,
    })
    const combined = combineHalves(forward, backward, ['A', 'D'])
    expect(combined.get('A')).not.toBeCloseTo(combined.get('D')!, 6)
  })
})

describe('batched', () => {
  it('splits a frontier and hands back one table', async () => {
    const { fetch, calls } = fakeSource()
    const whole = await fetch(['B', 'C', 'A'], 'inputs')
    const inThrees = await batched(fetch, 2)(['B', 'C', 'A'], 'inputs')
    // Two calls, and the same rows: a batching wrapper that dropped or reordered a batch would
    // silently shrink a hop rather than fail.
    expect(calls.slice(1).map((call) => call.ids)).toEqual([['B', 'C'], ['A']])
    expect(inThrees.length).toBe(whole.length)
    expect([...getColumn(inThrees, 'partnerId')].sort()).toEqual(
      [...getColumn(whole, 'partnerId')].sort(),
    )
  })

  it('does not batch what fits, and a size of zero means never', async () => {
    const { fetch, calls } = fakeSource()
    await batched(fetch, 10)(['B', 'C'], 'inputs')
    await batched(fetch, 0)(['B', 'C', 'A'], 'inputs')
    expect(calls.map((call) => call.ids.length)).toEqual([2, 3])
  })
})

describe('adjustInfluence', () => {
  it('is the reference implementation’s log compression', () => {
    expect(adjustInfluence(1)).toBeCloseTo(24, 12)
    expect(adjustInfluence(Math.exp(-10))).toBeCloseTo(14, 12)
    // Below the floor is 0, not minus infinity — which is the whole reason the floor is there.
    expect(adjustInfluence(Math.exp(-100))).toBeCloseTo(0, 12)
    expect(adjustInfluence(0)).toBe(0)
    // The sign is carried, for the signed mode this does not yet have.
    expect(adjustInfluence(-1)).toBeCloseTo(-24, 12)
  })
})

describe('influenceTable', () => {
  it('is a neurons table, strongest first, with the seeds flagged and their cells untouched', () => {
    const wide = '720575940626877432'
    const schema = influenceSchema(SCHEMA)
    const table = influenceTable({
      scores: new Map([
        ['A', 0.25],
        [wide, 0.75],
        ['B', 0],
      ]),
      schema,
      cells: new Map([
        ['A', 'A'],
        [wide, wide],
      ]),
      types: new Map([['A', 'LC4']]),
      firstHop: new Map([
        ['A', 2],
        [wide, 1],
      ]),
      seeds: [wide],
    })

    expect(table.kind).toBe('neurons')
    // A score of zero is not a row: it means the neuron was reached and carried nothing.
    expect(table.length).toBe(2)
    expect(getColumn(table, 'neuronId')).toEqual([wide, 'A'])
    // The 18-digit id survives as the very cell it arrived as — never through a Number().
    expect(getColumn(table, 'neuronId')[0]).toBe(wide)
    expect(getColumn(table, 'type')).toEqual([null, 'LC4'])
    expect(getColumn(table, 'isSeed')).toEqual([true, false])
    expect(getColumn(table, 'hops')).toEqual([1, 2])
    expect(getColumn(table, 'influenceLog')[0]).toBeCloseTo(adjustInfluence(0.75), 12)
  })

  it('takes the id dtype from the source rather than declaring one', () => {
    expect(influenceSchema(SCHEMA).columns[0]).toEqual({ name: 'neuronId', dtype: 'str' })
    expect(influenceSchema(undefined).columns[0]).toEqual({ name: 'neuronId', dtype: 'i64' })
  })
})
