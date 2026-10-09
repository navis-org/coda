import { describe, expect, it } from 'vitest'

import { fieldText, literalText, textEditable, valueFromText } from './fieldValues'
import type { FieldValue, TargetField } from './types'

/**
 * A cell is drawn as `fieldText` and an edit is read back with `valueFromText`, so the pair has to
 * round-trip: drawing a value and committing it unchanged must give the value back, or touching a
 * cell writes something nobody typed.
 */
describe('a cell’s text and its value', () => {
  const cases: Array<[TargetField, FieldValue]> = [
    [{ name: 'type', kind: 'text' }, 'LC4a'],
    [{ name: 'size', kind: 'number' }, 12.5],
    [{ name: 'group', kind: 'number', integer: true }, 10035],
    [{ name: 'checked', kind: 'date', withTime: true }, '2022-04-26 22:12'],
    [{ name: 'born', kind: 'date' }, '2022-04-26'],
    [{ name: 'side', kind: 'choice', options: ['left', 'right'] }, 'left'],
    [{ name: 'notes', kind: 'choices', options: ['a', 'b'] }, ['a', 'b']],
    [{ name: 'tags', kind: 'choices' }, ['putative', 'LC4']],
    [{ name: 'type', kind: 'text' }, null],
  ]
  it.each(cases)('round-trips a %o field', (field, value) => {
    expect(valueFromText(field, fieldText(value))).toEqual({ value })
  })

  it('does not edit as text a list whose entry holds a comma, which a split would turn into two', () => {
    const tags: TargetField = { name: 'tags', kind: 'choices' }
    expect(textEditable(tags, ['LC4, putative'])).toBe(false)
    expect(textEditable(tags, ['LC4', 'putative'])).toBe(true)
    expect(textEditable({ name: 'type', kind: 'text' }, 'LC4, putative')).toBe(true)
  })

  it('logs a value literally, so false and an empty cell stay apart', () => {
    expect(literalText(false)).toBe('false')
    expect(literalText(null)).toBe('')
    expect(literalText(['a', 'b'])).toBe('["a","b"]')
    expect(fieldText(false)).toBe('')
  })
})
