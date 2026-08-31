/**
 * Network filtering semantics.
 *
 * The order the three knobs apply in is the substance here, along with the roll-up
 * recomputation — a filtered network whose `degreeOut` still describes links that were cut
 * drives a size encoding and a tooltip that contradict the picture beside them.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import {
  NO_FILTER,
  connectedComponents,
  expandSelection,
  filterNetwork,
  isFiltering,
} from './networkOps'

const NODE_SCHEMA = tableSchema(
  column('id', 'str'),
  column('degreeIn', 'i64'),
  column('degreeOut', 'i64'),
  column('weightIn', 'f64'),
  column('weightOut', 'f64'),
)
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

/** Builds a network with the roll-ups filled in as `BuildNetwork` would. */
function network(ids: string[], links: Array<[string, string, number]>): NetworkValue {
  const acc = new Map(
    ids.map((id) => [id, { degreeIn: 0, degreeOut: 0, weightIn: 0, weightOut: 0 }]),
  )
  for (const [from, to, w] of links) {
    const a = acc.get(from)!
    const b = acc.get(to)!
    a.degreeOut += 1
    a.weightOut += w
    b.degreeIn += 1
    b.weightIn += w
  }
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      NODE_SCHEMA,
      ids.map((id) => ({ id, ...acc.get(id)! })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      links.map(([source, target, weight]) => ({ source, target, weight })),
    ),
  }
}

const ids = (n: NetworkValue) => getColumn(n.nodes, 'id').map(String)
const links = (n: NetworkValue) =>
  getColumn(n.edges, 'source').map(
    (s, i) => `${String(s)}->${String(getColumn(n.edges, 'target')[i])}`,
  )
const cell = (n: NetworkValue, col: string, row: number) => n.nodes.data[col]?.[row]

/** a→b (10), b→c (1), a→c (5), plus d with nothing attached. */
const sample = () =>
  network(
    ['a', 'b', 'c', 'd'],
    [
      ['a', 'b', 10],
      ['b', 'c', 1],
      ['a', 'c', 5],
    ],
  )

describe('isFiltering', () => {
  it('is false for the default, which is what keeps the whole thing a no-op', () => {
    expect(isFiltering(NO_FILTER)).toBe(false)
    expect(isFiltering({ ...NO_FILTER, minWeight: 1 })).toBe(true)
    expect(isFiltering({ ...NO_FILTER, topNodes: 1 })).toBe(true)
    expect(isFiltering({ ...NO_FILTER, hideIsolated: true })).toBe(true)
  })

  it('returns the very same value when nothing is filtered, not a copy', () => {
    const input = sample()
    expect(filterNetwork(input, NO_FILTER).network).toBe(input)
  })
})

describe('minWeight', () => {
  it('drops links under the threshold and leaves the nodes alone', () => {
    const { network: out, dropped } = filterNetwork(sample(), { ...NO_FILTER, minWeight: 5 })
    expect(links(out)).toEqual(['a->b', 'a->c'])
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd'])
    expect(dropped).toEqual({ nodes: 0, links: 1 })
  })

  it('keeps a link exactly on the threshold', () => {
    const out = filterNetwork(sample(), { ...NO_FILTER, minWeight: 10 }).network
    expect(links(out)).toEqual(['a->b'])
  })
})

describe('topNodes', () => {
  it('ranks by total attached weight, not by degree', () => {
    // a: 15, b: 11, c: 6, d: 0 — so b outranks c despite both having two links.
    const out = filterNetwork(sample(), { ...NO_FILTER, topNodes: 2 }).network
    expect(ids(out).sort()).toEqual(['a', 'b'])
    expect(links(out)).toEqual(['a->b'])
  })

  it('ranks over the links that survived the weight cut, not the original set', () => {
    /*
     * With minWeight 5 the b→c link is gone, so c is left with only a→c (5) while b keeps
     * a→b (10). Ranking before the cut would have counted the discarded link.
     */
    const out = filterNetwork(sample(), { ...NO_FILTER, minWeight: 5, topNodes: 2 }).network
    expect(ids(out).sort()).toEqual(['a', 'b'])
  })

  it('does nothing when asked for more nodes than exist', () => {
    const input = sample()
    expect(filterNetwork(input, { ...NO_FILTER, topNodes: 99 }).network).toBe(input)
  })

  it('breaks ties on id, so the provenance key cannot depend on iteration order', () => {
    const tied = network(
      ['z', 'y', 'x'],
      [
        ['z', 'y', 1],
        ['y', 'x', 1],
        ['x', 'z', 1],
      ],
    )
    // Every node scores 2; the tie-break is alphabetical.
    expect(ids(filterNetwork(tied, { ...NO_FILTER, topNodes: 2 }).network).sort()).toEqual([
      'x',
      'y',
    ])
  })
})

describe('hideIsolated', () => {
  it('drops a node with nothing attached', () => {
    const { network: out, dropped } = filterNetwork(sample(), {
      ...NO_FILTER,
      hideIsolated: true,
    })
    expect(ids(out)).toEqual(['a', 'b', 'c'])
    expect(dropped).toEqual({ nodes: 1, links: 0 })
  })

  it('drops a node stranded by the weight cut, not merely one that started isolated', () => {
    const out = filterNetwork(sample(), {
      ...NO_FILTER,
      minWeight: 10,
      hideIsolated: true,
    }).network
    // Only a→b survives, so c joins d in being stranded.
    expect(ids(out)).toEqual(['a', 'b'])
  })
})

describe('derived roll-ups', () => {
  it('rewrites the degree columns over the links that survived', () => {
    const out = filterNetwork(sample(), { ...NO_FILTER, minWeight: 5 }).network
    const row = ids(out).indexOf('c')
    // c kept only a→c (5); its b→c input is gone.
    expect(cell(out, 'degreeIn', row)).toBe(1)
    expect(cell(out, 'weightIn', row)).toBe(5)
  })

  it('zeroes a node the filter stranded, rather than leaving it claiming links', () => {
    const out = filterNetwork(sample(), { ...NO_FILTER, minWeight: 99 }).network
    const row = ids(out).indexOf('a')
    expect(cell(out, 'degreeOut', row)).toBe(0)
    expect(cell(out, 'weightOut', row)).toBe(0)
  })

  it('leaves a network without those columns untouched', () => {
    const plain: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), [{ id: 'a' }, { id: 'b' }]),
      edges: tableFromRows(EDGE_SCHEMA, [{ source: 'a', target: 'b', weight: 1 }]),
    }
    const out = filterNetwork(plain, { ...NO_FILTER, minWeight: 99 }).network
    expect(out.nodes.schema.columns.map((c) => c.name)).toEqual(['id'])
    expect(ids(out)).toEqual(['a', 'b'])
  })
})

describe('a network with no weight column', () => {
  const unweighted: NetworkValue = {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(tableSchema(column('id', 'str')), [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]),
    edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ]),
  }

  it('ranks by plain degree, every link weighing 1', () => {
    const out = filterNetwork(unweighted, { ...NO_FILTER, topNodes: 1 }).network
    expect(ids(out)).toEqual(['a'])
  })

  it('does not throw on a weight threshold it cannot measure', () => {
    expect(() => filterNetwork(unweighted, { ...NO_FILTER, minWeight: 2 })).not.toThrow()
  })
})

describe('connectedComponents', () => {
  /** `a → b → c`, a separate `d → e`, and an unattached `lone`: sizes 3, 2, 1. */
  const split: NetworkValue = {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(tableSchema(column('id', 'str')), [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
      { id: 'lone' },
    ]),
    edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'd', target: 'e' },
    ]),
  }

  it('numbers by size, largest first', () => {
    expect(connectedComponents(split)).toEqual([1, 1, 1, 2, 2, 3])
  })

  it('ignores direction, like the walk the menu selects with', () => {
    // A component that respected arrows would be a reachable set: `c` reaches nothing.
    const upstream = connectedComponents(split)
    expect(upstream[2]).toBe(upstream[0])
  })

  it('agrees with expandSelection about what a component is', () => {
    // Two walks written for one rule; this is what keeps them one rule. A viewer colouring by
    // component beside a menu selecting one are two statements about the same partition.
    const labels = connectedComponents(split)
    const ids = getColumn(split.nodes, 'id').map(String)
    for (const seed of ids) {
      const walked = expandSelection(split, {
        seeds: new Set([seed]),
        expand: 'component',
        hops: 0,
        direction: 'any',
      })
      const mine = labels[ids.indexOf(seed)]
      expect([...walked].sort()).toEqual(ids.filter((_, i) => labels[i] === mine).sort())
    }
  })

  it('breaks a size tie on the first node’s row, so the answer is stable', () => {
    const tied: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), [
        { id: 'x' },
        { id: 'y' },
        { id: 'z' },
      ]),
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), []),
    }
    expect(connectedComponents(tied)).toEqual([1, 2, 3])
  })

  it('survives a self-loop and a link naming a node that is not there', () => {
    const ragged: NetworkValue = {
      ...split,
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), [
        { source: 'a', target: 'a' },
        { source: 'a', target: 'gone' },
        { source: 'a', target: 'b' },
      ]),
    }
    expect(connectedComponents(ragged)).toEqual([1, 1, 2, 3, 4, 5])
  })

  it('calls an empty network no components at all', () => {
    const empty: NetworkValue = {
      kind: 'network',
      directed: true,
      nodes: tableFromRows(tableSchema(column('id', 'str')), []),
      edges: tableFromRows(tableSchema(column('source', 'str'), column('target', 'str')), []),
    }
    expect(connectedComponents(empty)).toEqual([])
  })
})
