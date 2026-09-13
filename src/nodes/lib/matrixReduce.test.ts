/**
 * The reduction itself, and the three decisions that are easy to get wrong in a way nothing
 * downstream can see.
 *
 * Absence is the first: a statistic over a line of `NaN` has four plausible answers — 0, `NaN`,
 * null, and a thrown error — and the one Coda gives is the one `Group By` gives, so the cases
 * here are that rule read back. The axis is the second, and it is checked by reducing one
 * matrix both ways and asserting the two answers are each other's transpose rather than by
 * asserting numbers twice. The diagonal is the third, and its *refusals* are what matter: a
 * square matrix over two different populations must keep its diagonal.
 */

import { describe, expect, it } from 'vitest'

import { SILENT } from '../../core/limits'
import { columnNames } from '../../core/types'
import { makeMatrix } from '../../core/values'
import type { MatrixValue } from '../../core/values'
import type { ReduceOptions, ReduceStat } from './matrixReduce'
import {
  REDUCE_STAT_OPTIONS,
  readReduceOptions,
  reduceColumnName,
  reduceMatrixSchema,
  reduceMatrixTable,
} from './matrixReduce'

const ALL_STATS: ReduceStat[] = REDUCE_STAT_OPTIONS.map((option) => option.value)

function matrix(rows: string[], cols: string[], values: number[][]): MatrixValue {
  return makeMatrix(rows, cols, Float64Array.from(values.flat()))
}

function options(extra: Partial<ReduceOptions> = {}): ReduceOptions {
  return { axis: 'rows', stats: ALL_STATS, prefix: '', excludeDiagonal: false, ...extra }
}

/** One line's answers, by statistic name, so a case reads as the numbers it is about. */
function reduced(
  m: MatrixValue,
  extra: Partial<ReduceOptions> = {},
  line = 0,
): Record<string, unknown> {
  const opts = options(extra)
  const table = reduceMatrixTable(m, opts, SILENT)
  const row: Record<string, unknown> = { label: table.data.label![line] }
  for (const stat of opts.stats)
    row[stat] = table.data[reduceColumnName(stat, opts.prefix)]![line]
  return row
}

/** A collecting warner, per test — module state here is five hand-resets and an ordering. */
function warner(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { warn: (message: string) => messages.push(message), messages }
}

describe('the statistics', () => {
  // 1, 2, 3, 6: mean 3, median 2.5, sample sd 2.16…, and a span nothing rounds away.
  const m = matrix(
    ['a', 'b'],
    ['t0', 't1', 't2', 't3'],
    [
      [1, 2, 3, 6],
      [10, 10, 10, 10],
    ],
  )

  it('answers each one over the line it was asked about', () => {
    expect(reduced(m)).toEqual({
      label: 'a',
      n: 4,
      sum: 12,
      mean: 3,
      // The sample standard deviation, `ddof = 1` — which is what pandas' `.std()` and R's
      // `sd()` both default to, so the two emitters need no correction.
      sd: Math.sqrt((4 + 1 + 0 + 9) / 3),
      min: 1,
      max: 6,
      // Type 7, interpolated: the same definition `quantileSorted` gives every other median in
      // the app, and numpy's and R's default.
      median: 2.5,
    })
  })

  it('answers 0 for the spread of a constant line rather than null', () => {
    // A measured absence of spread, where a line with nothing in it has *no* spread. The two
    // cases are one `Math.sqrt(0)` apart and read identically on a card.
    expect(reduced(m, {}, 1)).toMatchObject({ n: 4, sd: 0, mean: 10, median: 10 })
  })

  it('keeps its precision on a line whose mean dwarfs its spread', () => {
    /*
     * Welford rather than `Σx² − (Σx)²/n`, which subtracts two numbers agreeing to fifteen
     * digits. Measured on `[b+1, b+2, b+3]`, whose sd is 1 at every `b`: the closed form is
     * right to 1e7, answers **0** at 1e8 and 1e9, and at 1e10 answers a *negative* variance and
     * so `NaN` under the root. Both wrong answers are worse than noise — 0 is a claim the line
     * is constant — and 1e8 is not an exotic magnitude for a raw coordinate or a voxel count.
     */
    const big = matrix(['a'], ['t0', 't1', 't2'], [[1e8 + 1, 1e8 + 2, 1e8 + 3]])
    expect(reduced(big)).toMatchObject({ sd: 1, mean: 1e8 + 2 })
    const huge = matrix(['a'], ['t0', 't1', 't2'], [[1e10 + 1, 1e10 + 2, 1e10 + 3]])
    expect(reduced(huge)).toMatchObject({ sd: 1 })
  })
})

describe('absence', () => {
  const m = matrix(
    ['gap', 'one', 'inf'],
    ['t0', 't1'],
    [
      [NaN, NaN],
      [4, NaN],
      [Infinity, 5],
    ],
  )

  it('gives a line with nothing in it null, except the two that are counts', () => {
    expect(reduced(m)).toEqual({
      label: 'gap',
      // `Group By`'s rule: 0 is the identity of addition, where every other 0 here would be a
      // measurement nobody took.
      sum: 0,
      n: 0,
      mean: null,
      median: null,
      sd: null,
      min: null,
      max: null,
    })
  })

  it('gives a line holding one value no spread rather than a spread of zero', () => {
    expect(reduced(m, {}, 1)).toEqual({
      label: 'one',
      n: 1,
      sum: 4,
      mean: 4,
      median: 4,
      sd: null,
      min: 4,
      max: 4,
    })
  })

  it('skips an infinity as well as a NaN', () => {
    // `axisTotals`' rule, and the one place pandas differs — `skipna` keeps `±inf`, which is
    // why both emitters replace them first.
    expect(reduced(m, {}, 2)).toMatchObject({ n: 1, sum: 5, max: 5, min: 5 })
  })
})

describe('the axis', () => {
  const m = matrix(
    ['a', 'b'],
    ['t0', 't1', 't2'],
    [
      [1, 2, 3],
      [10, 20, 30],
    ],
  )

  it('names the lines that survive, not the ones that are consumed', () => {
    const rows = reduceMatrixTable(m, options({ stats: ['mean'] }), SILENT)
    const cols = reduceMatrixTable(m, options({ stats: ['mean'], axis: 'columns' }), SILENT)
    expect(rows.data.label).toEqual(['a', 'b'])
    expect(rows.data.mean).toEqual([2, 20])
    expect(cols.data.label).toEqual(['t0', 't1', 't2'])
    expect(cols.data.mean).toEqual([5.5, 11, 16.5])
  })

  it('reads the strided axis exactly as the contiguous one', () => {
    /*
     * The two arms differ only in a stride, and a stride computed wrongly still produces
     * plausible numbers — it reads a diagonal-ish smear of the matrix. Asserting each answer is
     * the other's transpose is what a wrong stride cannot survive.
     */
    const transposed = makeMatrix(
      m.colLabels,
      m.rowLabels,
      Float64Array.from([1, 10, 2, 20, 3, 30]),
    )
    const down = reduceMatrixTable(m, options({ axis: 'columns' }), SILENT)
    const across = reduceMatrixTable(transposed, options({ axis: 'rows' }), SILENT)
    expect(down.data).toEqual(across.data)
  })
})

describe('the diagonal', () => {
  const self = matrix(
    ['a', 'b'],
    ['a', 'b'],
    [
      [1, 0.2],
      [0.2, 1],
    ],
  )

  it('drops the self-comparison where the label lists agree', () => {
    const told = warner()
    const table = reduceMatrixTable(
      self,
      options({ stats: ['mean', 'n'], excludeDiagonal: true }),
      told,
    )
    expect(table.data.mean).toEqual([0.2, 0.2])
    expect(table.data.n).toEqual([1, 1])
    expect(told.messages).toEqual([])
  })

  it('keeps it on a square matrix over two different populations, and says so', () => {
    // The departure from `skip_self`, and the case that argued for it: this matrix is square by
    // coincidence and every cell on its diagonal is a real measurement.
    const told = warner()
    const crossed = matrix(
      ['a', 'b'],
      ['t0', 't1'],
      [
        [1, 3],
        [5, 7],
      ],
    )
    const table = reduceMatrixTable(
      crossed,
      options({ stats: ['mean'], excludeDiagonal: true }),
      told,
    )
    expect(table.data.mean).toEqual([2, 6])
    expect(told.messages).toHaveLength(1)
    expect(told.messages[0]).toContain('2 × 2')
  })

  it('says so on a matrix that is not square either', () => {
    const told = warner()
    reduceMatrixTable(
      matrix(['a'], ['t0', 't1'], [[1, 2]]),
      options({ stats: ['mean'], excludeDiagonal: true }),
      told,
    )
    expect(told.messages).toHaveLength(1)
  })

  it('is silent when nobody asked for it', () => {
    const told = warner()
    reduceMatrixTable(matrix(['a'], ['t0'], [[1]]), options({ stats: ['mean'] }), told)
    expect(told.messages).toEqual([])
  })
})

describe('the schema half', () => {
  const m = matrix(
    ['a', 'b'],
    ['t0', 't1'],
    [
      [1, 2],
      [3, 4],
    ],
  )

  it('promises exactly the columns the value half produces, in order', () => {
    // Invariant 3. A disagreement here breaks every column picker downstream, but only after a
    // run — so it is asserted over every arity rather than on one example.
    for (const stats of [[], ['mean'], ['n', 'sd'], ALL_STATS] as ReduceStat[][]) {
      for (const prefix of ['', 'zap']) {
        const opts = options({ stats, prefix })
        const table = reduceMatrixTable(m, opts, SILENT)
        expect(columnNames(reduceMatrixSchema(opts))).toEqual(columnNames(table.schema))
        expect(Object.keys(table.data)).toEqual(columnNames(table.schema))
        expect(table.length).toBe(2)
      }
    }
  })

  it('counts in integers and measures in floats', () => {
    const columns = reduceMatrixSchema(options()).columns
    expect(columns[0]).toMatchObject({ name: 'label', dtype: 'str' })
    expect(columns.find((c) => c.name === 'n')).toMatchObject({ dtype: 'i64' })
    expect(columns.find((c) => c.name === 'mean')).toMatchObject({ dtype: 'f64' })
  })

  it('hands back the labels alone when nothing is ticked', () => {
    // A legitimate state rather than a half-built card: a matrix's own line names, as a table.
    const table = reduceMatrixTable(m, options({ stats: [] }), SILENT)
    expect(columnNames(table.schema)).toEqual(['label'])
    expect(table.data.label).toEqual(['a', 'b'])
  })
})

describe('the column names', () => {
  it('joins a prefix with one underscore however it was typed', () => {
    expect(reduceColumnName('mean', '')).toBe('mean')
    expect(reduceColumnName('mean', 'zap')).toBe('zap_mean')
    expect(reduceColumnName('mean', 'zap_')).toBe('zap_mean')
  })
})

describe('readReduceOptions', () => {
  it('drops what nothing can compute and keeps the order that was chosen', () => {
    expect(readReduceOptions({ stats: ['max', 'nonsense', 'mean'] }).stats).toEqual([
      'max',
      'mean',
    ])
  })

  it('drops a repeat, which would name two columns one thing', () => {
    expect(readReduceOptions({ stats: ['mean', 'mean'] }).stats).toEqual(['mean'])
  })

  it('reads an unset or unrecognised axis as rows', () => {
    expect(readReduceOptions({}).axis).toBe('rows')
    expect(readReduceOptions({ axis: 'sideways' }).axis).toBe('rows')
    expect(readReduceOptions({ axis: 'columns' }).axis).toBe('columns')
  })

  it('trims the prefix and reads the toggle strictly', () => {
    expect(readReduceOptions({ prefix: '  zap  ' }).prefix).toBe('zap')
    expect(readReduceOptions({ excludeDiagonal: 'yes' }).excludeDiagonal).toBe(false)
    expect(readReduceOptions({ excludeDiagonal: true }).excludeDiagonal).toBe(true)
  })
})

describe('the memo', () => {
  /** A fresh identity per test: the cache is keyed on the matrix, so this is what makes it cold. */
  const grid = () =>
    matrix(
      ['a', 'b'],
      ['t0', 't1'],
      [
        [1, 2],
        [3, 4],
      ],
    )

  it('reuses the arithmetic when only the column names changed', () => {
    /*
     * The prefix is in the provenance key and changes no number, so every keystroke in that
     * field re-enters `evaluate`. Asserted by array *identity*, which is the only thing
     * observable from here — the work itself is 1.2 s on a real trace matrix with `median`
     * ticked, and a benchmark in a unit test is a flake.
     */
    const m = grid()
    const bare = reduceMatrixTable(m, options({ stats: ['mean'] }), SILENT)
    const prefixed = reduceMatrixTable(m, options({ stats: ['mean'], prefix: 'zap' }), SILENT)
    expect(prefixed.data.zap_mean).toBe(bare.data.mean)
    expect(prefixed.data.label).toBe(bare.data.label)
  })

  it('reuses it when a chip the one pass already computed is ticked', () => {
    // The six single-pass statistics are computed whether or not they were asked for — `min` is
    // two compares against a division every ticking pays anyway — so they are all in the entry
    // and the chips are not in the key.
    const m = grid()
    const first = reduceMatrixTable(m, options({ stats: ['mean'] }), SILENT)
    const second = reduceMatrixTable(m, options({ stats: ['mean', 'max', 'n'] }), SILENT)
    expect(second.data.mean).toBe(first.data.mean)
    expect(second.data.max).toEqual([2, 4])
    expect(second.data.n).toEqual([2, 2])
  })

  it('recomputes when a number could have changed', () => {
    const m = grid()
    const first = reduceMatrixTable(m, options({ stats: ['mean'] }), SILENT)
    for (const changed of [
      options({ stats: ['mean'], axis: 'columns' }),
      options({ stats: ['mean'], excludeDiagonal: true }),
      // `median` is the one chip in the key, being the one that is not single-pass.
      options({ stats: ['mean', 'median'] }),
    ]) {
      expect(reduceMatrixTable(m, changed, SILENT).data.mean).not.toBe(first.data.mean)
    }
  })

  it('replays the warnings it held, or a card loses a line it was showing', () => {
    const m = grid()
    const told = warner()
    const opts = options({ stats: ['mean'], excludeDiagonal: true })
    reduceMatrixTable(m, opts, told)
    reduceMatrixTable(m, { ...opts, prefix: 'zap' }, told)
    expect(told.messages).toHaveLength(2)
  })

  it('is cold for a matrix it has not seen, which is what a benchmark needs', () => {
    // Keyed on the input value's identity, so there is no reset to call: a fresh matrix is a
    // fresh answer, and the entry dies with the matrix it was keyed on.
    const before = reduceMatrixTable(grid(), options({ stats: ['mean'] }), SILENT)
    const after = reduceMatrixTable(grid(), options({ stats: ['mean'] }), SILENT)
    expect(after.data.mean).not.toBe(before.data.mean)
    expect(after.data.mean).toEqual(before.data.mean)
  })
})
