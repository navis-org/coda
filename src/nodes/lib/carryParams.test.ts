/**
 * `Carry fields`: the two halves of carrying a neuron table's columns onto geometry.
 *
 * The schema half and the value half are the pair invariant 3 is about, and here they are
 * separated by a whole fetch — `inferOutputs` promises the widened attribute table at edit time
 * and `evaluate` builds it after the geometry lands, so a disagreement shows up only after a
 * Run, as a column picker that empties. So the first thing pinned is that they agree.
 *
 * The rest is what the join brings with it and what "the carried column wins" means, both of
 * which are invisible until somebody looks at a value: a neuron listed twice upstream must not
 * double a skeleton, an id with no row upstream must keep its skeleton and carry a null, and an
 * overridden column must not leave a second copy of itself behind for a picker to offer.
 */

import { describe, expect, it } from 'vitest'

import { column, columnNames, tableSchema } from '../../core/types'
import type { SkeletonsValue, TableValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import { carriedGeometry, carriedSchema, carryParam } from './carryParams'

/** What a neuPrint fetch publishes: the canonical morphology schema. */
const MORPHOLOGY = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('status', 'str'),
  column('points', 'i64'),
)

/** What the table one wire back has: the dataset's own neuron properties. */
const NEURONS = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('cellBodyFiber', 'str'),
  column('somaSide', 'str'),
  column('pre', 'i64'),
)

function neurons(): TableValue {
  return tableFromRows(NEURONS, [
    { neuronId: '1', type: 'LC4', cellBodyFiber: 'AVLP', somaSide: 'L', pre: 10 },
    { neuronId: '2', type: 'LC6', cellBodyFiber: 'PVLP', somaSide: 'R', pre: 20 },
    // A repeat of neuron 1, which the join must annotate from rather than multiply by.
    { neuronId: '1', type: 'LC4b', cellBodyFiber: 'AVLP2', somaSide: 'L', pre: 11 },
  ])
}

/** Three skeletons, one of which (`3`) the neuron table above has no row for. */
function skeletons(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: ['1', '2', '3'].map((id) => ({
      id,
      positions: new Float32Array([0, 0, 0, 10, 0, 0]),
      radii: new Float32Array([1, 1]),
      parents: new Int32Array([-1, 0]),
    })),
    attributes: makeTable(MORPHOLOGY, {
      neuronId: ['1', '2', '3'],
      type: ['LC4', 'LC6', null],
      status: ['Traced', 'Traced', 'Assign'],
      points: [2, 2, 2],
    }),
    bounds: { min: [0, 0, 0], max: [10, 0, 0] },
    units: 'nm',
    space: 'JRC2018F',
  }
}

describe('the two halves', () => {
  /*
   * The assertion that matters most and the one nothing else could catch: the promise made at
   * edit time and the table built after the fetch are the same shape. A downstream picker is
   * configured against the first and reads the second.
   */
  it('agree, which is the whole of invariant 3 here', () => {
    for (const carry of [
      [],
      ['pre'],
      ['cellBodyFiber', 'somaSide'],
      ['type'],
      ['pre', 'type'],
    ]) {
      const promised = carriedSchema(MORPHOLOGY, NEURONS, carry)
      const built = carriedGeometry(skeletons(), neurons(), carry).attributes
      expect(columnNames(promised), carry.join()).toEqual(columnNames(built.schema))
      expect(promised?.columns, carry.join()).toEqual(built.schema.columns)
    }
  })

  it('promises nothing extra until a column is chosen', () => {
    expect(carriedSchema(MORPHOLOGY, NEURONS, [])).toBe(MORPHOLOGY)
  })

  /* An unresolved dataset publishes no morphology schema; a promise built on a stand-in would
     configure a picker against a shape that never arrives. */
  /*
   * The two sides degrade differently and the names say which. An unknown *morphology* schema is
   * an unresolved dataset, and there is nothing to promise; an unknown *neurons* schema is a
   * table that has not arrived, and the fetch's own fields are still the honest answer — which is
   * invariant 5's "unknown is not empty" both times.
   */
  it('promises nothing when the dataset has published no morphology schema', () => {
    expect(carriedSchema(undefined, NEURONS, ['pre'])).toBeUndefined()
  })

  it('falls back to the fetch’s own fields when the neuron table is unknown', () => {
    expect(carriedSchema(MORPHOLOGY, undefined, ['pre'])).toBe(MORPHOLOGY)
  })
})

describe('carrying', () => {
  it('adds the chosen columns, matched by neuronId', () => {
    const out = carriedGeometry(skeletons(), neurons(), ['cellBodyFiber', 'pre'])
    expect(columnNames(out.attributes.schema)).toEqual([
      'neuronId',
      'type',
      'status',
      'points',
      'cellBodyFiber',
      'pre',
    ])
    expect(out.attributes.data.cellBodyFiber).toEqual(['AVLP', 'PVLP', null])
    // The dtype survives, so a numeric column stays numeric rather than arriving as text.
    expect(out.attributes.data.pre).toEqual([10, 20, null])
  })

  /*
   * `joinTables`' rule, inherited rather than restated: the side being matched into is
   * deduplicated by key, first occurrence winning. Neuron 1 appears twice upstream and there is
   * still one skeleton for it, carrying the first row's values.
   */
  it('annotates from a repeated id rather than multiplying the geometry', () => {
    const out = carriedGeometry(skeletons(), neurons(), ['cellBodyFiber'])
    expect(out.items).toHaveLength(3)
    expect(out.attributes.length).toBe(3)
    expect(out.attributes.data.cellBodyFiber?.[0]).toBe('AVLP')
  })

  /* A left join: an id the table upstream does not mention keeps its skeleton and carries null. */
  it('keeps a neuron the incoming table has no row for', () => {
    const out = carriedGeometry(skeletons(), neurons(), ['somaSide'])
    expect(out.items.map((i) => i.id)).toEqual(['1', '2', '3'])
    expect(out.attributes.data.somaSide).toEqual(['L', 'R', null])
  })

  /*
   * "The carried column wins", and the half that matters is that the old one is *gone* rather
   * than suffixed: `type_r` beside `type` gives every downstream picker two answers, and the
   * second is the stale one.
   */
  /*
   * `foldNodeColumns`' two rules, and the second is the one this got wrong first. Written *over*,
   * never beside — a `type_r` beside a `type` gives every downstream picker two answers and the
   * second is stale. And **in place**: a column that moves to the end reorders every table,
   * viewer and CSV downstream, which reads as the data having changed. `type` is the second
   * column of the morphology schema and stays the second column.
   */
  it('replaces a column of the same name, in its own slot', () => {
    const out = carriedGeometry(skeletons(), neurons(), ['type'])
    expect(columnNames(out.attributes.schema)).toEqual(['neuronId', 'type', 'status', 'points'])
    expect(out.attributes.data.type).toEqual(['LC4', 'LC6', null])
    expect(out.attributes.data.type_r).toBeUndefined()
  })

  /* A carried column the geometry did not have is appended, in the order it was asked for. */
  it('appends a new column after the fetch’s own', () => {
    const out = carriedGeometry(skeletons(), neurons(), ['somaSide', 'pre'])
    expect(columnNames(out.attributes.schema)).toEqual([
      'neuronId',
      'type',
      'status',
      'points',
      'somaSide',
      'pre',
    ])
  })

  it('leaves the geometry itself untouched — items, bounds and frame', () => {
    const before = skeletons()
    const out = carriedGeometry(before, neurons(), ['pre'])
    expect(out.kind).toBe('skeletons')
    expect(out.items).toBe(before.items)
    expect(out.bounds).toBe(before.bounds)
    expect(out.units).toBe('nm')
    expect(out.space).toBe('JRC2018F')
  })

  /*
   * The fast path, and it is not only about speed: a graph saved before this param existed must
   * produce the same value it always did, not one that has been through a join and back.
   */
  it('hands the value straight back when there is nothing to carry', () => {
    const before = skeletons()
    expect(carriedGeometry(before, neurons(), [])).toBe(before)
    expect(carriedGeometry(before, undefined, ['pre'])).toBe(before)
    expect(carriedGeometry(before, neurons(), ['nosuchcolumn'])).toBe(before)
  })
})

describe('the param', () => {
  /*
   * The id is the join key, so offering it in the picker offers a no-op — which is what
   * `excludeIds` means, and declaring it is what replaced filtering the id out after the fact.
   * That version left `neuronId` in the dropdown, let somebody choose it and dropped it in
   * silence; `availableColumns` now never offers it.
   */
  it('keeps the id column out of the picker rather than dropping it later', () => {
    const param = carryParam('skeleton')
    expect(param.kind).toBe('columns')
    expect(param.excludeIds).toBe(true)
    expect(param.from).toBe('neurons')
    expect(param.optional).toBe(true)
  })

  /* The shared clauses live in the factory, so both adopters say the load-bearing half in the
     same words — `warnAboveParam`' split, cited in this module's header. */
  it('composes one help sentence per noun', () => {
    expect(carryParam('skeleton').help).toContain('onto the skeletons')
    expect(carryParam('mesh').help).toContain('onto the meshes')
    for (const noun of ['skeleton', 'mesh'] as const) {
      expect(carryParam(noun).help).toContain('replaces one of the same name')
    }
  })
})
