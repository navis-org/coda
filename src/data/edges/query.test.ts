/**
 * Querying a loaded edge set.
 *
 * The connectivity cases are ordinary. The path-step ones are not: this is a port of
 * `pathStepCypher`, and every rule it gets wrong produces a *different set of routes* rather
 * than an error — the Paths node traverses whatever comes back, so a graph would simply find
 * other circuits on an edge set than on the backend it was written against.
 */
import { describe, expect, it } from 'vitest'

import type { NeuronId } from '../../core/ids'
import { EdgeSetBuilder } from './encode'
import type { EncodedEdges } from './encode'
import type { EdgeSetMeta, LoadedEdgeSet } from './store'
import { edgesBetween, edgesFrom, pathStepFrom } from './query'

/** A resident set, without going anywhere near IndexedDB — the query layer never reads `meta`. */
function resident(encoded: EncodedEdges): LoadedEdgeSet {
  return {
    meta: { id: 'test', name: 'test', edges: encoded.edges } as EdgeSetMeta,
    ids: encoded.ids,
    index: new Map(encoded.ids.map((id, at) => [id, at])),
    out: encoded.out,
    in: encoded.in,
  }
}

function build(rows: [string, string, number][]): LoadedEdgeSet {
  const b = new EdgeSetBuilder()
  for (const [pre, post, w] of rows) b.add(pre, post, w)
  return resident(b.finish())
}

//   1 -> 2 (10)      1, 4 are LC4
//   1 -> 3 (2)       2, 3 are PLP1
//   4 -> 2 (5)       5 has no type at all
//   2 -> 5 (7)
const SET = build([
  ['1', '2', 10],
  ['1', '3', 2],
  ['4', '2', 5],
  ['2', '5', 7],
])

const TYPES = new Map<NeuronId, string>([
  ['1', 'LC4'],
  ['4', 'LC4'],
  ['2', 'PLP1'],
  ['3', 'PLP1'],
])

const pairs = (edges: { pre: string; post: string; weight: number }[]) =>
  edges.map((e) => [e.pre, e.post, e.weight]).sort()

describe('edgesFrom', () => {
  it('orients every row presynaptic to postsynaptic, whichever direction was asked', () => {
    expect(pairs(edgesFrom(SET, ['1'], 'outputs'))).toEqual([
      ['1', '2', 10],
      ['1', '3', 2],
    ])
    // Inputs of 2: the arrow still points into it, so 2 is the *post* end on both rows.
    expect(pairs(edgesFrom(SET, ['2'], 'inputs'))).toEqual([
      ['1', '2', 10],
      ['4', '2', 5],
    ])
  })

  it('cuts on weight', () => {
    expect(pairs(edgesFrom(SET, ['1'], 'outputs', 5))).toEqual([['1', '2', 10]])
  })

  it('keeps a negative weight when no threshold was asked for', () => {
    // `narrowWeights` deliberately preserves a signed score, so a query that silently dropped
    // one would make the encoder's care pointless — and an edge would simply be missing.
    const scored = build([
      ['1', '2', -5],
      ['1', '3', 4],
    ])
    expect(pairs(edgesFrom(scored, ['1'], 'outputs'))).toEqual([
      ['1', '2', -5],
      ['1', '3', 4],
    ])
    // And a threshold that *was* asked for still applies to it.
    expect(pairs(edgesFrom(scored, ['1'], 'outputs', 0))).toEqual([['1', '3', 4]])
  })

  it('answers nothing for a neuron the file has never heard of', () => {
    // Not an error: an unconnected neuron is what a backend would report too, and refusing
    // would make a Connectivity node fail on a perfectly ordinary id list.
    expect(edgesFrom(SET, ['999'], 'outputs')).toEqual([])
    expect(pairs(edgesFrom(SET, ['1', '999'], 'outputs'))).toHaveLength(2)
  })

  it('does not double a neuron listed twice', () => {
    expect(edgesFrom(SET, ['1', '1'], 'outputs')).toHaveLength(2)
  })
})

describe('edgesBetween', () => {
  it('keeps only the pairs with both ends in the requested sets', () => {
    expect(pairs(edgesBetween(SET, ['1', '4'], ['2']))).toEqual([
      ['1', '2', 10],
      ['4', '2', 5],
    ])
    // 1 -> 3 exists, but 3 was not asked for.
    expect(edgesBetween(SET, ['1'], ['2'])).toHaveLength(1)
  })
})

describe('pathStepFrom', () => {
  const step = (req: Parameters<typeof pathStepFrom>[1]) => {
    const table = pathStepFrom(SET, req, TYPES)
    return Array.from({ length: table.length }, (_, i) =>
      Object.fromEntries(table.schema.columns.map((c) => [c.name, table.data[c.name]![i]])),
    )
  }

  it('collapses a frontier of types onto its members', () => {
    const rows = step({
      datasetId: 'd',
      types: ['LC4'],
      direction: 'outputs',
      collapseTypes: true,
    })
    // 1->2 (10), 1->3 (2) and 4->2 (5) are all LC4 -> PLP1, and they are one row.
    expect(rows).toEqual([
      expect.objectContaining({
        source: 'LC4',
        sourceType: 'LC4',
        sourceId: null,
        target: 'PLP1',
        targetType: 'PLP1',
        targetId: null,
        weight: 17,
        pairs: 3,
      }),
    ])
  })

  it('applies the weight cut after the sum, not per pair', () => {
    // This is the rule the whole collapsed mode exists for: at type level the threshold is a
    // statement about traffic between two populations. Cut per pair first and 2 and 5 both go,
    // leaving 10 — under the threshold — so the pathway disappears entirely.
    const rows = step({
      datasetId: 'd',
      types: ['LC4'],
      direction: 'outputs',
      collapseTypes: true,
      minWeight: 15,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.weight).toBe(17)
  })

  it('gives an untyped neuron a group of its own, keyed by its id', () => {
    // Merging the untyped into one "null" bucket puts a fictitious node in the middle of the
    // graph, and the traversal then routes through it.
    const rows = step({
      datasetId: 'd',
      types: ['PLP1'],
      direction: 'outputs',
      collapseTypes: true,
    })
    expect(rows).toEqual([
      expect.objectContaining({
        source: 'PLP1',
        target: '5',
        targetType: null,
        targetId: '5',
        weight: 7,
      }),
    ])
  })

  it('keeps one node per neuron when not collapsing', () => {
    const rows = step({
      datasetId: 'd',
      neuronIds: ['1'],
      direction: 'outputs',
      collapseTypes: false,
    })
    expect(rows.map((r) => [r.source, r.target, r.weight]).sort()).toEqual([
      ['1', '2', 10],
      ['1', '3', 2],
    ])
    // Every group is one neuron here, so the id is always present and the type rides along.
    expect(rows.every((r) => r.sourceId === '1' && r.sourceType === 'LC4')).toBe(true)
  })

  it('takes the frontier as the union of types and ids', () => {
    // A collapsed traversal sends types for the neurons that have one and ids for those that do
    // not, in the same request — so reading either alone loses half the frontier.
    const rows = step({
      datasetId: 'd',
      types: ['LC4'],
      neuronIds: ['2'],
      direction: 'outputs',
      collapseTypes: true,
    })
    expect(rows.map((r) => `${String(r.source)}->${String(r.target)}`).sort()).toEqual([
      'LC4->PLP1',
      'PLP1->5',
    ])
  })

  it('sorts by weight, heaviest first', () => {
    const rows = step({
      datasetId: 'd',
      neuronIds: ['1', '2', '4'],
      direction: 'outputs',
      collapseTypes: false,
    })
    const weights = rows.map((r) => Number(r.weight))
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })

  it('is empty for an empty frontier rather than answering about the whole set', () => {
    expect(step({ datasetId: 'd', direction: 'outputs', collapseTypes: true })).toEqual([])
  })

  it('carries an eighteen-digit id out as exact text', () => {
    // The reason `pathStepSchema` takes a dtype: this id in an `i64` column is 720575940628857344,
    // a different neuron, and `idText` would then read it back as that one all the way into the
    // traversal's node keys.
    const wide = '720575940628857210'
    const set = build([[wide, '2', 4]])
    const table = pathStepFrom(
      set,
      { datasetId: 'd', neuronIds: [wide], direction: 'outputs', collapseTypes: false },
      new Map(),
    )
    expect(table.data.sourceId![0]).toBe(wide)
    expect(table.schema.columns.find((c) => c.name === 'sourceId')?.dtype).toBe('str')
  })
})
