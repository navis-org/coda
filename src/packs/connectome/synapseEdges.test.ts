/**
 * The node around the fold — what `synapseEdges.test.ts` cannot reach.
 *
 * The counting is checked there. Here: the schema the card promises before anything has run, the
 * two things `validate` can see that the framework cannot, and the refusals and warnings
 * `evaluate` makes.
 *
 * The one to hold on to is the partnerless cloud. `resolveColumn`'s rule 3 hands a picker still
 * on its declared default the *first compatible column*, so a `Synapses` cloud from neuPrint —
 * which carries no partner at all, by that node's own design — resolves both ends onto
 * `neuronId` and would otherwise count a connectome's worth of self-loops. The framework already
 * reports the substitution; what it cannot say is what the pair means.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import type { CodaType, TableSchema } from '../../core/types'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { PointsValue, TableValue, Value } from '../../core/values'
import { makeTable } from '../../core/values'
import '../../nodes'

const def = requireNodeDef('neuron.synapseEdges')

/** A `Synapses Between` cloud, plus the region column `Points in Volumes` writes. */
const BETWEEN = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('partnerId', 'str'),
  column('partnerType', 'str'),
  column('polarity', 'str'),
  column('confidence', 'f64'),
  column('roi', 'str'),
)

/** A neuPrint `Synapses` cloud: no partner column anywhere in it. */
const PARTNERLESS = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('polarity', 'str'),
  column('confidence', 'f64'),
)

function cloud(attributes: TableValue): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array(attributes.length * 3),
    attributes,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    units: 'nm',
  }
}

/**
 * A `Synapses Between` cloud of `n` rows, with only the columns a test is about spelled out.
 *
 * Seven columns written in full three times made the one cell each test turned on hard to see.
 */
function between(n: number, over: Partial<Record<string, Array<string | number | null>>> = {}) {
  const fill = <T>(value: T) => new Array<T>(n).fill(value)
  return makeTable(BETWEEN, {
    neuronId: fill('1'),
    type: fill('LC4'),
    partnerId: fill('3'),
    partnerType: fill('PLP1'),
    polarity: fill('pre'),
    confidence: fill(0.9),
    roi: fill('LO(R)'),
    ...over,
  })
}

const ROWS = between(4, {
  neuronId: ['1', '1', '2', '1'],
  roi: ['LO(R)', 'LO(R)', 'LO(R)', 'PLP(R)'],
})

/*
 * Inputs as a record rather than one optional type, because a default parameter value is applied
 * to an *explicit* `undefined` too — so an `input = T.points(BETWEEN)` default silently wires the
 * one case that is about nothing being wired.
 */
function infer(
  params: Partial<ParamValues>,
  inputs: Record<string, CodaType | undefined> = { in: T.points(BETWEEN) },
) {
  const ctx = makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, inputs)
  return { ctx, out: def.inferOutputs!(ctx) as Record<string, { schema?: TableSchema }> }
}

async function run(input: Value | undefined, params: Partial<ParamValues> = {}) {
  const warnings: string[] = []
  const filled = { ...defaultParams(def), ...params } as ParamValues
  // One context, built once: the params and the input type are fixed for the life of a `run`,
  // and `readPlan` asks six pickers.
  const resolved = makeInferContext(def, filled, {
    in: input && 'attributes' in input ? T.points(input.attributes.schema) : undefined,
  })
  const ctx = {
    params: filled,
    input: () => input,
    column: (id: string) => resolved.column(id),
    columns: (id: string) => resolved.columns(id),
    warn: (message: string) => warnings.push(message),
    progress: () => {},
  } as unknown as EvalContext
  const out = (await def.evaluate!(ctx)) as { out: TableValue }
  return { table: out.out, warnings }
}

describe('what the card promises before a Run', () => {
  /* The whole reason `inferOutputs` computes the schema: a Build Network below it configures
   * while this node is still idle. */
  it('publishes the edge list from the wire alone', () => {
    expect(columnNames(infer({}).out.out!.schema)).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
    ])
  })

  it('adds a split column the moment it is picked', () => {
    expect(columnNames(infer({ by: ['roi'] }).out.out!.schema)).toContain('roi')
  })

  /*
   * `optional`, so an empty picker means no column rather than rule 3's first text column —
   * which on a cloud with no `type` would name every neuron after its polarity.
   */
  it('leaves a type column out when its picker is empty', () => {
    const out = infer({ sourceType: '', targetType: '' }).out
    expect(columnNames(out.out!.schema)).toEqual(['preId', 'postId', 'weight'])
  })

  it('answers a bare table type when nothing is wired', () => {
    expect(infer({}, {}).out.out!.schema).toBeUndefined()
  })
})

describe('validate', () => {
  const issues = (params: Partial<ParamValues>, input: CodaType = T.points(BETWEEN)) =>
    def.validate!(infer(params, { in: input }).ctx)

  it('says nothing about an oriented cloud on its defaults', () => {
    expect(issues({})).toEqual([])
  })

  it('names the pair when a cloud carries no partner column', () => {
    const [message] = issues({}, T.points(PARTNERLESS))
    expect(message).toMatch(/both read "neuronId"/)
    expect(message).toMatch(/Synapses Between/)
  })

  it('says which split columns it will ignore', () => {
    expect(issues({ by: ['roi', 'neuronId'] })).toEqual([expect.stringContaining('neuronId')])
  })
})

describe('evaluate', () => {
  it('counts the cloud into an edge list', async () => {
    const { table } = await run(cloud(ROWS))
    expect(table.data['preId']).toEqual(['1', '2'])
    expect(table.data['weight']).toEqual([3, 1])
  })

  it('splits on the region column Points in Volumes wrote', async () => {
    const { table } = await run(cloud(ROWS), { by: ['roi'] })
    expect(table.data['roi']).toEqual(['LO(R)', 'LO(R)', 'PLP(R)'])
    expect(table.data['weight']).toEqual([2, 1, 1])
  })

  it('refuses anything that is not a point cloud', async () => {
    await expect(run(ROWS)).rejects.toThrow(/point cloud|synapse cloud/)
  })

  /* Said at both layers: `validate` marks the card, and a stored graph must not run and hand
   * back a table of self-loops. */
  it('refuses a partnerless cloud rather than counting self-loops', async () => {
    const rows = makeTable(PARTNERLESS, {
      neuronId: ['1'],
      type: ['LC4'],
      polarity: ['pre'],
      confidence: [0.9],
    })
    await expect(run(cloud(rows))).rejects.toThrow(/self-loop/)
  })

  it('warns about synapses it could not count', async () => {
    const rows = between(2, { partnerId: ['3', null], partnerType: ['PLP1', null] })
    const { warnings } = await run(cloud(rows))
    expect(warnings).toEqual([expect.stringContaining('no id at one end')])
  })

  it('warns about a polarity column it cannot read, and names it', async () => {
    const rows = between(1, { polarity: ['unknown'] })
    const { warnings } = await run(cloud(rows), { orientation: 'polarity' })
    expect(warnings).toEqual([expect.stringContaining('"polarity"')])
  })
})
