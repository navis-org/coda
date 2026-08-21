/**
 * Finding routes, and everything about that which a plausible-looking wrong answer survives.
 *
 * The failures being guarded against are all quiet ones. A one-sided search still returns
 * routes — just none of the ones that needed more than half the budget from the far end. A
 * pruning pass that forgets the `+1` on the edge inequality still returns a network — just one
 * carrying the back-edges the caller asked to be rid of. A ranking that scores by *sum* rather
 * than by bottleneck still returns "the strongest", and prefers a long weak chain to a short
 * strong one. And a shortlist that never raises its bound still returns the right answer, on a
 * graph small enough that nobody notices it took a million steps to get there.
 *
 * The fetch is a fake graph rather than a source, which is the point of taking it as a
 * callback: no network, no dataset, and every hop's *frontier* is observable.
 */

import { describe, expect, it } from 'vitest'

import type { TableValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import type { ConnectionDirection } from '../../data/source'
import { PATH_STEP_SCHEMA } from '../../data/source'
import {
  MAX_PATH_STEPS,
  hopSplit,
  pathStats,
  pathsTable,
  pathsToNetwork,
  prunePathGraph,
  rankPaths,
  traversePaths,
  type Frontier,
  type PathNode,
} from './pathOps'

/** A directed edge in the fake connectome: source key, target key, weight. */
type Edge = [string, string, number]

function node(key: string): PathNode {
  // Every key in these fixtures is a type name, i.e. the collapsed case. The neuron-level
  // case differs only in what the *source* returns, which `paths.test.ts` covers end to end.
  return { key, type: key, neuronId: null }
}

/**
 * A fake source answering the aggregated shape `PathStepRequest` promises.
 *
 * `minWeight` is applied here rather than by the traversal, exactly as the real thing does —
 * an edge below it is neither a row nor a reason to expand.
 */
function fakeSource(edges: Edge[], minWeight = 0) {
  const calls: Array<{ frontier: Frontier; direction: ConnectionDirection }> = []
  const fetch = async (
    frontier: Frontier,
    direction: ConnectionDirection,
  ): Promise<TableValue> => {
    calls.push({
      frontier: { types: [...frontier.types], neuronIds: [...frontier.neuronIds] },
      direction,
    })
    const wanted = new Set(frontier.types)
    const rows = edges
      .filter(
        ([source, target, weight]) =>
          weight >= minWeight && wanted.has(direction === 'outputs' ? source : target),
      )
      .map(([source, target, weight]) => ({
        source,
        sourceType: source,
        sourceId: null,
        target,
        targetType: target,
        targetId: null,
        weight,
        pairs: 1,
      }))
    return tableFromRows(PATH_STEP_SCHEMA, rows)
  }
  return { fetch, calls }
}

/** Traverse, prune and rank in one go — the sequence the node runs. */
async function findPaths(
  edges: Edge[],
  sources: string[],
  targets: string[],
  maxHops: number,
  topN = 0,
  minWeight = 0,
) {
  const fake = fakeSource(edges, minWeight)
  const graph = await traversePaths({
    sources: sources.map(node),
    targets: targets.map(node),
    maxHops,
    fetch: fake.fetch,
  })
  const pruned = prunePathGraph(graph, sources, targets, maxHops)
  const ranked = rankPaths(pruned, sources, targets, maxHops, topN)
  return { graph, pruned, ranked, calls: fake.calls }
}

describe('hopSplit', () => {
  it('gives the forward half the extra hop', () => {
    expect(hopSplit(1)).toEqual({ forward: 1, backward: 0 })
    expect(hopSplit(2)).toEqual({ forward: 1, backward: 1 })
    expect(hopSplit(3)).toEqual({ forward: 2, backward: 1 })
    expect(hopSplit(4)).toEqual({ forward: 2, backward: 2 })
  })
})

describe('traversePaths', () => {
  it('searches from both ends, so a 4-hop route costs 2 hops each way', async () => {
    const chain: Edge[] = [
      ['A', 'B', 10],
      ['B', 'C', 10],
      ['C', 'D', 10],
      ['D', 'E', 10],
    ]
    const { ranked, calls } = await findPaths(chain, ['A'], ['E'], 4)

    expect(ranked.paths).toHaveLength(1)
    expect(ranked.paths[0]?.keys).toEqual(['A', 'B', 'C', 'D', 'E'])
    // Two rounds forward, two back — never four in either direction.
    expect(calls.filter((c) => c.direction === 'outputs')).toHaveLength(2)
    expect(calls.filter((c) => c.direction === 'inputs')).toHaveLength(2)
  })

  it('finds a route the forward half alone could not reach', async () => {
    // Five hops of budget, so forward gets three and backward two. The middle edge is only
    // ever seen by the backward half; a one-sided search of ceil(h/2) would miss the route.
    const chain: Edge[] = [
      ['A', 'B', 5],
      ['B', 'C', 5],
      ['C', 'D', 5],
      ['D', 'E', 5],
      ['E', 'F', 5],
    ]
    const { ranked } = await findPaths(chain, ['A'], ['F'], 5)
    expect(ranked.paths[0]?.keys).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(ranked.paths[0]?.hops).toBe(5)
  })

  it('terminates on a recurrent circuit rather than re-expanding it', async () => {
    const loop: Edge[] = [
      ['A', 'B', 10],
      ['B', 'C', 10],
      ['C', 'B', 10],
      ['C', 'D', 10],
    ]
    const { ranked } = await findPaths(loop, ['A'], ['D'], 3)
    expect(ranked.paths.map((p) => p.keys.join('>'))).toEqual(['A>B>C>D'])
  })

  it('never returns to a node it has already been through', async () => {
    const loop: Edge[] = [
      ['A', 'B', 10],
      ['B', 'A', 10],
      ['B', 'C', 10],
    ]
    const { ranked } = await findPaths(loop, ['A'], ['C'], 3)
    // A>B>A>B>C is a walk, not a route. Every key must appear once.
    for (const path of ranked.paths) {
      expect(new Set(path.keys).size).toBe(path.keys.length)
    }
  })

  it('leaves an edge below the threshold neither a row nor a reason to expand', async () => {
    const edges: Edge[] = [
      ['A', 'B', 3],
      ['B', 'C', 100],
      ['A', 'D', 50],
      ['D', 'C', 50],
    ]
    const { ranked, calls } = await findPaths(edges, ['A'], ['C'], 2, 0, 10)
    expect(ranked.paths.map((p) => p.keys.join('>'))).toEqual(['A>D>C'])
    // B was pruned by the source, so it never became a frontier.
    expect(calls.flatMap((c) => c.frontier.types)).not.toContain('B')
  })
})

describe('prunePathGraph', () => {
  it('drops the strays the two searches picked up on the way', async () => {
    const edges: Edge[] = [
      ['A', 'B', 10],
      ['B', 'C', 10],
      // A hub off the route: reached forwards, leads nowhere near C.
      ['A', 'H', 10],
      ['H', 'Z', 10],
    ]
    const { graph, pruned } = await findPaths(edges, ['A'], ['C'], 2)
    expect([...graph.nodes.keys()]).toContain('H')
    expect([...pruned.nodes.keys()].sort()).toEqual(['A', 'B', 'C'])
  })

  it('keeps only the feed-forward edges — a back-edge between two kept nodes goes', async () => {
    const edges: Edge[] = [
      ['A', 'B', 10],
      ['B', 'C', 10],
      // Both ends survive, and the edge still cannot be on any A→C route within 2 hops.
      ['C', 'B', 99],
    ]
    const { pruned } = await findPaths(edges, ['A'], ['C'], 2)
    expect([...pruned.nodes.keys()].sort()).toEqual(['A', 'B', 'C'])
    expect([...pruned.edges.values()].map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      'A>B',
      'B>C',
    ])
  })

  it('keeps a shortcut that is itself a route', async () => {
    const edges: Edge[] = [
      ['A', 'B', 10],
      ['B', 'C', 10],
      ['A', 'C', 10],
    ]
    const { pruned } = await findPaths(edges, ['A'], ['C'], 2)
    expect(pruned.edges.size).toBe(3)
  })
})

describe('rankPaths', () => {
  const diamond: Edge[] = [
    // Weak middle: a long strong-looking chain whose bottleneck is 2.
    ['A', 'W', 500],
    ['W', 'X', 2],
    ['X', 'D', 500],
    // Modest throughout, but nothing on it is weaker than 40.
    ['A', 'Y', 40],
    ['Y', 'D', 60],
  ]

  it('scores a route by its weakest link, not by its total', async () => {
    const { ranked } = await findPaths(diamond, ['A'], ['D'], 3)
    expect(ranked.paths.map((p) => p.keys.join('>'))).toEqual(['A>Y>D', 'A>W>X>D'])
    expect(ranked.paths[0]?.bottleneck).toBe(40)
    expect(ranked.paths[1]?.bottleneck).toBe(2)
    // Summing would have ranked these the other way round, 1002 against 100.
  })

  it('keeps whole routes, so N is a count of routes and not of nodes', async () => {
    const { ranked } = await findPaths(diamond, ['A'], ['D'], 3, 1)
    expect(ranked.paths).toHaveLength(1)
    expect(ranked.paths[0]?.keys).toEqual(['A', 'Y', 'D'])
  })

  it('0 means every route', async () => {
    const { ranked } = await findPaths(diamond, ['A'], ['D'], 3, 0)
    expect(ranked.paths).toHaveLength(2)
  })

  it('ranks across lengths rather than preferring the shortest', async () => {
    const edges: Edge[] = [
      ['A', 'B', 1],
      ['B', 'D', 1],
      ['A', 'P', 90],
      ['P', 'Q', 90],
      ['Q', 'D', 90],
    ]
    const { ranked } = await findPaths(edges, ['A'], ['D'], 3, 1)
    // A shortest-paths-only search would have returned the 2-hop route carrying one synapse.
    expect(ranked.paths[0]?.keys).toEqual(['A', 'P', 'Q', 'D'])
    expect(ranked.paths[0]?.hops).toBe(3)
  })

  it('handles several sources and several targets at once', async () => {
    const edges: Edge[] = [
      ['A1', 'M', 10],
      ['A2', 'M', 20],
      ['M', 'T1', 30],
      ['M', 'T2', 5],
    ]
    const { ranked } = await findPaths(edges, ['A1', 'A2'], ['T1', 'T2'], 2)
    expect(ranked.paths.map((p) => p.keys.join('>'))).toEqual([
      'A2>M>T1',
      'A1>M>T1',
      // Both carry 5, so the tie breaks on the route's own name — only so that two runs of
      // the same query list them the same way round.
      'A1>M>T2',
      'A2>M>T2',
    ])
  })

  it('gives the same order twice, since the result reaches a saved graph', async () => {
    const edges: Edge[] = [
      ['A', 'B', 10],
      ['A', 'C', 10],
      ['B', 'T', 10],
      ['C', 'T', 10],
    ]
    const first = await findPaths(edges, ['A'], ['T'], 2)
    const second = await findPaths(edges, ['A'], ['T'], 2)
    expect(first.ranked.paths.map((p) => p.keys.join('>'))).toEqual(
      second.ranked.paths.map((p) => p.keys.join('>')),
    )
  })

  it('reports a truncated search rather than passing it off as exhaustive', async () => {
    // A layered graph dense enough that enumerating every route exceeds the step budget:
    // 8 layers of 9 nodes, fully connected between neighbours, is 9^7 routes.
    const edges: Edge[] = []
    const layers = 8
    const width = 9
    for (let layer = 0; layer < layers - 1; layer++) {
      for (let a = 0; a < width; a++) {
        for (let b = 0; b < width; b++) {
          edges.push([`L${layer}_${a}`, `L${layer + 1}_${b}`, 100])
        }
      }
    }
    edges.unshift(['S', 'L0_0', 100])
    for (let a = 0; a < width; a++) edges.push([`L${layers - 1}_${a}`, 'T', 100])

    const { ranked } = await findPaths(edges, ['S'], ['T'], layers + 1, 0)
    expect(ranked.truncated).toBe(true)
    expect(ranked.paths.length).toBeGreaterThan(0)
  })

  it('the bound makes an exhaustive-looking search cheap when N is small', async () => {
    // The same graph, asking for a shortlist rather than for everything. Every route here has
    // the same bottleneck, so this measures the plumbing rather than a lucky ordering: the
    // point is that it *returns*, which without a bound it would not do inside the budget.
    const edges: Edge[] = []
    for (let layer = 0; layer < 7; layer++) {
      for (let a = 0; a < 9; a++) {
        for (let b = 0; b < 9; b++) edges.push([`L${layer}_${a}`, `L${layer + 1}_${b}`, 100])
      }
    }
    edges.unshift(['S', 'L0_0', 100])
    for (let a = 0; a < 9; a++) edges.push([`L7_${a}`, 'T', 100])

    const { ranked } = await findPaths(edges, ['S'], ['T'], 9, 5)
    expect(ranked.paths).toHaveLength(5)
    expect(MAX_PATH_STEPS).toBeGreaterThan(0)
  })
})

describe('pathsToNetwork', () => {
  it('spans the kept routes and nothing else', async () => {
    const edges: Edge[] = [
      ['A', 'STRONG', 90],
      ['STRONG', 'T', 90],
      ['A', 'WEAK', 2],
      ['WEAK', 'T', 2],
    ]
    const { pruned, ranked } = await findPaths(edges, ['A'], ['T'], 2, 1)
    const network = pathsToNetwork(pruned, ranked.paths, ['A'], ['T'])

    expect([...getColumn(network.nodes, 'id')]).toEqual(['A', 'STRONG', 'T'])
    // WEAK survived the pruning — it is on a valid 2-hop route — and was ranked out.
    expect(pruned.nodes.has('WEAK')).toBe(true)
    expect(network.directed).toBe(true)
  })

  it('labels each node by its part in the circuit and how deep it sits', async () => {
    const edges: Edge[] = [
      ['A', 'M', 10],
      ['M', 'T', 10],
    ]
    const { pruned, ranked } = await findPaths(edges, ['A'], ['T'], 2)
    const network = pathsToNetwork(pruned, ranked.paths, ['A'], ['T'])

    expect([...getColumn(network.nodes, 'role')]).toEqual(['source', 'via', 'target'])
    expect([...getColumn(network.nodes, 'hop')]).toEqual([0, 1, 2])
  })

  it('counts how many kept routes run through each node and edge', async () => {
    const edges: Edge[] = [
      ['A', 'HUB', 50],
      ['HUB', 'T1', 40],
      ['HUB', 'T2', 30],
    ]
    const { pruned, ranked } = await findPaths(edges, ['A'], ['T1', 'T2'], 2)
    const network = pathsToNetwork(pruned, ranked.paths, ['A'], ['T1', 'T2'])

    const ids = [...getColumn(network.nodes, 'id')]
    const paths = [...getColumn(network.nodes, 'paths')]
    expect(paths[ids.indexOf('HUB')]).toBe(2)
    expect(paths[ids.indexOf('T1')]).toBe(1)

    const edgePaths = [...getColumn(network.edges, 'paths')]
    const sources = [...getColumn(network.edges, 'source')]
    const targets = [...getColumn(network.edges, 'target')]
    const shared = sources.findIndex((s, i) => s === 'A' && targets[i] === 'HUB')
    expect(edgePaths[shared]).toBe(2)
  })

  it('carries the aggregate weight through, not a re-derived one', async () => {
    const edges: Edge[] = [
      ['A', 'M', 137],
      ['M', 'T', 42],
    ]
    const { pruned, ranked } = await findPaths(edges, ['A'], ['T'], 2)
    const network = pathsToNetwork(pruned, ranked.paths, ['A'], ['T'])
    expect(
      [...getColumn(network.edges, 'weight')].sort((a, b) => Number(a) - Number(b)),
    ).toEqual([42, 137])
  })

  it('is empty, rather than broken, when nothing connects', async () => {
    const edges: Edge[] = [
      ['A', 'B', 10],
      ['X', 'T', 10],
    ]
    const { pruned, ranked } = await findPaths(edges, ['A'], ['T'], 3)
    const network = pathsToNetwork(pruned, ranked.paths, ['A'], ['T'])
    expect(ranked.paths).toEqual([])
    expect(network.nodes.length).toBe(0)
    expect(network.edges.length).toBe(0)
  })
})

describe('pathStats and pathsTable', () => {
  it('report the shortest route and the strongest route’s bottleneck — two different routes', async () => {
    const edges: Edge[] = [
      // Short and weak.
      ['A', 'T', 3],
      // Long and strong.
      ['A', 'P', 80],
      ['P', 'Q', 80],
      ['Q', 'T', 80],
    ]
    const { ranked } = await findPaths(edges, ['A'], ['T'], 3)
    const stats = pathStats(ranked.paths)
    expect(stats.count).toBe(2)
    expect(stats.minHops).toBe(1)
    expect(stats.bottleneck).toBe(80)
  })

  it('writes one row per route, strongest first, with the route spelled out', async () => {
    const edges: Edge[] = [
      ['A', 'M', 10],
      ['M', 'T', 10],
    ]
    const { ranked } = await findPaths(edges, ['A'], ['T'], 2)
    const table = pathsTable(ranked.paths)
    expect(table.length).toBe(1)
    expect(getColumn(table, 'rank')[0]).toBe(1)
    expect(getColumn(table, 'hops')[0]).toBe(2)
    expect(getColumn(table, 'bottleneck')[0]).toBe(10)
    expect(String(getColumn(table, 'path')[0])).toContain('A')
    expect(String(getColumn(table, 'path')[0])).toContain('T')
  })

  it('says nothing rather than zero when there are no routes', () => {
    expect(pathStats([])).toEqual({ count: 0, minHops: 0, bottleneck: 0 })
    expect(pathsTable([]).length).toBe(0)
  })
})
