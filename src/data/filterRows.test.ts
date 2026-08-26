/**
 * What a Find Neurons row means.
 *
 * Three things are worth pinning here, and they fail in three different ways.
 *
 * The **lowering** is where a friendly operator becomes a term the existing matcher already
 * understands, and every entry in that table is a chance to widen or narrow a set silently:
 * an unescaped `SMP001(a)` read as a group, an unanchored `LC.*` that starts matching `LPLC1`,
 * an `isIn` with an empty alternative that matches everything.
 *
 * The **null rule** has to survive the lowering. `status is not Traced` must keep the neurons
 * with no status at all, because that is what somebody auditing a dataset for gaps is asking
 * for — and it is the rule a compiler to Cypher has to write out by hand, so a test that only
 * exercised the local path would pass while the server path disagreed.
 *
 * The **refusals** are this module's own, and they are the opposite call from `tableFilter.ts`':
 * a row naming a field the dataset does not have is *reported*, never dropped, because dropping
 * it sends a broader query to a shared production server and the too-large answer looks correct.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import { tableFromRows } from '../core/values'
import type { FilterRow } from './filterRows'
import { arityOf, decodeRows, encodeRows, resolveRows, rowOpsForDType, toTerm } from './filterRows'
import { fieldTermsMatch, prepareFieldTerms } from './terms'

const SCHEMA = tableSchema(
  column('neuronId', 'i64'),
  column('type', 'str'),
  column('status', 'str'),
  column('size', 'i64'),
)

const NEURONS = tableFromRows(SCHEMA, [
  { neuronId: 1, type: 'LC4', status: 'Traced', size: 500 },
  { neuronId: 2, type: 'LPLC1', status: 'Traced', size: 100 },
  { neuronId: 3, type: 'SMP001(a)', status: null, size: 900 },
  { neuronId: 4, type: '', status: 'Assign', size: 50 },
])

const row = (field: string, op: FilterRow['op'], ...values: string[]): FilterRow => ({
  field,
  op,
  values,
})

/** Neuron ids surviving these rows, which is the only thing a caller ever wants. */
function matched(rows: readonly FilterRow[]): number[] {
  const { terms, problems } = resolveRows(SCHEMA, rows)
  expect(problems).toEqual([])
  const prepared = prepareFieldTerms(NEURONS, terms)
  const ids: number[] = []
  for (let i = 0; i < NEURONS.length; i++) {
    if (fieldTermsMatch(prepared, i)) ids.push(Number(NEURONS.data.neuronId![i]))
  }
  return ids
}

describe('lowering', () => {
  it('anchors a regex at both ends, the way Neo4j’s =~ does', () => {
    // The gotcha the whole codebase is written around: LC.* is LC4 and not LPLC1.
    expect(matched([row('type', 'matches', 'LC.*')])).toEqual([1])
  })

  it('does not anchor contains', () => {
    expect(matched([row('type', 'contains', 'LC')])).toEqual([1, 2])
  })

  it('treats an isIn value as a literal, metacharacters and all', () => {
    // Unescaped, `SMP001(a)` is a group and matches `SMP001a` instead of itself.
    expect(matched([row('type', 'isIn', 'SMP001(a)', 'LC4')])).toEqual([1, 3])
  })

  it('anchors an isIn alternation as a whole', () => {
    // Spliced in unwrapped, `^LC4|LPLC1$` would match anything containing LPLC1 at the end.
    expect(matched([row('type', 'isIn', 'LC4')])).toEqual([1])
  })

  it('compares numbers as numbers', () => {
    expect(matched([row('size', 'ge', '500')])).toEqual([1, 3])
  })

  it('is case-sensitive by default and insensitive on request', () => {
    expect(matched([row('type', 'is', 'lc4')])).toEqual([])
    expect(matched([{ ...row('type', 'is', 'lc4'), ignoreCase: true }])).toEqual([1])
  })

  it('ANDs its rows', () => {
    expect(matched([row('type', 'contains', 'LC'), row('size', 'ge', '400')])).toEqual([1])
  })
})

describe('the null rule', () => {
  it('keeps a missing value for "is not"', () => {
    // Neuron 3 has no status at all. Somebody asking for "not Traced" is hunting gaps and
    // means to see it; SQL's three-valued logic would drop it and never say so.
    expect(matched([row('status', 'isNot', 'Traced')])).toEqual([3, 4])
  })

  it('fails a missing value for every positive operator', () => {
    expect(matched([row('status', 'is', 'Traced')])).toEqual([1, 2])
    expect(matched([row('status', 'contains', 'race')])).toEqual([1, 2])
  })

  it('counts both a null and an empty string as empty', () => {
    expect(matched([row('type', 'isEmpty')])).toEqual([4])
    expect(matched([row('status', 'isEmpty')])).toEqual([3])
    expect(matched([row('status', 'notEmpty')])).toEqual([1, 2, 4])
  })
})

describe('storage', () => {
  it('round-trips a row', () => {
    const rows: FilterRow[] = [
      { field: 'type', op: 'isIn', values: ['LC4', 'LC6'], ignoreCase: true },
    ]
    expect(decodeRows(encodeRows(rows))).toEqual(rows)
  })

  it('does not store a row somebody is still filling in', () => {
    // A blank row is component state, never a param: storing one would put a half-typed control
    // in the provenance key and mark everything downstream stale.
    expect(encodeRows([row('', 'is', 'LC4')])).toEqual([])
    expect(encodeRows([row('type', 'is')])).toEqual([])
    // ...but an operator that wants no value is complete as it stands.
    expect(encodeRows([row('type', 'isEmpty')])).toHaveLength(1)
  })

  it('drops an unreadable entry rather than throwing', () => {
    const good = encodeRows([row('type', 'is', 'LC4')])[0]!
    expect(decodeRows(['not json', '{"f":"type"}', '{"f":"t","op":"nope","v":[]}', good])).toEqual(
      [{ field: 'type', op: 'is', values: ['LC4'] }],
    )
    expect(decodeRows('not even an array')).toEqual([])
  })

  it('drops an empty alternative, which would otherwise widen an isIn to everything', () => {
    expect(decodeRows(['{"f":"type","op":"isIn","v":["LC4",""]}'])).toEqual([
      { field: 'type', op: 'isIn', values: ['LC4'] },
    ])
  })
})

describe('resolving against a schema', () => {
  it('reports a field the dataset does not have, rather than dropping it', () => {
    // The CAVE/CATMAID failure this whole design exists to make impossible: a filter that
    // cannot be applied must not quietly return a larger answer.
    const { terms, problems } = resolveRows(SCHEMA, [row('hemilineage', 'is', 'x')])
    expect(terms).toEqual([])
    expect(problems).toEqual([
      { field: 'hemilineage', message: expect.stringContaining('no "hemilineage"') },
    ])
  })

  it('reports an operator the column’s type cannot answer', () => {
    const { problems } = resolveRows(SCHEMA, [row('size', 'contains', '5')])
    expect(problems[0]?.message).toContain('i64 column')
  })

  it('reports a regex that does not compile', () => {
    const { problems } = resolveRows(SCHEMA, [row('type', 'matches', 'LC(')])
    expect(problems[0]?.message).toContain('Invalid regex')
  })

  it('reports a non-numeric comparison value', () => {
    const { problems } = resolveRows(SCHEMA, [row('size', 'ge', 'big')])
    expect(problems[0]?.message).toContain('is not a number')
  })

  it('lowers without checking when the schema has not arrived', () => {
    /*
     * Unknown is not missing, and there are two ways to get that wrong in opposite directions.
     * Reporting every row as broken sends somebody to fix a graph that is fine; answering with
     * *no terms* reads as a query with no filters, and an exporter taking that literally writes
     * a notebook whose filters have silently vanished. So the rows lower, and nothing is said.
     */
    expect(resolveRows(undefined, [row('hemilineage', 'is', 'x')])).toEqual({
      terms: [toTerm(row('hemilineage', 'is', 'x'))],
      problems: [],
    })
  })

  it('still drops a row nobody has finished filling in, schema or no schema', () => {
    expect(resolveRows(undefined, [row('type', 'is')]).terms).toEqual([])
  })

  it('addresses the column by its own spelling', () => {
    const { terms } = resolveRows(SCHEMA, [row('TYPE', 'is', 'LC4')])
    expect(terms[0]?.field).toBe('type')
  })
})

describe('the operator vocabulary', () => {
  it('offers no isIn on a numeric column', () => {
    // Its lowering matches an alternation against `String(cell)`, which holds for part of a
    // float column and not the rest depending on how the backend serialised it.
    expect(rowOpsForDType('i64').map((o) => o.value)).not.toContain('isIn')
    expect(rowOpsForDType('str').map((o) => o.value)).toContain('isIn')
  })

  it('falls through to the text set for an unknown dtype', () => {
    expect(rowOpsForDType(undefined)).toEqual(rowOpsForDType('str'))
  })

  it('says how many values each operator takes', () => {
    expect(arityOf('isEmpty')).toBe('none')
    expect(arityOf('isIn')).toBe('many')
    expect(arityOf('contains')).toBe('one')
  })

  it('lowers every operator it offers', () => {
    // The guard on the exhaustive switch: an operator added to the vocabulary without a
    // lowering would match nothing at all, silently.
    for (const dtype of ['str', 'i64', 'bool'] as const) {
      for (const { value } of rowOpsForDType(dtype)) {
        expect(toTerm(row('type', value, 'x'))).toMatchObject({ kind: 'field', field: 'type' })
      }
    }
  })
})
