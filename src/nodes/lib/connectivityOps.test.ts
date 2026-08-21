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
import {
  connectivityOutputSchema,
  traverseConnectivity,
  type TraversalDirection,
} from './connectivityOps'

const SOURCE_SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('bodyType', 'str'),
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

/**
 * A fake source answering query-relative, exactly as `fetchConnectivity` does: `bodyId` is
 * always the neuron asked about, whichever way the arrow points.
 */
function fakeSource(edges: Edge[], minWeight = 0) {
  const calls: Array<{ bodyIds: number[]; direction: ConnectionDirection }> = []
  const fetch = async (
    bodyIds: string[],
    direction: ConnectionDirection,
  ): Promise<TableValue> => {
    // Recorded as numbers so the assertions below stay readable against the numeric fixtures;
    // the traversal itself passes ids as text, which is what `HopFetch` declares.
    calls.push({ bodyIds: bodyIds.map(Number), direction })
    const wanted = new Set(bodyIds.map(Number))
    const rows = edges
      .filter(
        ([pre, post, weight]) =>
          weight >= minWeight && wanted.has(direction === 'outputs' ? pre : post),
      )
      .map(([pre, post, weight]) => {
        const body = direction === 'outputs' ? pre : post
        const partner = direction === 'outputs' ? post : pre
        return {
          bodyId: body,
          bodyType: TYPES[body] ?? null,
          partnerId: partner,
          partnerType: TYPES[partner] ?? null,
          weight,
        }
      })
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
    expect(calls).toEqual([{ bodyIds: [1], direction: 'outputs' }])
  })

  it('swaps the ends for upstream, so a row still reads pre → post', async () => {
    const { table } = await run([[9, 1, 5]], { seeds: [1], direction: 'inputs' })
    // The source answers bodyId: 1 (the neuron asked about), partnerId: 9 (its input).
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
      { bodyIds: [1], direction: 'outputs' },
      { bodyIds: [2], direction: 'outputs' },
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
    expect(calls.map((c) => `${c.direction}:${c.bodyIds.join(',')}`)).toEqual([
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
    expect(calls[1]?.bodyIds).toEqual([2])
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
    expect(calls[0]?.bodyIds).toEqual([1])
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
