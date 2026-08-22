/**
 * Reading somebody else's CSV.
 *
 * Everything here is decided from the text, so every one of those decisions is a way to be
 * silently wrong about a real file. The assertions that matter are the ones where a *plausible*
 * implementation gives a different answer and nothing throws:
 *
 *  - a blank cell becoming `0` rather than null, which is `Number('')` and draws a stripe of
 *    data nobody recorded along every axis downstream;
 *  - `007` becoming `7`, which is how a zero-padded identifier stops being one;
 *  - a quoted field containing the delimiter or a newline, which is the bug in every CSV reader
 *    written as `split('\n').map(l => l.split(','))`;
 *  - the delimiter chosen by counting occurrences rather than by consistency, which picks the
 *    comma out of a tab-separated file of prose.
 */

import { describe, expect, it } from 'vitest'

import { inferDType, parseDelimited } from './csv'

describe('splitting', () => {
  it('reads a plain comma file with a header', () => {
    const { table, delimiter, hasHeader } = parseDelimited('neuronId,type\n1,LC4\n2,LC6\n')
    expect(delimiter).toBe(',')
    expect(hasHeader).toBe(true)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type'])
    expect(table.data['neuronId']).toEqual([1, 2])
    expect(table.data['type']).toEqual(['LC4', 'LC6'])
  })

  it('keeps a delimiter and a newline inside a quoted field', () => {
    const { table } = parseDelimited('id,note\n1,"a,b"\n2,"line\nbreak"\n')
    expect(table.length).toBe(2)
    expect(table.data['note']).toEqual(['a,b', 'line\nbreak'])
  })

  it('reads a doubled quote as one literal quote', () => {
    const { table } = parseDelimited('id,note\n1,"she said ""hi"""\n')
    expect(table.data['note']).toEqual(['she said "hi"'])
  })

  it('handles CRLF and a trailing newline without inventing a row', () => {
    const { table } = parseDelimited('a,b\r\n1,2\r\n3,4\r\n')
    expect(table.length).toBe(2)
    expect(table.data['b']).toEqual([2, 4])
  })

  it('strips a BOM rather than baking it into the first column name', () => {
    // Excel writes one, it survives every editor, and the symptom is a `neuronId` that no
    // column picker downstream ever matches.
    const { table } = parseDelimited('﻿neuronId,type\n1,LC4\n')
    expect(table.schema.columns[0]!.name).toBe('neuronId')
  })
})

describe('delimiter detection', () => {
  it('finds tabs and semicolons', () => {
    expect(parseDelimited('a\tb\n1\t2\n').delimiter).toBe('\t')
    expect(parseDelimited('a;b\n1;2\n').delimiter).toBe(';')
    expect(parseDelimited('a|b\n1|2\n').delimiter).toBe('|')
  })

  it('judges on consistency, not on how many separators it can find', () => {
    // Commas outnumber tabs three to one here and split the rows raggedly; the tab splits
    // every row into exactly two. Counting occurrences picks the comma and gets it wrong.
    const text = 'label\tnote\nLC4\ta, b, c\nLC6\tone, two\n'
    const { delimiter, table } = parseDelimited(text)
    expect(delimiter).toBe('\t')
    expect(table.data['note']).toEqual(['a, b, c', 'one, two'])
  })

  it('falls back to a comma for a single-column file', () => {
    const { table } = parseDelimited('neuronId\n1\n2\n')
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId'])
    expect(table.data['neuronId']).toEqual([1, 2])
  })
})

describe('header detection', () => {
  it('treats a first row containing a number as data and names the columns', () => {
    const { table, hasHeader } = parseDelimited('1,2\n3,4\n')
    expect(hasHeader).toBe(false)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['col_1', 'col_2'])
    expect(table.length).toBe(2)
  })

  it('still reads a header whose first name is blank', () => {
    // `to_csv()` with an index writes exactly this. Treating a blank name as disqualifying
    // would read every such export as headerless and shift its real header into row one.
    const { table, hasHeader } = parseDelimited(',type,pre\n0,LC4,5\n1,LC6,7\n')
    expect(hasHeader).toBe(true)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['col_1', 'type', 'pre'])
    expect(table.length).toBe(2)
  })

  it('suffixes a duplicated header name rather than demoting the row to data', () => {
    // Demoting would put the word "type" into the first row of the column it was naming.
    const { table, hasHeader } = parseDelimited('type,type\nLC4,LC6\n')
    expect(hasHeader).toBe(true)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['type', 'type_2'])
    expect(table.length).toBe(1)
  })

  it('does not suffix one column onto another that already carries the name', () => {
    /*
     * The case a *counting* deduplicator gets wrong, and it was writing one: numbering
     * occurrences turns `a, a, a_2` into `a, a_2, a_2` — a collision produced by the very
     * function that exists to prevent one, and then a ragged table or a silently dropped column
     * downstream. `uniqueName` probes for the first *free* name, so it cannot.
     */
    const { table } = parseDelimited('a,a,a_2\n1,2,3\n')
    expect(table.schema.columns.map((c) => c.name)).toEqual(['a', 'a_2', 'a_2_2'])
    expect(table.data.a_2).toEqual([2])
    expect(table.data.a_2_2).toEqual([3])
  })
})

describe('dtype inference', () => {
  it('narrows to the type every value agrees on', () => {
    expect(inferDType(['1', '2', '3'])).toBe('i64')
    expect(inferDType(['1.5', '2', '-3e4'])).toBe('f64')
    expect(inferDType(['true', 'FALSE'])).toBe('bool')
    expect(inferDType(['LC4', 'LC6'])).toBe('str')
  })

  it('lets one stray value keep the whole column text', () => {
    // A column that is 99% numeric with an `n/a` in it is a text column with a convention in
    // it. Reading the rest as numbers would drop that row's value with nothing said.
    expect(inferDType(['1', '2', 'n/a'])).toBe('str')
  })

  it('keeps a value that would not survive a round trip as text', () => {
    // The whole reason the `Text columns` override never has to rescue a *value*: nothing
    // lossy is ever parsed as a number in the first place.
    expect(inferDType(['007', '012'])).toBe('str')
    expect(inferDType(['720575940379000000000'])).toBe('str')
    expect(inferDType(['7', '12'])).toBe('i64')
  })

  it('reads 0 and 1 as integers, never as booleans', () => {
    // A synapse count of 1 is not `true`, and the text cannot tell you which was meant.
    expect(inferDType(['0', '1', '1'])).toBe('i64')
  })

  it('refuses what Number() would accept', () => {
    expect(inferDType(['0x10'])).toBe('str')
    expect(inferDType(['Infinity'])).toBe('str')
    expect(inferDType([' '])).toBe('str')
  })

  it('calls a column with nothing in it text', () => {
    // No evidence for anything narrower, and str is the one dtype every later value can
    // still be read as.
    expect(inferDType([])).toBe('str')
    expect(inferDType(['', ''])).toBe('str')
  })
})

describe('values', () => {
  it('reads a blank cell as null, never as zero', () => {
    const { table } = parseDelimited('neuronId,pre\n1,5\n2,\n3,7\n')
    expect(table.schema.columns[1]!.dtype).toBe('i64')
    expect(table.data['pre']).toEqual([5, null, 7])
  })

  it('pads a ragged row and reports it rather than dropping it', () => {
    // A trailing comma or a missing last field is routine in a hand-edited file, and losing
    // the row silently is worse than a null in it.
    const { table, raggedRows } = parseDelimited('a,b,c\n1,2,3\n4,5\n')
    expect(raggedRows).toBe(1)
    expect(table.length).toBe(2)
    expect(table.data['c']).toEqual([3, null])
  })

  it('comes back empty rather than throwing on empty text', () => {
    const { table } = parseDelimited('')
    expect(table.length).toBe(0)
    expect(table.schema.columns).toEqual([])
  })
})
