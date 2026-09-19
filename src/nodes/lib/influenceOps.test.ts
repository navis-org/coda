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
import type { CellValue, TableValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection } from '../../data/source'
import { MISSING_LABEL } from './chartSelection'
import {
  adjustInfluence,
  summedVector,
  batched,
  combineHalves,
  influenceFlow,
  influenceFlowSchema,
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

  it('refuses a scored list the channels cannot index, rather than answering NaN', async () => {
    /*
     * The channels are positional and nothing types the correspondence, so a `scored` list of
     * the wrong length is a wrong answer wearing the right shape: too long and the read runs off
     * the `Float64Array` into `undefined`, scoring `NaN` that `influenceTable`'s `score > floor`
     * then drops in silence; too short and one neuron's influencers are filed under another's
     * name. The node deduplicates both lists at the one point a table becomes a list — this is
     * what speaks if a second route to that mistake ever appears.
     */
    const { fetch } = fakeSource()
    const channelled = await propagate({
      seeds: ['A', 'D'],
      perSeedChannels: true,
      direction: 'outputs',
      hops: 1,
      gain: 0.5,
      fetch,
      denominators: totalsOf(),
    })
    const pooled = await propagate({
      seeds: ['C'],
      direction: 'inputs',
      hops: 1,
      gain: 0.5,
      fetch,
    })
    expect(() => combineHalves(channelled, pooled, ['A', 'D', 'B'])).toThrow(
      /3 neurons.*2 per-seed channels/,
    )
    expect(() => combineHalves(channelled, pooled, ['A'])).toThrow(
      /1 neurons.*2 per-seed channels/,
    )
    // The matching pair is still the ordinary case and still answers.
    expect(combineHalves(channelled, pooled, ['A', 'D']).size).toBeGreaterThan(0)
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
    // Unwired falls back to `str` too, where it used to say `i64`: every source publishes the
    // id as text (invariant 8), so an `i64` here advertised a dtype no run can produce and the
    // column changed under every downstream picker the moment anything was wired.
    expect(influenceSchema(undefined).columns[0]).toEqual({ name: 'neuronId', dtype: 'str' })
  })
})

/**
 * The Transfers port.
 *
 * Four things are asserted rather than trusted, and every one of them is invisible in a diagram
 * that looks right:
 *
 *  - a ribbon runs **presynaptic to postsynaptic** whichever way the walk was travelling, which
 *    is the failure that draws a plausible picture with every arrow reversed;
 *  - the layer runs in the direction the signal does, not in the direction the hop count does —
 *    the trap the retired `layer` column on the old Network port existed for;
 *  - the widths **conserve**, which is the property a Sankey's grammar claims and the reason
 *    this is drawable at all; and
 *  - the losses arrive as rows with no source, so the conservation above holds with them in.
 */
describe('influenceFlow', () => {
  /** A walk over a chain: seed ← a ← b, with a second `a`-typed neuron to fold. */
  const source =
    (edges: Record<string, Array<[string, number]>>, types: Record<string, string>) =>
    async (ids: NeuronId[], direction: ConnectionDirection): Promise<TableValue> => {
      const rows: Array<Record<string, CellValue>> = []
      for (const id of ids) {
        for (const [partner, weight] of edges[id] ?? []) {
          rows.push({
            neuronId: id,
            neuronType: types[id] ?? null,
            partnerId: partner,
            partnerType: types[partner] ?? null,
            weight,
          })
        }
      }
      void direction
      return tableFromRows(
        tableSchema(
          column('neuronId', 'str'),
          column('neuronType', 'str'),
          column('partnerId', 'str'),
          column('partnerType', 'str'),
          column('weight', 'f64'),
        ),
        rows,
      )
    }

  // Upstream: asking `s` for its inputs returns a1 and a2; asking those returns b.
  const EDGES: Record<string, Array<[string, number]>> = {
    s: [
      ['a1', 30],
      ['a2', 10],
    ],
    a1: [['b', 5]],
    a2: [['b', 5]],
  }
  const TYPES: Record<string, string> = { s: 'S', a1: 'A', a2: 'A', b: 'B' }

  const walk = (direction: ConnectionDirection, hops = 2) =>
    propagate({
      seeds: ['s' as NeuronId],
      direction,
      hops,
      gain: 0.5,
      ribbonsByType: true,
      fetch: source(EDGES, TYPES),
      ...(direction === 'outputs'
        ? { denominators: async () => new Map([['a1' as NeuronId, 40]]) }
        : {}),
    })

  const rowsOf = (table: TableValue) =>
    Array.from({ length: table.length }, (_, i) => ({
      layer: Number(getColumn(table, 'layer')[i]),
      source: getColumn(table, 'source')[i],
      target: getColumn(table, 'target')[i],
      value: Number(getColumn(table, 'value')[i]),
    }))

  it('folds a walk to cell types, so two A neurons are one ribbon', async () => {
    const half = await walk('inputs')
    const flow = influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table
    const rows = rowsOf(flow).filter((r) => r.source !== null)
    // A→S once, not twice: a1 and a2 both carry the type `A`.
    expect(rows.filter((r) => r.source === 'A' && r.target === 'S')).toHaveLength(1)
  })

  it('runs presynaptic to postsynaptic travelling upstream', async () => {
    const half = await walk('inputs')
    const rows = rowsOf(
      influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table,
    ).filter((r) => r.source !== null)
    // The walk goes S → A → B; the signal goes B → A → S, and the table says the second.
    expect(rows.map((r) => `${r.source}>${r.target}`).sort()).toEqual(['A>S', 'B>A'])
  })

  it('puts the seed in the last column travelling upstream', async () => {
    const half = await walk('inputs')
    const rows = rowsOf(
      influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table,
    ).filter((r) => r.source !== null)
    // Layer 0 is the furthest hop, so B→A is column 0 and A→S is column 1: the drive runs left
    // to right into the seed. Laid out by the hop count it would run the other way, and every
    // connection would draw as feedback — the defect the old `layer` column existed for.
    expect(rows.find((r) => r.source === 'B')?.layer).toBe(0)
    expect(rows.find((r) => r.source === 'A')?.layer).toBe(1)
  })

  it('conserves: what leaves a layer arrives at the next one, losses included', async () => {
    const half = await walk('inputs')
    const flow = influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table
    const rows = rowsOf(flow)
    // Under the traversal denominator a neuron's outgoing shares sum to exactly one, so the
    // whole of the seed's unit arrives at layer 1 and the whole of layer 1's mass at layer 0.
    const atLayer = (layer: number) =>
      rows.filter((r) => r.layer === layer).reduce((sum, r) => sum + r.value, 0)
    expect(atLayer(1)).toBeCloseTo(1, 10)
    expect(atLayer(0)).toBeCloseTo(1, 10)
  })

  it('records the ribbon into a dropped body, and narrows at the next column', async () => {
    // `published` drops `b`, so the drive that reached it stops there. The synapse into it was
    // still crossed and is still a ribbon — what is missing is anything past it. The budget was
    // three hops and the walk found two, so the columns are numbered from the depth it *reached*:
    // there is no empty column in front, which a reader of the table could not tell from a filter.
    const half = await propagate({
      seeds: ['s' as NeuronId],
      direction: 'inputs',
      hops: 3,
      gain: 0.5,
      ribbonsByType: true,
      fetch: source(EDGES, TYPES),
      published: async (ids) => new Set(ids.filter((id) => id !== ('b' as NeuronId))),
    })
    const rows = rowsOf(influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table)
    const atLayer = (layer: number) =>
      rows.filter((r) => r.layer === layer).reduce((sum, r) => sum + r.value, 0)
    expect([...new Set(rows.map((r) => r.layer))].sort()).toEqual([0, 1])
    expect(atLayer(1)).toBeCloseTo(1, 10)
    expect(atLayer(0)).toBeCloseTo(1, 10)
  })

  it('numbers the columns from a hop the floor kept, travelling upstream', async () => {
    /*
     * The half that shipped wrong. An upstream walk conserves mass, so every hop's ribbons sum
     * to the same total and a deeper hop merely spreads it over more cell-type pairs — which
     * means `Transfer floor` takes whole *trailing* hops long before it thins a shallow one.
     * Numbered from the deepest hop the walk took rather than the deepest one still in the
     * table, the survivors came back as layers 1..n with nothing at 0; the drawing renumbers
     * densely, so a six-hop run whose last two hops were floored away drew the identical
     * diagram to a four-hop run from a table whose `layer` counted from a column that is not
     * there.
     *
     * `a1` is a dead end, so hop 2 carries only what went to `a2` — a quarter of the drive,
     * against the whole of it at hop 1.
     */
    const edges: Record<string, Array<[string, number]>> = {
      s: [
        ['a1', 30],
        ['a2', 10],
      ],
      a2: [['b', 5]],
    }
    const half = await propagate({
      seeds: ['s' as NeuronId],
      direction: 'inputs',
      hops: 2,
      gain: 0.5,
      ribbonsByType: true,
      fetch: source(edges, TYPES),
    })
    const layersAt = (floor: number) => {
      const flow = influenceFlow({ half, direction: 'inputs', floor })
      return {
        layers: [...new Set(rowsOf(flow.table).map((r) => r.layer))].sort((a, b) => a - b),
        rows: rowsOf(flow.table),
      }
    }
    // Both hops kept: the seed is in the last column, its influencers' influencers in the first.
    expect(layersAt(0).layers).toEqual([0, 1])
    // The floor removes hop 2 whole. What is left is one column, and it is column 0.
    const trimmed = layersAt(0.5)
    expect(trimmed.rows.map((r) => `${r.source}>${r.target}`)).toEqual(['A>S'])
    expect(trimmed.layers).toEqual([0])
  })

  it('numbers the columns from a hop the floor kept, travelling downstream', async () => {
    /*
     * The mirror, and the reason the fix is not one-sided: travelling `outputs` the layer is the
     * hop count itself, so the gap opens at the *shallow* end when the floor empties hop 1.
     * Nothing bounds the mass in this direction — a partner whose published input total is
     * smaller than the edge into it carries more drive onwards than it received — which is what
     * lets a deeper hop outweigh a shallower one here and never upstream.
     */
    const edges: Record<string, Array<[string, number]>> = { s: [['x', 1]], x: [['y', 10]] }
    const types = { s: 'S', x: 'X', y: 'Y' }
    const half = await propagate({
      seeds: ['s' as NeuronId],
      direction: 'outputs',
      hops: 2,
      gain: 0.5,
      ribbonsByType: true,
      fetch: source(edges, types),
      denominators: async (ids) =>
        new Map(ids.map((id) => [id, id === ('x' as NeuronId) ? 100 : 1])),
    })
    const layersOf = (floor: number) =>
      rowsOf(influenceFlow({ half, direction: 'outputs', floor }).table)
    // S→X carries 0.01 and X→Y ten times that, so the floor takes the hop nearest the seed.
    expect(layersOf(0).map((r) => `${r.layer}:${r.source}>${r.target}`)).toEqual([
      '0:S>X',
      '1:X>Y',
    ])
    expect(layersOf(0.05).map((r) => `${r.layer}:${r.source}>${r.target}`)).toEqual(['0:X>Y'])
  })

  it('answers empty where there is no single walk to lay out', () => {
    // The halves count hops from opposite ends, so a forward hop 1 sits beside the candidates and
    // a backward hop 1 beside the seeds. Folded through one layer formula they land in the same
    // column and the diagram's columns become two different measurements — `firstHop`'s rule one
    // column over, and invisible in the widths.
    // The node is what decides there is no single half; this is the shape it hands over.
    expect(influenceFlow({ half: undefined, direction: 'inputs', floor: 0 }).table.length).toBe(
      0,
    )
  })

  it('folds an untyped body into one bucket rather than into its own id', async () => {
    // Otherwise a run with fragments in it fills the diagram with 18-digit root ids, one box
    // each. The bucket may be the biggest thing in the picture, which is true and worth seeing.
    const half = await propagate({
      seeds: ['s' as NeuronId],
      direction: 'inputs',
      hops: 1,
      gain: 0.5,
      ribbonsByType: true,
      fetch: source(EDGES, { s: 'S' }),
    })
    const rows = rowsOf(influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table)
    expect(rows.map((r) => r.source)).toEqual([MISSING_LABEL])
  })

  it('drops a ribbon under the floor, and keeps every one at a floor of zero', async () => {
    // A weak third input, so the two ribbons into the seed carry different masses — with equal
    // ones a floor either keeps both or drops both and the test passes for the wrong reason.
    const edges = { ...EDGES, s: [...EDGES['s']!, ['c', 1] as [string, number]] }
    const half = await propagate({
      seeds: ['s' as NeuronId],
      direction: 'inputs',
      hops: 2,
      gain: 0.5,
      ribbonsByType: true,
      fetch: source(edges, { ...TYPES, c: 'C' }),
    })
    const all = influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table
    const trimmed = influenceFlow({ half: half, direction: 'inputs', floor: 0.05 }).table
    // C→S is 1 of 41 synapses, so about 2.4% of the drive.
    expect(rowsOf(all).map((r) => r.source)).toContain('C')
    expect(rowsOf(trimmed).map((r) => r.source)).not.toContain('C')
    expect(all.length).toBeGreaterThan(trimmed.length)
  })

  it('agrees with its schema, so no picker downstream empties after a run', async () => {
    const half = await walk('inputs')
    const flow = influenceFlow({ half: half, direction: 'inputs', floor: 0 }).table
    // Invariant 3: the schema half and the value half, asserted rather than assumed.
    expect(flow.schema).toEqual(influenceFlowSchema())
    for (const col of influenceFlowSchema().columns) {
      expect(flow.data[col.name]).toHaveLength(flow.length)
    }
  })

  it('accumulates nothing when no grouping is asked for', async () => {
    const quiet = await propagate({
      seeds: ['s' as NeuronId],
      direction: 'inputs',
      hops: 2,
      gain: 0.5,
      fetch: source(EDGES, TYPES),
    })
    // The cost is a Map get and set per edge per hop; every caller that does not want a diagram
    // must not pay it.
    expect(quiet.ribbons.size).toBe(0)
  })
})
