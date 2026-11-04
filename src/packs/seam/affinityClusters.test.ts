/**
 * The card: the schema it promises before anything runs, the consent gate, and the two numbers
 * that are spelled in more than one place.
 *
 * What `evaluate` does cannot be reached from vitest — it needs WebGPU, a real `Worker` and
 * 406 MB of weights — so the run itself is the browser probes' (`pnpm probe:affinity-runtime`,
 * `pnpm probe:affinity-parity`). What is here is everything that holds without a GPU.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { CodaType, TableSchema } from '../../core/types'
import { NODE_VALUES } from '../../nodes/lib/nodeValues'
import '../../nodes'
import { clusterSummarySchema } from './affinityTables'
import { CLUSTER_NODE_VALUE } from './nodeValues'
import { AFFINITY_MODELS } from './models'

const def = requireNodeDef('seam:affinityClusters')

const NEURONS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

function infer(
  params: Partial<ParamValues> = {},
  inputs: Record<string, CodaType | undefined> = { in: T.skeletons(NEURONS) },
) {
  const ctx = makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, inputs)
  return def.inferOutputs!(ctx) as Record<string, { schema?: TableSchema }>
}

const validate = (params: Partial<ParamValues> = {}) =>
  def.validate!(
    makeInferContext(def, { ...defaultParams(def), ...params } as ParamValues, {
      in: T.skeletons(NEURONS),
    }),
  )

describe('the card', () => {
  /** Invariant 6: a `cheap` node would fire a 406 MB download on every keystroke. */
  it('is expensive', () => {
    expect(def.cost).toBe('expensive')
  })

  it('promises the summary columns on the skeletons and on the table alike', () => {
    const out = infer()
    const expected = columnNames(clusterSummarySchema(NEURONS))
    expect(columnNames(out.skeletons!.schema!)).toEqual(expected)
    expect(columnNames(out.summary!.schema!)).toEqual(expected)
    // The neurons' own columns are kept, which is what makes a Split work on the result.
    expect(columnNames(out.skeletons!.schema!)).toContain('type')
  })

  it('promises the point cloud’s columns before anything has run', () => {
    expect(columnNames(infer().points!.schema!)).toEqual([
      'neuronId',
      'node',
      'cluster',
      'confidence',
    ])
  })

  /** Invariant 2: inference runs on every graph mutation and may not throw. */
  it('infers with nothing wired', () => {
    expect(() => infer({}, { in: undefined })).not.toThrow()
  })
})

describe('the consent gate', () => {
  it('asks before the weights are allowed to be fetched', () => {
    expect(validate().join(' ')).toContain('Download the model')
  })

  it('stops asking once the box is ticked', () => {
    expect(validate({ download: true })).toEqual([])
  })

  /** A saved graph may name a model this build no longer carries. */
  it('says so when the chosen model is not in this build', () => {
    expect(validate({ download: true, model: 'gone' }).join(' ')).toContain('gone')
  })
})

describe('the numbers spelled twice', () => {
  /**
   * One spelling, not two held together: `nodeValues.ts` declares the key and everything else
   * imports it. What is left to check is that the glob actually picked the file up and attributed
   * it to this pack — without that the 3D View offers nothing and nothing fails.
   */
  it('offers the node value the node actually writes', () => {
    const declared = NODE_VALUES.find((v) => v.pack === 'seam')
    expect(declared?.value).toBe(CLUSTER_NODE_VALUE)
  })

  /**
   * The three numeric params are static literals because `defaultParams` runs at insert and
   * cannot fetch (invariant 4 forbids a `?? literal` beside the read). They are only *right* if
   * they match the shipped checkpoint, which is what the converter writes into the manifest —
   * so they are held against the same source the converter reads.
   */
  it('defaults to the shipped checkpoint’s own training constants', () => {
    const checkpoints = JSON.parse(
      readFileSync(
        new URL('../../../scripts/affinity-checkpoints.json', import.meta.url),
        'utf8',
      ),
    ) as { checkpoints: Record<string, { config: Record<string, Record<string, number>> }> }
    const shipped = checkpoints.checkpoints[AFFINITY_MODELS[0]!.id]
    expect(shipped, `${AFFINITY_MODELS[0]!.id} is not a published checkpoint`).toBeTruthy()
    const params = defaultParams(def)
    expect(params.points).toBe(shipped!.config.preprocessing!.samplesPerNeuron)
    expect(params.threshold).toBe(shipped!.config.clustering!.threshold)
    expect(params.minClusterSize).toBe(shipped!.config.clustering!.minClusterSize)
  })
})
