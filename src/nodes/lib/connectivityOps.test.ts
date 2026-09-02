/**
 * The traversal, and the reorientation that makes it an edge list.
 *
 * Every case here is one a naive implementation still answers with a plausible table. A
 * missing swap on `inputs` yields rows that look fine and point the wrong way; a missing
 * dedupe on `both` yields rows that look fine and double every internal synapse count once
 * Build Network sums them; re-expanding a visited neuron yields rows that look fine and never
 * terminates on a recurrent circuit — which is every connectome.
 *
 * The fetch is a fake graph rather than a source, which is the point of taking it as a
 * callback: no network, no dataset, and every hop's *query* is observable.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { ConnectionDirection } from '../../data/source'
import { connectivitySchemaWithRoi } from '../../data/source'
import {
  connectivityOutputSchema,
  endpointNeurons,
  endpointSchema,
  neuronRowsFor,
  normalizeConnectivity,
  normalizeTargets,
  totalsLookup,
  traverseConnectivity,
  type TraversalDirection,
} from './connectivityOps'

const SOURCE_SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('neuronType', 'str'),
  column('partnerId', 'i64'),
  column('partnerType', 'str'),
  column('weight', 'i64', 'synapses'),
)

const OUT_SCHEMA = connectivityOutputSchema(SOURCE_SCHEMA)

/** A tiny directed graph: pre → post → weight. */
type Edge = [number, number, number]

const TYPES: Record<number, string> = {
  1: 'A',
  2: 'B',
  3: 'C',
  4: 'D',
  5: 'E',
  9: 'X',
}

/** One query-relative row, which is the half both fakes share. */
function row(pre: number, post: number, weight: number, direction: ConnectionDirection) {
  const body = direction === 'outputs' ? pre : post
  const partner = direction === 'outputs' ? post : pre
  return {
    neuronId: body,
    neuronType: TYPES[body] ?? null,
    partnerId: partner,
    partnerType: TYPES[partner] ?? null,
    weight,
  }
}

/**
 * A fake source answering query-relative, exactly as `fetchConnectivity` does: `neuronId` is
 * always the neuron asked about, whichever way the arrow points.
 */
function fakeSource(edges: Edge[], minWeight = 0) {
  const calls: Array<{ neuronIds: number[]; direction: ConnectionDirection }> = []
  const fetch = async (
    neuronIds: string[],
    direction: ConnectionDirection,
  ): Promise<TableValue> => {
    // Recorded as numbers so the assertions below stay readable against the numeric fixtures;
    // the traversal itself passes ids as text, which is what `HopFetch` declares.
    calls.push({ neuronIds: neuronIds.map(Number), direction })
    const wanted = new Set(neuronIds.map(Number))
    const rows = edges
      .filter(
        ([pre, post, weight]) =>
          weight >= minWeight && wanted.has(direction === 'outputs' ? pre : post),
      )
      .map(([pre, post, weight]) => row(pre, post, weight, direction))
    return tableFromRows(SOURCE_SCHEMA, rows)
  }
  return { fetch, calls }
}

function run(
  edges: Edge[],
  opts: { seeds: number[]; direction: TraversalDirection; hops?: number; minWeight?: number },
) {
  const source = fakeSource(edges, opts.minWeight ?? 0)
  return traverseConnectivity({
    seeds: opts.seeds.map(String),
    direction: opts.direction,
    hops: opts.hops ?? 1,
    schema: OUT_SCHEMA,
    fetch: source.fetch,
  }).then((table) => ({ table, calls: source.calls }))
}

/** Rows as `pre>post@hop:direction`, which is the whole assertion in one string. */
function shape(table: TableValue): string[] {
  const pre = table.data.preId ?? []
  const post = table.data.postId ?? []
  const hop = table.data.hop ?? []
  const dir = table.data.direction ?? []
  return pre.map((_, i) => `${pre[i]}>${post[i]}@${hop[i]}:${dir[i]}`)
}

describe('connectivityOutputSchema', () => {
  it('renames the query-relative columns to pre/post and appends the traversal pair', () => {
    expect(OUT_SCHEMA.columns.map((c) => c.name)).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
      'hop',
      'direction',
    ])
  })

  it('keeps units and carries through any column it does not know about', () => {
    const extended = connectivityOutputSchema(
      tableSchema(...SOURCE_SCHEMA.columns, column('roi', 'str')),
    )
    expect(extended.columns.find((c) => c.name === 'weight')?.unit).toBe('synapses')
    expect(extended.columns.map((c) => c.name)).toContain('roi')
  })

  it('is what the value half is built against', async () => {
    const { table } = await run([[1, 2, 5]], { seeds: [1], direction: 'outputs' })
    const names = OUT_SCHEMA.columns.map((c) => c.name)
    expect(table.schema.columns.map((c) => c.name)).toEqual(names)
    expect(Object.keys(table.data).sort()).toEqual([...names].sort())
  })
})

describe('one hop', () => {
  it('reads as an ordinary partner list downstream', async () => {
    const { table, calls } = await run(
      [
        [1, 2, 5],
        [1, 3, 9],
      ],
      { seeds: [1], direction: 'outputs' },
    )
    // Strongest first, and every row is hop 1.
    expect(shape(table)).toEqual(['1>3@1:downstream', '1>2@1:downstream'])
    expect(calls).toEqual([{ neuronIds: [1], direction: 'outputs' }])
  })

  it('swaps the ends for upstream, so a row still reads pre → post', async () => {
    const { table } = await run([[9, 1, 5]], { seeds: [1], direction: 'inputs' })
    // The source answers neuronId: 1 (the neuron asked about), partnerId: 9 (its input).
    // The edge is 9 → 1, and that is what has to come out.
    expect(shape(table)).toEqual(['9>1@1:upstream'])
    expect(table.data.preId?.[0]).toBe(9)
    expect(table.data.preType?.[0]).toBe('X')
    expect(table.data.postId?.[0]).toBe(1)
    expect(table.data.postType?.[0]).toBe('A')
  })

  it('asks both ways for "both" and marks each row with the way it was found', async () => {
    const { table, calls } = await run(
      [
        [1, 2, 5],
        [9, 1, 7],
      ],
      { seeds: [1], direction: 'both' },
    )
    expect(calls.map((c) => c.direction)).toEqual(['outputs', 'inputs'])
    expect(shape(table)).toEqual(['9>1@1:upstream', '1>2@1:downstream'])
  })
})

describe('edges found from both ends', () => {
  it('emits one row, not two — a duplicate is a doubled synapse count downstream', async () => {
    const { table } = await run([[1, 2, 5]], { seeds: [1, 2], direction: 'both' })
    expect(table.length).toBe(1)
    expect(table.data.weight).toEqual([5])
  })

  it('marks an edge inside the seed set `both`', async () => {
    const { table } = await run(
      [
        [1, 2, 5],
        [1, 3, 4],
      ],
      { seeds: [1, 2], direction: 'both' },
    )
    // 1→2 is reached downstream from 1 and upstream from 2; 1→3 only downstream.
    expect(shape(table)).toEqual(['1>2@1:both', '1>3@1:downstream'])
  })

  it('keeps the direction an edge was first given when a later hop re-finds it', async () => {
    // Seed 1. Hop 1 finds 9→1 upstream. Hop 2 expands 9 and finds 9→1 again, downstream.
    // The endpoints are not equidistant, so this is not a `both` edge — and its hop stays 1.
    const { table } = await run(
      [
        [9, 1, 7],
        [9, 5, 3],
      ],
      { seeds: [1], direction: 'both', hops: 2 },
    )
    expect(shape(table)).toContain('9>1@1:upstream')
    expect(shape(table)).not.toContain('9>1@2:both')
  })
})

describe('multiple hops', () => {
  it('expands the frontier and labels each edge with the hop it was traversed at', async () => {
    const { table, calls } = await run(
      [
        [1, 2, 9],
        [2, 3, 8],
        [3, 4, 7],
      ],
      { seeds: [1], direction: 'outputs', hops: 2 },
    )
    expect(shape(table)).toEqual(['1>2@1:downstream', '2>3@2:downstream'])
    // 3 was reached but never expanded, so 3→4 is absent and there is no third query.
    expect(calls).toEqual([
      { neuronIds: [1], direction: 'outputs' },
      { neuronIds: [2], direction: 'outputs' },
    ])
  })

  it('sorts nearest first, then strongest', async () => {
    const { table } = await run(
      [
        [1, 2, 1],
        [2, 3, 100],
        [2, 4, 50],
      ],
      { seeds: [1], direction: 'outputs', hops: 2 },
    )
    // The hop-1 edge is the weakest and still leads, because distance beats weight.
    expect(shape(table)).toEqual(['1>2@1:downstream', '2>3@2:downstream', '2>4@2:downstream'])
  })

  it('never re-expands a neuron, so a recurrent circuit terminates', async () => {
    const { table, calls } = await run(
      [
        [1, 2, 5],
        [2, 1, 5],
      ],
      { seeds: [1], direction: 'outputs', hops: 4 },
    )
    // 2 → 1 is reported as an edge; 1 is a seed, so it is not queued again and the
    // traversal runs out of frontier after two rounds rather than four.
    expect(shape(table)).toEqual(['1>2@1:downstream', '2>1@2:downstream'])
    expect(calls.length).toBe(2)
  })

  it('expands both ways at every hop for "both" — the ball, not two cones', async () => {
    // 9 → 1 and 9 → 5: neuron 5 shares an input with the seed. Finding it needs hop 2 to
    // travel *downstream* from 9, which was itself reached upstream.
    const { table, calls } = await run(
      [
        [9, 1, 7],
        [9, 5, 6],
        [1, 2, 5],
      ],
      { seeds: [1], direction: 'both', hops: 2 },
    )
    expect(shape(table)).toContain('9>5@2:downstream')
    expect(calls.map((c) => `${c.direction}:${c.neuronIds.join(',')}`)).toEqual([
      'outputs:1',
      'inputs:1',
      // The frontier is in discovery order: the downstream pass ran first, so 2 precedes 9.
      'outputs:2,9',
      'inputs:2,9',
    ])
  })

  it('prunes the frontier through minWeight, because a cut edge is never returned', async () => {
    const { table, calls } = await run(
      [
        [1, 2, 10],
        [1, 3, 1],
        [3, 4, 99],
      ],
      { seeds: [1], direction: 'outputs', hops: 2, minWeight: 5 },
    )
    // 1→3 is below the cut, so 3 is neither a row nor a reason to expand — 3→4 never
    // appears despite being the strongest edge in the graph.
    expect(shape(table)).toEqual(['1>2@1:downstream'])
    expect(calls[1]?.neuronIds).toEqual([2])
  })

  it('stops early when the frontier runs dry', async () => {
    const { calls } = await run([[1, 2, 5]], { seeds: [1], direction: 'outputs', hops: 5 })
    expect(calls.length).toBe(2)
  })
})

describe('traversal edges', () => {
  it('treats a fractional or zero hop count as one', async () => {
    for (const hops of [0, -3, 1.7]) {
      const { calls } = await run([[1, 2, 5]], { seeds: [1], direction: 'outputs', hops })
      expect(calls.length).toBe(1)
    }
  })

  it('deduplicates the seed list before querying', async () => {
    const { calls } = await run([[1, 2, 5]], { seeds: [1, 1, 1], direction: 'outputs' })
    expect(calls[0]?.neuronIds).toEqual([1])
  })

  it('aborts between hops', async () => {
    const controller = new AbortController()
    const source = fakeSource([
      [1, 2, 5],
      [2, 3, 5],
    ])
    controller.abort()
    await expect(
      traverseConnectivity({
        seeds: ['1'],
        direction: 'outputs',
        hops: 2,
        schema: OUT_SCHEMA,
        fetch: source.fetch,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i)
  })

  it('reports each round, so a run indicator has something to move on', async () => {
    const source = fakeSource([
      [1, 2, 5],
      [2, 3, 5],
    ])
    const seen: string[] = []
    await traverseConnectivity({
      seeds: ['1'],
      direction: 'outputs',
      hops: 2,
      schema: OUT_SCHEMA,
      fetch: source.fetch,
      onHop: (hop, hops, frontier) => seen.push(`${hop}/${hops}:${frontier}`),
    })
    expect(seen).toEqual(['1/2:1', '2/2:1'])
  })
})

/**
 * The region split and the normalisation, which fail in ways a valid table hides.
 *
 * A dedupe still keyed on the pair alone keeps one region per connection and silently discards
 * the rest; a denominator lookup comparing a number to a string misses every row and looks like
 * a dataset that publishes no totals; a missing denominator substituted with zero divides to
 * `Infinity`, which a chart draws as a bar off the top of the axis.
 */

// The same helper the source uses, so the column has one spelling here too.
const ROI_SOURCE_SCHEMA = connectivitySchemaWithRoi(SOURCE_SCHEMA)
const ROI_OUT_SCHEMA = connectivityOutputSchema(SOURCE_SCHEMA, { splitByRoi: true })

/** `fakeSource` with a region on each edge: one row per (connection, region). */
function fakeRoiSource(edges: Array<[number, number, number, string]>) {
  return async (neuronIds: string[], direction: ConnectionDirection): Promise<TableValue> => {
    const wanted = new Set(neuronIds.map(Number))
    const rows = edges
      .filter(([pre, post]) => wanted.has(direction === 'outputs' ? pre : post))
      .map(([pre, post, weight, roi]) => ({ ...row(pre, post, weight, direction), roi }))
    return tableFromRows(ROI_SOURCE_SCHEMA, rows)
  }
}

describe('split by region', () => {
  it('keeps every region of a connection rather than the first one', async () => {
    const table = await traverseConnectivity({
      seeds: ['1'],
      direction: 'outputs',
      hops: 1,
      schema: ROI_OUT_SCHEMA,
      fetch: fakeRoiSource([
        [1, 2, 30, 'LO(R)'],
        [1, 2, 20, 'ME(R)'],
      ]),
    })
    expect(table.length).toBe(2)
    expect([...table.data.roi!]).toEqual(['LO(R)', 'ME(R)'])
    // The promise the whole feature rests on: the parts sum to the connection.
    expect([...table.data.weight!].reduce((a, b) => Number(a) + Number(b), 0)).toBe(50)
  })

  it('still dedupes a region seen from both ends of a `both` traversal', async () => {
    const table = await traverseConnectivity({
      seeds: ['1', '2'],
      direction: 'both',
      hops: 1,
      schema: ROI_OUT_SCHEMA,
      fetch: fakeRoiSource([
        [1, 2, 30, 'LO(R)'],
        [1, 2, 20, 'ME(R)'],
      ]),
    })
    // Two rows, not four: the edge is internal to the seed set, so each region comes back from
    // each end. Doubling here is a doubled synapse count everywhere downstream.
    expect(table.length).toBe(2)
    expect([...table.data.direction!]).toEqual(['both', 'both'])
  })

  it('advertises `roi` only when splitting', () => {
    expect(connectivityOutputSchema(SOURCE_SCHEMA).columns.map((c) => c.name)).not.toContain(
      'roi',
    )
    expect(ROI_OUT_SCHEMA.columns.map((c) => c.name)).toContain('roi')
  })
})

describe('normalisation', () => {
  const schema = connectivityOutputSchema(SOURCE_SCHEMA, { normalize: true })

  async function edgeTable() {
    return traverseConnectivity({
      seeds: ['1'],
      direction: 'outputs',
      hops: 1,
      schema: OUT_SCHEMA,
      fetch: fakeSource([
        [1, 2, 30],
        [1, 3, 10],
      ]).fetch,
    })
  }

  it('divides by the end the mode names, not by the query neuron', async () => {
    const table = await edgeTable()
    // Postsynaptic: each row is divided by *its own target's* total, so the two rows have
    // different denominators. Dividing by the query neuron would give one.
    const post = normalizeConnectivity(
      table,
      'postsynaptic',
      new Map([
        ['2', 300],
        ['3', 40],
      ]),
      schema,
    )
    expect([...post.table.data.weightNorm!]).toEqual([0.1, 0.25])
    expect([...post.table.data.weightTotal!]).toEqual([300, 40])

    const pre = normalizeConnectivity(table, 'presynaptic', new Map([['1', 100]]), schema)
    expect([...pre.table.data.weightNorm!]).toEqual([0.3, 0.1])
  })

  it('leaves a missing or zero denominator null, and counts it', async () => {
    const table = await edgeTable()
    const result = normalizeConnectivity(
      table,
      'postsynaptic',
      // 3 is absent entirely, 2 totals zero — a neuron with no synapses on this side.
      new Map([['2', 0]]),
      schema,
    )
    expect([...result.table.data.weightNorm!]).toEqual([null, null])
    expect(result.missingRows).toBe(2)
    expect(result.missingNeurons).toBe(2)
  })

  it('does not clamp a fraction above 1', async () => {
    const table = await edgeTable()
    // Legitimate under the `connected` basis: the denominator counts only reconstructed
    // partners while the numerator is whatever the connection carries.
    const result = normalizeConnectivity(table, 'postsynaptic', new Map([['2', 20]]), schema)
    expect(result.table.data.weightNorm![0]).toBe(1.5)
  })

  it('asks for totals per row-end rather than per seed', async () => {
    const table = await edgeTable()
    expect(normalizeTargets(table, 'postsynaptic')).toEqual(['2', '3'])
    expect(normalizeTargets(table, 'presynaptic')).toEqual(['1'])
  })

  it('reads a totals table through idText, so an i64 id column still matches', () => {
    const totals = tableFromRows(
      tableSchema(column('neuronId', 'i64'), column('total', 'i64', 'synapses')),
      [{ neuronId: 2, total: 300 }],
    )
    // The ids arrive as numbers and the edge list keys on text. A `Map<number>` here would miss
    // every row and read as a dataset with no totals at all.
    expect(totalsLookup(totals).get('2')).toBe(300)
  })
})

/**
 * The `Neurons` port's derivation.
 *
 * Every case here is one the obvious version answers with a plausible table. Dropping the
 * seeds loses only the neurons that turned out to have no partners — which is a hole nothing
 * on screen names. Keying the type off the same row that decided the order gets it right for
 * every neuron that arrived typed and wrong for the ones that did not. And rebuilding an id
 * instead of copying its cell is invariant 8 with no symptom at all until a CAVE root id.
 */
describe('endpoint neurons', () => {
  const SCHEMA = endpointSchema(SOURCE_SCHEMA)

  it('carries the id and type columns over whole, renamed and nothing else', () => {
    expect(SCHEMA.columns).toEqual([
      { name: 'neuronId', dtype: 'i64' },
      { name: 'type', dtype: 'str' },
    ])
  })

  it('takes the id dtype from the connectivity schema, not from a canonical neuron table', () => {
    const text = tableSchema(
      column('neuronId', 'str'),
      column('neuronType', 'str'),
      column('partnerId', 'str'),
      column('partnerType', 'str'),
      column('weight', 'i64', 'synapses'),
    )
    // A CAVE root id is text in `preId`, so it has to be text here — this table holds the
    // very same cells.
    expect(endpointSchema(text).columns[0]).toEqual({ name: 'neuronId', dtype: 'str' })
  })

  it('is a Neurons value, not a table — the port declares one and `selectTable` branches on it', async () => {
    const { table } = await run([[1, 2, 5]], { seeds: [1], direction: 'outputs' })
    expect(endpointNeurons(table, SCHEMA).kind).toBe('neurons')
  })

  it('lists both ends of every edge once, in first-appearance order', async () => {
    const { table } = await run(
      [
        [1, 2, 5],
        [1, 3, 5],
        [2, 3, 5],
      ],
      { seeds: [1], direction: 'outputs', hops: 2 },
    )
    const out = endpointNeurons(table, SCHEMA)
    expect(out.data.neuronId).toEqual([1, 2, 3])
    expect(out.data.type).toEqual(['A', 'B', 'C'])
  })

  it('keeps a seed that no surviving edge mentions, which is the half a downstream node could not do', async () => {
    // 9 is a real seed with a partner below the cut; the traversal returns nothing for it, so
    // both ends of the edge list cover 1 and 2 alone.
    const { table } = await run(
      [
        [1, 2, 20],
        [9, 3, 1],
      ],
      { seeds: [1, 9], direction: 'outputs', minWeight: 10 },
    )
    expect(shape(table)).toEqual(['1>2@1:downstream'])

    const seeds = tableFromRows(
      tableSchema(column('neuronId', 'i64'), column('type', 'str')),
      [
        { neuronId: 1, type: 'A' },
        { neuronId: 9, type: 'X' },
      ],
      'neurons',
    )
    const out = endpointNeurons(table, SCHEMA, seeds)
    expect(out.data.neuronId).toEqual([1, 9, 2])
    expect(out.data.type).toEqual(['A', 'X', 'B'])
  })

  it('takes the first non-empty type, which need not be the row that fixed the order', async () => {
    const { table } = await run([[1, 2, 5]], { seeds: [1], direction: 'outputs' })
    // A seed table with no type at all: `Input IDs` unwired emits exactly this, and the edge
    // list is where the type then comes from.
    const seeds = tableFromRows(
      tableSchema(column('neuronId', 'i64')),
      [{ neuronId: 1 }],
      'neurons',
    )
    const out = endpointNeurons(table, SCHEMA, seeds)
    expect(out.data.neuronId).toEqual([1, 2])
    expect(out.data.type).toEqual(['A', 'B'])
  })

  it('copies the id cell rather than rebuilding it, so a wide root id survives', () => {
    const text = tableSchema(
      column('neuronId', 'str'),
      column('neuronType', 'str'),
      column('partnerId', 'str'),
      column('partnerType', 'str'),
      column('weight', 'i64', 'synapses'),
    )
    const wide = '720575940628857210'
    const edges = tableFromRows(connectivityOutputSchema(text), [
      { preId: wide, preType: 'A', postId: '720575940628857211', postType: 'B', weight: 5 },
    ])
    const out = endpointNeurons(edges, endpointSchema(text))
    expect(out.data.neuronId?.[0]).toBe(wide)
  })

  it('answers seeds alone when the traversal found nothing', async () => {
    const { table } = await run([], { seeds: [1], direction: 'outputs' })
    const seeds = tableFromRows(
      tableSchema(column('neuronId', 'i64')),
      [{ neuronId: 1 }],
      'neurons',
    )
    expect(endpointNeurons(table, SCHEMA, seeds).data.neuronId).toEqual([1])
    expect(endpointNeurons(table, SCHEMA).length).toBe(0)
  })
})

/**
 * The `Partners` filter, and the two things it decides at once.
 *
 * Both are cases the obvious implementation answers with a plausible table. Dropping only the
 * far end of an edge leaves a row whose other half is a body nothing can look up; filtering the
 * edges but not the frontier expands through neurons the result has just dropped, so hop 2 finds
 * partners of a fragment that is not in the answer.
 */
describe('published partners', () => {
  /** Keeps the ids given, records what it was asked. */
  function filter(publishedIds: number[]) {
    const asked: number[][] = []
    const set = new Set(publishedIds.map(String))
    return {
      asked,
      published: async (ids: string[]) => {
        asked.push(ids.map(Number))
        return new Set(ids.filter((id) => set.has(id)))
      },
    }
  }

  function runFiltered(
    edges: Edge[],
    opts: {
      seeds: number[]
      direction: TraversalDirection
      hops?: number
      published: number[]
    },
  ) {
    const source = fakeSource(edges, 0)
    const keep = filter(opts.published)
    return traverseConnectivity({
      seeds: opts.seeds.map(String),
      direction: opts.direction,
      hops: opts.hops ?? 1,
      schema: OUT_SCHEMA,
      fetch: source.fetch,
      published: keep.published,
    }).then((table) => ({ table, calls: source.calls, asked: keep.asked }))
  }

  it('drops an edge whose partner the dataset does not publish', async () => {
    const { table, asked } = await runFiltered(
      [
        [1, 2, 5],
        [1, 3, 5],
      ],
      { seeds: [1], direction: 'outputs', published: [2] },
    )
    expect(shape(table)).toEqual(['1>2@1:downstream'])
    // Asked once, about the partners and not about the seed — a seed was named explicitly.
    expect(asked).toEqual([[2, 3]])
  })

  it('keeps a seed the dataset does not publish, and its edges', async () => {
    // 9 is seeded and unpublished; 2 is published. The edge between them survives because a
    // seed is exempt — dropping it would delete a neuron somebody asked for by id.
    const { table } = await runFiltered([[9, 2, 5]], {
      seeds: [9],
      direction: 'outputs',
      published: [2],
    })
    expect(shape(table)).toEqual(['9>2@1:downstream'])
  })

  it('does not expand through a partner it dropped', async () => {
    const { table, calls } = await runFiltered(
      [
        [1, 2, 5],
        [1, 3, 5],
        [3, 4, 5],
      ],
      { seeds: [1], direction: 'outputs', hops: 2, published: [2] },
    )
    // 3 was dropped, so 4 is never reached and the second hop asks only about 2.
    expect(shape(table)).toEqual(['1>2@1:downstream'])
    expect(calls.map((c) => c.neuronIds)).toEqual([[1], [2]])
  })

  it('still labels an internal edge `both` when it survives', async () => {
    const { table } = await runFiltered(
      [
        [1, 2, 5],
        [2, 1, 5],
      ],
      { seeds: [1, 2], direction: 'both', published: [] },
    )
    // Both ends are seeds, so nothing is dropped and the round's two directions still resolve
    // against each other — the rule the per-round accumulator had to preserve.
    expect(shape(table).sort()).toEqual(['1>2@1:both', '2>1@1:both'])
  })

  it('changes nothing when no filter is given', async () => {
    const plain = await run(
      [
        [1, 2, 5],
        [1, 3, 5],
      ],
      { seeds: [1], direction: 'outputs' },
    )
    const filtered = await runFiltered(
      [
        [1, 2, 5],
        [1, 3, 5],
      ],
      { seeds: [1], direction: 'outputs', published: [2, 3] },
    )
    expect(shape(filtered.table)).toEqual(shape(plain.table))
  })
})

/**
 * The left join that keeps the two ports the same set.
 *
 * `findNeurons` answers only about published neurons, so a lookup keyed by an endpoint list is
 * shorter than the list — which would make `Neuron Set` a different length from the edge list it
 * was derived from, the one property the port exists to have.
 */
describe('neuron rows for the endpoint list', () => {
  const NEURON_SCHEMA = tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('status', 'str'),
  )
  const derived = tableFromRows(
    tableSchema(column('neuronId', 'i64'), column('type', 'str')),
    [
      { neuronId: 1, type: 'A' },
      { neuronId: 2, type: 'B' },
      { neuronId: 3, type: null },
    ],
    'neurons',
  )

  it('keeps every endpoint, in its order, with the found rows filled in', () => {
    const rows = tableFromRows(
      NEURON_SCHEMA,
      [{ neuronId: 3, type: 'C', status: 'Traced' }],
      'neurons',
    )
    const out = neuronRowsFor(derived, rows, NEURON_SCHEMA)
    expect(out.length).toBe(3)
    expect(out.data.neuronId).toEqual([1, 2, 3])
    expect(out.data.status).toEqual([null, null, 'Traced'])
    expect(out.kind).toBe('neurons')
  })

  it('leaves an unmatched row its id and the type the edge carried', () => {
    const out = neuronRowsFor(
      derived,
      tableFromRows(NEURON_SCHEMA, [], 'neurons'),
      NEURON_SCHEMA,
    )
    expect(out.data.neuronId).toEqual([1, 2, 3])
    expect(out.data.type).toEqual(['A', 'B', null])
    expect(out.data.status).toEqual([null, null, null])
  })

  it('lets the dataset win the type where it published one', () => {
    const rows = tableFromRows(
      NEURON_SCHEMA,
      [{ neuronId: 1, type: 'renamed', status: 'Traced' }],
      'neurons',
    )
    expect(neuronRowsFor(derived, rows, NEURON_SCHEMA).data.type).toEqual([
      'renamed',
      'B',
      null,
    ])
  })

  it('builds the schema it was handed, not the one the lookup returned', () => {
    const wider = tableFromRows(
      tableSchema(...NEURON_SCHEMA.columns, column('size', 'i64')),
      [{ neuronId: 1, type: 'A', status: 'Traced', size: 10 }],
      'neurons',
    )
    const out = neuronRowsFor(derived, wider, NEURON_SCHEMA)
    expect(out.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'status'])
  })
})
