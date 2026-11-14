/**
 * The forest scorer, against **LightGBM's own predictions**.
 *
 * `__fixtures__/treeRanker.json` was made by loading SEAM's published `ranker/model.txt` in
 * LightGBM 4.7.0 and asking it for `raw_score` on 991 vectors
 * (`scratchpad/make_golden.py`, regenerable). The rows are not random cover: they are drawn to
 * hit what a hand-written traversal gets wrong — every feature's observed minimum and maximum,
 * values outside every range the model ever saw, zero, LightGBM's 1e-35 stand-in for zero,
 * missing values both alone and all at once, and **every row sitting exactly on a split
 * threshold, with its neighbour one float step above**.
 *
 * Those last ones were missing from the first version, which said it had them. Changing `<=` to
 * `<` in the traversal then passed all ten tests: 191 trees average a wrong boundary into a
 * plausible number, and no sampled row ever landed on one. The mutation check below is what
 * found that, and it is why these tests are written against the library instead of a
 * re-derivation.
 *
 * **Checking against the library rather than against a re-derivation is the point.** Every
 * mistake available here — `<` for `<=`, reading `decision_type` as an enum, taking a negative
 * child as an index — produces a number, and a forest of 191 trees averages the damage into
 * something that still ranks plausibly. Only the library's own answer can tell them apart.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import golden from './__fixtures__/treeRanker.json'
import manifest from './__fixtures__/fixture.json'
import type { FeatureRow } from './treeRanker'
import {
  parseTreeRanker,
  rankKey,
  rankKeys,
  resetTreeRankerCache,
  scoreRow,
  treeRankerFor,
} from './treeRanker'

const MODEL = readFileSync(new URL('./__fixtures__/rankerModel.txt', import.meta.url), 'utf8')
/**
 * The columns, **read from the set rather than copied**.
 *
 * `max_feature_idx` only checks the count, so a set that *reordered* its features — which is
 * close to what happened on 2026-11-11, when three were appended — would leave a hand-written
 * list silently scoring the wrong column, and the golden would still pass because its rows were
 * ordered by the same hand.
 */
const FEATURES: readonly string[] = manifest.pipeline.search.ranker.features
const RANKER = parseTreeRanker(MODEL, FEATURES)

/**
 * The golden's rows, with its JSON `null` read as the `undefined` a Coda column hands over.
 *
 * **Not a convenience.** Casting `null` through as a number instead sends every missing value in
 * the sweep down `null <= threshold`, which coerces to `0 <= threshold` — a third path that is
 * neither what LightGBM does nor what this module does, and the one that hid the missing-value
 * bug recorded in `treeRanker.ts`. Mapping here is what puts the 12 null-carrying rows through
 * the branch the file is about.
 */
const ROWS: readonly FeatureRow[] = golden.rows.map((row) => row.map((one) => one ?? undefined))

describe('the model as published', () => {
  it('holds the trees and features LightGBM reports', () => {
    expect(RANKER.trees).toHaveLength(golden.trees)
    expect(RANKER.features).toHaveLength(golden.features)
  })

  /**
   * **The model, the golden and the manifest are one set or they are nothing.**
   *
   * `rankerModel.txt` and `treeRanker.json` are self-consistent with each other, so a recut that
   * moved the parquets and the manifest while leaving the model behind would pass every other
   * test in this file and be wrong only once the search is wired — as ranks, which is the
   * failure this pack keeps finding. The maker stamps the set it read the model from; this is
   * where that stamp is spent.
   */
  it('was made from the set the fixture directory holds', () => {
    expect(golden.set_version).toBe(manifest.version)
  })

  it('refuses a model whose feature count is not the set’s', () => {
    expect(() => parseTreeRanker(MODEL, FEATURES.slice(1))).toThrow(/10 features/)
  })

  /*
   * A binary or regression model's raw sum goes through a link before it means anything, so
   * summing leaves would answer a plausible number that is not the model's.
   */
  it('refuses an objective whose score is not the raw sum', () => {
    expect(() =>
      parseTreeRanker(
        MODEL.replace('objective=lambdarank', 'objective=binary sigmoid:1'),
        FEATURES,
      ),
    ).toThrow(/objective/)
  })
})

describe('against LightGBM’s own predictions', () => {
  it('reproduces every one of the scored rows', () => {
    let worst = 0
    let where = -1
    for (const [at, row] of ROWS.entries()) {
      const got = scoreRow(RANKER, row)
      const difference = Math.abs(got - golden.score[at]!)
      if (difference > worst) {
        worst = difference
        where = at
      }
    }
    expect(worst, `worst at row ${where}`).toBeLessThan(1e-9)
  })

  /**
   * The missing-value rows on their own, because they are the ones `decision_type` decides and
   * the ones a reader is likeliest to get right by accident on the rest.
   */
  it('reproduces the rows that carry a missing value', () => {
    let seen = 0
    for (const [at, row] of ROWS.entries()) {
      if (!row.includes(undefined)) continue
      seen += 1
      expect(scoreRow(RANKER, row)).toBeCloseTo(golden.score[at]!, 9)
    }
    expect(seen).toBeGreaterThan(10)
  })

  /**
   * **An absent value is zero for this model, not a default direction** — and asserting it
   * against LightGBM rather than against `NaN` is the whole point.
   *
   * `decision_type = 2` means `missing_type = None`, under which LightGBM turns a `NaN` into 0
   * and never reads the default-left flag. A first draft here scored missing values by that flag
   * and still passed, because the golden's JSON `null` coerces to 0 in a `<=` comparison — so
   * the code was wrong and the only row that could have said so was taking a third path. The
   * proof is below: LightGBM scores an all-missing row exactly as it scores an all-zero one.
   */
  it('scores an absent value as LightGBM does — as zero, not by the default branch', () => {
    const allMissing = golden.rows.findIndex((one) => one.every((v) => v === null))
    const allZero = golden.rows.findIndex((one) => one.every((v) => v === 0))
    expect(allMissing).toBeGreaterThanOrEqual(0)
    expect(allZero).toBeGreaterThanOrEqual(0)
    expect(golden.score[allMissing]).toBeCloseTo(golden.score[allZero]!, 9)

    const missing = new Array<number | undefined>(golden.features).fill(undefined)
    const zero = new Array<number>(golden.features).fill(0)
    expect(scoreRow(RANKER, missing)).toBeCloseTo(golden.score[allMissing]!, 9)
    expect(scoreRow(RANKER, missing)).toBe(scoreRow(RANKER, zero))
  })

  /**
   * A value exactly on a split goes left, and one float step above it does not.
   *
   * **Compared within each pair**, which the first version did not: it walked the last 200 rows
   * and compared each with its predecessor, so most comparisons straddled *different* pairs. The
   * guard read 117 where only a dozen of the real pairs differ, and could not have failed.
   *
   * The pairs are found rather than sliced, because they are not at the tail — fourteen rows
   * follow them — and a second draft that assumed they were found none at all and failed loudly,
   * which is the better way round. A pair is two adjacent rows differing in exactly one feature,
   * which is how the maker builds them (`(on the threshold, one float step above)`).
   */
  it('puts a value sitting on a threshold on the low side of the split', () => {
    const pairs: [number, number][] = []
    for (let at = 0; at + 1 < ROWS.length; at += 1) {
      const apart = ROWS[at]!.filter((one, i) => one !== ROWS[at + 1]![i]).length
      if (apart !== 1) continue
      pairs.push([at, at + 1])
      at += 1
    }
    expect(pairs.length).toBeGreaterThan(40)
    let differed = 0
    for (const [low, high] of pairs) {
      expect(scoreRow(RANKER, ROWS[low]!)).toBeCloseTo(golden.score[low]!, 9)
      expect(scoreRow(RANKER, ROWS[high]!)).toBeCloseTo(golden.score[high]!, 9)
      if (golden.score[low] !== golden.score[high]) differed += 1
    }
    /*
     * Some pairs straddle nothing — a threshold the row's other features route around — so this
     * is not "all". It only has to be enough that `<` for `<=` could not slip through, and the
     * mutation check is what says it does.
     */
    expect(differed).toBeGreaterThan(5)
  })
})

describe('the rank key', () => {
  /** `geo_score` is published as a key where *lower is better*, which is minus the score. */
  it('is the negative of the score, so the best candidate sorts first', () => {
    for (const row of ROWS.slice(0, 20)) {
      expect(rankKey(RANKER, row)).toBe(-scoreRow(RANKER, row))
    }
  })

  it('scores a pool column-wise, in row order', () => {
    const rows = 8
    const columns: Record<string, Float64Array> = {}
    for (const [at, name] of FEATURES.entries()) {
      columns[name] = Float64Array.from({ length: rows }, (_, i) =>
        Number(golden.rows[i]![at] ?? 0),
      )
    }
    const got = rankKeys(RANKER, { rows, columns })
    for (let i = 0; i < rows; i++) {
      const row = FEATURES.map((name) => columns[name]![i]!)
      expect(got[i]).toBe(rankKey(RANKER, row))
    }
  })

  it('refuses a pool missing a column the model ranks on', () => {
    const columns: Record<string, Float64Array> = {}
    for (const name of FEATURES.slice(1)) columns[name] = new Float64Array(3)
    expect(() => rankKeys(RANKER, { rows: 3, columns })).toThrow(/no `min_dist_um` column/)
  })

  it('refuses a column that is not as long as the pool says', () => {
    const columns: Record<string, Float64Array> = {}
    for (const name of FEATURES) columns[name] = new Float64Array(3)
    columns['l2x'] = new Float64Array(2)
    expect(() => rankKeys(RANKER, { rows: 3, columns })).toThrow(
      /says 3 rows and its `l2x` column has 2/,
    )
  })
})

/**
 * A hand-written two-node model, because the published one cannot reach these branches.
 *
 * Every `decision_type` in `rankerModel.txt` is `2` — one distinct value across 11,842 nodes — so
 * the `Zero` and `NaN` missing rules, the categorical refusal and the general walk are all
 * carried without a case. The model format is text, so buying them one costs five lines rather
 * than a fixture.
 */
describe('a model whose nodes declare another missing rule', () => {
  const model = (decisionType: number) =>
    [
      'tree',
      'version=v4',
      'num_class=1',
      'num_tree_per_iteration=1',
      'max_feature_idx=0',
      'objective=lambdarank',
      '',
      'Tree=0',
      'num_leaves=2',
      'split_feature=0',
      'threshold=1',
      `decision_type=${decisionType}`,
      'left_child=-1',
      'right_child=-2',
      'leaf_value=10 20',
      '',
    ].join('\n')

  /** `missing_type = Zero` with `default_left`: 4 (zero) | 2 (left) = 6. */
  it('sends a zero down the default branch where the node calls zero missing', () => {
    const ranker = parseTreeRanker(model(6), ['only'])
    expect(ranker.plainMissing).toBe(false)
    // 0 is "missing" here, so it takes the default (left, leaf 0) rather than 0 <= 1.
    expect(scoreRow(ranker, [0])).toBe(10)
    // 2 is not missing and not <= 1, so it goes right.
    expect(scoreRow(ranker, [2])).toBe(20)
  })

  /** The same node without `default_left`: 4 | 0 = 4, so a zero goes right instead. */
  it('sends it the other way when the node does not default left', () => {
    expect(scoreRow(parseTreeRanker(model(4), ['only']), [0])).toBe(20)
  })

  /** `missing_type = NaN` (8) with `default_left` (2): an absent value is missing, not zero. */
  it('keeps a NaN as missing where the node counts NaN', () => {
    const ranker = parseTreeRanker(model(10), ['only'])
    expect(scoreRow(ranker, [undefined])).toBe(10)
    // Under this rule zero is an ordinary value: 0 <= 1 goes left, by the comparison not the flag.
    expect(scoreRow(ranker, [0])).toBe(10)
    expect(scoreRow(ranker, [5])).toBe(20)
  })

  /** Under `None`, which the published model is, an absent value is zero and the flag is unread. */
  it('reads an absent value as zero under the published rule', () => {
    const ranker = parseTreeRanker(model(2), ['only'])
    expect(ranker.plainMissing).toBe(true)
    expect(scoreRow(ranker, [undefined])).toBe(scoreRow(ranker, [0]))
  })

  it('refuses a categorical split, which this reader cannot walk', () => {
    expect(() => parseTreeRanker(model(1), ['only'])).toThrow(/categorical/)
  })

  it('refuses a body that lost a tree, by the header’s own count', () => {
    const short = model(2).replace('version=v4', 'version=v4\ntree_sizes=100 100')
    expect(() => parseTreeRanker(short, ['only'])).toThrow(
      /counts 2 trees and the body holds 1/,
    )
  })

  it('refuses a model that averages its leaves instead of summing them', () => {
    expect(() =>
      parseTreeRanker(model(2).replace('num_class=1', 'average_output\nnum_class=1'), ['only']),
    ).toThrow(/average_output/)
  })

  /**
   * **A short array does not fail, it hangs.** `node` runs past the end, `left[node]` is
   * `undefined`, every comparison against it is false, and the walk never reaches a negative
   * child. A version of this reader that checked only the tree count had that hole, and the test
   * written to show it wedged the runner instead of failing — which is why these assert a
   * *refusal at parse*, where there is no loop to get stuck in.
   */
  it('refuses a tree whose child arrays are shorter than its splits', () => {
    const short = model(2).replace('right_child=-2', 'right_child=')
    expect(() => parseTreeRanker(short, ['only'])).toThrow(/1 splits and a `right_child` of 0/)
  })

  it('refuses a child naming a node the tree does not have', () => {
    const wild = model(2).replace('left_child=-1', 'left_child=7')
    expect(() => parseTreeRanker(wild, ['only'])).toThrow(/names node 7 of 1/)
  })

  /* The quiet one: the walk ends, the leaf is `undefined`, and every row scores NaN. */
  it('refuses a child naming a leaf the model does not carry', () => {
    const wild = model(2).replace('left_child=-1', 'left_child=-9')
    expect(() => parseTreeRanker(wild, ['only'])).toThrow(/names leaf 8 of 2/)
  })

  it('refuses a row that is not as wide as the model', () => {
    const ranker = parseTreeRanker(model(2), ['only'])
    expect(() => scoreRow(ranker, [])).toThrow(/a row of 0 values/)
    expect(() => scoreRow(ranker, [1, 2])).toThrow(/a row of 2 values/)
  })

  it('refuses a multiclass model, whose sum is not one score', () => {
    expect(() =>
      parseTreeRanker(model(2).replace('num_class=1', 'num_class=3'), ['only']),
    ).toThrow(/3 classes/)
  })
})

/**
 * The parse memo, which exists because nothing in `parseTreeRanker`'s signature stops a caller
 * re-parsing per tip — 8 ms a time against ~130 ms of scoring for a whole neuron.
 */
describe('the parsed forest is kept', () => {
  it('parses one address once, and a different one again', () => {
    resetTreeRankerCache()
    const first = treeRankerFor('https://example.org/a/model.txt', MODEL, FEATURES)
    // The second call is handed no text at all: an empty string would not parse, so answering
    // from it proves the memo rather than a second identical parse.
    expect(treeRankerFor('https://example.org/a/model.txt', '', FEATURES)).toBe(first)
    expect(treeRankerFor('https://example.org/b/model.txt', MODEL, FEATURES)).not.toBe(first)
  })

  /**
   * A hit must not carry an old feature order past the guard that exists to catch one.
   *
   * `parseTreeRanker` refuses a model whose feature count is not the set's, and that guard is
   * there because SEAM appended three features on 2026-11-11. Keyed on the address alone, a set
   * that renamed or reordered its columns would be answered from the memo and never reach it.
   */
  it('does not answer a different feature list from the same address', () => {
    resetTreeRankerCache()
    const first = treeRankerFor('https://example.org/d/model.txt', MODEL, FEATURES)
    const renamed = [...FEATURES.slice(0, -1), 'end_distance_um']
    expect(treeRankerFor('https://example.org/d/model.txt', MODEL, renamed)).not.toBe(first)
    expect(() =>
      treeRankerFor('https://example.org/d/model.txt', MODEL, FEATURES.slice(1)),
    ).toThrow(/features/)
  })
})
