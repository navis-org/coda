/**
 * What can be decided about a tree without Python.
 *
 * The cut is the part worth the most care here, because both of its plausible implementations
 * return something and only one of them agrees with the reference. Every claim about SciPy in
 * these tests was measured against scipy 1.15.3 rather than recalled — see the comments on the
 * cases that carry a number.
 */

import { describe, expect, it } from 'vitest'

import { qualifiedDataset } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import type { LinkageValue } from '../../core/values'
import { getColumn, makeLinkage, makeMatrix } from '../../core/values'
import {
  cutHomogeneous,
  LINKAGE_METHODS,
  LINKAGE_OBSERVATIONS_WARN,
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

/** For the checks that are not about size; the size ones collect what was said. */
const NO_WARN = { warn: () => undefined }

describe('checkLinkageInput', () => {
  const square = (labels: string[]) =>
    makeMatrix(labels, labels.slice(), new Float64Array(labels.length ** 2))

  it('accepts a square matrix over one population', () => {
    expect(() => checkLinkageInput(NO_WARN, square(['a', 'b']))).not.toThrow()
  })

  it('refuses a matrix that is not square, naming NBLAST with a Target as the usual cause', () => {
    const rect = makeMatrix(['a', 'b'], ['x'], new Float64Array(2))
    expect(() => checkLinkageInput(NO_WARN, rect)).toThrow(/square/)
  })

  it('refuses a square matrix whose rows and columns are different things', () => {
    // The check that is about meaning rather than arithmetic. NBLAST of two sets of equal size
    // is perfectly square, and clustering it would treat row 3 and column 3 as one observation
    // because they happen to share an index — a confident wrong tree with nothing to say so.
    const crossed = makeMatrix(['a', 'b'], ['x', 'y'], new Float64Array(4))
    expect(() => checkLinkageInput(NO_WARN, crossed)).toThrow(/different things/)
  })

  it('refuses fewer than two observations, which is what fastcore itself says', () => {
    expect(() => checkLinkageInput(NO_WARN, square(['a']))).toThrow(/at least 2/)
  })

  it('warns above the threshold about the cost, and clusters them anyway', () => {
    const many = Array.from({ length: LINKAGE_OBSERVATIONS_WARN + 1 }, (_, i) => `n${i}`)
    // Not a `makeMatrix`, which would allocate 25 million cells for a message about the count.
    const shape = {
      kind: 'matrix' as const,
      rowLabels: many,
      colLabels: many,
      values: new Float64Array(0),
    }
    const said: string[] = []
    checkLinkageInput({ warn: (m: string) => said.push(m) }, shape)
    /*
     * The cost this warning is about is **time**, and only time: linkage is single-threaded and
     * quadratic. It deliberately says nothing about labels any more — a tree is not a dendrogram
     * (Cut Tree takes the same linkage and hands back a table, which is readable at any size),
     * and the drawing warns about its own leaves through `MAX_LEAVES_DRAWN`.
     */
    expect(said.join(' ')).toMatch(new RegExp(`${LINKAGE_OBSERVATIONS_WARN.toLocaleString()}`))
    expect(said.join(' ')).toMatch(/square of that number/)
    expect(said.join(' ')).not.toMatch(/labels/)
    // A guard rail warns; it does not refuse. See `docs/limits.md`.
    expect(said.join(' ')).toMatch(/Going ahead anyway/)
  })

  it('refuses only the size whose condensed vector cannot be allocated', () => {
    // `MAX_LINKAGE_OBSERVATIONS` is derived from the floor rather than rounded to a readable
    // number, so this `+ 1` really is the first refused size — the rounded 11,000 it replaced
    // was 586 short of where `refuseIfOverCrashFloor` actually fires.
    const many = Array.from({ length: MAX_LINKAGE_OBSERVATIONS + 1 }, (_, i) => `n${i}`)
    expect(() =>
      checkLinkageInput(NO_WARN, {
        kind: 'matrix',
        rowLabels: many,
        colLabels: many,
        values: new Float64Array(0),
      }),
    ).toThrow(/would allocate/)
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

describe('cutting so every group draws from both datasets', () => {
  /**
   * A tree over six neurons, three per dataset, built by hand so the merge order is the fact
   * under test rather than an artefact of a distance metric.
   *
   * Merges: (a1,b1) then (a2,b2) — two mixed pairs — then (a3,a4), a pair from one dataset
   * only, then the three groups joined. A count cut of 3 returns exactly those three groups
   * including the lopsided one; this mode has to split it.
   */
  const mixed = (): LinkageValue =>
    makeLinkage(
      new Float64Array([
        0,
        3,
        0.1,
        2, // a1 + b1
        1,
        4,
        0.2,
        2, // a2 + b2
        2,
        5,
        0.3,
        2, // a3 + a4  ← both from A
        6,
        7,
        0.8,
        4,
        9,
        8,
        0.9,
        6,
      ]),
      ['A:1', 'A:2', 'A:3', 'B:1', 'B:2', 'A:4'],
      new Int32Array([0, 3, 1, 4, 2, 5]),
    )

  // `qualifiedDataset`, which is what the node passes — and it answers *undefined* for an
  // unqualified id, so the "nothing was qualified" case below is the real one rather than a
  // helper that happens to split on a colon that is not there.
  const dataset = qualifiedDataset

  it('splits a group that is all one dataset, where a count cut would keep it', () => {
    const { clusters, singletons } = cutHomogeneous(mixed(), dataset, 0.8)
    const groupOf = (i: number) => clusters[i]!
    // The two mixed pairs survive whole.
    expect(groupOf(0)).toBe(groupOf(3))
    expect(groupOf(1)).toBe(groupOf(4))
    // A:3 and A:4 were joined by the tree and are separated here, because together they are
    // 100% one dataset — the group a count cut hands back and calls a correspondence.
    expect(groupOf(2)).not.toBe(groupOf(5))
    expect(singletons).toBe(2)
  })

  it('reports how many datasets it actually saw, so an unqualified tree is knowable', () => {
    const plain = makeLinkage(
      new Float64Array([0, 1, 0.1, 2]),
      ['1', '2'],
      new Int32Array([0, 1]),
    )
    // No qualified ids: one dataset, and every neuron ends up alone rather than silently in
    // one group. The count is what lets the node say so.
    const { datasets, clusters } = cutHomogeneous(plain, dataset, 0.8)
    expect(datasets).toBe(1)
    expect(new Set(clusters).size).toBe(2)
  })

  it('lets a lopsided group through once the share allows it', () => {
    // Both datasets present and the largest holds 2/3 — kept at 0.8, split at 0.6.
    const skewed = makeLinkage(
      new Float64Array([0, 1, 0.1, 2, 3, 2, 0.5, 3]),
      ['A:1', 'A:2', 'B:1'],
      new Int32Array([0, 1, 2]),
    )
    expect(new Set(cutHomogeneous(skewed, dataset, 0.8).clusters).size).toBe(1)
    expect(new Set(cutHomogeneous(skewed, dataset, 0.6).clusters).size).toBeGreaterThan(1)
  })

  it('numbers groups in leaf order, whichever mode produced them', () => {
    // `assign`'s convention, so the cluster column reads against the dendrogram either way.
    const { clusters } = cutHomogeneous(mixed(), dataset, 0.8)
    const order = mixed().order
    const seen: number[] = []
    for (const leaf of order) if (!seen.includes(clusters[leaf]!)) seen.push(clusters[leaf]!)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})
