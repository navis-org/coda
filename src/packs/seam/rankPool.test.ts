/**
 * The ordering step, on a hand-written forest.
 *
 * The *scoring* is checked against LightGBM's own predictions in `treeRanker.test.ts` and the
 * ranks against SEAM's published ones by `pnpm probe:candidate-search`. What is left for this
 * file is everything around the score — the direction of the sort, the cut, the numbering, the
 * gather — and the refusals, which exist because each of them otherwise produces a full list of
 * believable rows in the wrong order.
 *
 * The forest is two lines of text rather than the 1.3 MB published one: a model that returns a
 * feature's own value lets every expectation here be written as a number rather than as a
 * second reading of the fixture.
 */

import { describe, expect, it } from 'vitest'

import type { MeasuredPool } from './rankPool'
import { rankPool } from './rankPool'
import { parseTreeRanker } from './treeRanker'

/**
 * A forest that scores `x` as 0 below the threshold and 100 above it, over three features so
 * that `l2c` and `l2x` have somewhere to arrive. Only `x` is split on, so the score is readable
 * off the pool by eye.
 */
const FEATURES = ['x', 'l2c', 'l2x']
const RANKER = parseTreeRanker(
  [
    'tree',
    'version=v4',
    'num_class=1',
    'num_tree_per_iteration=1',
    'max_feature_idx=2',
    'objective=lambdarank',
    '',
    'Tree=0',
    'num_leaves=2',
    'split_feature=0',
    'threshold=10',
    'decision_type=2',
    'left_child=-1',
    'right_child=-2',
    'leaf_value=0 100',
    '',
  ].join('\n'),
  FEATURES,
)

/**
 * `l2c` and `l2x` sit in `columns` like any other feature: `searchRun.ts` joins them in, and
 * this file is deliberately unable to tell they arrived by a second crossing.
 */
const poolOf = (x: readonly number[], ids?: readonly bigint[]): MeasuredPool => ({
  rows: x.length,
  candRoot: BigUint64Array.from(ids ?? x.map((_, i) => 648518347608843326n + BigInt(i))),
  columns: {
    x: Float64Array.from(x),
    min_dist_um: Float64Array.from(x.map((v) => v / 100)),
    l2c: Float64Array.from(x, (_, i) => i + 1),
    l2x: Float64Array.from(x, (_, i) => (i + 1) / 5),
  },
})

describe('rankPool', () => {
  /**
   * The failure this whole file is for. `geo_score` is a rank key — **lower is better** — so a
   * high-scoring candidate carries a *low* key and sorts first. Reading the raw score and
   * sorting it the other way gives a list exactly reversed, which nothing downstream can see.
   */
  it('puts the best candidate first, by a key where lower is better', () => {
    const ranked = rankPool(RANKER, poolOf([1, 50, 2, 90]), 100)
    // 50 and 90 are above the split, so they score 100 and carry a key of −100.
    // Plain zeroes, not `-0`: the key is a negation, and a zero leaf would otherwise print as
    // "-0" wherever the column is shown. `toEqual` tells the two apart, so this pins both.
    expect([...ranked.columns['geo_score']!]).toEqual([-100, -100, 0, 0])
    expect([...ranked.columns['x']!]).toEqual([50, 90, 1, 2])
    expect([...ranked.columns['geo_rank']!]).toEqual([1, 2, 3, 4])
  })

  it('cuts to the set’s own top_k, keeping the best', () => {
    const ranked = rankPool(RANKER, poolOf([1, 50, 2, 90]), 2)
    expect(ranked.rows).toBe(2)
    expect([...ranked.columns['x']!]).toEqual([50, 90])
    expect([...ranked.columns['geo_rank']!]).toEqual([1, 2])
  })

  /**
   * Every column, not the ones the model reads. A gather that moved only the features would
   * leave `min_dist_um` and the contact point in the *old* order — a ranked list whose scores
   * belong to one candidate and whose contact belongs to another, which `ownTip.ts` then
   * measures against the wrong tip.
   */
  it('gathers every column into the new order, not only the scored ones', () => {
    const ranked = rankPool(RANKER, poolOf([1, 50, 2, 90]), 100)
    expect([...ranked.columns['min_dist_um']!]).toEqual([0.5, 0.9, 0.01, 0.02])
    expect([...ranked.columns['l2c']!]).toEqual([2, 4, 1, 3])
  })

  /** An 18-digit id through a float64 is a different neuron, so the ids stay 64-bit. */
  it('carries the candidate ids 64-bit, in the new order', () => {
    const ids = [864691128455770001n, 864691128455770002n, 864691128455770003n]
    const ranked = rankPool(RANKER, poolOf([1, 90, 2], ids), 100)
    expect(ranked.candRoot).toBeInstanceOf(BigUint64Array)
    expect([...ranked.candRoot]).toEqual([
      864691128455770002n,
      864691128455770001n,
      864691128455770003n,
    ])
  })

  /** SEAM's quicksort is free to order a tie either way; this one is not, so it is pinned. */
  it('breaks a tie by the pool’s own order', () => {
    const ranked = rankPool(RANKER, poolOf([50, 90, 60]), 100)
    expect([...ranked.columns['x']!]).toEqual([50, 90, 60])
  })

  it('answers an empty pool with an empty list', () => {
    const ranked = rankPool(RANKER, poolOf([]), 100)
    expect(ranked.rows).toBe(0)
    expect(ranked.columns['geo_rank']).toHaveLength(0)
  })

  /**
   * The old bridge returned a pool already sorted, cut and numbered. Ranking one of those again
   * would renumber a hundred rows the *previous* ranker chose — a believable list drawn from the
   * wrong population — so a pool carrying any minted column is refused rather than merged over.
   */
  it('refuses a pool that has been ranked already', () => {
    const pool = poolOf([1, 2])
    const already = {
      ...pool,
      columns: { ...pool.columns, geo_rank: Float64Array.from([1, 2]) },
    }
    expect(() => rankPool(RANKER, already, 100)).toThrow(/already carries/)
  })

  /**
   * Answered by `rankKeys`, not by a check here: every column this reads is a feature the model
   * names, so the model's own guard names it too. A copy in this file restated the same sentence
   * in a second place, where drift would be invisible.
   */
  it('refuses a column that does not match the pool, by the model’s own name for it', () => {
    const pool = poolOf([1, 2, 3])
    const short = { ...pool, columns: { ...pool.columns, l2c: Float64Array.from([1, 2]) } }
    expect(() => rankPool(RANKER, short, 100)).toThrow(/says 3 rows and its `l2c` column has 2/)
  })

  /**
   * The columns the model never reads are the dangerous ones: a short one is not caught by
   * `rankKeys`, and the gather would turn it into a full-length column of `NaN` that every
   * downstream length check accepts — `ownTipRule` would then place the contact at nowhere.
   */
  it('refuses a short column the model does not rank on', () => {
    const pool = poolOf([1, 2, 3])
    const short = {
      ...pool,
      columns: { ...pool.columns, contact_x_nm: Float64Array.from([1, 2]) },
    }
    expect(() => rankPool(RANKER, short, 100)).toThrow(
      /says 3 rows and its `contact_x_nm` column has 2/,
    )
  })

  it('refuses a cut that is not a positive whole number', () => {
    expect(() => rankPool(RANKER, poolOf([1]), 0)).toThrow(/positive whole number/)
    expect(() => rankPool(RANKER, poolOf([1]), 2.5)).toThrow(/positive whole number/)
  })

  it('refuses an id column that does not match the pool', () => {
    const pool = { ...poolOf([1, 2]), candRoot: BigUint64Array.from([1n]) }
    expect(() => rankPool(RANKER, pool, 100)).toThrow(/candidate ids number 1/)
  })

  /** The model's own guard, reached through this one: a pool short of a feature it ranks on. */
  it('refuses a pool with no column for a feature the model reads', () => {
    const pool: MeasuredPool = { rows: 1, candRoot: BigUint64Array.from([1n]), columns: {} }
    expect(() => rankPool(RANKER, pool, 100)).toThrow(/has no `x` column/)
  })
})
