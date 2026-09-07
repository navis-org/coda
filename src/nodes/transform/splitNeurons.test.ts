/**
 * Split Neurons — the partition, and the four rules that are not obvious from the name.
 *
 * What is worth pinning is mostly what a plausible implementation gets wrong. That the two
 * outputs *partition* the collection, since filtering twice with opposite conditions does not;
 * that the question is asked of the attribute table and answered in **items**, so the geometry
 * and its rows stay aligned; that everything a subset must not carry (`bounds`) is recomputed
 * while everything it must (`units`, `space`, `provenance`) is kept; and that the two kinds this
 * node refuses are refused with the remedy named rather than as "wrong type".
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { MeshesValue, SkeletonsValue, TableValue, Value } from '../../core/values'
import { makeTable } from '../../core/values'
import type { FilterRow } from '../../data/filterRows'
import { encodeRows, resolveRows } from '../../data/filterRows'
import '../index'
import type { SplitCollection } from '../lib/splitRows'
import {
  matchesNothing,
  splitCollection,
  unresolvedRowsReason,
  wrongKindReason,
} from '../lib/splitRows'

/** The morphology attributes a real collection carries, plus a Stack Neurons `source` column. */
const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('cableLength', 'f64', 'nm'),
  column('source', 'str'),
)

/** Five neurons: three LC4s and two LC6s, from two stacked datasets, one untyped. */
function attributes(): TableValue {
  return makeTable(SCHEMA, {
    neuronId: ['1', '2', '3', '4', '5'],
    type: ['LC4', 'LC6', 'LC4', null, 'LC4'],
    cableLength: [1000, 2000, 3000, 4000, null],
    source: ['hemibrain', 'hemibrain', 'flywire', 'flywire', 'flywire'],
  })
}

/** One two-node arbour per neuron, at x = 10·i so the bounds are readable in the assertions. */
function skeletons(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [1, 2, 3, 4, 5].map((i) => ({
      id: String(i),
      positions: new Float32Array([0, 0, 0, i * 10, 0, 0]),
      radii: new Float32Array([1, 1]),
      parents: new Int32Array([-1, 0]),
    })),
    attributes: attributes(),
    bounds: { min: [0, 0, 0], max: [50, 0, 0] },
    units: 'nm',
    space: 'FLYWIRE',
    provenance: { id: 'published', label: 'published skeletons' },
  }
}

function meshes(): MeshesValue {
  return {
    kind: 'meshes',
    items: [1, 2, 3, 4, 5].map((i) => ({
      id: String(i),
      positions: new Float32Array([0, 0, 0, i * 10, 0, 0, 0, i * 10, 0]),
      indices: new Uint32Array([0, 1, 2]),
    })),
    attributes: attributes(),
    bounds: { min: [0, 0, 0], max: [50, 50, 0] },
    units: 'nm',
    space: 'FLYWIRE',
    detail: { lod: 1, levels: 3, triangles: 3 },
  }
}

/** The op, asked the way the node asks it: rows resolved against the collection's attributes. */
function split<V extends SplitCollection>(value: V, rows: readonly FilterRow[]) {
  const { terms, problems } = resolveRows(value.attributes.schema, rows)
  expect(problems).toEqual([])
  return splitCollection(value, terms)
}

const ids = (v: SplitCollection): string[] => v.items.map((item) => item.id)
const attrIds = (v: SplitCollection): unknown[] => v.attributes.data.neuronId as unknown[]

describe('the partition', () => {
  it('sends the matches one way and the rest the other, in the input’s order', () => {
    const { matched, rest } = split(skeletons(), [
      { field: 'type', op: 'is', values: ['LC4'] },
      { field: 'source', op: 'is', values: ['flywire'] },
    ])
    expect(ids(matched)).toEqual(['3', '5'])
    expect(ids(rest)).toEqual(['1', '2', '4'])
  })

  /*
   * The whole reason the node exists. Filtering the neuron table twice with opposite conditions
   * cannot say this: the negation of the two rows above is not one condition, so a
   * `type is not LC4` arm drops neuron 1 from both halves. Here every item lands exactly once
   * and the counts sum, whatever the rows are.
   */
  it('loses nothing and duplicates nothing, whatever the rows say', () => {
    for (const rows of [
      [{ field: 'type', op: 'is', values: ['LC4'] }] as FilterRow[],
      [
        { field: 'type', op: 'is', values: ['LC4'] },
        { field: 'source', op: 'is', values: ['flywire'] },
      ] as FilterRow[],
      [{ field: 'cableLength', op: 'ge', values: ['2500'] }] as FilterRow[],
      [{ field: 'type', op: 'isEmpty', values: [] }] as FilterRow[],
    ]) {
      const { matched, rest } = split(skeletons(), rows)
      expect(matched.items.length + rest.items.length).toBe(5)
      expect([...ids(matched), ...ids(rest)].sort()).toEqual(['1', '2', '3', '4', '5'])
    }
  })

  /*
   * The contract the whole node rests on: one attribute row per item, in the same order. A split
   * that sliced the geometry and kept the attribute table whole would look right on the card —
   * the counts on the wire come from `items` — and mislabel every neuron downstream.
   */
  it('keeps each item’s attribute row with it', () => {
    const { matched, rest } = split(skeletons(), [{ field: 'type', op: 'is', values: ['LC4'] }])
    expect(ids(matched)).toEqual(attrIds(matched))
    expect(ids(rest)).toEqual(attrIds(rest))
    expect(matched.attributes.data.source).toEqual(['hemibrain', 'flywire', 'flywire'])
  })

  /*
   * `fieldTermsMatch`'s null rule, which a second implementation of the "rest" arm would get
   * wrong: a missing value satisfies `ne` and no other operator. Neuron 4 has no type, so it is
   * `rest` under `type is LC4` and `matched` under `type is not LC4`; neuron 5's absent
   * cableLength is on neither side of `>=`.
   */
  it('puts a missing value on the side the term’s null rule says', () => {
    const under = (row: FilterRow) => ids(split(skeletons(), [row]).matched)
    expect(under({ field: 'type', op: 'is', values: ['LC4'] })).toEqual(['1', '3', '5'])
    expect(under({ field: 'type', op: 'isNot', values: ['LC4'] })).toEqual(['2', '4'])
    expect(under({ field: 'cableLength', op: 'ge', values: ['2500'] })).toEqual(['3', '4'])
  })

  /*
   * Both halves are collections of the same kind, and the difference between what a subset may
   * carry and what it must recompute is `sliceElements`' — the reason this node borrows it rather
   * than slicing geometry itself. Bounds describe the geometry, so a half still claiming the box
   * of all five frames a 3D viewer on empty space; units, space and provenance describe where the
   * coordinates came from, and taking neurons out does not change any of them.
   */
  it('recomputes the bounds and keeps the frame, on both halves', () => {
    const { matched, rest } = split(skeletons(), [{ field: 'type', op: 'is', values: ['LC6'] }])
    expect(matched.kind).toBe('skeletons')
    expect(matched.bounds.max).toEqual([20, 0, 0])
    expect(rest.bounds.max).toEqual([50, 0, 0])
    for (const half of [matched, rest]) {
      expect(half.units).toBe('nm')
      expect(half.space).toBe('FLYWIRE')
      expect(half.provenance?.id).toBe('published')
      expect(half.attributes.schema).toBe(SCHEMA)
    }
  })

  it('splits meshes the same way, keeping the level of detail', () => {
    const { matched, rest } = split(meshes(), [{ field: 'type', op: 'is', values: ['LC6'] }])
    expect(matched.kind).toBe('meshes')
    expect(ids(matched)).toEqual(['2'])
    expect(ids(rest)).toEqual(['1', '3', '4', '5'])
    expect(matched.detail?.lod).toBe(1)
    expect(matched.items[0]!.indices).toHaveLength(3)
  })

  it('hands a whole side back by identity rather than re-slicing every item', () => {
    const value = skeletons()
    // Nothing matches: `rest` *is* the input, so the two ports share one set of buffers.
    const nothing = split(value, [{ field: 'type', op: 'is', values: ['LC10'] }])
    expect(nothing.rest).toBe(value)
    expect(nothing.matched.items).toHaveLength(0)
    // Everything matches: the same the other way up.
    const all = split(value, [{ field: 'neuronId', op: 'notEmpty', values: [] }])
    expect(all.matched).toBe(value)
    expect(all.rest.items).toHaveLength(0)
  })
})

describe('no filters', () => {
  /*
   * A predicate with no clauses has matched nothing. The alternative — everything to `Matching`,
   * "an AND over no clauses is true" — is defensible and was rejected because it makes a
   * half-built card indistinguishable from a finished one whose filters keep every neuron.
   */
  it('sends the whole collection to Rest and leaves Matching empty', () => {
    const value = skeletons()
    const { matched, rest } = splitCollection(value, [])
    expect(matched.items).toHaveLength(0)
    expect(matched.attributes.schema).toBe(SCHEMA)
    expect(matched.kind).toBe('skeletons')
    expect(rest).toBe(value)
  })
})

describe('the node around it', () => {
  const def = requireNodeDef('neuron.splitNeurons')

  const run = (rows: readonly FilterRow[], input: Value = skeletons()) => {
    const inputs: Record<string, Value | undefined> = { in: input }
    const warnings: string[] = []
    const ctx = {
      params: { ...defaultParams(def), filters: encodeRows(rows) } as ParamValues,
      input: (id: string) => inputs[id],
      warn: (message: string) => warnings.push(message),
    } as unknown as EvalContext
    const out = def.evaluate!(ctx) as { matched: SkeletonsValue; rest: SkeletonsValue }
    return { ...out, warnings }
  }

  it('splits on its own params', () => {
    const { matched, rest, warnings } = run([{ field: 'type', op: 'is', values: ['LC4'] }])
    expect(ids(matched)).toEqual(['1', '3', '5'])
    expect(ids(rest)).toEqual(['2', '4'])
    expect(warnings).toEqual([])
  })

  /* Not a refusal: there is no wait to interrupt and nothing to raise. It says so and runs. */
  it('warns rather than refusing when nothing is configured', () => {
    const { matched, rest, warnings } = run([])
    expect(matched.items).toHaveLength(0)
    expect(rest.items).toHaveLength(5)
    expect(warnings.join(' ')).toContain('every neuron leaves on Rest')
  })

  /*
   * The message is `unresolvedRowsReason`'s, asserted against the function rather than against a
   * pattern: the R emitter renders the same sentence, and a refusal the canvas and the document
   * describe differently is what writing it per surface already produced once.
   */
  it('refuses a row naming a column the attributes do not have, and names what they carry', () => {
    const rows: FilterRow[] = [{ field: 'hemilineage', op: 'is', values: ['x'] }]
    const expected = unresolvedRowsReason(resolveRows(SCHEMA, rows).problems, [
      'neuronId',
      'type',
      'cableLength',
      'source',
    ])
    expect(() => run(rows)).toThrow(expected)
    expect(expected).toContain('hemilineage')
    expect(expected).toContain('These neurons carry: neuronId, type, cableLength, source')
  })

  /*
   * The two kinds this node refuses, each with its own remedy — "wire skeletons or meshes" tells
   * somebody holding a neuron table nothing they can act on. A point cloud is the subtler of the
   * two: `Stack Neurons` accepts one, so the pair is deliberately asymmetric.
   */
  it('refuses a table and a point cloud, naming what to use instead', () => {
    const table = makeTable(SCHEMA, {
      neuronId: [],
      type: [],
      cableLength: [],
      source: [],
    })
    expect(() => run([], table)).toThrow(/Filter Table keeps the rows/)
    const points = {
      kind: 'points',
      positions: new Float32Array([0, 0, 0]),
      attributes: attributes(),
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    } as unknown as Value
    expect(() => run([], points)).toThrow(/one attribute row per connector/)
  })

  /* The predicate the card and the R emitter read, so a fourth reading cannot appear. */
  it('calls an empty set of rows the one that matches nothing', () => {
    expect(matchesNothing([])).toBe(true)
    expect(matchesNothing([{ field: 'type', op: 'is', values: ['LC4'] }])).toBe(false)
  })

  const inferWith = (params: ParamValues, input: ReturnType<typeof T.skeletons> | undefined) =>
    makeInferContext(def, { ...defaultParams(def), ...params }, { in: input })

  it('reports a broken row on the card, before anything runs', () => {
    const issues = def.validate!(
      inferWith(
        { filters: encodeRows([{ field: 'hemilineage', op: 'is', values: ['x'] }]) },
        T.skeletons(SCHEMA),
      ),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('hemilineage')
  })

  it('says nothing about a card that has no rows yet', () => {
    expect(def.validate!(inferWith({ filters: [] }, T.skeletons(SCHEMA)))).toEqual([])
  })

  /* An unresolved socket is the ordinary state before anything upstream has run. */
  it('accuses an unwired card of nothing', () => {
    expect(def.validate!(inferWith({ filters: [] }, undefined))).toEqual([])
  })

  it('marks a wrong kind on the card too, with the same sentence', () => {
    const issues = def.validate!(
      makeInferContext(def, defaultParams(def), { in: T.table(SCHEMA) }),
    )
    expect(issues).toEqual([wrongKindReason('table')])
  })

  it('promises both halves the input’s kind and attributes at edit time', () => {
    const types = def.inferOutputs!(inferWith({}, T.skeletons(SCHEMA)))
    expect(types.matched).toEqual(T.skeletons(SCHEMA))
    expect(types.rest).toEqual(T.skeletons(SCHEMA))
  })

  /* Nothing promised for a kind that will be refused, rather than a shape that never arrives. */
  it('advertises nothing for a collection it cannot split', () => {
    const types = def.inferOutputs!(
      makeInferContext(def, defaultParams(def), { in: T.table(SCHEMA) }),
    )
    expect(types.matched?.kind).toBe('any')
    expect(types.rest?.kind).toBe('any')
  })
})
