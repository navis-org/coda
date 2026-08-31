/**
 * `Edit Table`'s op. The two things worth pinning are invariant 3 — `editSchema` and
 * `editTable` agreeing about dtypes and about columns that did not exist a moment ago — and
 * the direction every failure errs in, which is the opposite of `tableFilter.test.ts`'s and is
 * the reason this node is not just the Table viewer's filters with an assignment on the end.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { EditSetter } from './tableEdits'
import { decodeSetters, editPlan, editSchema, editTable, encodeSetters } from './tableEdits'

const NEURONS = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('side', 'str'),
  column('pre', 'i64', 'synapses'),
)

function neurons(): TableValue {
  return tableFromRows(
    NEURONS,
    [
      { neuronId: '100', type: 'LC4', side: 'left', pre: 120 },
      { neuronId: '101', type: 'LC4', side: 'right', pre: 80 },
      { neuronId: '102', type: 'LPLC2', side: 'left', pre: 40 },
      { neuronId: '103', type: null, side: 'right', pre: 5 },
    ],
    'neurons',
  )
}

function setter(where: string, col: string, value: string): EditSetter {
  return { where, column: col, value }
}

/** Invariant 3, asked the way `tableOps.test.ts` asks it. */
function expectSchemaAgreement(schema: ReturnType<typeof editSchema>, actual: TableValue) {
  expect(schema).toBeDefined()
  expect(actual.schema.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual(
    schema!.columns.map((c) => `${c.name}:${c.dtype}`),
  )
}

describe('storage', () => {
  it('round-trips a setter', () => {
    const setters = [setter('type=LC4', 'type', 'LC4a'), setter('', 'note', '""')]
    expect(decodeSetters(encodeSetters(setters))).toEqual(setters)
  })

  it('keeps a half-typed row and drops an abandoned one', () => {
    expect(encodeSetters([setter('', 'type', '')])).toHaveLength(1)
    expect(encodeSetters([setter('', '', '')])).toHaveLength(0)
  })

  it('drops anything unreadable rather than throwing', () => {
    expect(decodeSetters(['not json', '{"w":1}', '[]', 7, null])).toEqual([])
    expect(decodeSetters('nonsense')).toEqual([])
  })
})

describe('editing in place', () => {
  it('writes only the rows the filter matches', () => {
    const setters = [setter('type=LC4 side=left', 'type', 'LC4a')]
    const out = editTable(neurons(), setters)
    expect(out.table.data.type).toEqual(['LC4a', 'LC4', 'LPLC2', null])
    expect(out.matched).toEqual([1])
    expectSchemaAgreement(editSchema(NEURONS, setters), out.table)
  })

  it('treats a blank filter as every row', () => {
    const out = editTable(neurons(), [setter('', 'side', 'unknown')])
    expect(out.table.data.side).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(out.matched).toEqual([4])
  })

  it('leaves the input table alone', () => {
    const input = neurons()
    editTable(input, [setter('', 'type', 'x')])
    expect(input.data.type).toEqual(['LC4', 'LC4', 'LPLC2', null])
  })

  it('keeps the input schema by identity when no column changes', () => {
    /*
     * Not merely an equal schema: identity is what every downstream `useMemo([schema])` and
     * column picker keys on, and `editPlan` runs on every graph mutation — including every frame
     * of a node drag.
     */
    expect(editSchema(NEURONS, [setter('type==LC4', 'type', 'x')])).toBe(NEURONS)
    expect(editSchema(NEURONS, [setter('', 'group', 'A')])).not.toBe(NEURONS)
  })

  it('passes the table through untouched when there is nothing to do', () => {
    const input = neurons()
    expect(editTable(input, []).table).toBe(input)
    // A row somebody is still typing is inert, not a reason to copy every column.
    expect(editTable(input, [setter('type=LC4', 'type', '')]).table).toBe(input)
  })

  it('keeps the neurons kind, because no column is ever dropped', () => {
    expect(editTable(neurons(), [setter('', 'note', 'x')]).table.kind).toBe('neurons')
  })

  it('writes an empty value only when it is asked for with quotes', () => {
    const out = editTable(neurons(), [setter('type=LPLC2', 'type', '""')])
    expect(out.table.data.type).toEqual(['LC4', 'LC4', null, null])
    // The same field left blank is an unfinished row, and says so rather than clearing anything.
    const blank = editPlan(NEURONS, [setter('type=LPLC2', 'type', '')])
    expect(blank.targets).toHaveLength(0)
    expect(blank.issues.join(' ')).toMatch(/no value/)
  })
})

describe('columns that did not exist', () => {
  it('adds one, null outside the matched rows, and agrees with its schema half', () => {
    const setters = [setter('side=left', 'group', 'A')]
    const out = editTable(neurons(), setters)
    expect(out.table.data.group).toEqual(['A', null, 'A', null])
    expectSchemaAgreement(editSchema(NEURONS, setters), out.table)
    expect(editPlan(NEURONS, setters).added).toEqual([{ column: 'group', dtype: 'str' }])
  })

  it('types a new column from the value, not always as text', () => {
    const setters = [setter('', 'rank', '3')]
    expectSchemaAgreement(editSchema(NEURONS, setters), editTable(neurons(), setters).table)
    expect(editSchema(NEURONS, setters)!.columns.at(-1)).toEqual({ name: 'rank', dtype: 'i64' })
  })

  it('keeps an id-shaped value as text rather than rounding it into a number', () => {
    /*
     * Invariant 8, reached through the dtype guess rather than through a picker. `Number()` reads
     * this as 864691135463487600 — a different neuron, with nothing to say so — which is why
     * `naturalDType` asks `inferDType` instead of testing `Number.isFinite` itself.
     */
    const setters = [setter('', 'partnerId', '864691135463487579')]
    expect(editSchema(NEURONS, setters)!.columns.at(-1)).toEqual({
      name: 'partnerId',
      dtype: 'str',
    })
    expect(editTable(neurons(), setters).table.data.partnerId?.[0]).toBe('864691135463487579')
  })

  it('keeps a zero-padded code as text, for the same reason', () => {
    expect(editSchema(NEURONS, [setter('', 'code', '007')])!.columns.at(-1)!.dtype).toBe('str')
  })

  it('widens rather than rounding when an id is written into a number column', () => {
    // The other half: the column exists and is numeric, so the value has to widen it.
    const setters = [setter('type==LC4', 'pre', '864691135463487579')]
    const out = editTable(neurons(), setters)
    expect(out.table.data.pre).toEqual(['864691135463487579', '864691135463487579', '40', '5'])
    expectSchemaAgreement(editSchema(NEURONS, setters), out.table)
  })

  it('publishes the column even when the rule it came with is broken', () => {
    // The schema is decided by column and value alone — see the header. A column blinking out of
    // every downstream picker while a regex is half-typed is worse than one that arrives early.
    const setters = [setter('~[bad', 'group', 'A')]
    const plan = editPlan(NEURONS, setters)
    expect(plan.added).toEqual([{ column: 'group', dtype: 'str' }])
    expect(plan.targets[0]!.problems).not.toEqual([])
    const out = editTable(neurons(), setters)
    expect(out.table.data.group).toEqual([null, null, null, null])
    expectSchemaAgreement(plan.schema, out.table)
  })

  it('resolves an existing column case-insensitively rather than adding a second one', () => {
    const setters = [setter('', 'TYPE', 'x')]
    expect(editPlan(NEURONS, setters).added).toEqual([])
    expect(editTable(neurons(), setters).table.data.type).toEqual(['x', 'x', 'x', 'x'])
  })
})

describe('dtypes', () => {
  it('widens a numeric column to text, existing values included', () => {
    const setters = [setter('type=LPLC2', 'pre', 'unknown')]
    const out = editTable(neurons(), setters)
    expect(out.table.data.pre).toEqual(['120', '80', 'unknown', '5'])
    expectSchemaAgreement(editSchema(NEURONS, setters), out.table)
  })

  it('widens an integer column to float rather than to text', () => {
    const setters = [setter('type=LPLC2', 'pre', '1.5')]
    const out = editTable(neurons(), setters)
    expect(out.table.data.pre).toEqual([120, 80, 1.5, 5])
    expect(editSchema(NEURONS, setters)!.columns.find((c) => c.name === 'pre')!.dtype).toBe(
      'f64',
    )
  })

  it('decides a column dtype once for every setter writing it', () => {
    const setters = [setter('type=LC4', 'pre', '7'), setter('type=LPLC2', 'pre', 'unknown')]
    const out = editTable(neurons(), setters)
    // `7` lands as text too, or the column's values would disagree with its own declaration.
    expect(out.table.data.pre).toEqual(['7', '7', 'unknown', '5'])
    expectSchemaAgreement(editSchema(NEURONS, setters), out.table)
  })

  it('keeps the unit when a column widens', () => {
    const widened = editSchema(NEURONS, [setter('', 'pre', 'x')])!.columns.find(
      (c) => c.name === 'pre',
    )
    expect(widened).toEqual({ name: 'pre', dtype: 'str', unit: 'synapses' })
  })

  it('does not widen a column just to clear a cell', () => {
    const setters = [setter('type=LPLC2', 'pre', '""')]
    const out = editTable(neurons(), setters)
    expect(out.table.data.pre).toEqual([120, 80, null, 5])
    expectSchemaAgreement(editSchema(NEURONS, setters), out.table)
  })

  it('parses a numeric literal into a numeric column', () => {
    expect(editTable(neurons(), [setter('type=LPLC2', 'pre', '9')]).table.data.pre).toEqual([
      120, 80, 9, 5,
    ])
  })
})

describe('a rule that cannot be resolved switches itself off', () => {
  it('refuses a bare term rather than matching any column', () => {
    const setters = [setter('LC4', 'type', 'x')]
    const plan = editPlan(NEURONS, setters)
    expect(plan.targets[0]!.problems.join(' ')).toMatch(/column==value/)
    expect(editTable(neurons(), setters).table.data.type).toEqual(['LC4', 'LC4', 'LPLC2', null])
  })

  it('disables a rule whose filter names a column that does not exist', () => {
    // The case this rule exists for: `fieldTermsMatch` reads an unknown column as "did not
    // match", so a *negated* term on one matches every row — and one keystroke turns
    // `!type=LC4` into a rule that overwrites the whole table.
    const setters = [setter('!typ=LC4', 'side', 'x')]
    expect(editPlan(NEURONS, setters).targets[0]!.problems).toHaveLength(1)
    expect(editTable(neurons(), setters).table.data.side).toEqual([
      'left',
      'right',
      'left',
      'right',
    ])
  })

  it('reports a filter that does not compile, and changes nothing', () => {
    const out = editTable(neurons(), [setter('~[unclosed', 'type', 'x')])
    expect(out.table.data.type).toEqual(['LC4', 'LC4', 'LPLC2', null])
    expect(out.plan.issues.join(' ')).toMatch(/Edit 1 changes nothing/)
  })

  it('reports nothing about columns while the schema is unknown', () => {
    // A port publishes no schema before its first run, and every rule reading as broken then
    // would badge a node that is perfectly well configured.
    expect(editPlan(undefined, [setter('type=LC4', 'type', 'x')]).issues).toEqual([])
  })
})

describe('rules run in order', () => {
  it('lets a later rule narrow on what an earlier one wrote', () => {
    const out = editTable(neurons(), [
      setter('type=LC4', 'group', 'A'),
      setter('group=A side=left', 'type', 'LC4a'),
    ])
    expect(out.table.data.group).toEqual(['A', 'A', null, null])
    expect(out.table.data.type).toEqual(['LC4a', 'LC4', 'LPLC2', null])
    expect(out.matched).toEqual([2, 1])
  })

  it('lets a later rule overwrite an earlier one', () => {
    const out = editTable(neurons(), [
      setter('', 'side', 'unknown'),
      setter('type=LPLC2', 'side', 'left'),
    ])
    expect(out.table.data.side).toEqual(['unknown', 'unknown', 'left', 'unknown'])
  })
})

describe('what it says out loud', () => {
  it('warns about editing the id column without refusing to', () => {
    const plan = editPlan(NEURONS, [setter('type=LC4', 'neuronId', '999')])
    expect(plan.issues.join(' ')).toMatch(/which neuron a row is about/)
    expect(plan.targets[0]!.problems).toEqual([])
  })

  it('names the widening in words a scientist can act on', () => {
    expect(editPlan(NEURONS, [setter('', 'pre', 'x')]).issues.join(' ')).toMatch(
      /"pre" becomes text: "x" is not a whole number/,
    )
  })

  it('names the applied rules and the pass-through on the plan itself', () => {
    // `active` and `noop` are read by `editTable` and by both export emitters — two of those
    // across the seam, where a disagreement emits a pass-through for a node that edits.
    const plan = editPlan(NEURONS, [
      setter('LC4', 'type', 'x'),
      setter('type==LC4', 'side', 'l'),
    ])
    expect(plan.active.map((t) => t.index)).toEqual([1])
    expect(plan.noop).toBe(false)
    expect(editPlan(NEURONS, []).noop).toBe(true)
    expect(editPlan(NEURONS, [setter('LC4', 'type', 'x')]).noop).toBe(true)
  })

  it('counts the rows each rule changed', () => {
    const out = editTable(neurons(), [
      setter('side=left', 'group', 'A'),
      setter('side=nowhere', 'group', 'B'),
    ])
    expect(out.matched).toEqual([2, 0])
  })
})
