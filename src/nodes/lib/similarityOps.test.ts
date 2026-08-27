/**
 * The sparse similarity pass.
 *
 * **The metric values are scipy's, not hand-arithmetic.** Every number below came out of
 * `scipy.spatial.distance.pdist` on the *dense* form of the same three vectors, which is the
 * one comparison worth making: the whole claim of this module is that never building that
 * dense form gives the same answer, and a reference computed by the same reasoning as the code
 * would agree with a shared mistake. `scripts/probe-py-helpers.py` makes the same comparison
 * from the other end, on the generated notebook helper.
 *
 * The three vectors are deliberately *not* parallel and not disjoint — two share a feature, two
 * share nothing, and one carries a feature nobody else has — so a metric that ignored the
 * weights and one that ignored the supports give visibly different answers.
 */

import { describe, expect, it } from 'vitest'

import { SILENT } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import {
  SIMILARITY_METRIC_OPTIONS,
  effectiveOutput,
  featuresFromLong,
  featuresFromWide,
  pairWork,
  similarityMatrix,
  similarityValueLabel,
} from './similarityOps'
import type { SimilarityMetric } from './similarityOps'

/**
 * a = [1, 2, 0, 0], b = [0, 3, 1, 0], c = [1, 0, 0, 4], over four features.
 *
 * `a`'s f2 arrives as two rows, which is the merge this module does instead of a Group By.
 */
const LONG = longTable([
  ['a', 'f1', 1],
  ['a', 'f2', 1.5],
  ['a', 'f2', 0.5],
  ['b', 'f2', 3],
  ['b', 'f3', 1],
  ['c', 'f1', 1],
  ['c', 'f4', 4],
])

const WIDE = makeTable(
  tableSchema(
    column('id', 'str'),
    column('f1', 'f64'),
    column('f2', 'f64'),
    column('f3', 'f64'),
    column('f4', 'f64'),
  ),
  {
    id: ['a', 'b', 'c'],
    f1: [1, 0, 1],
    f2: [2, 3, 0],
    f3: [0, 1, 0],
    f4: [0, 0, 4],
  },
)

function longTable(rows: ReadonlyArray<[string, string, number]>): TableValue {
  return makeTable(
    tableSchema(column('obs', 'str'), column('feat', 'str'), column('w', 'f64')),
    {
      obs: rows.map((r) => r[0]),
      feat: rows.map((r) => r[1]),
      w: rows.map((r) => r[2]),
    },
  )
}

function pairs(
  table: TableValue,
  metric: SimilarityMetric,
  options: { output?: 'similarity' | 'distance'; ctx?: Warner } = {},
) {
  const features = featuresFromLong(table, 'obs', 'feat', 'w')
  const matrix = similarityMatrix(
    features,
    metric,
    options.output ?? 'similarity',
    options.ctx ?? SILENT,
  )
  const at = (x: string, y: string) =>
    matrix.values[matrix.rowLabels.indexOf(x) * matrix.rowLabels.length + matrix.colLabels.indexOf(y)]!
  return { matrix, ab: at('a', 'b'), ac: at('a', 'c'), bc: at('b', 'c'), aa: at('a', 'a') }
}

describe('the metrics, against scipy on the dense form', () => {
  it('cosine', () => {
    const { ab, ac, bc } = pairs(LONG, 'cosine')
    expect(ab).toBeCloseTo(0.8485281374238569, 12)
    expect(ac).toBeCloseTo(0.10846522890932808, 12)
    expect(bc).toBe(0)
  })

  it('euclidean', () => {
    const { ab, ac, bc } = pairs(LONG, 'euclidean')
    expect(ab).toBeCloseTo(1.7320508075688772, 12)
    expect(ac).toBeCloseTo(4.47213595499958, 12)
    expect(bc).toBeCloseTo(5.196152422706632, 12)
  })

  /*
   * scipy calls this `correlation`, and it centres over the **ambient** feature space — every
   * feature, including the ones a vector does not have. Centring over the present ones instead
   * would make two neurons with one partner each perfectly correlated, and would agree with
   * scipy on nothing here.
   */
  it('pearson', () => {
    const { ab, ac, bc } = pairs(LONG, 'pearson')
    expect(ab).toBeCloseTo(0.7385489458759965, 12)
    expect(ac).toBeCloseTo(-0.5057805388588732, 12)
    expect(bc).toBeCloseTo(-0.6225728063646905, 12)
  })

  it('jaccard, on the supports rather than the weights', () => {
    const { ab, ac, bc } = pairs(LONG, 'jaccard')
    // a and b share f2 out of {f1,f2,f3}; a and c share f1 out of {f1,f2,f4}. Same index,
    // entirely different weights — which is the difference from cosine above.
    expect(ab).toBeCloseTo(1 / 3, 12)
    expect(ac).toBeCloseTo(1 / 3, 12)
    expect(bc).toBe(0)
  })

  it('weighted jaccard, which has no scipy equivalent', () => {
    const { ab, ac, bc } = pairs(LONG, 'jaccardWeighted')
    // Σ min over Σ max, written out: min(a,b) = [0,2,0,0] and max = [1,3,1,0].
    expect(ab).toBeCloseTo(0.4, 12)
    expect(ac).toBeCloseTo(1 / 7, 12)
    expect(bc).toBe(0)
  })
})

describe('what comes out', () => {
  it('is square over one population, with the observations sorted', () => {
    const { matrix } = pairs(LONG, 'cosine')
    expect(matrix.rowLabels).toEqual(['a', 'b', 'c'])
    expect(matrix.colLabels).toEqual(matrix.rowLabels)
  })

  it('is symmetric', () => {
    const { matrix } = pairs(LONG, 'jaccardWeighted')
    const n = matrix.rowLabels.length
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        expect(matrix.values[r * n + c]).toBeCloseTo(matrix.values[c * n + r]!, 15)
      }
    }
  })

  /*
   * `measure` is what makes `Similarity Matrix → Linkage` need nothing configured: Linkage
   * inverts a similarity and leaves a distance alone by reading exactly this field. A blank one
   * is treated as a similarity there, which for Euclidean would be a tree built on 1 − distance.
   */
  it('says whether the cells are similarities or distances', () => {
    expect(pairs(LONG, 'cosine').matrix.measure).toBe('similarity')
    expect(pairs(LONG, 'cosine', { output: 'distance' }).matrix.measure).toBe('distance')
    expect(pairs(LONG, 'euclidean').matrix.measure).toBe('distance')
  })

  it('carries a label naming the metric, for the legend and the dendrogram axis', () => {
    expect(pairs(LONG, 'cosine').matrix.valueLabel).toBe('cosine similarity')
    expect(pairs(LONG, 'cosine', { output: 'distance' }).matrix.valueLabel).toBe('1 − cosine')
    expect(pairs(LONG, 'euclidean').matrix.valueLabel).toBe('Euclidean distance')
  })

  it('has a diagonal of 1, or 0 as a distance', () => {
    expect(pairs(LONG, 'cosine').aa).toBe(1)
    expect(pairs(LONG, 'cosine', { output: 'distance' }).aa).toBe(0)
    expect(pairs(LONG, 'euclidean').aa).toBe(0)
  })

  it('inverts to a distance without touching Euclidean, which has no other form', () => {
    const sim = pairs(LONG, 'cosine')
    const dist = pairs(LONG, 'cosine', { output: 'distance' })
    expect(dist.ab).toBeCloseTo(1 - sim.ab, 12)
    // The param is hidden for Euclidean and therefore out of the provenance key, so `evaluate`
    // has to reach this answer without reading it.
    expect(effectiveOutput('euclidean', 'similarity')).toBe('distance')
    expect(pairs(LONG, 'euclidean', { output: 'similarity' }).ab).toBeCloseTo(
      1.7320508075688772,
      12,
    )
  })

  it('names every metric it offers', () => {
    for (const option of SIMILARITY_METRIC_OPTIONS) {
      expect(similarityValueLabel(option.value, 'similarity')).toBeTruthy()
      expect(() => pairs(LONG, option.value)).not.toThrow()
    }
  })
})

describe('the sparse half', () => {
  /*
   * The coalescing is not tidying. An ungrouped connectivity table has one row per *connection*,
   * so a neuron with four synapses onto four cells of one type arrives as four rows — left
   * alone, the presence Jaccard would count that type four times toward |A|.
   */
  it('sums a repeated pair, and says so', () => {
    const said: string[] = []
    const { ab } = pairs(LONG, 'cosine', { ctx: { warn: (m) => said.push(m) } })
    // a's f2 arrived as 1.5 + 0.5. Summed, `a` is [1,2,0,0] and matches the scipy reference.
    expect(ab).toBeCloseTo(0.8485281374238569, 12)
    expect(said.join(' ')).toMatch(/repeated an observation\/feature pair/)
  })

  /*
   * **Presence has to be applied after the merge**, not by handing in a column of ones. Found by
   * running the generated Python helper: the same repeat above made `a` a 2 where `b` was a 1,
   * so cosine answered 0.949 for two observations whose supports are identical.
   */
  it('reads presence as presence, however many rows list a pair', () => {
    const presence = similarityMatrix(
      featuresFromLong(LONG, 'obs', 'feat', undefined),
      'cosine',
      'similarity',
      SILENT,
    )
    const at = (x: string, y: string) =>
      presence.values[presence.rowLabels.indexOf(x) * 3 + presence.colLabels.indexOf(y)]!
    const [ab, ac, bc] = [at('a', 'b'), at('a', 'c'), at('b', 'c')]
    // Supports only: a is {f1,f2}, b is {f2,f3}, c is {f1,f4}. One shared feature out of two
    // each way, so 1/(√2·√2) — and `a`'s repeated f2 is a 1 rather than a 2.
    expect(ab).toBeCloseTo(0.5, 12)
    expect(ac).toBeCloseTo(0.5, 12)
    expect(bc).toBe(0)
  })

  it('drops a zero, an empty and a non-number rather than storing them', () => {
    const table = longTable([
      ['a', 'f1', 1],
      ['a', 'f2', 0],
      ['b', 'f1', Number.NaN],
      ['b', 'f2', 2],
    ])
    const features = featuresFromLong(table, 'obs', 'feat', 'w')
    expect(features.rowNnz[0]).toBe(1)
    expect(features.rowNnz[1]).toBe(1)
    // Which leaves nothing shared: `a` is only f1 and `b` only f2.
    expect(similarityMatrix(features, 'cosine', 'similarity', SILENT).values[1]).toBe(0)
  })

  it('reaches the same answer from the wide layout', () => {
    const wide = similarityMatrix(
      featuresFromWide(WIDE, 'id', ['f1', 'f2', 'f3', 'f4']),
      'cosine',
      'similarity',
      SILENT,
    )
    const long = pairs(LONG, 'cosine').matrix
    expect(wide.rowLabels).toEqual(long.rowLabels)
    wide.values.forEach((v, i) => expect(v).toBeCloseTo(long.values[i]!, 12))
  })

  /*
   * The work estimate is what the warning is built on, and it is exact rather than a guess from
   * `n`: it is the *feature* distribution that decides. Here f1 and f2 have two entries each
   * (three pairs each, counting the self-pair) and f3 and f4 one (one each).
   */
  it('counts the pair contributions before the matrix is allocated', () => {
    // f1 and f2 are carried by two observations each, so one pair apiece; f3 and f4 by one
    // each, which is no pair at all — a private feature costs nothing and is counted as
    // nothing, which is most of the columns on connectivity keyed by partner id.
    expect(pairWork(featuresFromLong(LONG, 'obs', 'feat', 'w'))).toBe(1 + 1 + 0 + 0)
  })
})

describe('what it refuses and what it merely says', () => {
  it('refuses a Jaccard over negative values, which it is not defined on', () => {
    const table = longTable([
      ['a', 'f1', -1],
      ['b', 'f1', 2],
    ])
    const features = featuresFromLong(table, 'obs', 'feat', 'w')
    expect(() => similarityMatrix(features, 'jaccardWeighted', 'similarity', SILENT)).toThrow(
      /not defined over negative values/,
    )
    // Cosine, Euclidean and Pearson all take them.
    expect(() =>
      similarityMatrix(features, 'cosine', 'similarity', SILENT),
    ).not.toThrow()
  })

  /*
   * An observation with nothing in it divides 0 by 0. The diagonal is written rather than
   * computed so it cannot come out as a non-zero distance to itself — which is not a distance,
   * and which fastcore clusters without complaining.
   */
  it('says how many observations have no features, and still keeps the diagonal honest', () => {
    const table = longTable([
      ['a', 'f1', 1],
      ['b', 'f1', 2],
      ['empty', 'f1', 0],
    ])
    const said: string[] = []
    const features = featuresFromLong(table, 'obs', 'feat', 'w')
    const matrix = similarityMatrix(features, 'cosine', 'distance', { warn: (m) => said.push(m) })
    const n = matrix.rowLabels.length
    expect(matrix.rowLabels).toContain('empty')
    expect(matrix.values[matrix.rowLabels.indexOf('empty') * (n + 1)]).toBe(0)
    expect(said.join(' ')).toMatch(/have no features at all/)
  })

  it('refuses a matrix past the crash floor rather than warning about it', () => {
    // 9,000 observations is 648 MB of float64 in one allocation, which is past the floor.
    const labels = Array.from({ length: 9000 }, (_, i) => `n${i}`)
    const table = longTable(labels.map((l) => [l, 'f1', 1] as [string, string, number]))
    const features = featuresFromLong(table, 'obs', 'feat', 'w')
    expect(() => similarityMatrix(features, 'cosine', 'similarity', SILENT)).toThrow(
      /one limit Coda still refuses/,
    )
  })
})
