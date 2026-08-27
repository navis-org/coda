/**
 * The connectivity reshape, and the two ways it can learn which end was the query.
 *
 * The fixture is the one `scripts/probe-py-helpers.py` and `scripts/probe-r-helpers.R` use, on
 * purpose: three implementations of one reshape drift, and asking all three the same questions
 * is the cheapest thing that notices. Its one hop-2 edge is what tells the two routes apart —
 * a wired `Neurons` table names the queries outright and reaches it, where the `direction`
 * column can only answer for the first hop.
 */

import { describe, expect, it } from 'vitest'

import { SILENT } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { column, findColumn, tableSchema } from '../../core/types'
import type { CellValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import type { TableValue } from '../../core/values'
import { partnerVectorIssues, partnerVectorSchema, partnerVectorTable } from './partnerVectors'
import type { PartnerVectorSpec } from './partnerVectors'

const EDGES = makeTable(
  tableSchema(
    column('preId', 'i64'),
    column('postId', 'i64'),
    column('preType', 'str'),
    column('postType', 'str'),
    column('weight', 'i64', 'synapses'),
    column('hop', 'i64'),
    column('direction', 'str'),
  ),
  {
    preId: [1, 1, 1, 2, 20, 1, 2],
    postId: [10, 12, 11, 10, 1, 2, 30],
    preType: ['A', 'A', 'A', 'B', 'Y', 'A', 'B'],
    postType: ['X', 'X', null, 'X', 'A', 'B', 'Z'],
    weight: [3, 1, 2, 5, 7, 4, 6],
    hop: [1, 1, 1, 1, 1, 1, 2],
    direction: [
      'downstream',
      'downstream',
      'downstream',
      'downstream',
      'upstream',
      'both',
      'downstream',
    ],
  },
)

const QUERIES = new Set(['1', '2'])

function vectors(spec: Partial<PartnerVectorSpec> = {}, ctx: Warner = SILENT) {
  return partnerVectorTable(
    EDGES,
    {
      partnerBy: 'type',
      untyped: 'id',
      weightColumn: 'weight',
      weighting: 'raw',
      queries: QUERIES,
      ...spec,
    },
    ctx,
  )
}

/** One neuron's vector as `{ feature: weight }`. */
function vector(table: TableValue, neuron: CellValue): Record<string, number> {
  const ids = getColumn(table, 'neuronId')
  const features = getColumn(table, 'feature')
  const weights = getColumn(table, 'weight')
  const out: Record<string, number> = {}
  for (let i = 0; i < table.length; i++) {
    if (ids[i] === neuron) out[String(features[i])] = Number(weights[i])
  }
  return out
}

describe('the reshape', () => {
  /*
   * `out:` and `in:` unconditionally, which is the whole point of the node: a neuron that
   * receives from a type and one that projects to it are not alike for it, and without the
   * prefix the two would land on one feature.
   */
  it('keeps the two directions apart as separate features', () => {
    expect(vector(vectors(), 1)).toEqual({
      'out:X': 4,
      'out:11': 2,
      'out:B': 4,
      'in:Y': 7,
    })
  })

  it('counts an edge inside the query set for both of its ends', () => {
    // Row 6 is 1 → 2, and both are queries: an output for 1 and an input for 2.
    expect(vector(vectors(), 1)['out:B']).toBe(4)
    expect(vector(vectors(), 2)['in:A']).toBe(4)
  })

  /*
   * The aggregation, folded in — which is what removes the Group By that would otherwise sit
   * between this and Similarity. Rows 1 and 2 are two different cells of one type.
   */
  it('sums the partners that share a feature', () => {
    expect(vector(vectors(), 1)['out:X']).toBe(4)
  })

  it('gives every partner its own feature when grouping by id', () => {
    expect(vector(vectors({ partnerBy: 'id' }), 1)).toEqual({
      'out:10': 3,
      'out:12': 1,
      'out:11': 2,
      'out:2': 4,
      'in:20': 7,
    })
  })
})

describe('which end was the query', () => {
  it('takes a wired Neurons table at its word, at any hop', () => {
    expect(vector(vectors(), 2)['out:Z']).toBe(6)
  })

  /*
   * `direction` records how the traversal *found* an edge, which names the neuron that was
   * asked about only while the frontier still is the seed set. So the derived route agrees
   * exactly on the first hop and declines the rest, counting what it left out.
   */
  it('reads the direction column identically on the first hop', () => {
    const said: string[] = []
    const ctx: Warner = { warn: (m) => said.push(m) }
    const derived = vectors({ queries: undefined }, ctx)
    expect(vector(derived, 1)).toEqual(vector(vectors(), 1))
    expect(vector(derived, 2)['out:Z']).toBeUndefined()
    expect(said.join(' ')).toMatch(/past the first hop/)
  })

  it('refuses when neither a Neurons table nor a direction column says', () => {
    const bare = makeTable(
      tableSchema(column('preId', 'i64'), column('postId', 'i64'), column('weight', 'i64')),
      { preId: [1], postId: [2], weight: [1] },
    )
    expect(() =>
      partnerVectorTable(
        bare,
        { partnerBy: 'id', untyped: 'id', weightColumn: 'weight', weighting: 'raw' },
        SILENT,
      ),
    ).toThrow(/which end of an edge was the query/)
  })
})

describe('untyped partners', () => {
  /*
   * The em-dash trap, met properly. `labelOf` pools every absent value into one label, which is
   * right for a pivot axis somebody can look at and wrong for a feature vector: it would make
   * two neurons alike for both touching unnamed things.
   */
  it('stands an untyped partner in for itself under its own id', () => {
    const said: string[] = []
    const ctx: Warner = { warn: (m) => said.push(m) }
    expect(vector(vectors({}, ctx), 1)['out:11']).toBe(2)
    expect(said.join(' ')).toMatch(/has not typed/)
  })

  it('drops it instead when asked, and says the vectors are then short', () => {
    const said: string[] = []
    const ctx: Warner = { warn: (m) => said.push(m) }
    expect(Object.keys(vector(vectors({ untyped: 'drop' }, ctx), 1)).sort()).toEqual([
      'in:Y',
      'out:B',
      'out:X',
    ])
    expect(said.join(' ')).toMatch(/do not account for all of their synapses/)
  })
})

describe('weighting', () => {
  /*
   * Per direction, and that is the useful part: a neuron with far more input than output would
   * otherwise have its whole out-vector rounded away against the in-half.
   */
  it('divides by the query’s total in that direction', () => {
    const fractions = vector(vectors({ weighting: 'fraction' }), 1)
    expect(fractions['out:X']).toBeCloseTo(4 / 10, 12)
    expect(fractions['out:B']).toBeCloseTo(4 / 10, 12)
    expect(fractions['in:Y']).toBe(1)
  })
})

describe('the schema half and the value half', () => {
  it('agree, column for column', () => {
    const table = vectors()
    const declared = partnerVectorSchema(EDGES.schema, { weighting: 'raw', weightColumn: 'weight' })
    expect(table.schema.columns.map((c) => c.name)).toEqual(declared.columns.map((c) => c.name))
    for (const col of declared.columns) expect(table.data[col.name]).toBeDefined()
  })

  /*
   * Derived from the edge list rather than declared `i64`: an id's dtype is a fact about the
   * backend — CAVE's are eighteen digits and travel as text — and restating it here is how a
   * column comes to disagree with the values under it.
   */
  it('carry the id column’s dtype through from the input', () => {
    const asText = makeTable(
      tableSchema(
        column('preId', 'str'),
        column('postId', 'str'),
        column('weight', 'i64'),
        column('direction', 'str'),
      ),
      {
        preId: ['720575940628857210'],
        postId: ['720575940628857211'],
        weight: [4],
        direction: ['downstream'],
      },
    )
    const schema = partnerVectorSchema(asText.schema, { weighting: 'raw' })
    expect(findColumn(schema, 'neuronId')?.dtype).toBe('str')
    const table = partnerVectorTable(
      asText,
      { partnerBy: 'id', untyped: 'id', weightColumn: 'weight', weighting: 'raw' },
      SILENT,
    )
    // Exactly, never through a double — the id is 18 digits and would not survive one.
    expect(getColumn(table, 'neuronId')[0]).toBe('720575940628857210')
    expect(getColumn(table, 'feature')[0]).toBe('out:720575940628857211')
  })

  it('drop the weight’s unit under fractions, since a share is not synapses', () => {
    expect(
      findColumn(partnerVectorSchema(EDGES.schema, { weighting: 'raw', weightColumn: 'weight' }), 'weight')
        ?.unit,
    ).toBe('synapses')
    expect(
      findColumn(
        partnerVectorSchema(EDGES.schema, { weighting: 'fraction', weightColumn: 'weight' }),
        'weight',
      )?.unit,
    ).toBeUndefined()
  })
})

describe('what it says about an input it cannot use', () => {
  it('names the columns it needs, and the node that renames them', () => {
    const wrong = makeTable(
      tableSchema(column('source', 'str'), column('target', 'str'), column('weight', 'i64')),
      { source: ['a'], target: ['b'], weight: [1] },
    )
    expect(partnerVectorIssues(wrong.schema, 'type', false)[0]).toMatch(/preId and postId/)
    expect(partnerVectorIssues(wrong.schema, 'type', false)[0]).toMatch(/Rename Columns/)
  })

  it('says nothing at all about a schema that has not arrived — invariant 2', () => {
    expect(partnerVectorIssues(undefined, 'type', false)).toEqual([])
  })

  it('asks for the Neurons input where there is no direction column to read', () => {
    const noDirection = tableSchema(
      column('preId', 'i64'),
      column('postId', 'i64'),
      column('weight', 'i64'),
    )
    expect(partnerVectorIssues(noDirection, 'id', false)[0]).toMatch(/Neurons input/)
    expect(partnerVectorIssues(noDirection, 'id', true)).toEqual([])
  })
})
