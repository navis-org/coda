/**
 * Invariant 3 for this pack: each schema half held to its value half.
 *
 * Both pairs fold over an upstream schema, so a column written under a name the schema half spells
 * differently does not throw — it simply never reaches a picker downstream. `makeTable` catches
 * one direction (a declared column nothing provided); these catch the other.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { NeuronSummary } from './affinityOps'
import {
  affinityPointsSchema,
  affinityPointsTable,
  clusterName,
  clusterSummarySchema,
  clusterSummaryTable,
} from './affinityTables'

const summary = (clusters: number): NeuronSummary => ({
  clusters,
  background: 4,
  backgroundShare: 0.25,
  confidence: 0.9,
  lowestConfidence: 0.4,
})

const neurons = tableFromRows(
  tableSchema(column(ID_COLUMN_NAME, 'str'), column('type', 'str')),
  [
    { [ID_COLUMN_NAME]: 'a', type: 'LC4' },
    { [ID_COLUMN_NAME]: 'b', type: 'LPLC2' },
  ],
  'neurons',
)

describe('the summary pair', () => {
  it('agrees with its schema half, column for column', () => {
    const got = clusterSummaryTable(neurons, [summary(2), undefined])
    expect(got.schema).toEqual(clusterSummarySchema(neurons.schema))
    expect(Object.keys(got.data).sort()).toEqual(got.schema.columns.map((c) => c.name).sort())
  })

  it('keeps the neurons’ own columns, and stays a neuron table', () => {
    const got = clusterSummaryTable(neurons, [summary(2), summary(1)])
    expect(got.data.type).toEqual(['LC4', 'LPLC2'])
    expect(got.kind).toBe('neurons')
    expect(got.data.clusters).toEqual([2, 1])
  })

  /**
   * A skipped neuron is null in every column, never zero: nobody asked the model about it, so
   * "no clusters" would be a finding this run did not make.
   */
  it('reads a skipped neuron as null, not as zero clusters', () => {
    const got = clusterSummaryTable(neurons, [summary(2), undefined])
    expect(got.data.clusters).toEqual([2, null])
    expect(got.data.backgroundShare).toEqual([0.25, null])
    expect(got.data.lowestConfidence).toEqual([0.4, null])
  })

  /**
   * The failure a dense fixture cannot see. `new Array(n)` with only some slots filled is a
   * *sparse* array, and `Array.prototype.map` preserves holes — so the straightforward spelling
   * put `undefined` in a skipped neuron's cells while the column stayed the right length.
   */
  it('fills a skipped neuron’s cells even when the array it was handed is sparse', () => {
    const sparse: (NeuronSummary | undefined)[] = new Array(2)
    sparse[0] = summary(2)
    const got = clusterSummaryTable(neurons, sparse)
    expect(1 in got.data.clusters!).toBe(true)
    expect(got.data.clusters).toEqual([2, null])
    expect(got.data.confidence).toEqual([0.9, null])
  })

  it('writes over a column of its own name rather than beside it', () => {
    const stale = tableFromRows(
      tableSchema(column(ID_COLUMN_NAME, 'str'), column('clusters', 'str')),
      [{ [ID_COLUMN_NAME]: 'a', clusters: 'stale' }],
    )
    const got = clusterSummaryTable(stale, [summary(3)])
    expect(got.schema.columns.map((c) => c.name)).toEqual([
      ID_COLUMN_NAME,
      'clusters',
      'backgroundShare',
      'confidence',
      'lowestConfidence',
    ])
    expect(got.data.clusters).toEqual([3])
  })
})

describe('the points pair', () => {
  const rows = [
    {
      neuronId: 'a',
      sourceIndex: Int32Array.from([3, 7]),
      labels: Int32Array.from([1, 0]),
      confidence: [0.8, null],
    },
    {
      neuronId: 'b',
      sourceIndex: Int32Array.from([2]),
      labels: Int32Array.from([2]),
      confidence: [0.5],
    },
  ]

  it('agrees with its schema half, column for column', () => {
    const got = affinityPointsTable(rows)
    expect(got.schema).toEqual(affinityPointsSchema())
    expect(Object.keys(got.data).sort()).toEqual(got.schema.columns.map((c) => c.name).sort())
  })

  it('writes one row per point, in neuron order', () => {
    const got = affinityPointsTable(rows)
    expect(got.length).toBe(3)
    expect(got.data[ID_COLUMN_NAME]).toEqual(['a', 'a', 'b'])
    expect(got.data.node).toEqual([3, 7, 2])
    expect(got.data.cluster).toEqual(['cluster 1', 'background', 'cluster 2'])
    expect(got.data.confidence).toEqual([0.8, null, 0.5])
  })

  it('names background rather than leaving it null', () => {
    expect(clusterName(0)).toBe('background')
    expect(clusterName(1)).toBe('cluster 1')
  })
})
