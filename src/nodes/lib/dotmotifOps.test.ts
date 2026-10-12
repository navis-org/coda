import { describe, expect, it } from 'vitest'
import { queriedColumns } from './dotmotifOps'

const columns = { id: [1], side: ['L'], 'cell type': ['LC4'], weight: [3] }

describe('queriedColumns', () => {
  it('keeps the columns the query names as words, and nothing it merely contains', () => {
    expect(Object.keys(queriedColumns(columns, 'A -> B; A.side = "L"'))).toEqual(['side'])
  })

  it('keeps a quoted key with a space in it', () => {
    expect(Object.keys(queriedColumns(columns, 'A -> B; A["cell type"] = "LC4"'))).toEqual([
      'cell type',
    ])
  })

  it('keeps nothing for a query with no constraints', () => {
    expect(queriedColumns(columns, 'A -> B\nB -> C\nA -> C')).toEqual({})
  })
})
