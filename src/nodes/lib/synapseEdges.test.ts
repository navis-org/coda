/**
 * The fold, and the agreement between its two halves.
 *
 * Invariant 3's assertion for this pair lives here rather than in `tableOps.test.ts`, which is
 * hand-written per op over ops that take a table: this one takes a plan as well, and the schema
 * it promises moves with four of that plan's five fields.
 *
 * The case worth reading first is the orientation pair. A neuron's inputs and its outputs in one
 * query-relative cloud fold to two connections either way, with the same two weights — and read
 * without the flip, one of them points backwards. A table that is entirely plausible, the right
 * shape, the right size, and wrong about the direction of half the synapses in it.
 */

import { describe, expect, it } from 'vitest'

import { column, columnNames, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { EdgePlan } from './synapseEdges'
import { droppedGroupColumns, synapseEdgesSchema, synapseEdgesTable } from './synapseEdges'

const CLOUD = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('partnerId', 'str'),
  column('partnerType', 'str'),
  column('polarity', 'str'),
  column('roi', 'str'),
)

const PLAN: EdgePlan = {
  source: 'neuronId',
  target: 'partnerId',
  sourceType: 'type',
  targetType: 'partnerType',
  orientation: 'fixed',
  by: [],
}

type Row = [
  neuronId: string | null,
  type: string | null,
  partnerId: string | null,
  partnerType: string | null,
  polarity: string | null,
  roi: string | null,
]

/** Rows as tuples, in the schema's order, because a cloud is read row-wise here. */
function cloud(rows: Row[]): TableValue {
  return makeTable(CLOUD, {
    neuronId: rows.map((r) => r[0]),
    type: rows.map((r) => r[1]),
    partnerId: rows.map((r) => r[2]),
    partnerType: rows.map((r) => r[3]),
    polarity: rows.map((r) => r[4]),
    roi: rows.map((r) => r[5]),
  })
}

/** Every edge as `pre>post` at its weight, which is what most of these assertions are about. */
function edges(table: TableValue): string[] {
  const pre = table.data['preId'] as string[]
  const post = table.data['postId'] as string[]
  const weight = table.data['weight'] as number[]
  return pre.map((id, i) => `${id}>${post[i]}=${weight[i]}`)
}

describe('the schema half and the value half agree', () => {
  const plans: Array<[string, EdgePlan]> = [
    ['both types, no split', PLAN],
    ['no types', { ...PLAN, sourceType: undefined, targetType: undefined }],
    ['one type', { ...PLAN, targetType: undefined }],
    ['split on a region', { ...PLAN, by: ['roi'] }],
    ['polarity', { ...PLAN, orientation: 'polarity', polarity: 'polarity', by: ['roi'] }],
    // A picker naming a column the schema lacks reaches neither half from the node, but the two
    // must still answer the same thing — which is the failure `present` exists to make impossible.
    ['a type column that is not there', { ...PLAN, targetType: 'gone' }],
  ]
  const rows = cloud([
    ['1', 'LC4', '2', 'PLP1', 'pre', 'LO(R)'],
    ['1', 'LC4', '2', 'PLP1', 'post', 'PLP(R)'],
  ])

  for (const [name, plan] of plans) {
    it(name, () => {
      const promised = synapseEdgesSchema(CLOUD, plan)!
      const { table } = synapseEdgesTable(rows, plan)
      expect(columnNames(table.schema)).toEqual(columnNames(promised))
      for (const col of promised.columns) expect(table.data[col.name]).toBeDefined()
    })
  }

  it('publishes nothing for a schema that has not arrived', () => {
    expect(synapseEdgesSchema(undefined, PLAN)).toBeUndefined()
  })

  /* Connectivity's order, which is what makes the two results interchangeable downstream. */
  it("names its columns Connectivity's way, with the split columns after the weight", () => {
    expect(columnNames(synapseEdgesSchema(CLOUD, { ...PLAN, by: ['roi'] })!)).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
      'roi',
    ])
  })

  /* `idText`'s output is text, so an `i64` id column may not be declared through (invariant 8). */
  it('declares both ends as text whatever the cloud said', () => {
    const wide = tableSchema(column('neuronId', 'i64'), column('partnerId', 'i64'))
    const schema = synapseEdgesSchema(wide, {
      ...PLAN,
      sourceType: undefined,
      targetType: undefined,
    })!
    expect(schema.columns.map((c) => c.dtype)).toEqual(['str', 'str', 'i64'])
  })
})

describe('counting', () => {
  it('counts rows per pair, in first-appearance order', () => {
    const { table } = synapseEdgesTable(
      cloud([
        ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
        ['2', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
        ['1', 'LC4', '3', 'PLP1', 'pre', 'PLP(R)'],
      ]),
      PLAN,
    )
    expect(edges(table)).toEqual(['1>3=2', '2>3=1'])
  })

  it('carries a type for each end, and the first non-null wins', () => {
    const { table } = synapseEdgesTable(
      cloud([
        ['1', null, '3', 'PLP1', 'pre', 'LO(R)'],
        ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
      ]),
      PLAN,
    )
    expect(table.data['preType']).toEqual(['LC4'])
    expect(table.data['postType']).toEqual(['PLP1'])
  })

  /* A weight is a count. Nothing sums a confidence, which is what `weight` holds on CAVE. */
  it('splits a pair on an extra column', () => {
    const { table } = synapseEdgesTable(
      cloud([
        ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
        ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
        ['1', 'LC4', '3', 'PLP1', 'pre', 'PLP(R)'],
      ]),
      { ...PLAN, by: ['roi'] },
    )
    expect(edges(table)).toEqual(['1>3=2', '1>3=1'])
    expect(table.data['roi']).toEqual(['LO(R)', 'PLP(R)'])
  })

  /* `Points in Volumes` writes a null region on every point of its `Outside` port. */
  it('keeps a null split value as a group of its own', () => {
    const { table } = synapseEdgesTable(
      cloud([
        ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
        ['1', 'LC4', '3', 'PLP1', 'pre', null],
      ]),
      { ...PLAN, by: ['roi'] },
    )
    expect(table.data['roi']).toEqual(['LO(R)', null])
  })

  /* Invariant 8: an eighteen-digit root id is text, and two adjacent ones are two neurons. */
  it('groups wide ids as themselves', () => {
    const a = '720575940632499757'
    const b = '720575940632499758'
    const { table } = synapseEdgesTable(
      cloud([
        [a, '', '3', '', 'pre', ''],
        [b, '', '3', '', 'pre', ''],
      ]),
      { ...PLAN, sourceType: undefined, targetType: undefined },
    )
    expect(table.data['preId']).toEqual([a, b])
  })
})

describe('orientation', () => {
  /*
   * One neuron's inputs and outputs in one query-relative cloud. Body 1 drives 3 twice and is
   * driven by 2 twice; read with the flip that is four synapses over two connections pointing
   * the right way, and read without it the two connections are 1→3 and 1→2, the second of which
   * is backwards. Nothing about the second table looks wrong.
   */
  const queryRelative = cloud([
    ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
    ['1', 'LC4', '3', 'PLP1', 'pre', 'LO(R)'],
    ['1', 'LC4', '2', 'LC4', 'post', 'LO(R)'],
    ['1', 'LC4', '2', 'LC4', 'post', 'LO(R)'],
  ])

  it('flips a post row, so inputs and outputs stay apart', () => {
    const { table } = synapseEdgesTable(queryRelative, {
      ...PLAN,
      orientation: 'polarity',
      polarity: 'polarity',
    })
    expect(edges(table)).toEqual(['1>3=2', '2>1=2'])
  })

  it('counts them the wrong way round without it — which is why the control exists', () => {
    const { table } = synapseEdgesTable(queryRelative, PLAN)
    expect(edges(table)).toEqual(['1>3=2', '1>2=2'])
  })

  it('flips both types with the ids', () => {
    const { table } = synapseEdgesTable(cloud([['1', 'LC4', '2', 'T4a', 'post', 'LO(R)']]), {
      ...PLAN,
      orientation: 'polarity',
      polarity: 'polarity',
    })
    expect(table.data['preId']).toEqual(['2'])
    expect(table.data['preType']).toEqual(['T4a'])
    expect(table.data['postType']).toEqual(['LC4'])
  })

  /* The safe direction, argued on `SynapseEdges.unoriented`. */
  it('counts a cell that is neither, and leaves the row alone', () => {
    const { table, unoriented } = synapseEdgesTable(
      cloud([
        ['1', '', '2', '', 'presynaptic', ''],
        ['1', '', '2', '', 'POST', ''],
      ]),
      {
        ...PLAN,
        sourceType: undefined,
        targetType: undefined,
        orientation: 'polarity',
        polarity: 'polarity',
      },
    )
    expect(unoriented).toBe(1)
    expect(edges(table)).toEqual(['1>2=1', '2>1=1'])
  })

  it('reads nothing at all under the fixed orientation', () => {
    const { unoriented } = synapseEdgesTable(cloud([['1', '', '2', '', 'nonsense', '']]), {
      ...PLAN,
      sourceType: undefined,
      targetType: undefined,
    })
    expect(unoriented).toBe(0)
  })
})

describe('what it refuses and what it drops', () => {
  it('refuses two pickers on one column rather than counting self-loops', () => {
    expect(() =>
      synapseEdgesTable(cloud([['1', '', '2', '', 'pre', '']]), {
        ...PLAN,
        target: 'neuronId',
      }),
    ).toThrow(/self-loop/)
  })

  it('drops a synapse with no id at one end, and counts it', () => {
    const { table, dropped } = synapseEdgesTable(
      cloud([
        ['1', 'LC4', '2', 'LC4', 'pre', ''],
        ['1', 'LC4', null, null, 'pre', ''],
      ]),
      PLAN,
    )
    expect(dropped).toBe(1)
    expect(edges(table)).toEqual(['1>2=1'])
  })

  /*
   * A CAVE synapse cloud really does carry a column called `weight` — the cleft score — so the
   * name this node owns is one somebody can pick without meaning anything by it.
   */
  it('ignores a split column this node already owns, and says which', () => {
    const plan: EdgePlan = { ...PLAN, by: ['roi', 'weight', 'neuronId', 'roi'] }
    expect(droppedGroupColumns(plan)).toEqual(['weight', 'neuronId'])
    const schema = synapseEdgesSchema(CLOUD, plan)!
    expect(columnNames(schema).filter((n) => n === 'weight')).toHaveLength(1)
  })

  /*
   * Only where it is doing the orienting: under the fixed reading a polarity column is an
   * ordinary column, constant on a `Synapses Between` cloud and a legitimate thing to split on.
   */
  it('spends the polarity column only under the polarity orientation', () => {
    expect(droppedGroupColumns({ ...PLAN, by: ['polarity'] })).toEqual([])
    expect(
      droppedGroupColumns({
        ...PLAN,
        orientation: 'polarity',
        polarity: 'polarity',
        by: ['polarity'],
      }),
    ).toEqual(['polarity'])
  })

  it('answers an empty cloud with an empty edge list rather than throwing', () => {
    const { table } = synapseEdgesTable(cloud([]), { ...PLAN, by: ['roi'] })
    expect(table.length).toBe(0)
    expect(columnNames(table.schema)).toContain('roi')
  })
})
