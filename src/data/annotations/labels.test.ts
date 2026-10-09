/**
 * The shared geometry attribute row, held against the schema half it answers to (invariant 3):
 * `morphologyAttributes`' rows against `withAnnotations(...).morphology`, which is what
 * `schemasFromType` publishes before a Run. CAVE and the Custom Dataset both build their rows
 * here, so one test pins both — and the precedence rule, which CAVE once got the wrong way round.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, tableSchema } from '../../core/types'
import type { DatasetAnnotations } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { SourceSchemas } from '../source'
import { withAnnotations } from './schema'
import { morphologyAttributes } from './labels'

const ID_ONLY = tableSchema(column(ID_COLUMN_NAME, 'str'))

const SCHEMAS: SourceSchemas = {
  neurons: tableSchema(column(ID_COLUMN_NAME, 'str'), column('type', 'str')),
  connectivity: ID_ONLY,
  roiCounts: ID_ONLY,
  morphology: tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('type', 'str'),
    column('points', 'i64'),
  ),
  synapses: ID_ONLY,
}

const CHAIN: DatasetAnnotations = {
  key: 'chain',
  table: tableFromRows(
    tableSchema(column(ID_COLUMN_NAME, 'str'), column('type', 'str'), column('side', 'str')),
    [{ [ID_COLUMN_NAME]: '7', type: 'from-chain', side: 'L' }],
  ),
}

const ITEMS = [{ id: '7', positions: new Float32Array(9) }]

describe('morphologyAttributes', () => {
  it('builds rows to the schema inference publishes, with and without a chain', () => {
    for (const annotations of [undefined, CHAIN]) {
      const table = morphologyAttributes(SCHEMAS, annotations, ITEMS)
      expect(table.schema).toEqual(
        withAnnotations(SCHEMAS, annotations?.table.schema).morphology,
      )
      expect(table.data.points).toEqual([3])
    }
  })

  it('keeps the fetched count where the chain carries a points column of its own', () => {
    // A Skeletons attribute table fed back in as the neuron table.
    const chain: DatasetAnnotations = {
      key: 'fed-back',
      table: tableFromRows(
        tableSchema(column(ID_COLUMN_NAME, 'str'), column('points', 'str')),
        [{ [ID_COLUMN_NAME]: '7', points: '999' }],
      ),
    }
    const table = morphologyAttributes(SCHEMAS, chain, ITEMS)
    expect(table.schema.columns.map((c) => c.name)).toEqual([ID_COLUMN_NAME, 'points'])
    expect(table.data.points).toEqual([3])
  })

  it('lets a chain win a name the source’s fallback also writes', () => {
    const fallback = () => ({ type: 'from-source' })
    expect(morphologyAttributes(SCHEMAS, undefined, ITEMS, fallback).data.type).toEqual([
      'from-source',
    ])
    const labelled = morphologyAttributes(SCHEMAS, CHAIN, ITEMS, fallback)
    expect(labelled.data.type).toEqual(['from-chain'])
    expect(labelled.data.side).toEqual(['L'])
  })
})
