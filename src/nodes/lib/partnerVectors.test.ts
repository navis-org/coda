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

/** One neuron's `cnFrac`, which is per neuron and repeated down its rows. */
function coverage(table: TableValue, neuron: CellValue): number | undefined {
  const ids = getColumn(table, 'neuronId')
  const fracs = getColumn(table, 'cnFrac')
  for (let i = 0; i < table.length; i++) {
    if (ids[i] === neuron) return Number(fracs[i])
  }
  return undefined
}

describe('a shared label space', () => {
  /*
   * The mapping covers neuron 10 and 12 but not 11, 2 or 30 — so neuron 1's downstream partners
   * are partly outside it. Deliberately maps two *different* partners onto one label, which is
   * the whole point of a cross-dataset mapping and the case a per-partner check would miss.
   */
  const LABELS = new Map([
    ['10', 'shared:X'],
    ['12', 'shared:X'],
    ['20', 'shared:Y'],
  ])

  it('names partners by the shared label, pooling two that map onto one', () => {
    // 10 and 12 are separate partners with separate types; under the mapping they are one
    // feature carrying both weights (3 + 1).
    expect(vector(vectors({ labels: LABELS }), 1)).toEqual({
      'out:shared:X': 4,
      'in:shared:Y': 7,
    })
  })

  it('overrides Partners by rather than combining with it', () => {
    // `partnerBy: 'id'` would normally make every partner its own feature. The mapping wins,
    // because a feature outside the shared space cannot make two datasets alike either way.
    expect(vector(vectors({ labels: LABELS, partnerBy: 'id' }), 1)).toEqual({
      'out:shared:X': 4,
      'in:shared:Y': 7,
    })
  })

  it('drops a partner the mapping does not cover rather than falling back to its type', () => {
    const table = vectors({ labels: LABELS })
    // Partner 11 is typed `null` and partner 2 is typed `B`; neither is in the mapping, and
    // neither appears. Under no mapping, both would be features.
    expect(Object.keys(vector(table, 1))).not.toContain('out:B')
    expect(Object.keys(vector(table, 1)).some((f) => f.includes('11'))).toBe(false)
  })

  it('says how many connections it dropped for want of a label', () => {
    const messages: string[] = []
    vectors({ labels: LABELS }, { warn: (m) => messages.push(m) })
    expect(messages.join(' ')).toMatch(/mapping does not cover/)
  })

  it('leaves the two existing rules exactly as they were when nothing is wired', () => {
    // The mapping is an override, not a new default: no map means the type/id rules stand.
    expect(vector(vectors(), 1)).toEqual(vector(vectors({}), 1))
    expect(Object.keys(vector(vectors(), 1))).toContain('out:X')
  })
})

describe('cnFrac', () => {
  const LABELS = new Map([
    ['10', 'shared:X'],
    ['12', 'shared:X'],
    ['20', 'shared:Y'],
  ])

  it('is the share of a neuron’s weight that survived the restriction', () => {
    /*
     * Neuron 1's attributable weight is 3 + 1 + 2 (downstream) + 7 (upstream, from 20) + 4
     * (the `both` edge to neuron 2) = 17. Under the mapping it keeps 3 + 1 + 7 = 11, losing
     * partner 11 (2) and partner 2 (4).
     */
    expect(coverage(vectors({ labels: LABELS }), 1)).toBeCloseTo(11 / 17, 6)
  })

  it('is 1 where nothing was dropped', () => {
    // The default rules keep every partner, so every neuron is fully represented.
    expect(coverage(vectors(), 1)).toBe(1)
  })

  it('counts what `Untyped partners ▸ drop` removes too, not only a mapping', () => {
    // Partner 11 is untyped; dropping it is the same subtraction by another route, and cnFrac
    // is the one number that says so.
    const dropped = coverage(vectors({ untyped: 'drop' }), 1)
    expect(dropped).toBeLessThan(1)
    expect(dropped).toBeCloseTo(15 / 17, 6)
  })

  it('warns about the worst neuron by name rather than a mean', () => {
    /*
     * A mean over a thousand neurons hides the neuron this is about. Neuron 2 keeps only its
     * edge to partner 10 (5) out of 5 + 4 = 9 — under the floor, so it is named.
     */
    const messages: string[] = []
    vectors({ labels: LABELS }, { warn: (m) => messages.push(m) })
    // Both warnings mention cnFrac — one points at it, this one *is* it.
    const warning = messages.find((m) => m.includes('kept only'))
    expect(warning).toMatch(/Neuron 2 kept only 33%/)
  })

  it('stays quiet where every neuron is well covered', () => {
    const messages: string[] = []
    vectors({}, { warn: (m) => messages.push(m) })
    expect(messages.filter((m) => m.includes('kept only'))).toEqual([])
  })

  it('rides on every row of a neuron, so one Filter drops the badly covered ones', () => {
    const table = vectors({ labels: LABELS })
    const ids = getColumn(table, 'neuronId')
    const fracs = getColumn(table, 'cnFrac')
    const seen = new Map<unknown, Set<unknown>>()
    for (let i = 0; i < table.length; i++) {
      if (!seen.has(ids[i])) seen.set(ids[i], new Set())
      seen.get(ids[i])!.add(fracs[i])
    }
    for (const values of seen.values()) expect(values.size).toBe(1)
  })
})
