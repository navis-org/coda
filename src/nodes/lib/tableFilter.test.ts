/**
 * What a header filter cell means.
 *
 * Two things are worth testing here and they are not the same thing. The **grammar** is
 * borrowed from `neuronSearch.ts`, so most of it is already covered there and what matters is
 * that the borrowing is real — `>=10` in a cell has to be the same comparison `weight>=10` is
 * in the Explore box, including the null rule. The **refusals** are this module's own, and
 * every one of them is a case where doing the obvious thing produces a plausible wrong answer
 * rather than an error: an unresolvable column that empties the table, a half-typed operator
 * that reports itself as broken, a bare number read as a substring.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { FilterClause } from './tableFilter'
import {
  clauseFor,
  decodeClauses,
  encodeClauses,
  filterRowIndices,
  filterTableByClauses,
  parseExpression,
  resolveFilters,
  withClause,
} from './tableFilter'

const SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('weight', 'i64'),
  column('flag', 'bool'),
)

const ROWS = [
  { neuronId: 1, type: 'LC4', weight: 40, flag: true },
  { neuronId: 2, type: 'LC6', weight: 5, flag: false },
  { neuronId: 3, type: 'DNp01', weight: 100, flag: true },
  { neuronId: 4, type: null, weight: null, flag: null },
  { neuronId: 5, type: 'lc11', weight: 10, flag: false },
]

const table = () => tableFromRows(SCHEMA, ROWS)

/** Which neuronIds survive — the readable form of an index list. */
function kept(clauses: FilterClause[]): number[] {
  const t = table()
  const ids = t.data['neuronId'] as number[]
  // `undefined` is the "every row" sentinel, so an unfiltered answer reads as the whole list.
  const rows = filterRowIndices(t, clauses).rows ?? ids.map((_, i) => i)
  return rows.map((row) => ids[row]!)
}

const clause = (column: string, expression: string): FilterClause => ({ column, expression })

describe('parseExpression', () => {
  it('reads the operator off the front', () => {
    expect(parseExpression('>=10')).toEqual({ op: 'ge', value: '10', negate: false })
    expect(parseExpression('<5')).toEqual({ op: 'lt', value: '5', negate: false })
    expect(parseExpression('==LC4')).toEqual({ op: 'eq', value: 'LC4', negate: false })
    expect(parseExpression('~^LC')).toEqual({ op: 'match', value: '^LC', negate: false })
  })

  it('leaves a bare value without an operator, for the column to decide', () => {
    expect(parseExpression('LC')).toEqual({ op: undefined, value: 'LC', negate: false })
  })

  /**
   * `!` leads both a negation and `!=`, and the operator has to win. Read the other way `!=0`
   * becomes "not `=0`" — the same answer by luck, and the wrong one the moment a value is
   * missing, since `!=` is the one operator a null satisfies.
   */
  it('prefers the != operator to a leading negation', () => {
    expect(parseExpression('!=0')).toEqual({ op: 'ne', value: '0', negate: false })
    expect(parseExpression('!frag')).toEqual({ op: undefined, value: 'frag', negate: true })
    expect(parseExpression('-frag')).toEqual({ op: undefined, value: 'frag', negate: true })
  })

  it('says nothing about a cell mid-typing', () => {
    // Every one of these is a state the field passes through between two keystrokes.
    expect(parseExpression('')).toBeUndefined()
    expect(parseExpression('   ')).toBeUndefined()
    expect(parseExpression('>=')).toBeUndefined()
    expect(parseExpression('~')).toBeUndefined()
    // A lone dash must not negate whatever is typed next.
    expect(parseExpression('-')).toEqual({ op: undefined, value: '-', negate: false })
  })
})

describe('a bare value follows the column, not the text', () => {
  it('is equality on a number', () => {
    // Substring would match 100 as well, which is the reading nobody means in a count column.
    expect(kept([clause('weight', '10')])).toEqual([5])
  })

  it('is a substring on text, case-insensitively', () => {
    expect(kept([clause('type', 'LC')])).toEqual([1, 2, 5])
  })

  it('matches a metacharacter literally', () => {
    const t = tableFromRows(tableSchema(column('type', 'str')), [
      { type: 'LC4(R)' },
      { type: 'LC4XR' },
    ])
    // Unescaped, `LC4(R)` is a group and would match `LC4R`; escaped it matches itself.
    expect(filterRowIndices(t, [clause('type', 'LC4(R)')]).rows).toEqual([0])
  })

  /**
   * `undefined` rather than an identity array. A table here can be the whole of male-CNS, and
   * both callers already treat "all rows" specially — building 165,000 indices to say "I did
   * nothing" is the allocation the sentinel exists to avoid.
   */
  it('answers "every row" without building a list of them', () => {
    expect(filterRowIndices(table(), []).rows).toBeUndefined()
    expect(filterRowIndices(table(), [clause('type', '  ')]).rows).toBeUndefined()
  })
})

describe('the null rule is the search language’s', () => {
  it('lets a missing value satisfy != and nothing else', () => {
    // Body 4 has no type at all. `!=LC4` returns it; every positive comparison does not.
    expect(kept([clause('type', '!=LC4')])).toEqual([2, 3, 4, 5])
    expect(kept([clause('type', '==LC4')])).toEqual([1])
    expect(kept([clause('weight', '>0')])).toEqual([1, 2, 3, 5])
  })

  it('applies negation after it, so !LC keeps the untyped row', () => {
    expect(kept([clause('type', '!LC')])).toEqual([3, 4])
  })
})

describe('clauses combine and keep table order', () => {
  it('ANDs every clause', () => {
    expect(kept([clause('type', 'LC'), clause('weight', '>=10')])).toEqual([1, 5])
  })

  /**
   * `runSearch` ranks its hits, which is right for a search box and wrong for a filter: a
   * subset is what every node downstream expects, in the order it arrived.
   */
  it('never reorders', () => {
    expect(kept([clause('weight', '>0')])).toEqual([1, 2, 3, 5])
  })

  it('keeps everything when nothing is set', () => {
    expect(kept([])).toEqual([1, 2, 3, 4, 5])
    expect(kept([clause('type', '  ')])).toEqual([1, 2, 3, 4, 5])
  })
})

describe('what it refuses to do', () => {
  /**
   * The load-bearing one. `prepareFieldTerms` marks an unresolvable column `unknown`, which
   * matches no row — so letting a stale column name through would empty the table and read as
   * a node that had broken, rather than as a filter that could not be applied.
   */
  it('drops a clause on a column the table does not have, rather than emptying it', () => {
    const result = filterRowIndices(table(), [clause('somaSide', 'L')])
    // The "every row" sentinel: nothing was applied, so nothing was cut.
    expect(result.rows).toBeUndefined()
    expect(result.problems).toEqual([
      { column: 'somaSide', message: 'Filter on "somaSide": the table has no such column' },
    ])
  })

  it('drops a regex that does not compile, naming the column', () => {
    const result = filterRowIndices(table(), [clause('type', '~^LC[')])
    expect(result.rows).toBeUndefined()
    expect(result.problems[0]?.column).toBe('type')
    expect(result.problems[0]?.message).toContain('Filter on "type"')
  })

  /**
   * The column travels beside the message, not inside it. Recovered by substring-matching the
   * prose, this message would also mark a column called `abc` as broken, because the value is
   * quoted too.
   */
  it('drops an ordering comparison against something that is not a number', () => {
    const result = filterRowIndices(table(), [clause('weight', '>abc')])
    expect(result.problems).toEqual([
      { column: 'weight', message: 'Filter on "weight": "abc" is not a number' },
    ])
  })

  /**
   * `==` and `!=` against a non-number are not refused: they fall through to a string compare
   * that answers "no row holds that", which is true rather than broken.
   */
  it('allows equality against a non-number', () => {
    expect(filterRowIndices(table(), [clause('weight', '==abc')]).problems).toEqual([])
  })

  /**
   * An upstream Pivot publishes no schema until it has run. Reporting then would badge every
   * clause as broken on every reload — the same unknown-is-not-empty distinction
   * `columnSchemaFor` draws.
   */
  it('says nothing at all when the schema has not arrived', () => {
    const result = resolveFilters(undefined, [clause('nope', '>1')])
    expect(result.problems).toEqual([])
    expect(result.terms).toEqual([])
  })
})

describe('storage', () => {
  it('round-trips a column name that is not an identifier', () => {
    // A wide pivot names its columns after label values and an uploaded CSV after whatever its
    // author typed — neither of which the query language could carry as a field name.
    const clauses = [clause('LC11_02(R)', '>1'), clause('Cell Type', '~^LC')]
    expect(decodeClauses(encodeClauses(clauses))).toEqual(clauses)
  })

  it('drops anything it cannot read instead of throwing', () => {
    expect(decodeClauses(['not json', '{}', '[1,2]', '["only"]', '["",  "x"]'])).toEqual([])
    expect(decodeClauses(undefined)).toEqual([])
    // An empty expression is no clause; a file can still carry one.
    expect(decodeClauses(['["type",""]'])).toEqual([])
  })

  it('replaces a column’s clause rather than adding a second', () => {
    let clauses = withClause([], 'type', 'LC')
    clauses = withClause(clauses, 'type', 'DN')
    expect(clauses).toEqual([clause('type', 'DN')])
    expect(clauseFor(clauses, 'type')).toBe('DN')
    // Clearing a cell removes it, which is what lets "any clauses at all" mean "filtering".
    expect(withClause(clauses, 'type', '')).toEqual([])
    expect(clauseFor([], 'type')).toBe('')
  })
})

describe('filterTableByClauses', () => {
  it('hands back the same table when nothing was cut', () => {
    const t = table()
    // Identity rather than a copy of every column: columns are immutable by contract, so this
    // is what keeps an unfiltered Table node's second port free.
    expect(filterTableByClauses(t, []).table).toBe(t)
    expect(filterTableByClauses(t, [clause('weight', '>=0')]).table).not.toBe(t)
  })

  it('keeps the schema and the kind', () => {
    const t = tableFromRows(SCHEMA, ROWS, 'neurons')
    const out = filterTableByClauses(t, [clause('type', 'LC')]).table
    expect(out.kind).toBe('neurons')
    expect(out.schema.columns.map((c) => c.name)).toEqual(t.schema.columns.map((c) => c.name))
    expect(out.length).toBe(3)
  })
})
