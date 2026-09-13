/**
 * The Attach Attributes node's own contract. The join is `carryParams.test.ts`'; what belongs
 * here is what this node adds and what fails quietly:
 *
 * - `inferOutputs` publishes the input's *kind* with the widened attribute schema, which is what
 *   fills the 3D viewer's "colour by" picker before anything has run;
 * - **empty columns means every column**, this node's rule and the opposite of the param's, so
 *   both halves have to expand it the same way;
 * - `resolveColumn`'s **rule 3** hands a required picker sitting on its declared default the
 *   *first compatible column*, so a table with no `neuronId` matches on whatever comes first —
 *   a real join, plausibly shaped, and empty. The card has to say so.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext, validateColumnParams } from '../../core/node'
import { defaultInputPorts, defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue, TableValue, Value } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import { geometryTypeOf, isGeometryValue, schemaOfGeometry } from '../lib/transformOps'
import '../index'

const def = requireNodeDef('neuron.attachAttributes')

const MORPHOLOGY = tableSchema(column('neuronId', 'str'), column('type', 'str'))

/** A Reduce Matrix's shape: keyed on `label`, with no `neuronId` at all. */
const STATS = tableSchema(column('label', 'str'), column('zap_mean', 'f64'))

const stats = (): TableValue =>
  tableFromRows(STATS, [
    { label: '1', zap_mean: 0.25 },
    { label: '2', zap_mean: 0.5 },
  ])

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
    }),
    bounds: { min: [0, 0, 0], max: [10, 0, 0] },
    units: 'nm',
  }
}

/** A synapse cloud: four connectors over two neurons, so the keys repeat. */
function points(): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array(12),
    attributes: makeTable(tableSchema(column('neuronId', 'str')), {
      neuronId: ['1', '1', '2', '2'],
    }),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  }
}

/**
 * An eval context built on the **real** resolver.
 *
 * `makeInferContext` supplies `column`/`columns`, so rule 3 is the app's rule rather than this
 * file's copy of it (invariant 5) — the first version hand-wrote `names.includes(stored) ?
 * stored : names[0]`, which made the rule-3 cases assert against the stub. Only `input` differs
 * between the two contexts, so only `input` is added.
 */
function ctxFor(params: Record<string, unknown>, geometry: Value, table: Value | undefined) {
  const tableSchemaOf = table && 'schema' in table ? table.schema : undefined
  const base = makeInferContext(
    def,
    { ...defaultParams(def), ...params } as never,
    {
      in: isGeometryValue(geometry)
        ? geometryTypeOf(geometry.kind, geometry.attributes.schema)
        : T.table(tableSchemaOf),
      table: T.table(tableSchemaOf),
    } as never,
  )
  return { ...base, input: (port: string) => (port === 'in' ? geometry : table) }
}

function run(params: Record<string, unknown>, geometry: Value, table: Value | undefined) {
  return (def.evaluate as (c: unknown) => { out: Value })(ctxFor(params, geometry, table)).out
}

function inferCtx(params: Record<string, unknown>, inputs: Record<string, unknown>) {
  return makeInferContext(def, { ...defaultParams(def), ...params } as never, inputs as never)
}

describe('the ports', () => {
  it('takes any geometry and a table, and hands the geometry back', () => {
    expect(defaultInputPorts(def).map((p) => p.id)).toEqual(['in', 'table'])
    // Points included, where `Split Neurons` declares only two — annotating a connector row is
    // not the same operation as partitioning a population.
    expect(defaultInputPorts(def)[0]?.kinds).toEqual(['skeletons', 'meshes', 'points'])
    expect(defaultOutputPorts(def).map((p) => p.id)).toEqual(['out'])
  })
})

describe('the two halves', () => {
  it('publishes the input’s kind with the widened schema, and returns exactly that', () => {
    for (const params of [
      {},
      { matchOn: 'label', columns: [] },
      { matchOn: 'label', columns: ['zap_mean'] },
    ]) {
      const promised = inferCtx(params, { in: T.skeletons(MORPHOLOGY), table: T.table(STATS) })
      const inferred = def.inferOutputs?.(promised)?.out
      const built = run(params, skeletons(), stats())
      expect(inferred?.kind, JSON.stringify(params)).toBe('skeletons')
      expect(columnNames(schemaOfGeometry(inferred)), JSON.stringify(params)).toEqual(
        columnNames((built as SkeletonsValue).attributes.schema),
      )
    }
  })

  it('promises meshes for meshes and points for points', () => {
    for (const type of [T.meshes(MORPHOLOGY), T.points(MORPHOLOGY)]) {
      const inferred = def.inferOutputs?.(
        inferCtx({}, { in: type, table: T.table(STATS) }),
      )?.out
      expect(inferred?.kind).toBe(type.kind)
    }
  })

  it('promises nothing about a socket that has not resolved', () => {
    expect(def.inferOutputs?.(inferCtx({}, {}))?.out?.kind).toBe('any')
  })
})

describe('attaching', () => {
  it('carries every column but the keys when nothing is picked', () => {
    // This node's rule, and the opposite of the `Carry fields` param's empty.
    const out = run({ matchOn: 'label' }, skeletons(), stats()) as SkeletonsValue
    expect(columnNames(out.attributes.schema)).toEqual(['neuronId', 'type', 'zap_mean'])
    expect(out.attributes.data.zap_mean).toEqual([0.25, 0.5, null])
  })

  it('carries only what is picked when something is', () => {
    const out = run(
      { matchOn: 'label', columns: ['zap_mean'] },
      skeletons(),
      stats(),
    ) as SkeletonsValue
    expect(columnNames(out.attributes.schema)).toEqual(['neuronId', 'type', 'zap_mean'])
  })

  it('annotates a synapse cloud rather than multiplying it', () => {
    // Four connectors over two neurons: every row takes its neuron's value, and the cloud is
    // still four points. `joinTables`' annotate-never-multiply rule seen from the other side.
    const out = run({ matchOn: 'label' }, points(), stats()) as PointsValue
    expect(out.attributes.length).toBe(4)
    expect(out.attributes.data.zap_mean).toEqual([0.25, 0.25, 0.5, 0.5])
    expect(out.positions).toHaveLength(12)
  })

  it('refuses a value that is not geometry', () => {
    const table = tableFromRows(MORPHOLOGY, [{ neuronId: '1', type: 'LC4' }])
    expect(() => run({}, table, stats())).toThrow(/not skeletons, meshes or points/)
  })

  it('refuses a missing table, which only a hand-built context can reach', () => {
    // Both ports are required, so the scheduler blocks before `evaluate`; the guard is what
    // narrows the type, and this is the only caller that can see it.
    expect(() => run({}, skeletons(), undefined)).toThrow(/not a table/)
  })
})

describe('validate', () => {
  /*
   * The rule-3 trap, and the node says **nothing** about it on purpose: `validateColumnParams`
   * runs for every node on every mutation and already names the substitution. Asserted through
   * the framework rather than the node, so the coverage survives the node not duplicating it —
   * and so a line added here later shows up as the second badge it would be.
   */
  it('leaves the substitution to validateColumnParams, which already names it', () => {
    const ctx = inferCtx({}, { in: T.skeletons(MORPHOLOGY), table: T.table(STATS) })
    expect(validateColumnParams(def, ctx)).toEqual([
      'Column "neuronId" is gone — using "label"',
    ])
    expect(def.validate?.(ctx)).toEqual([])
  })

  it('is silent once somebody has chosen a column that is there', () => {
    const ctx = inferCtx(
      { matchOn: 'label' },
      { in: T.skeletons(MORPHOLOGY), table: T.table(STATS) },
    )
    expect(validateColumnParams(def, ctx)).toEqual([])
    expect(def.validate?.(ctx)).toEqual([])
  })

  it('is silent on a table that has a neuronId', () => {
    const ctx = inferCtx({}, { in: T.skeletons(MORPHOLOGY), table: T.table(MORPHOLOGY) })
    expect(validateColumnParams(def, ctx)).toEqual([])
    expect(def.validate?.(ctx)).toEqual([])
  })

  it('accepts an unresolved passthrough socket, which declares `any`', () => {
    // Mirror, Transform and every other passthrough publishes its declared `T.any()`, so a
    // membership test on `GEOMETRY_KINDS` would refuse a card wired to a perfectly good
    // skeleton. `isGeometryKind` admits it; `evaluate` catches a real mismatch.
    expect(def.validate?.(inferCtx({}, { in: T.any(), table: T.table(STATS) }))).toEqual([])
  })

  it('names the remedy for a table on the geometry port', () => {
    const issues = def.validate?.(
      inferCtx({}, { in: T.table(MORPHOLOGY), table: T.table(STATS) }),
    )
    expect(issues?.[0]).toContain('Join')
  })
})
