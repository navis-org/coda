/**
 * The Parquet fast path (`pages.ts`) against the library route it stands in for, on the pyarrow
 * fixtures: the same rows, the same values, cell for cell — and taken where it should be, since a
 * path that quietly falls back on every block passes every equality test there is.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { blobBytes } from './bytes'
import type { ReadRowsRequest } from './read'
import { openTableFile, readRows } from './read'
import type { TableFileReader } from './reader'
import { readRequest } from '../../test/tableFiles'

const BASE = 720575940600000000n
const IDS = [BASE + 1n, BASE + 1003n, BASE + 1008n].map(String)

async function open(name: string) {
  const blob = new Blob([readFileSync(`src/data/files/__fixtures__/${name}`)])
  return openTableFile(blobBytes(blob))
}

function request(reader: TableFileReader, columns: readonly string[]): ReadRowsRequest {
  const key = { names: ['pre_pt_root_id', 'post_pt_root_id'], ids: IDS }
  return readRequest(reader.summary, { key }, columns)
}

/** The read both ways, and how many blocks the fast path answered for. */
async function bothWays(name: string, columns: readonly string[]) {
  const reader = await open(name)
  let answered = 0
  const counting: TableFileReader = {
    ...reader,
    readMatches: async (...args) => {
      const found = await reader.readMatches!(...args)
      if (found) answered++
      return found
    },
  }
  const fast = await readRows(counting, request(reader, columns))
  const slow = await readRows({ ...reader, readMatches: undefined }, request(reader, columns))
  return { fast, slow, answered, blocks: reader.summary.blocks }
}

const NUMBERS = ['pre_pt_root_id', 'post_pt_root_id', 'size', 'score']

describe('the Parquet fast path', () => {
  for (const name of [
    'synapses.parquet',
    'synapses-unsorted.parquet',
    'synapses-zstd.parquet',
  ]) {
    it(`answers every block of ${name}, as the library does`, async () => {
      const { fast, slow, answered, blocks } = await bothWays(name, [...NUMBERS, 'hash'])
      expect(fast.rows).toBeGreaterThan(0)
      expect(fast.data).toEqual(slow.data)
      expect(answered).toBe(blocks)
    })
  }

  it('reads only the pages holding the rows, where the file wrote a page index', async () => {
    const blob = new Blob([readFileSync('src/data/files/__fixtures__/synapses-paged.parquet')])
    let read = 0
    const bytes = blobBytes(blob)
    const counted = {
      ...bytes,
      read: (from: number, to: number) => ((read += to - from), bytes.read(from, to)),
    }
    const reader = await openTableFile(counted)
    const outputs = ['pre_pt_root_id', 'post_pt_root_id', 'size', 'score', 'region']
    read = 0
    const fast = await readRows(reader, request(reader, outputs))
    const fastBytes = read
    read = 0
    const slow = await readRows({ ...reader, readMatches: undefined }, request(reader, outputs))
    expect(fast.data).toEqual(slow.data)
    expect(fast.rows).toBeGreaterThan(0)
    expect(fastBytes).toBeLessThan(read)
  })

  it('reads plain pages of a non-nullable column, many to a group', async () => {
    const { fast, slow, answered } = await bothWays('synapses-required.parquet', NUMBERS)
    expect(fast.rows).toBeGreaterThan(0)
    expect(fast.data).toEqual(slow.data)
    expect(answered).toBe(1)
  })

  it('reads an output column with nulls in it, placing each null where the library does', async () => {
    // `region` holds a null in every block of four.
    const { fast, slow, answered, blocks } = await bothWays('synapses.parquet', [
      ...NUMBERS,
      'region',
    ])
    expect(fast.data).toEqual(slow.data)
    expect(fast.data.region).toContain(null)
    expect(answered).toBe(blocks)
  })
})
