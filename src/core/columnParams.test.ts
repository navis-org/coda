/**
 * What a column picker is allowed to complain about.
 *
 * `validateColumnParams` runs for every node on every graph mutation, so each message it can
 * emit lands on a badge somebody has to read — and a check that cries wolf is worse than no
 * check, because it is how a genuine issue further down the list stops being read.
 *
 * Three distinctions carry that, and two of them were got wrong first. A schema that has not
 * arrived is not a schema with nothing in it; an optional picker answering "off" is not a
 * picker falling back to the first column; and a stored value that is still the definition's
 * own default was never a decision anybody made.
 */

import { describe, expect, it } from 'vitest'

import type { NodeDefinition, ParamDef } from './node'
import { makeInferContext, resolveColumn, validateColumnParams } from './node'
import type { CodaType, TableSchema } from './types'
import { T, column, tableSchema } from './types'

const SCHEMA: TableSchema = tableSchema(
  column('bodyId', 'i64'),
  column('type', 'str'),
  column('pre', 'i64'),
)

function def(...params: ParamDef[]): NodeDefinition {
  return {
    type: 'test.columns',
    label: 'Test',
    category: 'transform',
    description: 'fixture',
    cost: 'cheap',
    inputs: [{ id: 'in', label: 'Table', type: T.table() }],
    outputs: [{ id: 'out', label: 'Table', type: T.table() }],
    params,
    evaluate: () => ({}),
  }
}

function issues(
  definition: NodeDefinition,
  params: Record<string, unknown>,
  input: CodaType | undefined,
): string[] {
  const inputs = { in: input }
  return validateColumnParams(
    definition,
    makeInferContext(definition, params as never, inputs),
  )
}

const picker = (extra: Partial<ParamDef> = {}): ParamDef =>
  ({ id: 'col', kind: 'column', label: 'Column', from: 'in', default: '', ...extra }) as ParamDef

describe('an input that says nothing', () => {
  it('is silent when the port is unconnected', () => {
    // Reported by the port itself; don't double up.
    expect(issues(def(picker()), { col: 'gone' }, undefined)).toEqual([])
  })

  it('is silent when the port is connected but carries no schema', () => {
    /*
     * The case this rule was written for: `core.pivot` declares `observesOutputSchema`
     * because its wide columns *are* the distinct values of its Columns field, so it
     * publishes none until it has run — and none again after a reload, which is how a saved
     * graph opens. Reading that as "this table has no columns" put a warning on every column
     * param downstream of it at once, about a table nobody had seen.
     */
    expect(issues(def(picker({ dtypes: ['i64', 'f64'] })), { col: 'pre' }, T.table())).toEqual([])
  })

  it('does not report drift against a schema it cannot see either', () => {
    // The stored column is most likely still correct; inviting someone to re-pick from an
    // empty list is worse advice than silence.
    expect(issues(def(picker()), { col: 'anything' }, T.table())).toEqual([])
  })
})

describe('an input with nothing matching', () => {
  it('names the restriction and the control', () => {
    const only = T.table(tableSchema(column('type', 'str')))
    expect(issues(def(picker({ dtypes: ['i64', 'f64'] })), { col: '' }, only)).toEqual([
      'No columns of type i64/f64 available for "Column"',
    ])
  })

  it('says nothing for an optional picker, which is allowed to have nothing to offer', () => {
    const only = T.table(tableSchema(column('type', 'str')))
    expect(
      issues(def(picker({ dtypes: ['i64', 'f64'], optional: true })), { col: '' }, only),
    ).toEqual([])
  })
})

describe('a stored column that has disappeared', () => {
  const table = T.table(SCHEMA)

  it('reports a chosen column as missing, because that is what now happens to it', () => {
    // `resolveColumn` keeps it, so there is no fallback to name — the singular says exactly
    // what the plural has always said.
    expect(issues(def(picker()), { col: 'weight' }, table)).toEqual(['Missing column: weight'])
  })

  it('names the fallback only where one is actually taken', () => {
    // A stored value still equal to the definition's declared default is a suggestion, not a
    // decision, so it does fall back — and says so.
    expect(issues(def(picker({ default: 'weight' })), { col: 'weight' }, table)).toEqual([
      'Column "weight" is gone — using "bodyId"',
    ])
  })

  it('claims no fallback for an optional picker, because there is not one', () => {
    // `resolveColumn` answers *off* here rather than reaching for the first column, so the
    // message above would be a false statement and not merely a loud one.
    expect(issues(def(picker({ optional: true })), { col: 'weight' }, table)).toEqual([
      'Column "weight" is gone',
    ])
  })

  it('still reports a column somebody actually chose', () => {
    // A link label quietly drawing nothing is exactly the silent failure this check is for —
    // `out.network`'s edge label picker is the live case, and it is optional.
    expect(issues(def(picker({ optional: true })), { col: 'degreeOut' }, table)).toHaveLength(1)
  })

  it('says nothing when the stored value is still the definition’s own default', () => {
    /*
     * A default is the definition's suggestion, not a decision to report drift on.
     * `out.scatter` declares `bodyId` so a neuron table needs no configuring at all, and on a
     * table without one it means row positions — the node working, rather than a column
     * anybody has to re-pick.
     */
    const noIds = T.table(tableSchema(column('type', 'str'), column('L', 'f64')))
    expect(
      issues(def(picker({ optional: true, default: 'bodyId' })), { col: 'bodyId' }, noIds),
    ).toEqual([])
  })

  it('reports a multi-column picker’s missing entries', () => {
    const multi: ParamDef = {
      id: 'cols',
      kind: 'columns',
      label: 'Columns',
      from: 'in',
      default: [],
    }
    expect(issues(def(multi), { cols: ['type', 'weight', 'nope'] }, table)).toEqual([
      'Missing column(s): weight, nope',
    ])
  })
})

describe('a picker that is not currently showing', () => {
  it('is not validated, since a hidden control cannot be fixed', () => {
    const hidden = picker({ visibleIf: () => false })
    expect(issues(def(hidden), { col: 'weight' }, T.table(SCHEMA))).toEqual([])
  })
})

/**
 * What the resolver answers, which is the half the messages above have to agree with.
 *
 * The rule that matters: a column somebody chose is kept even when the current schema does not
 * list it. Substituting the first column instead is what let a Pivot quietly pivot a field
 * against itself when neuPrint discovery had not landed — see `resolveColumn`.
 */
describe('resolving a column', () => {
  const table = T.table(SCHEMA)
  const pick = (param: Partial<ParamDef>, stored: unknown) =>
    resolveColumn(picker(param) as never, { col: stored } as never, { in: table })

  it('uses the stored name when the schema lists it', () => {
    expect(pick({}, 'type')).toBe('type')
  })

  it('keeps a chosen name the schema does not list, rather than substituting', () => {
    // The schema may simply not have arrived. Answering "bodyId" here is not a degraded
    // answer to the question asked — it is a confident answer to a different one.
    expect(pick({}, 'somaSide')).toBe('somaSide')
  })

  it('falls back for an empty default, which means decide for me', () => {
    expect(pick({}, '')).toBe('bodyId')
    expect(pick({ dtypes: ['str'] }, '')).toBe('type')
  })

  it('falls back for a named default, which is a suggestion rather than a decision', () => {
    // `out.scatter` opens on `pre`/`post` so a neuron table needs no configuring; on a table
    // without them it must still find something to plot.
    expect(pick({ default: 'somaSide' }, 'somaSide')).toBe('bodyId')
  })

  it('answers off for an optional picker, before any of that', () => {
    expect(pick({ optional: true }, 'somaSide')).toBeUndefined()
  })

  it('answers nothing when there is nothing to offer and nothing was chosen', () => {
    expect(resolveColumn(picker({}) as never, { col: '' } as never, { in: T.table() })).toBeUndefined()
  })
})
