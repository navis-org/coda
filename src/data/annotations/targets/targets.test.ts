import { describe, expect, it } from 'vitest'

import { MemoryTarget } from './fake'
import type { TargetField, TargetRecord } from './types'
import { dateRefusal, refusal, sameValue, valueFromText } from './fieldValues'

const FIELDS: TargetField[] = [
  { name: 'root_id', kind: 'text', readOnly: 'the id column' },
  { name: 'cell_type', kind: 'text' },
  { name: 'side', kind: 'choice', options: ['left', 'right', 'center'] },
  { name: 'notes', kind: 'choices', options: ['a', 'b'] },
  { name: 'proofread', kind: 'bool' },
]

/** Two records for one id, as FlyWire's `main.info` holds for some root ids. */
function records(): TargetRecord[] {
  return [
    { key: 'r1', id: '720575940621522189', values: { cell_type: 'LC4', side: 'left' } },
    { key: 'r2', id: '720575940621522189', values: { cell_type: 'LC4', side: 'left' } },
    { key: 'r3', id: '720575940628857210', values: { cell_type: null, side: 'right' } },
  ]
}

describe('two cells holding the same thing', () => {
  it('reads an empty string, null and an empty list as one absence', () => {
    expect(sameValue('', null)).toBe(true)
    expect(sameValue([], null)).toBe(true)
    expect(sameValue('LC4', null)).toBe(false)
  })

  it('compares a multiple-select as a set and a number by value', () => {
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameValue(['a'], ['a', 'b'])).toBe(false)
    expect(sameValue(3, 3)).toBe(true)
  })
})

describe('a value refused before it is sent', () => {
  const byName = (name: string) => FIELDS.find((f) => f.name === name)
  it('refuses a read-only field, an option a select lacks, and a mistyped cell', () => {
    expect(refusal(byName('root_id'), '1')).toBe('the id column')
    expect(refusal(byName('side'), 'middle')).toMatch(/not one of side's options/)
    expect(refusal(byName('notes'), ['a', 'z'])).toMatch(/"z" is not among/)
    expect(refusal(byName('proofread'), 'yes')).toBe('not true or false')
  })

  it('lets a clear through on any editable field', () => {
    expect(refusal(byName('side'), null)).toBeUndefined()
    expect(refusal(byName('cell_type'), 'LC4a')).toBeUndefined()
  })
})

describe('a value of the wrong kind', () => {
  it('refuses a fraction where a whole number is wanted', () => {
    const count: TargetField = { name: 'group', kind: 'number', integer: true }
    expect(refusal(count, 3)).toBeUndefined()
    expect(refusal(count, 3.5)).toBe('not a whole number')
    expect(refusal(count, Number.NaN)).toBe('not a number')
  })

  it('refuses a date that is not a real day, or not in the column’s shape', () => {
    // SeaTable stores an empty cell for any of these and answers 200, so they must not leave.
    expect(dateRefusal('2024-02-03', false)).toBeUndefined()
    expect(dateRefusal('2024-02-03 14:30', true)).toBeUndefined()
    expect(dateRefusal('next tuesday', false)).toMatch(/not a date like YYYY-MM-DD/)
    expect(dateRefusal('2024-13-45', false)).toMatch(/not a day in the calendar/)
    expect(dateRefusal('2023-02-29', false)).toMatch(/not a day in the calendar/)
    expect(dateRefusal('2024-02-03 14:30', false)).toMatch(/YYYY-MM-DD$/)
    expect(dateRefusal('2024-02-03 25:00', true)).toBe('not a time like HH:mm')
  })

  it('takes any list of text in a list field with no fixed options', () => {
    const tags: TargetField = { name: 'tags', kind: 'choices' }
    expect(refusal(tags, ['a', 'b'])).toBeUndefined()
    expect(refusal(tags, 'a')).toBe('not a list')
  })
})

describe('what somebody typed, as a value', () => {
  const day: TargetField = { name: 'born', kind: 'date' }
  const stamp: TargetField = { name: 'checked', kind: 'date', withTime: true }

  it('takes a date with a T or a space between day and time', () => {
    expect(valueFromText(stamp, '2024-02-03T14:30')).toEqual({ value: '2024-02-03 14:30' })
    expect(valueFromText(stamp, ' 2024-02-03 14:30 ')).toEqual({ value: '2024-02-03 14:30' })
  })

  it('refuses rather than trims: a time in a day-only field, a stray digit', () => {
    expect(valueFromText(day, '2024-01-01 12:00')).toEqual({
      error: 'not a date like YYYY-MM-DD',
    })
    expect(valueFromText(day, '2024-01-019')).toEqual({ error: 'not a date like YYYY-MM-DD' })
  })

  it('reads a list comma-separated, and an empty cell as a clear', () => {
    expect(valueFromText({ name: 'tags', kind: 'choices' }, 'a, b,, ')).toEqual({
      value: ['a', 'b'],
    })
    expect(valueFromText(day, '   ')).toEqual({ value: null })
  })
})

describe('a checked write', () => {
  it('reads every record of an id, and names the ids it holds nothing for', async () => {
    const target = new MemoryTarget(FIELDS, records())
    const read = await target.read(['720575940621522189', '1'], ['cell_type'])
    expect(read.records.map((r) => r.key)).toEqual(['r1', 'r2'])
    expect(read.missing).toEqual(['1'])
  })

  it('writes what still holds what the card showed', async () => {
    const target = new MemoryTarget(FIELDS, records())
    const result = await target.write([
      { key: 'r1', field: 'cell_type', value: 'LC4a', before: 'LC4' },
    ])
    expect(result.written).toHaveLength(1)
    expect(target.value('r1', 'cell_type')).toBe('LC4a')
  })

  it('holds a change whose cell somebody moved since it was read', async () => {
    const target = new MemoryTarget(FIELDS, records())
    target.edit('r1', 'cell_type', 'LC6')
    const result = await target.write([
      { key: 'r1', field: 'cell_type', value: 'LC4a', before: 'LC4' },
    ])
    expect(result.conflicts).toEqual([
      { change: expect.objectContaining({ key: 'r1' }), now: 'LC6' },
    ])
    expect(target.value('r1', 'cell_type')).toBe('LC6')
    expect(target.sent).toHaveLength(0)
  })

  it('sends nothing for a cell that already holds the new value', async () => {
    const target = new MemoryTarget(FIELDS, records())
    target.edit('r1', 'cell_type', 'LC4a')
    const result = await target.write([
      { key: 'r1', field: 'cell_type', value: 'LC4a', before: 'LC4a' },
    ])
    expect(result.written).toHaveLength(1)
    expect(target.sent).toHaveLength(0)
  })

  it('refuses a value outside a select before sending, and a row that is gone', async () => {
    const target = new MemoryTarget(FIELDS, records())
    const result = await target.write([
      { key: 'r3', field: 'side', value: 'middle', before: 'right' },
      { key: 'gone', field: 'cell_type', value: 'x', before: null },
    ])
    expect(result.failed.map((f) => f.message)).toEqual([
      expect.stringMatching(/not one of side's options/),
      'the record is no longer there',
    ])
  })

  it('reports a refused batch as failed and the batches before it as written', async () => {
    const target = new MemoryTarget(FIELDS, records(), { batch: 1 })
    target.refuse = (rows) => (rows.has('r2') ? 'nope' : undefined)
    const result = await target.write([
      { key: 'r1', field: 'cell_type', value: 'A', before: 'LC4' },
      { key: 'r2', field: 'cell_type', value: 'B', before: 'LC4' },
    ])
    expect(result.written.map((c) => c.key)).toEqual(['r1'])
    expect(result.failed).toEqual([
      { change: expect.objectContaining({ key: 'r2' }), message: 'nope' },
    ])
    expect([target.value('r1', 'cell_type'), target.value('r2', 'cell_type')]).toEqual([
      'A',
      'LC4',
    ])
  })

  it('sends a row’s changes together, so a row cannot straddle two requests', async () => {
    const target = new MemoryTarget(FIELDS, records(), { batch: 1 })
    await target.write([
      { key: 'r1', field: 'cell_type', value: 'A', before: 'LC4' },
      { key: 'r1', field: 'side', value: 'right', before: 'left' },
      { key: 'r3', field: 'cell_type', value: 'B', before: null },
    ])
    // One request per row at a batch of one: r1 with both fields, then r3.
    expect(target.sent.map((rows) => Object.fromEntries(rows))).toEqual([
      { r1: { cell_type: 'A', side: 'right' } },
      { r3: { cell_type: 'B' } },
    ])
  })
})
