/**
 * The table transforms' export decisions, asked of the plans directly.
 *
 * The fixture configures every one of these nodes, so its goldens take none of the refusals: an
 * unset picker, a mode no build offered, a Group By with keys but nothing to aggregate. Those are
 * the branches pinned here, together with the values the plans resolve for both renderers.
 */

import { describe, expect, it } from 'vitest'

import type { ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { rawFileUrl } from '../../data/rawFileUrl'
import type { FilterOp } from '../../nodes/lib/tableOps'
import {
  FILTER_TABLE_DEFAULT_OP,
  NORMALIZE_OPTIONS,
  SAMPLE_OPTIONS,
  filterConditionIssues,
  resolveFilterOp,
} from '../../nodes/lib/tableOps'
import {
  filterTablePlan,
  groupByPlan,
  joinPlan,
  normalizePlan,
  pivotPlan,
  qualifyIdsPlan,
  relabelPlan,
  samplePlan,
  selectPlan,
  sortPlan,
  tableFromUrlPlan,
} from './table'
import { fakeNeutralContext } from './testContext'

const SCHEMA: TableSchema = {
  columns: [
    { name: 'type', dtype: 'str' },
    { name: 'pre', dtype: 'i64' },
  ],
}

const ctx = (type: string, params: ParamValues) =>
  fakeNeutralContext({ type, params, schemas: { in: SCHEMA } })

describe('the table plans refuse an unset picker', () => {
  it('in the sentence both documents write', () => {
    expect(filterTablePlan(ctx('core.filterTable', {})).refusal).toBe(
      'No column is chosen on this Filter Table.',
    )
    expect(sortPlan(ctx('core.sort', {})).refusal).toBe('No column is chosen on this Sort.')
    expect(
      relabelPlan(ctx('core.relabel', { column: 'type', keyColumn: 'type' })).refusal,
    ).toBe('This Relabel has no column chosen on one side.')
    expect(joinPlan(ctx('core.join', { leftKey: 'type' })).refusal).toBe(
      'This Join has no key column on one side.',
    )
    expect(pivotPlan(ctx('core.pivot', { rows: 'type' })).refusal).toBe(
      'This Pivot needs both a Rows and a Columns field.',
    )
    expect(qualifyIdsPlan(ctx('core.qualifyIds', {})).refusal).toBe(
      'This Qualify Ids has no id column chosen.',
    )
    expect(groupByPlan(ctx('core.groupBy', { by: [] })).refusal).toBe(
      'No group-by columns are chosen.',
    )
    expect(tableFromUrlPlan({ url: '   ' }).refusal).toBe(
      'This Table from URL node has no URL.',
    )
  })

  it('refuses Group By on its second level when there is nothing to aggregate', () => {
    const plan = groupByPlan(ctx('core.groupBy', { by: ['type'], agg: 'sum' }))
    expect(plan.refusal).toBeUndefined()
    expect(plan.refusal === undefined && plan.aggregate).toEqual({
      refusal: '"sum" needs at least one value column.',
    })
    // `count` counts rows, so it reads no column even when one is picked.
    const count = groupByPlan(
      ctx('core.groupBy', { by: ['type'], agg: 'count', value: ['pre'] }),
    )
    expect(count.refusal === undefined && count.aggregate).toEqual({ agg: 'count', values: [] })
  })
})

describe('the table plans refuse a mode the node does not offer', () => {
  it('for Sample and Normalize, and accept every mode their option lists do', () => {
    expect(samplePlan({ mode: 'every-other' }).refusal).toBe(
      'Unknown sample mode "every-other".',
    )
    expect(normalizePlan({ mode: 'zscore' }).refusal).toBe('Unknown normalize mode "zscore".')
    for (const { value } of SAMPLE_OPTIONS) {
      expect(samplePlan({ mode: value, step: 0 })).toMatchObject({ mode: value, step: 1 })
    }
    for (const { value } of NORMALIZE_OPTIONS) {
      expect(normalizePlan({ mode: value })).toEqual({ mode: value })
    }
  })
})

describe('the values the table plans resolve', () => {
  it('filters with the operator `evaluate` resolves for the column', () => {
    const plan = filterTablePlan(ctx('core.filterTable', { column: 'pre', op: 'gt', value: 5 }))
    expect(plan).toEqual({
      column: 'pre',
      op: resolveFilterOp('gt', 'i64', FILTER_TABLE_DEFAULT_OP),
      value: '5',
      numeric: true,
      keepsNull: false,
    })
    // The declared default giving way on a text column is resolution, not a refusal.
    expect(
      filterTablePlan(ctx('core.filterTable', { column: 'type', value: 'LC4' })),
    ).toMatchObject({ op: 'eq', numeric: false })
  })

  /*
   * `makePredicate` reads a null through `Number`, so on a numeric column it is 0 — the Filter
   * nodes' own rule, which the plan takes from the canvas rather than restating.
   */
  it('keeps a null on a numeric column exactly where the canvas reads it as 0', () => {
    const keeps = (op: string, value: string) => {
      const plan = filterTablePlan(ctx('core.filterTable', { column: 'pre', op, value }))
      return plan.refusal === undefined ? plan.keepsNull : plan.refusal
    }
    expect(keeps('eq', '0')).toBe(true)
    expect(keeps('eq', '5')).toBe(false)
    expect(keeps('ne', '0')).toBe(false)
    expect(keeps('ne', '5')).toBe(true)
    for (const op of ['gt', 'ge', 'lt', 'le']) {
      expect(keeps(op, '0')).toBe(false)
      expect(keeps(op, '-5')).toBe(false)
    }
  })

  it('refuses a condition the canvas throws on, in the sentence the card shows', () => {
    const refusal = (params: ParamValues) =>
      filterTablePlan(ctx('core.filterTable', params)).refusal
    // The card's own sentence, from the function `validate` puts on the card.
    const onCard = (dtype: 'i64' | 'str', op: FilterOp, value: string) =>
      `This Filter Table fails on the canvas too: ${filterConditionIssues(dtype, op, value)[0]}.`
    expect(refusal({ column: 'pre', op: 'contains', value: '5' })).toBe(
      onCard('i64', 'contains', '5'),
    )
    expect(refusal({ column: 'type', op: 'gt', value: 'M' })).toBe(onCard('str', 'gt', 'M'))
    expect(refusal({ column: 'pre', op: 'ge', value: 'abc' })).toBe(onCard('i64', 'ge', 'abc'))
    // `validate` has nothing to say about a pattern, so the thrown error is the sentence.
    expect(refusal({ column: 'type', op: 'matches', value: '[' })).toMatch(
      /^This Filter Table fails on the canvas too: Invalid regex \/\[\/: .+\.$/,
    )
    // Conditions `validate` complains about but `evaluate` runs are not refused: the canvas
    // reads an empty value as 0 and tests emptiness on any column.
    expect(refusal({ column: 'pre', op: 'ge', value: '' })).toBeUndefined()
    expect(refusal({ column: 'pre', op: 'isEmpty' })).toBeUndefined()
    // A column the schema does not know cannot be judged, so nothing is refused.
    expect(refusal({ column: 'arrivedLater', op: 'gt', value: 'x' })).toBeUndefined()
  })

  it('notes collation only for a text column, including one the schema does not know', () => {
    const notes = (column: string) => {
      const plan = sortPlan(ctx('core.sort', { column }))
      return plan.refusal === undefined ? plan.notes : undefined
    }
    expect(notes('type')).toEqual(['textCollation'])
    expect(notes('pre')).toEqual([])
    expect(notes('arrivedLater')).toEqual(['textCollation'])
  })

  it('reads an empty Select as every column', () => {
    expect(selectPlan(ctx('core.select', { columns: [] }))).toEqual({
      note: 'No columns picked, which Coda reads as "keep them all".',
    })
    expect(selectPlan(ctx('core.select', { columns: ['type'] }))).toEqual({ columns: ['type'] })
  })

  it('passes a prefix only when adding, even an empty one, and a target only when removing', () => {
    const qualify = (params: ParamValues) =>
      qualifyIdsPlan(ctx('core.qualifyIds', { column: 'type', ...params }))
    expect(qualify({ direction: 'add', prefix: ' hb ', into: 'x' })).toEqual({
      column: 'type',
      direction: 'add',
      prefix: 'hb',
    })
    expect(qualify({ direction: 'add', prefix: '' })).toHaveProperty('prefix', '')
    expect(qualify({ direction: 'remove', into: 'bare' })).toEqual({
      column: 'type',
      direction: 'remove',
      into: 'bare',
    })
    const kept = qualify({ direction: 'remove', into: '' })
    expect(kept.refusal === undefined && kept.into).toBeUndefined()
  })

  it('reads the raw file behind a GitHub page, keeping the pasted link for the note', () => {
    const typed = 'https://github.com/owner/repo/blob/main/table.csv'
    const plan = tableFromUrlPlan({ url: ` ${typed} ` })
    expect(plan).toEqual({ typed, url: rawFileUrl(typed) })
    expect(plan.refusal === undefined && plan.url).not.toBe(typed)
  })
})
