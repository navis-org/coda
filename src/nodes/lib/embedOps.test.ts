/**
 * What can be decided about an embedding without running one.
 *
 * The layout UMAP produces is stochastic and is not what these check. What they check is the
 * **k-NN graph handed to it**, which is entirely determined by the input and is where every
 * silent wrong answer this node can give comes from: a self entry in the wrong place drops a
 * neighbour from every bandwidth search, a padded row with an infinite distance destroys its own
 * neighbourhood, and a similarity read as a distance embeds a plausible mirror image of the
 * truth. None of those raises, and none of them is visible in a picture.
 */

import { describe, expect, it } from 'vitest'

import type { Warner } from '../../core/limits'
import { column, tableSchema } from '../../core/types'
import { makeMatrix, tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import {
  EMBED_ANNOTATION_COLUMN,
  MIN_EMBED_OBSERVATIONS,
  checkEmbedCount,
  checkEmbedMatrix,
  checkNeighbourDistances,
  clampNeighbours,
  countAnnotated,
  embedSchema,
  embedTable,
  knnFromMatrix,
  knnFromNeighbours,
} from './embedOps'

const NO_WARN: Warner = { warn: () => undefined }

function collecting(): Warner & { messages: string[] } {
  const messages: string[] = []
  return { messages, warn: (message: string) => messages.push(message) }
}

/**
 * Six observations in two tight triples — `a b c` and `d e f`.
 *
 * Six rather than four so that a `k` of 3 has a real choice to get wrong: with four, every
 * neighbour selection returns the same set whatever the ordering.
 */
function similarities() {
  const labels = ['a', 'b', 'c', 'd', 'e', 'f']
  const near = 0.9
  const far = 0.1
  const values: number[] = []
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      values.push(i === j ? 1 : Math.floor(i / 3) === Math.floor(j / 3) ? near : far)
    }
  }
  return makeMatrix(
    labels,
    labels.slice(),
    Float64Array.from(values),
    'NBLAST score',
    'similarity',
  )
}

/** A long neighbour table in `NBLAST k-NN`'s shape. */
function neighbourTable(
  rows: Array<{ queryId: string; targetId: string; score: number }>,
): TableValue {
  return tableFromRows(
    tableSchema(column('queryId', 'str'), column('targetId', 'str'), column('score', 'f64')),
    rows,
  )
}

describe('the k-NN graph a matrix becomes', () => {
  it('names each row itself first, at distance zero', () => {
    // umap-js's `smoothKNNDistance` sums from index 1, as umap-learn's `smooth_knn_dist` does,
    // because the reference convention is that a point is its own nearest neighbour. Without
    // this the closest real neighbour is dropped from every bandwidth search — a slightly wrong
    // picture with nothing to say so.
    const graph = knnFromMatrix(similarities(), 'one_minus', 3)
    expect(graph.indices.map((row) => row[0])).toEqual([0, 1, 2, 3, 4, 5])
    expect(graph.distances.map((row) => row[0])).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('takes the nearest, which under `one_minus` are the highest-scoring', () => {
    const graph = knnFromMatrix(similarities(), 'one_minus', 3)
    // Row `a` is 0; its triple is 1 and 2, and the other three are all further.
    expect(graph.indices[0]!.slice(1).sort()).toEqual([1, 2])
    expect(graph.indices[3]!.slice(1).sort()).toEqual([4, 5])
    expect(graph.distances[0]!.slice(1)).toEqual([
      expect.closeTo(0.1, 10),
      expect.closeTo(0.1, 10),
    ])
  })

  it('reads the cells as distances when told to, which inverts what is near', () => {
    // The same matrix, the opposite answer — which is the whole of what the Distance control
    // does, and the reason `checkLinkageDistances` guards the guess that sets it.
    const graph = knnFromMatrix(similarities(), 'none', 3)
    expect(graph.indices[0]!.slice(1).sort()).not.toEqual([1, 2])
  })

  it('keeps its neighbours in ascending order', () => {
    // `smoothKNNDistance` reads `nonZeroDists[index - 1]` for rho, so the row has to be sorted
    // rather than merely correct as a set.
    const labels = ['a', 'b', 'c', 'd', 'e']
    const values = [0, 4, 1, 3, 2, 4, 0, 1, 2, 3, 1, 1, 0, 1, 1, 3, 2, 1, 0, 1, 2, 3, 1, 1, 0]
    const matrix = makeMatrix(
      labels,
      labels.slice(),
      Float64Array.from(values),
      'd',
      'distance',
    )
    const graph = knnFromMatrix(matrix, 'none', 4)
    const row = graph.distances[0]!
    expect(row).toEqual([...row].sort((x, y) => x - y))
    expect(graph.indices[0]).toEqual([0, 2, 4, 3])
  })

  it('skips a cell that is not a number rather than sorting it', () => {
    const labels = ['a', 'b', 'c', 'd']
    const values = [0, NaN, 2, 3, NaN, 0, 1, 2, 2, 1, 0, 1, 3, 2, 1, 0]
    const matrix = makeMatrix(
      labels,
      labels.slice(),
      Float64Array.from(values),
      'd',
      'distance',
    )
    const graph = knnFromMatrix(matrix, 'none', 3)
    // `b` is unrecorded from `a`, so `a`'s two neighbours are `c` and `d` rather than a NaN
    // sorting to whichever end the comparator puts it.
    expect(graph.indices[0]).toEqual([0, 2, 3])
    expect(graph.distances[0]!.every((d) => Number.isFinite(d))).toBe(true)
  })
})

describe('the k-NN graph a neighbour table becomes', () => {
  const rows = [
    { queryId: 'a', targetId: 'b', score: 0.9 },
    { queryId: 'b', targetId: 'a', score: 0.9 },
    { queryId: 'a', targetId: 'c', score: 0.2 },
    { queryId: 'c', targetId: 'd', score: 0.8 },
    { queryId: 'd', targetId: 'c', score: 0.8 },
    { queryId: 'b', targetId: 'c', score: 0.1 },
    { queryId: 'c', targetId: 'a', score: 0.2 },
    { queryId: 'd', targetId: 'b', score: 0.1 },
    // The same pair again, closer. Interleaved rather than adjacent to its first appearance,
    // which is the arrangement a "first wins" rule and a "closest wins" rule disagree on.
    { queryId: 'a', targetId: 'b', score: 0.99 },
  ]

  it('lays the queries out in first-appearance order', () => {
    const { graph } = knnFromNeighbours(
      neighbourTable(rows),
      { query: 'queryId', target: 'targetId', score: 'score', scoreIs: 'similarity' },
      3,
      NO_WARN,
    )
    expect(graph.labels).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps the smallest distance for a repeated pair', () => {
    const { graph } = knnFromNeighbours(
      neighbourTable(rows),
      { query: 'queryId', target: 'targetId', score: 'score', scoreIs: 'similarity' },
      3,
      NO_WARN,
    )
    // 0.99 rather than the 0.9 listed first — where a map built by walking the rows keeps
    // whichever came last, and `match()` in R keeps whichever came first.
    expect(graph.distances[0]![1]).toBeCloseTo(1 - 0.99, 10)
  })

  it('drops a neighbour that is never itself a query, and counts it', () => {
    const { graph, losses } = knnFromNeighbours(
      neighbourTable([...rows, { queryId: 'a', targetId: 'zz', score: 0.95 }]),
      { query: 'queryId', target: 'targetId', score: 'score', scoreIs: 'similarity' },
      3,
      NO_WARN,
    )
    // A target with no row of its own cannot be placed; carried in it would index past the end.
    expect(graph.labels).toEqual(['a', 'b', 'c', 'd'])
    expect(losses.unknownTargets).toBe(1)
    for (const row of graph.indices) {
      for (const index of row) expect(index).toBeLessThan(4)
    }
  })

  it('pads a short row with -1 and a finite distance', () => {
    const { graph } = knnFromNeighbours(
      neighbourTable([
        { queryId: 'a', targetId: 'b', score: 0.9 },
        { queryId: 'b', targetId: 'a', score: 0.9 },
        { queryId: 'c', targetId: 'a', score: 0.5 },
        { queryId: 'd', targetId: 'a', score: 0.5 },
      ]),
      { query: 'queryId', target: 'targetId', score: 'score', scoreIs: 'similarity' },
      3,
      NO_WARN,
    )
    const row = graph.indices[2]!
    expect(row).toHaveLength(3)
    expect(row).toContain(-1)
    // Not an infinity: `smoothKNNDistance` takes the row's *mean*, so one infinite slot makes
    // the whole row's sigma infinite and quietly destroys its neighbourhood.
    expect(graph.distances[2]!.every((d) => Number.isFinite(d))).toBe(true)
  })

  it('counts a row that ended up with nobody', () => {
    const { losses } = knnFromNeighbours(
      neighbourTable([
        { queryId: 'a', targetId: 'b', score: 0.9 },
        { queryId: 'b', targetId: 'a', score: 0.9 },
        { queryId: 'c', targetId: 'a', score: 0.5 },
        // `d` names only itself, which is not a neighbour.
        { queryId: 'd', targetId: 'd', score: 1 },
      ]),
      { query: 'queryId', target: 'targetId', score: 'score', scoreIs: 'similarity' },
      3,
      NO_WARN,
    )
    expect(losses.isolated).toBe(1)
  })

  it('treats an absent score column as "every listed pair is equally close"', () => {
    const { graph } = knnFromNeighbours(
      neighbourTable(rows),
      { query: 'queryId', target: 'targetId', score: undefined, scoreIs: 'similarity' },
      3,
      NO_WARN,
    )
    for (const row of graph.distances) {
      for (const [i, d] of row.entries()) expect(d).toBe(i === 0 ? 0 : 0)
    }
  })
})

describe('the guards', () => {
  it('refuses a matrix whose rows and columns are different populations', () => {
    const rows = ['a', 'b', 'c', 'd']
    const cols = ['w', 'x', 'y', 'z']
    const matrix = makeMatrix(rows, cols, new Float64Array(16), 's', 'similarity')
    expect(() => checkEmbedMatrix(NO_WARN, matrix)).toThrow(/different things/)
  })

  it('refuses too few observations, naming the floor', () => {
    expect(() => checkEmbedCount(NO_WARN, MIN_EMBED_OBSERVATIONS - 1)).toThrow(
      /at least 4 observations/,
    )
  })

  it('clamps Neighbours to what the data can offer, and says so', () => {
    // umap-js throws on `X.length <= nNeighbors` rather than clamping, so a set of six under
    // the default 15 would be a stack trace where the honest answer is "everybody".
    const warner = collecting()
    expect(clampNeighbours(warner, 15, 6)).toBe(5)
    expect(warner.messages.join(' ')).toMatch(/Neighbours was 15/)
    expect(clampNeighbours(NO_WARN, 3, 100)).toBe(3)
  })

  it('refuses scores that invert into negative distances', () => {
    // An un-normalised NBLAST score is above 1, so `1 - score` is negative — which umap embeds
    // perfectly happily into a picture whose wrongness is invisible.
    expect(() => checkNeighbourDistances([[0, 1.4, -0.4]], 'similarity')).toThrow(/Normalise/)
    expect(() => checkNeighbourDistances([[0, 0.2, 0.4]], 'similarity')).not.toThrow()
  })
})

describe('the output table', () => {
  it('carries the annotation column whether or not anything filled it', () => {
    // A schema that changes shape with an optional port empties every picker downstream on a
    // graph reopened without it — `partnerVectorSchema`'s rule.
    const table = embedTable(['a', 'b'], Float64Array.from([1, 2, 3, 4]))
    expect(table.schema.columns.map((c) => c.name)).toEqual(
      embedSchema().columns.map((c) => c.name),
    )
    expect(table.data[EMBED_ANNOTATION_COLUMN]).toEqual([null, null])
  })

  it('pairs each label with its own coordinates', () => {
    const table = embedTable(['a', 'b'], Float64Array.from([1, 2, 3, 4]))
    expect(table.data.label).toEqual(['a', 'b'])
    expect(table.data.umap1).toEqual([1, 3])
    expect(table.data.umap2).toEqual([2, 4])
  })

  it('leaves an unannotated row null rather than filling it with its own label', () => {
    // The opposite of what a Dendrogram leaf does, and deliberately: there the name is the
    // drawing, here it is still in its own column, so a copy would put ids in a legend
    // somebody is colouring by cell type.
    const table = embedTable(
      ['a', 'b'],
      Float64Array.from([0, 0, 0, 0]),
      new Map([['a', 'LC4']]),
    )
    expect(table.data[EMBED_ANNOTATION_COLUMN]).toEqual(['LC4', null])
    expect(countAnnotated(['a', 'b'], new Map([['a', 'LC4']]))).toBe(1)
  })
})
