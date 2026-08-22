import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { collectLabels, labelMatch, parseTypedLabels, unmatchedLabels } from './labelLookup'

const NEURONS = tableSchema(column('neuronId', 'i64'), column('type', 'str'))

function neurons(types: Array<string | null>) {
  return tableFromRows(
    NEURONS,
    types.map((type, i) => ({ neuronId: 1000 + i, type })),
  )
}

const LABELS = tableSchema(column('name', 'str'))
function labelTable(names: Array<string | null>) {
  return tableFromRows(
    LABELS,
    names.map((name) => ({ name })),
  )
}

describe('parseTypedLabels', () => {
  it('splits on commas and newlines alike', () => {
    expect(parseTypedLabels('LC4, LC6\nLPLC2')).toEqual(['LC4', 'LC6', 'LPLC2'])
  })

  it('keeps whitespace inside a label but trims the ends', () => {
    expect(parseTypedLabels('  LC4 unclear  ,LC6')).toEqual(['LC4 unclear', 'LC6'])
  })

  it('drops empty entries rather than passing on an empty label', () => {
    // An '' would match every neuron whose property is the empty string.
    expect(parseTypedLabels('LC4,,\n , LC6')).toEqual(['LC4', 'LC6'])
  })

  it('reads a non-string param as no labels', () => {
    expect(parseTypedLabels(undefined)).toEqual([])
  })
})

describe('collectLabels', () => {
  it('unions the typed list with the wired column, typed first', () => {
    expect(
      collectLabels({ typed: 'LC4', table: labelTable(['LPLC2', 'LC6']), column: 'name' }),
    ).toEqual(['LC4', 'LPLC2', 'LC6'])
  })

  it('deduplicates across the two sources, keeping first occurrence', () => {
    expect(
      collectLabels({ typed: 'LC6, LC4', table: labelTable(['LC4', 'LC4']), column: 'name' }),
    ).toEqual(['LC6', 'LC4'])
  })

  it('skips null cells rather than turning them into the label "null"', () => {
    expect(
      collectLabels({ typed: '', table: labelTable(['LC4', null]), column: 'name' }),
    ).toEqual(['LC4'])
  })

  it('ignores the table when no column is resolved', () => {
    expect(
      collectLabels({ typed: 'LC4', table: labelTable(['LC6']), column: undefined }),
    ).toEqual(['LC4'])
  })
})

describe('unmatchedLabels', () => {
  it('names the labels absent from the result', () => {
    expect(
      unmatchedLabels(['LC4', 'LC6', 'LC9'], neurons(['LC4', 'LC4', 'LC6']), 'type'),
    ).toEqual(['LC9'])
  })

  it('is case-sensitive by default and folds when asked', () => {
    const result = neurons(['LC4'])
    expect(unmatchedLabels(['lc4'], result, 'type')).toEqual(['lc4'])
    expect(unmatchedLabels(['lc4'], result, 'type', { ignoreCase: true })).toEqual([])
  })

  it('reports nothing before a run — an absent result is not a miss', () => {
    expect(unmatchedLabels(['LC4'], undefined, 'type')).toEqual([])
  })

  it('reports nothing when the result does not carry the matched field', () => {
    // "Nothing matched" over a table full of matches is a specific and wrong claim; silence
    // is the honest answer.
    expect(unmatchedLabels(['LC4'], neurons(['LC4']), 'hemilineage')).toEqual([])
  })

  it('ignores null values when deciding what is present', () => {
    expect(unmatchedLabels(['LC4'], neurons([null, 'LC6']), 'type')).toEqual(['LC4'])
  })

  describe('regex mode', () => {
    it('matches whole names, as the query does', () => {
      // Anchored: LC4 is matched by LC.*, LPLC2 is not matched by LC.*
      expect(
        unmatchedLabels(['LC.*'], neurons(['LC4', 'LC6']), 'type', { regex: true }),
      ).toEqual([])
      expect(unmatchedLabels(['LC.*'], neurons(['LPLC2']), 'type', { regex: true })).toEqual([
        'LC.*',
      ])
    })

    it('folds case when asked', () => {
      expect(
        unmatchedLabels(['lc.*'], neurons(['LC4']), 'type', { regex: true, ignoreCase: true }),
      ).toEqual([])
    })

    it('reports an unparseable pattern as unmatched rather than throwing', () => {
      // `validate` complains about the syntax separately; throwing here takes the card down.
      expect(unmatchedLabels(['LC('], neurons(['LC4']), 'type', { regex: true })).toEqual([
        'LC(',
      ])
    })
  })
})

describe('labelMatch', () => {
  it('is undefined when there is nothing to look up', () => {
    expect(labelMatch('type', [], {})).toBeUndefined()
    expect(labelMatch(undefined, ['LC4'], {})).toBeUndefined()
  })

  it('omits the flags it is not given, so the provenance key stays stable', () => {
    expect(labelMatch('type', ['LC4'], {})).toEqual({ field: 'type', values: ['LC4'] })
    expect(labelMatch('type', ['LC4'], { regex: true, ignoreCase: true })).toEqual({
      field: 'type',
      values: ['LC4'],
      regex: true,
      ignoreCase: true,
    })
  })
})
