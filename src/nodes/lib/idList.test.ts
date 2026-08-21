/**
 * Reading a list of neuron ids.
 *
 * Nearly all of this file is about *refusing*, which is the decision that separates it from
 * `labelLookup.ts`: a label is free text and anything is a valid one, where an id is a number and
 * a token that is not one is a mistake somebody just made. Two rules carry real weight:
 *
 *  - **A bad token refuses the whole list**, rather than being skipped. The cost is that a
 *    pasted spreadsheet header fails, so the message has to point at that.
 *  - **A wide id is kept exactly**, because ids are carried as decimal text. This is the rule
 *    that inverted: the file used to refuse anything past `Number.MAX_SAFE_INTEGER`, which was
 *    correct while an id had to become a float64 on the way to a query, and which made every
 *    CAVE root id unusable. The ceiling now describes the *data* — nineteen digits, a signed
 *    64-bit maximum — rather than describing JavaScript.
 *
 * And one deliberate asymmetry: the *wired* half drops what it cannot use instead of refusing,
 * because that is data rather than something somebody just typed.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { collectIds, parseIdList, unmatchedIds } from './idList'

const IDS = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
/** A CAVE-shaped table: the id column is text, because eighteen digits cannot be a number. */
const TEXT_IDS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

describe('parseIdList', () => {
  it('reads ids separated however they arrive', () => {
    expect(parseIdList('1234, 5678').ids).toEqual(['1234', '5678'])
    expect(parseIdList('1234 5678').ids).toEqual(['1234', '5678'])
    expect(parseIdList('1234\n5678').ids).toEqual(['1234', '5678'])
    expect(parseIdList('1234;5678').ids).toEqual(['1234', '5678'])
    expect(parseIdList('1234,\n  5678\t9012').ids).toEqual(['1234', '5678', '9012'])
  })

  it('takes a list pasted out of Python or JSON', () => {
    // Brackets and quotes are separators rather than stripped characters, which is what keeps
    // `12a` one bad token instead of a 12 with something quietly discarded after it.
    expect(parseIdList('[1234, 5678]').ids).toEqual(['1234', '5678'])
    expect(parseIdList('"1234","5678"').ids).toEqual(['1234', '5678'])
    expect(parseIdList("(1234, '5678')").ids).toEqual(['1234', '5678'])
  })

  it('keeps first-occurrence order and drops repeats', () => {
    // A neuron listed twice is one neuron; a repeated row would be double-counted by everything
    // downstream that sums a weight.
    expect(parseIdList('5678, 1234, 5678').ids).toEqual(['5678', '1234'])
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
    const result = parseIdList('neuronId\n1234\n5678')
    expect(result.error).toContain('"neuronId"')
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

  /*
   * The rule that inverted, and the reason this whole change exists.
   *
   * Both of these were *refused* while ids were numbers, because `Number('720575940379279312')`
   * is `720575940379279400` — a different neuron, silently. Held as text there is nothing to
   * lose, so the exact digits come back out.
   */
  it('keeps an eighteen-digit id exactly, where a number could not', () => {
    // A FlyWire root id, and an Aedes one. Round-tripping either through a JS number changes it.
    expect(parseIdList('720575940379279312').ids).toEqual(['720575940379279312'])
    expect(parseIdList('648518347529750614').ids).toEqual(['648518347529750614'])
    expect(parseIdList('648518347529750614').error).toBeUndefined()
  })

  it('is exact past the point a number stops being', () => {
    const wide = '648518347529750614'
    expect(Number(wide).toString()).not.toBe(wide)
    expect(parseIdList(wide).ids[0]).toBe(wide)
  })

  it('accepts ids either side of the old JavaScript ceiling', () => {
    // `MAX_SAFE_INTEGER` no longer means anything here; it is only where the old refusal sat.
    expect(parseIdList(String(Number.MAX_SAFE_INTEGER)).error).toBeUndefined()
    expect(parseIdList('9007199254740993').ids).toEqual(['9007199254740993'])
  })

  it('refuses a token too long to be any backend id, and says the width', () => {
    // Nineteen digits is a signed 64-bit maximum; a twenty-digit token is a paste that went
    // wrong. The refusal is about the data rather than about the language.
    const result = parseIdList('12345678901234567890')
    expect(result.ids).toEqual([])
    expect(result.error).toContain('19 digits')
  })

  it('strips leading zeros, so a typo dedupes and the query stays valid', () => {
    // The digits are spliced into Cypher as an integer literal, where a leading zero is not
    // read the way it looks — and `007` has to be the same id as `7`.
    expect(parseIdList('007').ids).toEqual(['7'])
    expect(parseIdList('007, 7').ids).toEqual(['7'])
    expect(parseIdList('0').ids).toEqual(['0'])
  })

  it('accepts the ids real datasets actually use', () => {
    // hemibrain, manc and male-CNS are nine to eleven digits; CAVE root ids are eighteen.
    expect(parseIdList('1158187240, 10001, 720575940379').ids).toEqual([
      '1158187240',
      '10001',
      '720575940379',
    ])
  })
})

describe('collectIds', () => {
  const table = () =>
    tableFromRows(IDS, [
      { neuronId: 5678, type: 'LC6' },
      { neuronId: 9012, type: 'LC4' },
    ])

  it('unions the typed list with the wired column, typed first', () => {
    // A union rather than one overriding the other: a node that dropped the text field the
    // moment a wire arrived would look correct, because the result is a valid table either way.
    const out = collectIds({ typed: '1234, 5678', table: table(), column: 'neuronId' })
    expect(out.ids).toEqual(['1234', '5678', '9012'])
    expect(out.error).toBeUndefined()
  })

  it('works from either half alone', () => {
    expect(collectIds({ typed: '1234' }).ids).toEqual(['1234'])
    expect(collectIds({ typed: '', table: table(), column: 'neuronId' }).ids).toEqual([
      '5678',
      '9012',
    ])
    expect(collectIds({ typed: '' }).ids).toEqual([])
  })

  it('collects nothing at all when the typed half is refused', () => {
    // The refusal is about the whole list, so a wired table cannot quietly stand in for it.
    const out = collectIds({ typed: 'LC4', table: table(), column: 'neuronId' })
    expect(out.ids).toEqual([])
    expect(out.error).toContain('"LC4"')
  })

  it('drops an unusable wired value instead of refusing, and counts it', () => {
    // The deliberate asymmetry. Typed text is authored and a bad token is a mistake to fix; a
    // wired column is data, and refusing to run over one null row would make the node unusable
    // — which is why `idColumn()` has always skipped them too.
    const ragged = tableFromRows(IDS, [
      { neuronId: 1234, type: 'a' },
      { neuronId: null, type: 'b' },
      // Computed, not written: the literal would lose precision in this source file too. As a
      // *number* its digits are already gone, so there is nothing to recover and it is dropped
      // — which is exactly the case the text column below does not have.
      { neuronId: Number.MAX_SAFE_INTEGER + 2, type: 'c' },
    ])
    const out = collectIds({ typed: '', table: ragged, column: 'neuronId' })
    expect(out.ids).toEqual(['1234'])
    expect(out.error).toBeUndefined()
    expect(out.dropped).toBe(1)
  })

  it('keeps a wide id out of a text column, which is how CAVE carries one', () => {
    // The counterpart of the case above: the same width, but never routed through a number, so
    // every digit is still there and nothing is dropped.
    const wide = tableFromRows(TEXT_IDS, [
      { neuronId: '648518347529750614', type: 'KC' },
      { neuronId: '648518347481448779', type: 'ALIN' },
    ])
    const out = collectIds({ typed: '', table: wide, column: 'neuronId' })
    expect(out.ids).toEqual(['648518347529750614', '648518347481448779'])
    expect(out.dropped).toBe(0)
  })

  it('drops a text cell that is not digits, rather than refusing', () => {
    const odd = tableFromRows(TEXT_IDS, [
      { neuronId: '1234', type: 'a' },
      { neuronId: 'not-an-id', type: 'b' },
    ])
    const out = collectIds({ typed: '', table: odd, column: 'neuronId' })
    expect(out.ids).toEqual(['1234'])
    expect(out.dropped).toBe(1)
  })

  it('reads nothing from a column that is not there', () => {
    expect(collectIds({ typed: '1', table: table(), column: 'nope' }).ids).toEqual(['1'])
    expect(collectIds({ typed: '1', table: table() }).ids).toEqual(['1'])
  })
})

describe('unmatchedIds', () => {
  const result = () => tableFromRows(IDS, [{ neuronId: 1234, type: 'LC4' }])

  it('names the ids the dataset did not return', () => {
    expect(unmatchedIds(['1234', '5678'], result())).toEqual(['5678'])
    expect(unmatchedIds(['1234'], result())).toEqual([])
  })

  it('matches a numeric result column against ids held as text', () => {
    // The result's `neuronId` is `i64` on neuPrint and `str` on CAVE; the comparison has to be
    // the same either way, or every id would report as missing on one of them.
    const asText = tableFromRows(TEXT_IDS, [{ neuronId: '1234', type: 'LC4' }])
    expect(unmatchedIds(['1234', '5678'], asText)).toEqual(['5678'])
  })

  it('says nothing before the node has run', () => {
    // There is nothing to be missing from yet, and claiming every id unmatched would put a
    // warning on a node nobody has run.
    expect(unmatchedIds(['1234', '5678'], undefined)).toEqual([])
  })

  it('says nothing about a result carrying no neuronId', () => {
    // "None of these exist" over a table full of neurons is a specific and wrong claim, where
    // saying nothing is merely unhelpful.
    const odd = tableFromRows(tableSchema(column('type', 'str')), [{ type: 'LC4' }])
    expect(unmatchedIds(['1234'], odd)).toEqual([])
  })

  it('says nothing when nothing was asked for', () => {
    expect(unmatchedIds([], result())).toEqual([])
  })
})
