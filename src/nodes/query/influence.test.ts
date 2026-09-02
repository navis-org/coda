/**
 * The Influence node, driven through the real scheduler against the mock connectome.
 *
 * `influenceOps.test.ts` pins the arithmetic against a six-edge graph and
 * `scripts/probe-influence.py` pins it against the published implementation's exact solve. What
 * neither can cover is the wiring, which is where this node has the most to get wrong: three
 * modes decided by a param and a port between them, and two of the three are *unreachable*
 * under the default denominator. A node that quietly ran the wrong one would return a table of
 * entirely plausible scores.
 *
 * So the load-bearing test here is the last one: that a meet-in-the-middle run and a single
 * full-depth run over the same dataset agree neuron for neuron. That is the property the split
 * exists to have, asserted through the real source rather than through a fixture.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { TableValue } from '../../core/values'
import { getColumn, isTableValue } from '../../core/values'
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

/** Settings every comparison shares, so only the thing under test differs. */
const COMPARABLE = {
  minWeight: 1,
  gain: 0.5,
  // No limit and no filter: both would be applied at different hops under a split, and the
  // question here is whether the split *arithmetic* agrees, not whether two prunings do.
  frontierLimit: 0,
  includeFragments: true,
}

/**
 * dataset → find(seed) → influence, with an optional second Find wired to `candidates`.
 */
function pipeline(
  params: Record<string, unknown> = {},
  options: { candidates?: string } = {},
): CodaGraph {
  let g = emptyGraph('influence-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('inf', 'neuron.influence', params))
  const wire = (source: string, handle: string, target: string, into: string) => {
    g = addEdge(g, { source, sourceHandle: handle, target, targetHandle: into })
  }
  wire('ds', 'dataset', 'find', 'dataset')
  wire('ds', 'dataset', 'inf', 'dataset')
  wire('find', 'neurons', 'inf', 'neurons')
  if (options.candidates) {
    g = addNode(
      g,
      node('cand', 'neuron.findNeurons', { typePattern: options.candidates, status: 'Traced' }),
    )
    wire('ds', 'dataset', 'cand', 'dataset')
    wire('cand', 'neurons', 'inf', 'candidates')
  }
  return g
}

function scheduler() {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

async function influence(
  params: Record<string, unknown> = {},
  options: { candidates?: string } = {},
): Promise<TableValue> {
  const sched = scheduler()
  await sched.run(pipeline(params, options), { mode: 'full' })
  const table = sched.output('inf', 'influence')
  if (!isTableValue(table)) {
    throw new Error(`expected a table, got ${sched.info('inf').error ?? JSON.stringify(table)}`)
  }
  return table
}

/** The scores as a map, which is what every comparison actually wants. */
function scoresOf(table: TableValue): Map<string, number> {
  const ids = getColumn(table, 'neuronId')
  const values = getColumn(table, 'influence')
  const out = new Map<string, number>()
  for (let i = 0; i < table.length; i++) out.set(String(ids[i]), Number(values[i]))
  return out
}

function issues(params: Record<string, unknown> = {}, options: { candidates?: string } = {}) {
  return (inferGraph(pipeline(params, options)).nodes.inf?.issues ?? []).map((i) => i.message)
}

describe('Influence output shape', () => {
  it('advertises the columns it actually builds', async () => {
    const declared = inferGraph(pipeline()).nodes.inf?.outputs.influence
    const advertised =
      declared && 'schema' in declared ? declared.schema?.columns.map((c) => c.name) : undefined
    expect(advertised).toEqual([
      'neuronId',
      'type',
      'influence',
      'influenceLog',
      'hops',
      'isSeed',
    ])

    const table = await influence(COMPARABLE)
    expect(table.schema.columns.map((c) => c.name)).toEqual(advertised)
  })

  it('is a Neurons value, ranked, with the seeds in it and flagged', async () => {
    const table = await influence(COMPARABLE)
    // A `neurons` kind rather than a table, which is the whole reason the score is not appended
    // to an edge list: the top influencers have to be wirable straight into Skeletons.
    expect(table.kind).toBe('neurons')
    expect(table.length).toBeGreaterThan(0)

    const values = getColumn(table, 'influence').map(Number)
    expect([...values]).toEqual([...values].sort((a, b) => b - a))
    expect(values.every((value) => value > 0)).toBe(true)
    expect(getColumn(table, 'isSeed').some((cell) => cell === true)).toBe(true)
  })
})

describe('Influence hop budget', () => {
  it('reaches further and scores higher with every hop, and never lower', async () => {
    // Both halves of the lower-bound property, through the real source: a longer walk is a
    // superset of a shorter one and every shared score has risen or held.
    const near = scoresOf(await influence({ ...COMPARABLE, maxHops: 1 }))
    const far = scoresOf(await influence({ ...COMPARABLE, maxHops: 3 }))
    expect(far.size).toBeGreaterThan(near.size)
    for (const [id, score] of near) {
      expect(far.get(id) ?? 0).toBeGreaterThanOrEqual(score - 1e-12)
    }
  })
})

describe('Influence denominator gating', () => {
  it('refuses downstream under the traversal denominator, at edit time and at run time', async () => {
    const params = { ...COMPARABLE, direction: 'outputs' }
    expect(issues(params).join(' ')).toMatch(/Denominator to published totals|use Upstream/i)

    const sched = scheduler()
    await sched.run(pipeline(params), { mode: 'full' })
    // Named the fix rather than reporting a missing column two layers down.
    expect(sched.info('inf').error).toMatch(/published totals|Upstream/)
  })

  it('runs downstream once the denominator can be had from the far end', async () => {
    const table = await influence({
      ...COMPARABLE,
      direction: 'outputs',
      denominator: 'connected',
    })
    expect(table.length).toBeGreaterThan(0)
  })

  it('says at edit time that candidates cannot split under the traversal denominator', () => {
    const said = issues(COMPARABLE, { candidates: 'L1' }).join(' ')
    // A warning about *cost*, and it has to say the scores are unaffected — otherwise it reads
    // as a wrong answer rather than a slow one.
    expect(said).toMatch(/same scores/)
    expect(said).toMatch(/published totals/)
  })
})

describe('Influence per query neuron', () => {
  it('advertises a plain table of pairs, and stops calling itself a neuron set', () => {
    const declared = (params: Record<string, unknown>) =>
      inferGraph(pipeline(params)).nodes.inf?.outputs.influence

    const plain = declared(COMPARABLE)
    expect(plain?.kind).toBe('neurons')

    const pairs = declared({ ...COMPARABLE, perQuery: true })
    // A table, not a neurons value: `neuronId` repeats once per query neuron, so a wire into
    // Skeletons has to break rather than silently fetch the same body a hundred times.
    expect(pairs?.kind).toBe('table')
    expect(pairs && 'schema' in pairs ? pairs.schema?.columns.map((c) => c.name) : undefined).toEqual(
      ['queryId', 'queryType', 'neuronId', 'type', 'influence', 'influenceLog', 'hops', 'isSeed'],
    )
  })

  it('builds the columns it advertised', async () => {
    const table = await influence({ ...COMPARABLE, perQuery: true })
    expect(table.kind).toBe('table')
    expect(table.length).toBeGreaterThan(0)
    const declared = inferGraph(pipeline({ ...COMPARABLE, perQuery: true })).nodes.inf?.outputs
      .influence
    expect(table.schema.columns.map((c) => c.name)).toEqual(
      declared && 'schema' in declared ? declared.schema?.columns.map((c) => c.name) : undefined,
    )
    // More than one query neuron, and each contributes its own rows.
    expect(new Set(getColumn(table, 'queryId')).size).toBeGreaterThan(1)
  })

  it('sums over the query neurons to exactly the plain ranking', async () => {
    /*
     * The property the whole mode rests on, and the one a plausible-looking wrong answer would
     * break silently: the two ports are read off the same channelled walk, so a Group By on the
     * influencer has to land on the number the plain run reports. A channel read as `[0]`, or a
     * seed mass applied to one shape and not the other, still produces a perfectly ordinary
     * heatmap that disagrees with the ranking beside it.
     */
    const plain = scoresOf(await influence(COMPARABLE))
    const pairs = await influence({ ...COMPARABLE, perQuery: true })

    const summed = new Map<string, number>()
    const ids = getColumn(pairs, 'neuronId')
    const values = getColumn(pairs, 'influence')
    for (let i = 0; i < pairs.length; i++) {
      const id = String(ids[i])
      summed.set(id, (summed.get(id) ?? 0) + Number(values[i]))
    }

    expect(summed.size).toBe(plain.size)
    for (const [id, score] of plain) expect(summed.get(id)).toBeCloseTo(score, 10)
  })

  it('restricts the pairs to the candidates without touching the scores', async () => {
    const all = await influence({ ...COMPARABLE, perQuery: true })
    const some = await influence({ ...COMPARABLE, perQuery: true }, { candidates: 'L1' })
    expect(some.length).toBeGreaterThan(0)
    expect(some.length).toBeLessThan(all.length)

    const key = (t: TableValue, i: number) =>
      `${String(getColumn(t, 'queryId')[i])}→${String(getColumn(t, 'neuronId')[i])}`
    const before = new Map<string, number>()
    for (let i = 0; i < all.length; i++) before.set(key(all, i), Number(getColumn(all, 'influence')[i]))
    for (let i = 0; i < some.length; i++) {
      expect(before.get(key(some, i))).toBeCloseTo(Number(getColumn(some, 'influence')[i]), 12)
    }
  })

  it('says at edit time that it cannot also meet in the middle', () => {
    const said = issues(
      { ...COMPARABLE, perQuery: true, denominator: 'connected' },
      { candidates: 'L1' },
    ).join(' ')
    expect(said).toMatch(/meet in the middle/)
    expect(said).toMatch(/scores are the same/)
  })
})

describe('Influence candidates', () => {
  it('restricts the result to the candidates without changing what they scored', async () => {
    const all = scoresOf(await influence(COMPARABLE))
    const some = await influence(COMPARABLE, { candidates: 'L1' })
    expect(some.length).toBeGreaterThan(0)
    expect(some.length).toBeLessThan(all.size)
    for (const [id, score] of scoresOf(some)) {
      expect(all.get(id)).toBeCloseTo(score, 12)
    }
  })

  it('meets in the middle and lands on the same scores as the full-depth walk', async () => {
    /*
     * The property the bidirectional mode exists to have, end to end. The single pass walks four
     * hops backwards from LC4 and reports what LC6 scored; the split walks two hops forwards
     * from LC6 and two backwards from LC4 and multiplies. `z_0' W^k s = z_b' W^a s` says these
     * are the same number, and if a decomposition were counted twice — or the channelled half
     * were the wrong one — every score here would be wrong in a way that still ranked plausibly.
     */
    const params = { ...COMPARABLE, maxHops: 4, denominator: 'connected' }
    const single = scoresOf(await influence(params))
    const split = scoresOf(await influence(params, { candidates: 'L1' }))

    expect(split.size).toBeGreaterThan(0)
    for (const [id, score] of split) {
      expect(score).toBeCloseTo(single.get(id) ?? 0, 10)
    }
  })

  it('leaves the hop column empty under a split, rather than naming one end’s distance', async () => {
    const params = { ...COMPARABLE, maxHops: 4, denominator: 'connected' }
    const split = await influence(params, { candidates: 'L1' })
    expect(getColumn(split, 'hops').every((cell) => cell === null)).toBe(true)
    // ...and fills it when there is one walk and therefore one distance.
    const single = await influence(params)
    expect(getColumn(single, 'hops').some((cell) => typeof cell === 'number')).toBe(true)
  })
})
