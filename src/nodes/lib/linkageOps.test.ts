/**
 * What can be decided about a tree without Python.
 *
 * The cut is the part worth the most care here, because both of its plausible implementations
 * return something and only one of them agrees with the reference. Every claim about SciPy in
 * these tests was measured against scipy 1.15.3 rather than recalled — see the comments on the
 * cases that carry a number.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { LinkageValue } from '../../core/values'
import { getColumn, makeLinkage, makeMatrix } from '../../core/values'
import {
  LINKAGE_METHODS,
  MAX_LINKAGE_OBSERVATIONS,
  checkLinkageDistances,
  checkLinkageInput,
  clusterTable,
  cutByCount,
  cutByHeight,
  distanceLabelFor,
  linkageMaxHeight,
  linkageRequestFrom,
  orderedMatrix,
  transformFor,
  withClusters,
} from './linkageOps'

/**
 * Four observations in two obvious pairs, then the pairs joined.
 *
 *   0 ─┐            (0,1) at 0.1
 *   1 ─┴─┐
 *   2 ─┐ ├─         (2,3) at 0.2, the two pairs at 0.8
 *   3 ─┴─┘
 */
function tree(clusters?: Int32Array): LinkageValue {
  return makeLinkage(
    Float64Array.from([
      0,
      1,
      0.1,
      2, //
      2,
      3,
      0.2,
      2,
      4,
      5,
      0.8,
      4,
    ]),
    ['a', 'b', 'c', 'd'],
    Int32Array.from([0, 1, 2, 3]),
    { method: 'average', ...(clusters ? { clusters } : {}) },
  )
}

describe('checkLinkageInput', () => {
  const square = (labels: string[]) =>
    makeMatrix(labels, labels.slice(), new Float64Array(labels.length ** 2))

  it('accepts a square matrix over one population', () => {
    expect(() => checkLinkageInput(square(['a', 'b']))).not.toThrow()
  })

  it('refuses a matrix that is not square, naming NBLAST with a Target as the usual cause', () => {
    const rect = makeMatrix(['a', 'b'], ['x'], new Float64Array(2))
    expect(() => checkLinkageInput(rect)).toThrow(/square/)
  })

  it('refuses a square matrix whose rows and columns are different things', () => {
    // The check that is about meaning rather than arithmetic. NBLAST of two sets of equal size
    // is perfectly square, and clustering it would treat row 3 and column 3 as one observation
    // because they happen to share an index — a confident wrong tree with nothing to say so.
    const crossed = makeMatrix(['a', 'b'], ['x', 'y'], new Float64Array(4))
    expect(() => checkLinkageInput(crossed)).toThrow(/different things/)
  })

  it('refuses fewer than two observations, which is what fastcore itself says', () => {
    expect(() => checkLinkageInput(square(['a']))).toThrow(/at least 2/)
  })

  it('refuses more observations than a dendrogram could carry labels for', () => {
    const many = Array.from({ length: MAX_LINKAGE_OBSERVATIONS + 1 }, (_, i) => `n${i}`)
    // Not a `makeMatrix`, which would allocate 4 million cells for a message about the count.
    expect(() =>
      checkLinkageInput({
        kind: 'matrix',
        rowLabels: many,
        colLabels: many,
        values: new Float64Array(0),
      }),
    ).toThrow(/ceiling/)
  })
})

describe('the distance transform', () => {
  it('inverts a similarity and passes a distance through', () => {
    expect(transformFor('similarity', 'auto')).toBe('one_minus')
    expect(transformFor('distance', 'auto')).toBe('none')
  })

  it('treats a matrix that says nothing as similarities', () => {
    // Pivot cannot answer — its cells are whatever aggregation was picked — and the wrong
    // guess here is visible rather than subtle: a tree built on similarities merges the least
    // alike first, so it comes out inverted.
    expect(transformFor(undefined, 'auto')).toBe('one_minus')
  })

  it('is overridable in both directions', () => {
    expect(transformFor('distance', 'one_minus')).toBe('one_minus')
    expect(transformFor('similarity', 'none')).toBe('none')
  })

  it('says what a height means, so the axis is not a bare number', () => {
    const scores = makeMatrix(
      ['a'],
      ['a'],
      Float64Array.from([1]),
      'NBLAST score',
      'similarity',
    )
    expect(distanceLabelFor(scores, 'one_minus')).toBe('1 − NBLAST score')
    expect(distanceLabelFor(scores, 'none')).toBe('NBLAST score')
  })
})

describe('the request', () => {
  it('copies the matrix rather than handing over the upstream buffer', () => {
    // `callPython` *transfers* every typed array in a call's arguments. The scores here are
    // the upstream node's cached result, so transferring would detach it: the Heatmap beside
    // this node redraws empty and the cache holds a zero-length array, with nothing connecting
    // either to the node that ran.
    const matrix = makeMatrix(['a', 'b'], ['a', 'b'], Float64Array.from([1, 0.5, 0.5, 1]))
    const request = linkageRequestFrom(matrix, {
      method: 'ward',
      symmetry: 'mean',
      transform: 'one_minus',
    })
    expect(request.scores).not.toBe(matrix.values)
    expect(Array.from(request.scores)).toEqual([1, 0.5, 0.5, 1])
    expect(request.n).toBe(2)
  })
})

describe('the ordered matrix', () => {
  it('permutes rows and columns together, which is what makes the blocks square', () => {
    const matrix = makeMatrix(
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
      Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    )
    const out = orderedMatrix(matrix, Int32Array.from([2, 0, 1]))
    expect(out.rowLabels).toEqual(['c', 'a', 'b'])
    expect(out.colLabels).toEqual(['c', 'a', 'b'])
    // Row c, column c is the old (2,2) = 9; row c, column a is the old (2,0) = 7.
    expect(Array.from(out.values)).toEqual([9, 7, 8, 3, 1, 2, 6, 4, 5])
  })

  it('keeps what the cells mean, so the Heatmap still labels its colour bar', () => {
    const matrix = makeMatrix(
      ['a', 'b'],
      ['a', 'b'],
      new Float64Array(4),
      'NBLAST score',
      'similarity',
    )
    const out = orderedMatrix(matrix, Int32Array.from([1, 0]))
    expect(out.valueLabel).toBe('NBLAST score')
    expect(out.measure).toBe('similarity')
  })
})

describe('cutting by count', () => {
  it('returns exactly the number asked for', () => {
    expect(new Set(cutByCount(tree(), 2)).size).toBe(2)
    expect(new Set(cutByCount(tree(), 3)).size).toBe(3)
    expect(new Set(cutByCount(tree(), 4)).size).toBe(4)
  })

  it('puts the two obvious pairs together at k = 2', () => {
    expect(Array.from(cutByCount(tree(), 2))).toEqual([1, 1, 2, 2])
  })

  it('numbers clusters left to right as the dendrogram draws them', () => {
    // A divergence from SciPy and a deliberate one: its two cut functions do not agree with
    // each other on numbering, so there was never a convention to match — only a partition,
    // which does. Numbering by position is what makes the column read against the picture.
    const reversed = makeLinkage(
      tree().merges,
      ['a', 'b', 'c', 'd'],
      Int32Array.from([2, 3, 0, 1]),
    )
    // c and d are leftmost now, so they are cluster 1.
    expect(Array.from(cutByCount(reversed, 2))).toEqual([2, 2, 1, 1])
  })

  it('cannot be cut further than one cluster per leaf', () => {
    expect(new Set(cutByCount(tree(), 99)).size).toBe(4)
    expect(new Set(cutByCount(tree(), 0)).size).toBe(1)
  })
})

describe('cutting by height', () => {
  it('keeps every merge at or below the height', () => {
    // Below the first merge: nothing joined.
    expect(new Set(cutByHeight(tree(), 0.05)).size).toBe(4)
    // At 0.1 exactly, the first pair is in — "at or below", not "below".
    expect(Array.from(cutByHeight(tree(), 0.1))).toEqual([1, 1, 2, 3])
    expect(Array.from(cutByHeight(tree(), 0.2))).toEqual([1, 1, 2, 2])
    expect(new Set(cutByHeight(tree(), 0.8)).size).toBe(1)
  })

  it('answers one cluster above the top of the tree rather than failing', () => {
    expect(linkageMaxHeight(tree())).toBeCloseTo(0.8)
    expect(new Set(cutByHeight(tree(), 5)).size).toBe(1)
  })
})

describe('the cluster table', () => {
  it('carries the label, the group, the drawing position and the group size', () => {
    const clusters = cutByCount(tree(), 2)
    const table = clusterTable(tree(), clusters)
    expect(getColumn(table, 'label')).toEqual(['a', 'b', 'c', 'd'])
    expect(getColumn(table, 'cluster')).toEqual([1, 1, 2, 2])
    expect(getColumn(table, 'order')).toEqual([0, 1, 2, 3])
    expect(getColumn(table, 'size')).toEqual([2, 2, 2, 2])
  })

  it('reports the position in the drawing, not the row number', () => {
    const shuffled = makeLinkage(
      tree().merges,
      ['a', 'b', 'c', 'd'],
      Int32Array.from([3, 2, 1, 0]),
    )
    expect(getColumn(clusterTable(shuffled, cutByCount(shuffled, 4)), 'order')).toEqual([
      3, 2, 1, 0,
    ])
  })

  it('agrees with the schema it declares', () => {
    const table = clusterTable(tree(), cutByCount(tree(), 2))
    expect(table.schema.columns.map((c) => c.name)).toEqual(
      tableSchema(
        column('label', 'str'),
        column('cluster', 'i64'),
        column('order', 'i64'),
        column('size', 'i64'),
      ).columns.map((c) => c.name),
    )
  })
})

describe('carrying a cut on the tree', () => {
  it('records the clusters without disturbing the tree', () => {
    const cut = withClusters(tree(), cutByCount(tree(), 2))
    expect(Array.from(cut.clusters!)).toEqual([1, 1, 2, 2])
    expect(Array.from(cut.merges)).toEqual(Array.from(tree().merges))
    expect(Array.from(cut.order)).toEqual([0, 1, 2, 3])
    expect(cut.method).toBe('average')
  })

  it('refuses a cut of the wrong length, which would silently mislabel every branch', () => {
    expect(() => withClusters(tree(), Int32Array.from([1, 2]))).toThrow(/cluster assignments/)
  })
})

describe('the methods offered', () => {
  it('leaves out the two that produce non-monotonic trees', () => {
    // Measured against scipy on random NBLAST-shaped matrices, 25 observations, 40 trials:
    // centroid inverted in 39 of 40 and median in 40 of 40, where these five inverted in none.
    // An inverted tree cannot be drawn honestly, and it is what makes the prefix cut above
    // agree with `cut_tree` — 300 comparisons across these five, 45 disagreements across those.
    const values = LINKAGE_METHODS.map((m) => m.value)
    expect(values).not.toContain('centroid')
    expect(values).not.toContain('median')
    expect(values).toEqual(['ward', 'average', 'complete', 'single', 'weighted'])
  })
})

describe('checkLinkageDistances', () => {
  const cells = (values: number[], measure?: 'similarity' | 'distance' | 'count') => {
    const n = Math.sqrt(values.length)
    const labels = Array.from({ length: n }, (_, i) => `n${i}`)
    return makeMatrix(labels, labels.slice(), Float64Array.from(values), undefined, measure)
  }

  it('accepts similarities in the usual range', () => {
    expect(() => checkLinkageDistances(cells([1, 0.5, 0.5, 1]), 'one_minus')).not.toThrow()
  })

  it('refuses a matrix of counts, and names the Normalize that fixes it', () => {
    // The bug this exists for, found in a browser and invisible everywhere else: an Adjacency
    // matrix carries raw synapse counts, so `1 - 77` is `-76`. fastcore clusters that without
    // complaint and the tree's brackets project thousands of pixels off the card — nothing
    // throws, nothing logs, and every count in the caption is right.
    const counts = cells([0, 77, 12, 0])
    expect(() => checkLinkageDistances(counts, 'one_minus')).toThrow(/Normalize/)
    expect(() => checkLinkageDistances(counts, 'one_minus')).toThrow(/-76/)
  })

  it('points at the NBLAST node when the scores were not normalised there', () => {
    expect(() => checkLinkageDistances(cells([1, 4.2, 3.1, 1]), 'one_minus')).toThrow(/NBLAST/)
  })

  it('refuses negative cells offered as distances, without mentioning similarities', () => {
    const negative = cells([0, -1, -1, 0], 'distance')
    expect(() => checkLinkageDistances(negative, 'none')).toThrow(/cannot be negative/)
    expect(() => checkLinkageDistances(negative, 'none')).not.toThrow(/Normalize/)
  })

  it('accepts a distance matrix that is already one', () => {
    expect(() =>
      checkLinkageDistances(cells([0, 0.4, 0.4, 0], 'distance'), 'none'),
    ).not.toThrow()
  })

  it('ignores non-finite cells rather than reading them as the extreme', () => {
    const withNan = cells([1, Number.NaN, 0.5, 1])
    expect(() => checkLinkageDistances(withNan, 'one_minus')).not.toThrow()
  })

  it('refuses a matrix with nothing usable in it at all', () => {
    expect(() =>
      checkLinkageDistances(
        cells([Number.NaN, Number.NaN, Number.NaN, Number.NaN]),
        'one_minus',
      ),
    ).toThrow(/no usable values/)
  })
})
