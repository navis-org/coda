/**
 * The gallery's `Cell types` choice, as the tables it reads: proofreading always, typing as
 * chosen, one read where one table carries both — and a schema that names the columns the wall
 * groups by before any read has landed.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { AnnotationRef } from '../../data/annotations/types'
import {
  NO_CELL_TYPES,
  cellTypeAnnotations,
  cellTypeOptions,
  cellTypeRefs,
  cellTypesSchema,
} from './cellTypes'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import { frameFor } from './frames'

const DATASET = { sourceId: 'cave', datasetId: 'minnie65_public:1822' }
const MINNIE = frameFor(DATASET.sourceId, DATASET.datasetId)!
const tables = (refs: AnnotationRef[]) => refs.map((ref) => ref.config['table'])

describe('which tables a choice reads', () => {
  it('reads the default typing and the proofreading flags in one read of one table', () => {
    const refs = cellTypeRefs(MINNIE, DATASET, '')
    expect(tables(refs)).toEqual(['aibs_cell_info'])
    // Every column, the flags among them: the chain names none, and a union with nothing named
    // would narrow the read to the flags alone.
    expect(refs[0]!.config['columns']).toBe('')
  })

  it('reads exactly what the dataset’s annotation chain reads, so the two share one cache entry', () => {
    const chain = DATASET_FAMILIES.find((f) => f.family === 'minnie65_public')!.annotationChain!
    const [ref] = cellTypeRefs(MINNIE, DATASET, '')
    expect(ref!.config['columns']).toBe(chain.nodes[0]!.params!['columns'])
  })

  it('keeps the proofreading table when another typing is chosen, read first so typing wins', () => {
    const refs = cellTypeRefs(MINNIE, DATASET, 'aibs_metamodel_mtypes_v661_v2')
    expect(tables(refs)).toEqual(['aibs_cell_info', 'aibs_metamodel_mtypes_v661_v2'])
    expect(refs[0]!.config['columns']).toBe('dendrite_cleaned, axon_cleaned, axon_strategy')
  })

  it('reads only the proofreading table for None', () => {
    expect(tables(cellTypeRefs(MINNIE, DATASET, NO_CELL_TYPES))).toEqual(['aibs_cell_info'])
  })

  it('still reads a table the frame no longer lists, keeping every column', () => {
    const refs = cellTypeRefs(MINNIE, DATASET, 'retired_cell_types')
    expect(tables(refs)).toEqual(['aibs_cell_info', 'retired_cell_types'])
    expect(refs[1]!.config['columns']).toBe('')
  })

  it('reads nothing without a frame or a dataset id', () => {
    expect(cellTypeRefs(undefined, DATASET, '')).toEqual([])
    expect(cellTypeRefs(MINNIE, {}, '')).toEqual([])
  })
})

describe('the dropdown', () => {
  it('offers the default as empty, every declared table, then None', () => {
    const options = cellTypeOptions(MINNIE)
    expect(options[0]).toMatchObject({ value: '', label: 'aibs_cell_info' })
    expect(options.slice(1, -1).map((o) => o.value)).toEqual(
      MINNIE.cellTypes.slice(1).map((source) => source.table),
    )
    expect(options.at(-1)!.value).toBe(NO_CELL_TYPES)
  })
})

describe('the schema half', () => {
  // A view keeping every column joins on once the gallery's own read lands (`learnedColumns`).
  it('is the Dataset’s own columns until the typing’s read lands', () => {
    const neurons = tableSchema(column('neuronId', 'str'))
    expect(cellTypesSchema(neurons, cellTypeRefs(MINNIE, DATASET, ''))).toEqual(neurons)
  })
})

describe('the value half', () => {
  it('hands the wired annotations back untouched when there is nothing to read', async () => {
    const wired = {
      key: 'chain',
      table: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1'] }, 'neurons'),
    }
    expect(await cellTypeAnnotations(wired, [], {})).toBe(wired)
    expect(await cellTypeAnnotations(undefined, [], {})).toBeUndefined()
  })
})
