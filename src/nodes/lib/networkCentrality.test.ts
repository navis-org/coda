/**
 * Centrality: the definitions checked against networkx, and the choices checked by hand.
 *
 * Same two layers as `networkMetrics.test.ts`, and the split falls in the same place. Whether
 * betweenness is normalised by ordered pairs, whether harmonic centrality sums incoming or
 * outgoing distances, whether a weighted link's length is its weight or its reciprocal — those
 * are definitions, and the fixture is what says we picked the same ones everybody else did.
 * Whether a sampled sweep refuses to report a diameter, whether parallel links are merged before
 * paths are counted, whether Louvain's ids come out largest-first — those are ours.
 *
 * The parallel-link case is the one worth reading twice. `net.build`'s merging can be turned
 * off, and Brandes adds `sigma[u]` to `sigma[v]` once per copy of a link, so one path between a
 * pair gets counted four times and every betweenness downstream of it is quietly wrong. Nothing
 * about the output looks unusual.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import {
  CENTRALITY_DEFAULTS,
  centralityNodeSchema,
  centralitySummarySchema,
  eigenvector,
  networkCentrality,
  pagerank,
} from './networkCentrality'
import { networkxColumn, networkxFixture, networkxValue } from './__fixtures__/networkx'
import { indexNetwork } from './networkMetrics'

const NODE_SCHEMA = tableSchema(column('id', 'str'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function network(
  ids: string[],
  links: Array<[string, string, number?]>,
  directed = true,
): NetworkValue {
  return {
    kind: 'network',
    directed,
    nodes: tableFromRows(
      NODE_SCHEMA,
      ids.map((id) => ({ id })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      links.map(([source, target, weight]) => ({ source, target, weight: weight ?? 1 })),
    ),
  }
}

/** Only what a case is about, so a test does not pay for the four measures it never reads. */
function only(...on: Array<keyof typeof CENTRALITY_DEFAULTS>) {
  return {
    ...CENTRALITY_DEFAULTS,
    betweenness: false,
    closeness: false,
    pagerank: false,
    eigenvector: false,
    communities: false,
    ...Object.fromEntries(on.map((key) => [key, true])),
  }
}

function firstRow(table: {
  schema: { columns: Array<{ name: string }> }
  data: Record<string, unknown[]>
}) {
  const row: Record<string, unknown> = {}
  for (const col of table.schema.columns) row[col.name] = table.data[col.name]![0]
  return row
}

describe('betweenness', () => {
  it('gives the middle of a three-node path the whole of it', () => {
    // n = 3, so networkx's scale is 1/((n-1)(n-2)) = 1/2 and the raw Brandes sum for the middle
    // node is 2 — one from each end. Undirected, so both directions count.
    const path = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      false,
    )
    return networkCentrality(path, only('betweenness')).then((result) => {
      expect(getColumn(result.nodeStats, 'betweenness')).toEqual([0, 1, 0])
    })
  })

  it('follows arrows on a directed graph', async () => {
    const path = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const result = await networkCentrality(path, only('betweenness'))
    // Only a → c passes through b, and the directed scale is the same 1/((n-1)(n-2)) = 1/2.
    expect(getColumn(result.nodeStats, 'betweenness')).toEqual([0, 0.5, 0])
  })

  it('makes a heavy link a short one when paths are weighted', async () => {
    // Unweighted, a → c is one hop and b is on nothing. Weighted, a → b → c is 1/10 + 1/10 and
    // the direct link is 1/1, so the detour is the shortest path and b carries it.
    const net = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b', 10],
        ['b', 'c', 10],
        ['a', 'c', 1],
      ],
    )
    const hops = await networkCentrality(net, only('betweenness'))
    expect(getColumn(hops.nodeStats, 'betweenness')).toEqual([0, 0, 0])

    const weighted = await networkCentrality(net, { ...only('betweenness'), weighted: true })
    expect(getColumn(weighted.nodeStats, 'betweenness')).toEqual([0, 0.5, 0])
  })

  it('is not inflated by parallel links between the same pair', async () => {
    const once = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const four = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['a', 'b'],
        ['a', 'b'],
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    const a = await networkCentrality(once, only('betweenness'))
    const b = await networkCentrality(four, only('betweenness'))
    expect(getColumn(b.nodeStats, 'betweenness')).toEqual(getColumn(a.nodeStats, 'betweenness'))
  })
})

describe('the sweep`s graph-level numbers', () => {
  it('reports mean path length over reachable pairs and refuses a sampled diameter', async () => {
    const path = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      false,
    )
    const exact = firstRow((await networkCentrality(path, only('closeness'))).summary)
    // Six ordered pairs, four at distance 1 and two at distance 2.
    expect(exact['meanPathLength']).toBeCloseTo((4 * 1 + 2 * 2) / 6, 12)
    expect(exact['diameter']).toBe(2)
    expect(exact['reachable']).toBe(1)
    expect(exact['sources']).toBe(3)

    const sampled = firstRow(
      (await networkCentrality(path, { ...only('closeness'), samples: 2 })).summary,
    )
    expect(sampled['sources']).toBe(2)
    // A sampled maximum is a lower bound with no error bar. Null, rather than a number that
    // reads like an answer.
    expect(sampled['diameter']).toBeNull()
    expect(sampled['meanPathLength']).not.toBeNull()
  })

  it('says nothing about paths when no path metric was asked for', async () => {
    const row = firstRow(
      (await networkCentrality(network(['a'], []), only('pagerank'))).summary,
    )
    expect(row['sources']).toBeNull()
    expect(row['meanPathLength']).toBeNull()
    expect(row['diameter']).toBeNull()
  })
})

describe('pagerank', () => {
  it('sums to one and splits a cycle evenly', () => {
    const cycle = network(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    )
    const rank = pagerank(indexNetwork(cycle), 0.85)
    expect([...rank].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    for (const value of rank) expect(value).toBeCloseTo(1 / 3, 10)
  })

  it('keeps a sink`s mass in the graph rather than losing it', () => {
    // `c` has no outgoing links. Dropping its rank instead of redistributing it makes the
    // vector stop summing to one, and then every score is scaled by however much of the graph
    // happened to be a sink — which after a filter is a lot of it.
    const sink = network(
      ['a', 'b', 'c'],
      [
        ['a', 'c'],
        ['b', 'c'],
      ],
    )
    const rank = pagerank(indexNetwork(sink), 0.85)
    expect([...rank].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(rank[2]!).toBeGreaterThan(rank[0]!)
  })
})

describe('eigenvector centrality', () => {
  it('is uniform on a ring and unit length', () => {
    const ring = network(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
        ['d', 'a'],
      ],
      false,
    )
    const x = eigenvector(indexNetwork(ring))
    for (const value of x) expect(value).toBeCloseTo(0.5, 8)
  })

  it('returns the last usable vector rather than NaN on a graph with no links', () => {
    const x = eigenvector(indexNetwork(network(['a', 'b'], [])))
    expect([...x].every(Number.isFinite)).toBe(true)
  })
})

describe('communities', () => {
  it('separates two cliques and numbers them largest-first', async () => {
    const big = ['a', 'b', 'c', 'd', 'e']
    const small = ['x', 'y', 'z']
    const links: Array<[string, string]> = []
    for (const set of [big, small]) {
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) links.push([set[i]!, set[j]!])
      }
    }
    links.push(['e', 'x'])

    const net = network([...big, ...small], links, false)
    const result = await networkCentrality(net, only('communities'))
    const community = getColumn(result.nodeStats, 'community') as number[]
    expect(new Set(community.slice(0, 5)).size).toBe(1)
    expect(new Set(community.slice(5)).size).toBe(1)
    // Largest first, as `componentsOfEdges` numbers components — so that colouring by community
    // and colouring by component rank the same way, and two runs draw the same picture.
    expect(community[0]).toBe(1)
    expect(community[5]).toBe(2)

    const row = firstRow(result.summary)
    expect(row['communities']).toBe(2)
    expect(row['modularity']).toBeGreaterThan(0.3)
  })

  it('gives the same answer twice, because the seed is ours rather than Math.random', async () => {
    const net = network(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'c'],
        ['d', 'e'],
        ['e', 'f'],
        ['d', 'f'],
        ['c', 'd'],
      ],
      false,
    )
    const one = await networkCentrality(net, only('communities'))
    const two = await networkCentrality(net, only('communities'))
    expect(getColumn(two.nodeStats, 'community')).toEqual(getColumn(one.nodeStats, 'community'))
  })
})

describe('the schema follows the switches', () => {
  it('offers only the columns that were asked for', async () => {
    const net = network(['a', 'b'], [['a', 'b']])
    const options = only('pagerank')
    const result = await networkCentrality(net, options)
    expect(result.nodeStats.schema).toEqual(centralityNodeSchema(options))
    expect(result.nodeStats.schema.columns.map((c) => c.name)).toEqual(['id', 'pagerank'])
    // The summary is constant-width whatever was computed — its use is being stacked across
    // runs, and a stack of tables whose columns depend on each run's settings is five tables.
    expect(result.summary.schema).toEqual(centralitySummarySchema())
  })

  it('writes its columns onto the network`s node table, keeping what was there', async () => {
    const schema = tableSchema(column('id', 'str'), column('type', 'str'))
    const net: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(schema, [
        { id: 'a', type: 'LC4' },
        { id: 'b', type: 'LC6' },
      ]),
      edges: tableFromRows(EDGE_SCHEMA, [{ source: 'a', target: 'b', weight: 1 }]),
    }
    const result = await networkCentrality(net, only('pagerank'))
    expect(result.network.nodes.schema.columns.map((c) => c.name)).toEqual([
      'id',
      'type',
      'pagerank',
    ])
    expect(getColumn(result.network.nodes, 'type')).toEqual(['LC4', 'LC6'])
  })
})

// ---------------------------------------------------------------------------
// Against networkx
// ---------------------------------------------------------------------------

const fixtureNetwork = (directed: boolean) =>
  network(
    networkxFixture.nodes,
    networkxFixture.links.map(([a, b, w]) => [a, b, w] as [string, string, number]),
    directed,
  )

describe('agreement with networkx', () => {
  it('matches its normalised betweenness on a directed graph', async () => {
    const result = await networkCentrality(fixtureNetwork(true), only('betweenness'))
    const ours = getColumn(result.nodeStats, 'betweenness') as number[]
    const theirs = networkxColumn('directed', 'betweenness')
    ours.forEach((value, row) => expect(value).toBeCloseTo(theirs[row]!, 12))
    expect(Math.max(...ours)).toBeGreaterThan(0)
  })

  it('matches its harmonic centrality, scaled by n - 1', async () => {
    const result = await networkCentrality(fixtureNetwork(true), only('closeness'))
    const ours = getColumn(result.nodeStats, 'closeness') as number[]
    const theirs = networkxColumn('directed', 'closeness')
    ours.forEach((value, row) => expect(value).toBeCloseTo(theirs[row]!, 12))
  })

  it('matches its weighted PageRank', async () => {
    const result = await networkCentrality(fixtureNetwork(true), only('pagerank'))
    const ours = getColumn(result.nodeStats, 'pagerank') as number[]
    const theirs = networkxColumn('directed', 'pagerank')
    ours.forEach((value, row) => expect(value).toBeCloseTo(theirs[row]!, 8))
  })

  it('matches its weighted eigenvector centrality on the undirected projection', async () => {
    const result = await networkCentrality(fixtureNetwork(false), only('eigenvector'))
    const ours = getColumn(result.nodeStats, 'eigenvector') as number[]
    const theirs = networkxColumn('undirected', 'eigenvector')
    ours.forEach((value, row) => expect(value).toBeCloseTo(theirs[row]!, 6))
  })

  it('matches its mean path length and diameter over reachable pairs', async () => {
    const row = firstRow(
      (await networkCentrality(fixtureNetwork(true), only('closeness'))).summary,
    )
    expect(row['meanPathLength']).toBeCloseTo(networkxValue('directed', 'meanPathLength'), 12)
    expect(row['diameter']).toBe(networkxValue('directed', 'diameter'))
    expect(row['reachable']).toBeCloseTo(networkxValue('directed', 'reachable'), 12)
  })

  it('estimates betweenness from a sample of pivots', async () => {
    const net = fixtureNetwork(true)
    const exact = getColumn(
      (await networkCentrality(net, only('betweenness'))).nodeStats,
      'betweenness',
    ) as number[]
    const sampled = getColumn(
      (await networkCentrality(net, { ...only('betweenness'), samples: 20 })).nodeStats,
      'betweenness',
    ) as number[]

    // The estimator is unbiased in the total rather than per node, which is the honest thing to
    // assert: a third of the sources over a 60-node graph is a coarse sample by design.
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    expect(sum(sampled)).toBeGreaterThan(0.5 * sum(exact))
    expect(sum(sampled)).toBeLessThan(1.5 * sum(exact))

    // And the ranking survives, which is what a sample is usually read for: the busiest node
    // by the exact answer is still near the top of the estimate.
    const rank = [...sampled.keys()].sort((a, b) => sampled[b]! - sampled[a]!)
    const busiest = exact.indexOf(Math.max(...exact))
    expect(rank.slice(0, 5)).toContain(busiest)
  })
})
