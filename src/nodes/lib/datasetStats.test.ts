/**
 * The dataset roll-ups.
 *
 * Every case here is one where a wrong answer is a plausible number rather than an error —
 * which is the whole reason this arithmetic lives outside the component. A bar chart drawn
 * from a miscount looks exactly like a bar chart.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { CellValue } from '../../core/values'
import { makeTable } from '../../core/values'
import {
  MAX_SUMMARY_ATTRIBUTES,
  attributeCounts,
  completenessTotals,
  datasetTotals,
  statsFor,
  summaryAttributes,
} from './datasetStats'

const NEURON_SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('type', 'str'),
  column('class', 'str'),
  column('pre', 'i64'),
  column('post', 'i64'),
)

function neurons(rows: Array<Partial<Record<string, CellValue>>>) {
  const data: Record<string, CellValue[]> = {}
  for (const col of NEURON_SCHEMA.columns) data[col.name] = rows.map((r) => r[col.name] ?? null)
  return makeTable(NEURON_SCHEMA, data, 'neurons')
}

describe('attributeCounts', () => {
  it('ranks by count and reports shares over the rows it counted', () => {
    const table = neurons([
      { class: 'optic' },
      { class: 'optic' },
      { class: 'optic' },
      { class: 'central' },
    ])
    const counts = attributeCounts(table, 'class')
    expect(counts.values.map((v) => [v.value, v.count])).toEqual([
      ['optic', 3],
      ['central', 1],
    ])
    expect(counts.values[0]?.share).toBeCloseTo(0.75, 10)
    expect(counts.total).toBe(4)
    expect(counts.distinct).toBe(2)
  })

  it('folds null and empty string into one absence, and keeps it out of the ranking', () => {
    // neuPrint publishes both for the same "nothing recorded" depending on the property and
    // the dataset. Two categories here would split one bar in two and put a nameless sliver
    // in the legend — and "unspecified" is not a class of neuron, so it is counted apart.
    const table = neurons([
      { class: 'optic' },
      { class: null },
      { class: '' },
      { class: '   ' },
    ])
    const counts = attributeCounts(table, 'class')
    expect(counts.missing).toBe(3)
    expect(counts.values.map((v) => v.value)).toEqual(['optic'])
    // The denominator is what was counted, not the table length — so the one real value is
    // 100% of the neurons that have a class, which is the true statement.
    expect(counts.values[0]?.share).toBe(1)
    expect(counts.total).toBe(1)
  })

  it('counts absence as a bucket only when asked, and puts it last regardless of size', () => {
    const table = neurons([{ class: 'optic' }, { class: null }, { class: null }])
    const counts = attributeCounts(table, 'class', { includeMissing: true })
    expect(counts.values.map((v) => [v.value, v.count])).toEqual([
      ['optic', 1],
      [null, 2],
    ])
    expect(counts.total).toBe(3)
    // `distinct` still counts real values only, or a caption would claim a dataset has one
    // more class than it does.
    expect(counts.distinct).toBe(1)
  })

  it('keeps a boolean false as a value rather than as absence', () => {
    // `Boolean(cell)` here would merge every false into the missing bucket and report a
    // column of flags as half empty.
    const schema = tableSchema(column('primary', 'bool'))
    const table = makeTable(schema, { primary: [true, false, false, null] })
    const counts = attributeCounts(table, 'primary')
    expect(counts.missing).toBe(1)
    expect(counts.values.map((v) => [v.value, v.count])).toEqual([
      ['false', 2],
      ['true', 1],
    ])
  })

  it('breaks a tie on the label, so an unrelated sort upstream cannot reorder the chart', () => {
    const ascending = neurons([{ class: 'a' }, { class: 'b' }])
    const descending = neurons([{ class: 'b' }, { class: 'a' }])
    expect(attributeCounts(ascending, 'class').values.map((v) => v.value)).toEqual(['a', 'b'])
    expect(attributeCounts(descending, 'class').values.map((v) => v.value)).toEqual(['a', 'b'])
  })

  it('folds the tail into a residual that says how much it hid', () => {
    const table = neurons(
      ['a', 'a', 'a', 'b', 'b', 'c', 'd'].map(
        (c) => ({ class: c }) as Record<string, CellValue>,
      ),
    )
    const counts = attributeCounts(table, 'class', { topN: 2 })
    expect(counts.values.map((v) => v.value)).toEqual(['a', 'b'])
    expect(counts.other).toEqual({ count: 2, share: 2 / 7, distinct: 2 })
    // `distinct` is before the fold, so "2 of 4" is expressible.
    expect(counts.distinct).toBe(4)
  })

  it('reports nothing rather than throwing for a column the table does not have', () => {
    const counts = attributeCounts(neurons([{ class: 'optic' }]), 'superclass')
    expect(counts).toEqual({
      column: 'superclass',
      values: [],
      missing: 0,
      distinct: 0,
      total: 0,
    })
  })

  it('omits the residual entirely when nothing was folded', () => {
    // Undefined and a fold of size zero are different statements: only the first lets a
    // caption say "8 of 214" exactly when there is a remainder.
    expect(
      attributeCounts(neurons([{ class: 'a' }]), 'class', { topN: 5 }).other,
    ).toBeUndefined()
  })
})

describe('summaryAttributes', () => {
  it('picks the categorical columns a dataset actually has, in priority order', () => {
    const schema = tableSchema(
      column('bodyId', 'i64'),
      column('class', 'str'),
      column('superclass', 'str'),
      column('pre', 'i64'),
    )
    expect(summaryAttributes(schema)).toEqual(['superclass', 'class'])
  })

  it('excludes numeric columns outright', () => {
    // A bar chart of "how many neurons have exactly 1,204 presynaptic sites" is one bar per
    // neuron. That shape belongs on a histogram, which is a different tile.
    const schema = tableSchema(
      column('pre', 'i64'),
      column('size', 'f64'),
      column('class', 'str'),
    )
    expect(summaryAttributes(schema)).toEqual(['class'])
  })

  it('spends one slot per fact, not one per name for it', () => {
    // male-CNS publishes hemilineage twice and a transmitter call twice. Charting both spends
    // two slots saying one thing, and pushes something that says more past the cap.
    const schema = tableSchema(
      column('hemilineage', 'str'),
      column('itoleeHl', 'str'),
      column('consensusNt', 'str'),
      column('predictedNt', 'str'),
      column('somaSide', 'str'),
      column('rootSide', 'str'),
    )
    expect(summaryAttributes(schema)).toEqual(['somaSide', 'consensusNt', 'hemilineage'])
  })

  it('caps the automatic list', () => {
    const schema = tableSchema(
      ...[
        'superclass',
        'class',
        'subclass',
        'flow',
        'side',
        'consensusNt',
        'hemilineage',
        'cellBodyFiber',
        'nerve',
        'status',
      ].map((n) => column(n, 'str')),
    )
    expect(summaryAttributes(schema)).toHaveLength(MAX_SUMMARY_ATTRIBUTES)
  })

  it('takes a chosen list literally — in order, uncapped, and without deduplication', () => {
    // The same rule Explore's `chips` param follows: trimming what someone asked for by name
    // is how a control stops being believed.
    const schema = tableSchema(
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'hemilineage', 'itoleeHl'].map((n) =>
        column(n, 'str'),
      ),
    )
    const chosen = ['i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a', 'hemilineage', 'itoleeHl']
    expect(summaryAttributes(schema, chosen)).toEqual(chosen)
  })

  it('drops a chosen column the dataset does not have, rather than charting blanks', () => {
    const schema = tableSchema(column('class', 'str'))
    expect(summaryAttributes(schema, ['class', 'superclass'])).toEqual(['class'])
  })

  it('answers nothing for a schema nobody has yet', () => {
    expect(summaryAttributes(undefined)).toEqual([])
  })
})

describe('datasetTotals', () => {
  it('counts what the table has and stays silent about what it does not', () => {
    // A table that has been through Select may carry nothing but a bodyId, and reporting zeros
    // there would read as measurements rather than as absences.
    const totals = datasetTotals(
      neurons([
        { bodyId: 1, type: 'LC4', pre: 10, post: 20 },
        { bodyId: 2, type: 'LC4', pre: 5, post: 1 },
        { bodyId: 3, type: null, pre: null, post: 4 },
      ]),
    )
    expect(totals).toEqual({ neurons: 3, typed: 2, distinctTypes: 1, pre: 15, post: 25 })

    const bare = makeTable(tableSchema(column('bodyId', 'i64')), { bodyId: [1, 2] })
    expect(datasetTotals(bare)).toEqual({ neurons: 2 })
  })
})

describe('completenessTotals', () => {
  const SCHEMA = tableSchema(
    column('roi', 'str'),
    column('pre', 'i64'),
    column('post', 'i64'),
    column('totalPre', 'i64'),
    column('totalPost', 'i64'),
    column('primary', 'bool'),
  )

  it('sums only the regions that tile the volume, and says that it did', () => {
    /*
     * The nesting is the whole hazard: AL-DA1(R) is inside AL(R), so adding both counts the
     * same synapses twice. Summing hemibrain's raw table gives 20,988,880 presynaptic sites
     * against a true 9,428,400 over its 63 primary regions — a 2.2x overcount that still reads
     * as a plausible number, with nothing on screen to blame.
     */
    const table = makeTable(SCHEMA, {
      roi: ['AL(R)', 'AL-DA1(R)'],
      pre: [90, 40],
      post: [30, 10],
      totalPre: [100, 50],
      totalPost: [100, 40],
      primary: [true, false],
    })
    const totals = completenessTotals(table)
    expect(totals.pre).toBe(90)
    expect(totals.totalPre).toBe(100)
    expect(totals.preCompleteness).toBeCloseTo(0.9, 10)
    expect(totals.regions).toBe(1)
    expect(totals.filtered).toBe(true)
  })

  it('refuses a region it cannot vouch for, unlike the node that merely shows it', () => {
    // Null `primary` means the source could not say whether the row nests. Showing such a
    // region costs nothing; adding it into a headline total is the one thing looking cannot
    // undo, so this excludes it while `neuron.roiCompleteness` keeps it.
    const table = makeTable(SCHEMA, {
      roi: ['A', 'B'],
      pre: [10, 10],
      post: [1, 1],
      totalPre: [20, 20],
      totalPost: [2, 2],
      primary: [true, null],
    })
    const totals = completenessTotals(table)
    expect(totals.pre).toBe(10)
    expect(totals.regions).toBe(1)
    expect(totals.filtered).toBe(true)
  })

  it('leaves the fraction null where there is nothing to divide', () => {
    const table = makeTable(SCHEMA, {
      roi: ['A'],
      pre: [0],
      post: [0],
      totalPre: [0],
      totalPost: [0],
      primary: [true],
    })
    expect(completenessTotals(table).preCompleteness).toBeNull()
  })

  it('sums everything when the table carries no primary column at all', () => {
    const schema = tableSchema(
      column('roi', 'str'),
      column('pre', 'i64'),
      column('totalPre', 'i64'),
    )
    const table = makeTable(schema, { roi: ['A', 'B'], pre: [1, 2], totalPre: [10, 10] })
    const totals = completenessTotals(table)
    expect(totals.pre).toBe(3)
    expect(totals.regions).toBe(2)
    expect(totals.filtered).toBe(false)
  })
})

describe('statsFor', () => {
  it('walks the table once and answers every cap from the same count', () => {
    const table = neurons(
      ['a', 'a', 'b', 'c'].map((c) => ({ class: c }) as Record<string, CellValue>),
    )
    const all = statsFor(table, 'class')
    const capped = statsFor(table, 'class', { topN: 1 })

    expect(all.values).toHaveLength(3)
    expect(all.other).toBeUndefined()
    expect(capped.values.map((v) => v.value)).toEqual(['a'])
    expect(capped.other).toEqual({ count: 2, share: 0.5, distinct: 2 })
    // The stored count is uncapped, so a "show more" control costs no recount — asking again
    // without a cap must still give the full list back.
    expect(statsFor(table, 'class').values).toHaveLength(3)
  })

  it('keeps the two missing modes apart, since they have different denominators', () => {
    const table = neurons([{ class: 'a' }, { class: null }])
    expect(statsFor(table, 'class').total).toBe(1)
    expect(statsFor(table, 'class', { includeMissing: true }).total).toBe(2)
  })

  it('gives two callers on one table the same object, which is the point of it', () => {
    // Keyed on the TableValue, which is safe because columns are immutable by contract and
    // because `loadCachedTable` hands the *same* object to every consumer of one dataset's
    // index — so a second Summary card, or a Summary beside an Explore, shares this walk.
    const table = neurons([{ class: 'a' }])
    expect(statsFor(table, 'class')).toBe(statsFor(table, 'class'))
    // A different table with identical contents does not, because identity is the key.
    expect(statsFor(neurons([{ class: 'a' }]), 'class')).not.toBe(statsFor(table, 'class'))
  })
})
