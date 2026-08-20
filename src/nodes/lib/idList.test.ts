/**
 * Reading a list of neuron ids.
 *
 * Nearly all of this file is about *refusing*, which is the decision that separates it from
 * `labelLookup.ts`: a label is free text and anything is a valid one, where an id is a number and
 * a token that is not one is a mistake somebody just made. Two refusals carry real weight:
 *
 *  - **A bad token refuses the whole list**, rather than being skipped. The cost is that a
 *    pasted spreadsheet header fails, so the message has to point at that.
 *  - **An id past `Number.MAX_SAFE_INTEGER` refuses too**, because `CellValue` is a JS number:
 *    it would be stored as a nearby integer and identify a different neuron, with nothing
 *    anywhere to say so. neuPrint ids are nowhere near it; FlyWire root ids are well past.
 *
 * And one deliberate asymmetry: the *wired* half drops what it cannot use instead of refusing,
 * because that is data rather than something somebody just typed.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { collectIds, parseIdList, unmatchedIds } from './idList'

const IDS = tableSchema(column('bodyId', 'i64'), column('type', 'str'))

describe('parseIdList', () => {
  it('reads ids separated however they arrive', () => {
    expect(parseIdList('1234, 5678').ids).toEqual([1234, 5678])
    expect(parseIdList('1234 5678').ids).toEqual([1234, 5678])
    expect(parseIdList('1234\n5678').ids).toEqual([1234, 5678])
    expect(parseIdList('1234;5678').ids).toEqual([1234, 5678])
    expect(parseIdList('1234,\n  5678\t9012').ids).toEqual([1234, 5678, 9012])
  })

  it('takes a list pasted out of Python or JSON', () => {
    // Brackets and quotes are separators rather than stripped characters, which is what keeps
    // `12a` one bad token instead of a 12 with something quietly discarded after it.
    expect(parseIdList('[1234, 5678]').ids).toEqual([1234, 5678])
    expect(parseIdList('"1234","5678"').ids).toEqual([1234, 5678])
    expect(parseIdList("(1234, '5678')").ids).toEqual([1234, 5678])
  })

  it('keeps first-occurrence order and drops repeats', () => {
    // A neuron listed twice is one neuron; a repeated row would be double-counted by everything
    // downstream that sums a weight.
    expect(parseIdList('5678, 1234, 5678').ids).toEqual([5678, 1234])
  })

  it('reads nothing out of nothing, without complaining', () => {
    expect(parseIdList('')).toEqual({ ids: [] })
    expect(parseIdList('   \n ')).toEqual({ ids: [] })
    expect(parseIdList(undefined)).toEqual({ ids: [] })
  })

  it('refuses the whole list for one token that is not an id', () => {
    const result = parseIdList('1234, LC4, 5678')
    expect(result.ids).toEqual([])
    expect(result.error).toContain('"LC4"')
    expect(result.error).toContain('digits only')
  })

  it('names the pasted header, because that is the usual cause', () => {
    // The accepted cost of refusing rather than skipping: copying a column out of a spreadsheet
    // brings its header. The message has to make the fix obvious rather than just correct.
    const result = parseIdList('bodyId\n1234\n5678')
    expect(result.error).toContain('"bodyId"')
    expect(result.error).toContain('delete its header line')
  })

  it('offers that hint only where it could be true', () => {
    // A word in the middle of a list is not a header, and saying so would be noise on top of
    // an error — the check exists so the message stays precise rather than merely helpful.
    expect(parseIdList('1234, LC4').error).not.toContain('header')
  })

  it('refuses a partial number rather than reading the digits off the front', () => {
    expect(parseIdList('12a').error).toContain('"12a"')
    // A range typed with a dash is one token, not two ids.
    expect(parseIdList('123-456').error).toContain('"123-456"')
    expect(parseIdList('12.5').error).toContain('"12.5"')
    expect(parseIdList('-1').error).toContain('"-1"')
  })

  it('refuses an id too large to hold exactly, and says why', () => {
    // A FlyWire root id. `Number('720575940379279312')` is a *different* integer, so accepting
    // it would silently point at a neuron nobody asked for.
    const result = parseIdList('720575940379279312')
    expect(result.ids).toEqual([])
    expect(result.error).toContain('720575940379279312')
    expect(result.error).toContain('identify a different neuron')
  })

  it('accepts the largest id that is exact, and refuses the next one', () => {
    expect(parseIdList(String(Number.MAX_SAFE_INTEGER)).ids).toEqual([Number.MAX_SAFE_INTEGER])
    expect(parseIdList(String(Number.MAX_SAFE_INTEGER + 2)).error).toBeTruthy()
  })

  it('accepts the ids real datasets actually use', () => {
    // hemibrain, manc and male-CNS are nine to eleven digits. Nothing here is near the ceiling.
    expect(parseIdList('1158187240, 10001, 720575940379').ids).toEqual([
      1158187240, 10001, 720575940379,
    ])
  })
})

describe('collectIds', () => {
  const table = () =>
    tableFromRows(IDS, [
      { bodyId: 5678, type: 'LC6' },
      { bodyId: 9012, type: 'LC4' },
    ])

  it('unions the typed list with the wired column, typed first', () => {
    // A union rather than one overriding the other: a node that dropped the text field the
    // moment a wire arrived would look correct, because the result is a valid table either way.
    const out = collectIds({ typed: '1234, 5678', table: table(), column: 'bodyId' })
    expect(out.ids).toEqual([1234, 5678, 9012])
    expect(out.error).toBeUndefined()
  })

  it('works from either half alone', () => {
    expect(collectIds({ typed: '1234' }).ids).toEqual([1234])
    expect(collectIds({ typed: '', table: table(), column: 'bodyId' }).ids).toEqual([
      5678, 9012,
    ])
    expect(collectIds({ typed: '' }).ids).toEqual([])
  })

  it('collects nothing at all when the typed half is refused', () => {
    // The refusal is about the whole list, so a wired table cannot quietly stand in for it.
    const out = collectIds({ typed: 'LC4', table: table(), column: 'bodyId' })
    expect(out.ids).toEqual([])
    expect(out.error).toContain('"LC4"')
  })

  it('drops an unusable wired value instead of refusing, and counts it', () => {
    // The deliberate asymmetry. Typed text is authored and a bad token is a mistake to fix; a
    // wired column is data, and refusing to run over one null row would make the node unusable
    // — which is why `idColumn()` has always skipped them too.
    const ragged = tableFromRows(IDS, [
      { bodyId: 1234, type: 'a' },
      { bodyId: null, type: 'b' },
      // Computed, not written: the literal would lose precision in this source file too,
      // which is the very thing being tested for.
      { bodyId: Number.MAX_SAFE_INTEGER + 2, type: 'c' },
    ])
    const out = collectIds({ typed: '', table: ragged, column: 'bodyId' })
    expect(out.ids).toEqual([1234])
    expect(out.error).toBeUndefined()
    expect(out.dropped).toBe(1)
  })

  it('reads nothing from a column that is not there', () => {
    expect(collectIds({ typed: '1', table: table(), column: 'nope' }).ids).toEqual([1])
    expect(collectIds({ typed: '1', table: table() }).ids).toEqual([1])
  })
})

describe('unmatchedIds', () => {
  const result = () => tableFromRows(IDS, [{ bodyId: 1234, type: 'LC4' }])

  it('names the ids the dataset did not return', () => {
    expect(unmatchedIds([1234, 5678], result())).toEqual([5678])
    expect(unmatchedIds([1234], result())).toEqual([])
  })

  it('says nothing before the node has run', () => {
    // There is nothing to be missing from yet, and claiming every id unmatched would put a
    // warning on a node nobody has run.
    expect(unmatchedIds([1234, 5678], undefined)).toEqual([])
  })

  it('says nothing about a result carrying no bodyId', () => {
    // "None of these exist" over a table full of neurons is a specific and wrong claim, where
    // saying nothing is merely unhelpful.
    const odd = tableFromRows(tableSchema(column('type', 'str')), [{ type: 'LC4' }])
    expect(unmatchedIds([1234], odd)).toEqual([])
  })

  it('says nothing when nothing was asked for', () => {
    expect(unmatchedIds([], result())).toEqual([])
  })
})
