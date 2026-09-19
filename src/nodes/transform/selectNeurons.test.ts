/**
 * Select Neurons — the subset, and the four rules that are not obvious from the name.
 *
 * What is pinned is mostly what a plausible implementation gets wrong. That the match is on the
 * geometry's **own id** and not on its `neuronId` attribute column, which is invisible until
 * something upstream rewrites one of them; that the result keeps the *collection's* order rather
 * than the table's; that everything a subset must not carry (`bounds`) is recomputed while
 * everything it must (`units`, `space`, `provenance`, `detail`) is kept; and that an id the
 * collection has no geometry for is counted and said rather than refused.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { MeshesValue, SkeletonsValue, TableValue, Value } from '../../core/values'
import { makeTable } from '../../core/values'
import '../index'
import type { SelectableCollection } from '../lib/selectNeurons'
import {
  nothingSelectedReason,
  selectByIds,
  skippedNeuronsReason,
  unselectableKindReason,
  wantedIds,
} from '../lib/selectNeurons'

/** The morphology attributes a real collection carries. */
const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('cableLength', 'f64', 'nm'),
)

function attributes(): TableValue {
  return makeTable(SCHEMA, {
    neuronId: ['1', '2', '3', '4', '5'],
    type: ['LC4', 'LC6', 'LC4', null, 'LC4'],
    cableLength: [1000, 2000, 3000, 4000, null],
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

/** A neuron table naming some of them, under a column that is not `neuronId`. */
const TABLE_SCHEMA = tableSchema(column('bodyId', 'str'), column('cluster', 'i64'))

function neuronTable(ids: (string | number | null)[]): TableValue {
  return makeTable(TABLE_SCHEMA, {
    bodyId: ids,
    cluster: ids.map(() => 1),
  })
}

const ids = (v: SelectableCollection): string[] => v.items.map((item) => item.id)
const attrIds = (v: SelectableCollection): unknown[] => v.attributes.data.neuronId as unknown[]

describe('the ids a column names', () => {
  it('reads them as exact text, deduplicated, in first-appearance order', () => {
    expect(wantedIds(neuronTable(['3', '1', '3', '1']), 'bodyId')).toEqual(['3', '1'])
  })

  /*
   * `idText`'s rule rather than `String(cell)`: a safe integer becomes its digits, an empty cell
   * and a null are nothing at all. The float64 half of invariant 8 is why this goes through that
   * function and not through `String`.
   */
  it('takes an integer cell and drops what is not an id at all', () => {
    expect(wantedIds(neuronTable([3, null, '', 1]), 'bodyId')).toEqual(['3', '1'])
  })

  it('answers nothing for a column that is not there, rather than throwing', () => {
    expect(wantedIds(neuronTable(['1']), 'missing')).toEqual([])
    expect(wantedIds(undefined, 'bodyId')).toEqual([])
  })
})

describe('the subset', () => {
  it('keeps the named neurons in the collection’s order, not the table’s', () => {
    const { kept } = selectByIds(skeletons(), ['5', '1', '3'])
    expect(ids(kept)).toEqual(['1', '3', '5'])
  })

  /*
   * The contract the whole node rests on: one attribute row per item, in the same order. A subset
   * that sliced the geometry and kept the attribute table whole would look right on the card —
   * the counts on the wire come from `items` — and mislabel every neuron downstream.
   */
  it('keeps each item’s attribute row with it', () => {
    const { kept } = selectByIds(skeletons(), ['2', '4'])
    expect(ids(kept)).toEqual(attrIds(kept))
    expect(kept.attributes.data.type).toEqual(['LC6', null])
  })

  /*
   * The match is on `item.id`, never on the `neuronId` column beside it. The two agree when a
   * source builds a collection and can stop agreeing afterwards — an `Attach Attributes` writes
   * over columns — and only the attributes can be rewritten upstream, which is why the identity
   * is the one the geometry carries.
   */
  it('matches the geometry’s own id, not its neuronId column', () => {
    const value = skeletons()
    const relabelled: SkeletonsValue = {
      ...value,
      attributes: makeTable(SCHEMA, {
        neuronId: ['a', 'b', 'c', 'd', 'e'],
        type: value.attributes.data.type!,
        cableLength: value.attributes.data.cableLength!,
      }),
    }
    expect(ids(selectByIds(relabelled, ['2']).kept)).toEqual(['2'])
    expect(ids(selectByIds(relabelled, ['b']).kept)).toEqual([])
  })

  /* Not an error at any layer: the shortfall is a number the node reports. */
  it('reports the ids it had no geometry for, in the table’s order', () => {
    const { kept, missing } = selectByIds(skeletons(), ['9', '3', '7'])
    expect(ids(kept)).toEqual(['3'])
    expect(missing).toEqual(['9', '7'])
  })

  /*
   * `sliceElements`' division between what a subset may carry and what it must recompute — the
   * reason this borrows `partitionElements` rather than slicing geometry itself. Bounds describe
   * the geometry, so a subset still claiming the box of all five frames a 3D viewer on empty
   * space; units, space and provenance describe where the coordinates came from.
   */
  it('recomputes the bounds and keeps the frame', () => {
    const { kept } = selectByIds(skeletons(), ['2'])
    expect(kept.kind).toBe('skeletons')
    expect(kept.bounds.max).toEqual([20, 0, 0])
    expect(kept.units).toBe('nm')
    expect(kept.space).toBe('FLYWIRE')
    expect(kept.provenance?.id).toBe('published')
    expect(kept.attributes.schema).toBe(SCHEMA)
  })

  it('subsets meshes the same way, keeping the level of detail', () => {
    const { kept } = selectByIds(meshes(), ['2', '5'])
    expect(kept.kind).toBe('meshes')
    expect(ids(kept)).toEqual(['2', '5'])
    expect(kept.detail?.lod).toBe(1)
    expect(kept.items[0]!.indices).toHaveLength(3)
  })

  it('hands the whole collection back by identity when every neuron is named', () => {
    const value = skeletons()
    expect(selectByIds(value, ['1', '2', '3', '4', '5']).kept).toBe(value)
  })

  it('yields an empty collection of the same kind when none is', () => {
    const { kept } = selectByIds(skeletons(), ['99'])
    expect(kept.items).toHaveLength(0)
    expect(kept.kind).toBe('skeletons')
    expect(kept.attributes.schema).toBe(SCHEMA)
  })
})

describe('the node around it', () => {
  const def = requireNodeDef('neuron.selectNeurons')

  const run = (
    table: Value,
    geometry: Value = skeletons(),
    params: ParamValues = { idColumn: 'bodyId' },
  ) => {
    const inputs: Record<string, Value | undefined> = { in: geometry, neurons: table }
    const warnings: string[] = []
    const stored = { ...defaultParams(def), ...params }
    const ctx = {
      params: stored,
      input: (id: string) => inputs[id],
      // The node resolves its picker through `readSelection`, which goes through `ctx.column`
      // (invariant 5); the real context reads the wired schema, and here the stored name is the
      // answer for every case under test.
      column: (id: string) => stored[id] as string | undefined,
      warn: (message: string) => warnings.push(message),
    } as unknown as EvalContext
    const out = def.evaluate!(ctx) as { out: SkeletonsValue }
    return { out: out.out, warnings }
  }

  it('selects on its own params, quietly, when every id is there', () => {
    const { out, warnings } = run(neuronTable(['3', '1']))
    expect(ids(out)).toEqual(['1', '3'])
    expect(warnings).toEqual([])
  })

  it('counts the ids it had no geometry for rather than refusing', () => {
    const { out, warnings } = run(neuronTable(['1', '77', '88']))
    expect(ids(out)).toEqual(['1'])
    expect(warnings).toEqual([skippedNeuronsReason('bodyId', ['77', '88'], 3)])
  })

  /*
   * The rule-3 trap, which is the one thing edit time cannot see: a picker pointed at a column of
   * cell types resolves perfectly well, runs perfectly well and hands back an empty scene. The
   * sentence is `nothingSelectedReason`'s, asserted against the function rather than a pattern,
   * so the card cannot come to word it differently from anything else that renders it.
   */
  it('says why an empty result is the column rather than the data', () => {
    const { out, warnings } = run(
      makeTable(tableSchema(column('type', 'str')), { type: ['LC4', 'LC6'] }),
      skeletons(),
      { idColumn: 'type' },
    )
    expect(out.items).toHaveLength(0)
    expect(warnings).toEqual([nothingSelectedReason('type', ['LC4', 'LC6'])])
  })

  /*
   * The two kinds this node refuses, each with its own remedy — "wire skeletons or meshes" tells
   * somebody holding a neuron table nothing they can act on. The point cloud's reason is its own:
   * it carries no id, where Split Neurons refuses one because its rows are connectors.
   */
  it('refuses a table and a point cloud, naming what to use instead', () => {
    expect(() => run(neuronTable(['1']), attributes())).toThrow(/Join keeps the rows/)
    const points = {
      kind: 'points',
      positions: new Float32Array([0, 0, 0]),
      attributes: attributes(),
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    } as unknown as Value
    expect(() => run(neuronTable(['1']), points)).toThrow(/carries no id of its own/)
  })

  const inferWith = (input: ReturnType<typeof T.skeletons> | undefined) =>
    makeInferContext(def, defaultParams(def), { in: input, neurons: T.table(TABLE_SCHEMA) })

  it('promises the input’s kind and attributes at edit time', () => {
    expect(def.inferOutputs!(inferWith(T.skeletons(SCHEMA))).out).toEqual(T.skeletons(SCHEMA))
  })

  /* Nothing promised for a kind that will be refused, rather than a shape that never arrives. */
  it('advertises nothing for a collection it cannot subset', () => {
    const types = def.inferOutputs!(
      makeInferContext(def, defaultParams(def), { in: T.table(SCHEMA) }),
    )
    expect(types.out?.kind).toBe('any')
  })

  /* An unresolved socket is the ordinary state before anything upstream has run. */
  it('accuses an unwired card of nothing', () => {
    expect(def.validate!(inferWith(undefined))).toEqual([])
  })

  it('marks a wrong kind on the card, with the same sentence evaluate throws', () => {
    expect(def.validate!(inferWith(T.table(SCHEMA) as never))).toEqual([
      unselectableKindReason('table'),
    ])
  })
})
