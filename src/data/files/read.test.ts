/**
 * The lazy readers, against real files written by pyarrow (`__fixtures__/make.py`): twelve rows in
 * three blocks, as sorted Parquet, shuffled Parquet and lz4 Feather.
 *
 * What is worth pinning is what a user cannot see go wrong: that a sorted file's lookup reads only
 * the blocks that can hold the ids (and a shuffled one reads them all, which the card warns
 * about), that an eighteen-digit id survives exactly, and that the 64-bit rule types columns the
 * same way before and after a read.
 */

import { readFileSync } from 'node:fs'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import type { ByteSource } from './bytes'
import { blobBytes } from './bytes'
import { fileTableSchema, textColumnsFor } from './columns'
import { withBlockIndex } from './blockIndex'
import { readTableFileRows } from './client'
import type { ReadRowsRequest } from './read'
import { openTableFile, readRows } from './read'
import type { BlockIndex } from './reader'
import { resetFileStore } from './store'
import { readRequest } from '../../test/tableFiles'

const BASE = 720575940600000000n

function fixture(name: string): ByteSource {
  return blobBytes(new Blob([readFileSync(`src/data/files/__fixtures__/${name}`)]))
}

describe('a capped read with no key', () => {
  const FILES = [
    'synapses.parquet',
    'synapses-unsorted.parquet',
    'synapses-zstd.parquet',
    'synapses-paged.parquet',
    'synapses.feather',
  ]
  for (const name of FILES) {
    it(`keeps the first rows of ${name}, the same ones a whole read starts with`, async () => {
      const reader = await openTableFile(fixture(name))
      // Without `hash`, which is past 2^53 in the Feather fixture and refused as a number.
      const names = reader.summary.columns.map((c) => c.name).filter((n) => n !== 'hash')
      const whole = await readRows(reader, readRequest(reader.summary, {}, names))
      const capped = await readRows(reader, readRequest(reader.summary, { limit: 5 }, names))
      expect(capped.rows).toBe(5)
      expect(capped.truncated).toBe(true)
      for (const [column, values] of Object.entries(whole.data)) {
        expect(capped.data[column]).toEqual(values.slice(0, 5))
      }
    })
  }

  it('reads a group’s leading pages rather than the group, where the file has a page index', async () => {
    // 20,000 rows in one row group of 2 kB pages: five rows are in the first page of each column.
    // Not a fraction of the whole here — the library joins neighbouring ranges, and in a file this
    // small most columns are neighbours.
    const read = async (limit: number) => {
      const source = fixture('synapses-paged.parquet')
      let bytes = 0
      const counted: ByteSource = {
        ...source,
        read: (from, to) => ((bytes += to - from), source.read(from, to)),
      }
      const reader = await openTableFile(counted)
      await readRows(reader, readRequest(reader.summary, { limit }))
      return bytes
    }
    expect(await read(5)).toBeLessThan(await read(Infinity))
  })
})

describe('a fingerprint', () => {
  it('tells apart two Feather files whose footers agree, and two copies of one', async () => {
    // An Arrow footer holds offsets and the schema only: change a value and it stays the same.
    const bytes = readFileSync('src/data/files/__fixtures__/synapses.feather')
    const edited = new Uint8Array(bytes)
    const footer = new DataView(bytes.buffer, bytes.byteOffset).getInt32(
      bytes.length - 10,
      true,
    )
    const at = bytes.length - 10 - footer - 64 // inside the last batch's body, before the footer
    edited[at] = edited[at]! ^ 0xff
    const print = async (source: ByteSource) =>
      (await openTableFile(source)).summary.fingerprint
    expect(await print(blobBytes(new Blob([edited])))).not.toBe(
      await print(blobBytes(new Blob([bytes]))),
    )
    // The same bytes, rewritten on disk: a local file's modification time is part of it.
    const file = (lastModified: number) =>
      new File([bytes], 'synapses.feather', { lastModified })
    expect(await print(blobBytes(file(1)))).not.toBe(await print(blobBytes(file(2))))
    expect(await print(blobBytes(file(1)))).toBe(await print(blobBytes(file(1))))
  })
})

describe('summary', () => {
  it('leaves out a whole-number decimal too wide for a float, rather than rounding the ids', async () => {
    const { summary } = await openTableFile(fixture('decimals.parquet'))
    expect(summary.skipped).toEqual(['root_id'])
    expect(summary.columns).toEqual([
      { name: 'volume', dtype: 'f64' },
      { name: 'count', dtype: 'f64' },
    ])
  })

  it('reads Parquet’s shape from the footer alone', async () => {
    const { summary } = await openTableFile(fixture('synapses.parquet'))
    expect(summary).toMatchObject({ format: 'parquet', rows: 12, blocks: 3, skipped: [] })
    expect(summary.columns.map((c) => c.name)).toEqual([
      'pre_pt_root_id',
      'post_pt_root_id',
      'size',
      'score',
      'region',
      'hash',
    ])
  })

  it('reads Feather’s batches, and does not claim a row count it would have to read for', async () => {
    const { summary } = await openTableFile(fixture('synapses.feather'))
    expect(summary).toMatchObject({ format: 'feather', rows: undefined, blocks: 3 })
  })

  it('reads ids as text by name or by statistics, and counts as numbers', async () => {
    const parquet = (await openTableFile(fixture('synapses.parquet'))).summary
    // `hash` is not an id by name; only its statistics say it cannot be a number column.
    expect(textColumnsFor(parquet, true, [])).toEqual([
      'pre_pt_root_id',
      'post_pt_root_id',
      'hash',
    ])
    const feather = (await openTableFile(fixture('synapses.feather'))).summary
    // Feather keeps no statistics, so `hash` is read as a number there — and refused at read.
    expect(textColumnsFor(feather, true, [])).toEqual(['pre_pt_root_id', 'post_pt_root_id'])
    expect(textColumnsFor(parquet, false, ['size'])).toEqual(['size'])
    const schema = fileTableSchema(parquet, textColumnsFor(parquet, true, []))
    expect(schema.columns.map((c) => c.dtype)).toEqual([
      'str',
      'str',
      'i64',
      'f64',
      'str',
      'str',
    ])
  })

  it('refuses a CSV with the conversion that fixes it', async () => {
    const csv = blobBytes(new Blob(['root_id,type\n1,A\n']))
    await expect(openTableFile(csv)).rejects.toThrow(/to_parquet/)
  })
})

describe('readRows', () => {
  it('skips the row groups a sorted file’s statistics rule out', async () => {
    const reader = await openTableFile(fixture('synapses.parquet'))
    const id = String(BASE)
    const out = await readRows(
      reader,
      readRequest(reader.summary, { key: { names: ['pre_pt_root_id'], ids: [id] } }),
    )
    expect(out).toMatchObject({ rows: 3, blocksRead: 1, blocksSkipped: 2, truncated: false })
    // Exact at eighteen digits, and typed as the schema says.
    expect(out.data.pre_pt_root_id).toEqual([id, id, id])
    expect(out.data.size).toEqual([10, 11, 12])
    expect(out.data.region).toEqual([null, 'R1', 'R2'])
  })

  it('reads a column delivered a chunk per page in place, across the page boundaries', async () => {
    // Non-nullable columns in four-row pages: three chunks per column, and id BASE + 1's rows
    // (3, 4, 5) straddle the first boundary. The answers must be the sorted file's.
    const reader = await openTableFile(fixture('synapses-required.parquet'))
    const across = await readRows(
      reader,
      readRequest(reader.summary, {
        key: { names: ['pre_pt_root_id'], ids: [String(BASE + 1n)] },
      }),
    )
    expect(across.data.size).toEqual([13, 14, 15])
    const all = await readRows(reader, readRequest(reader.summary))
    expect(all.data.size).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])
    expect(all.data.score?.[11]).toBeCloseTo(1.1)
  })

  it('reads every group of a shuffled file, and finds the same rows', async () => {
    const reader = await openTableFile(fixture('synapses-unsorted.parquet'))
    const out = await readRows(
      reader,
      readRequest(reader.summary, { key: { names: ['pre_pt_root_id'], ids: [String(BASE)] } }),
    )
    expect(out).toMatchObject({ rows: 3, blocksRead: 3, blocksSkipped: 0 })
    expect([...(out.data.size ?? [])].sort()).toEqual([10, 11, 12])
  })

  it('reads a Feather file polars wrote exactly as the one pyarrow wrote', async () => {
    // polars' lz4 frames carry block checksums, which `lz4js`' own frame walk misplaced: four
    // bytes short per block, and ids that were real numbers and wrong. Its strings are Utf8View.
    const everything = async (name: string) => {
      const reader = await openTableFile(fixture(name))
      const all = readRequest(reader.summary)
      return readRows(reader, {
        ...all,
        columns: all.columns.filter((c) => c.column.name !== 'hash'),
      })
    }
    const polars = await everything('synapses-polars.feather')
    const pyarrow = await everything('synapses.feather')
    expect(polars.data).toEqual(pyarrow.data)
    // And ZSTD, which apache-arrow ships no codec for (`libraries.ts` registers one).
    expect((await everything('synapses-zstd.feather')).data).toEqual(pyarrow.data)
    expect(polars.data.pre_pt_root_id?.[0]).toBe(String(BASE))
  })

  it('reads Feather batch by batch, with nothing to skip', async () => {
    const reader = await openTableFile(fixture('synapses.feather'))
    const summary = reader.summary
    // `hash` would be refused as a number here, so leave it out.
    const all = readRequest(summary)
    const out = await readRows(reader, {
      ...all,
      columns: all.columns.filter((c) => c.column.name !== 'hash'),
      key: { names: ['pre_pt_root_id'], ids: [String(BASE + 3n)] },
    })
    expect(out).toMatchObject({ rows: 3, blocksRead: 3, blocksSkipped: 0 })
    expect(out.data.size).toEqual([19, 20, 21])
  })

  it('refuses a 64-bit value past 2^53 in a number column rather than rounding it', async () => {
    const reader = await openTableFile(fixture('synapses.feather'))
    await expect(readRows(reader, readRequest(reader.summary))).rejects.toThrow(
      /untick `Detect id columns` and choose "hash" under `Read as text`, along with every other id column/,
    )
  })

  it('answers an empty id list with nothing, and stops at the row cap', async () => {
    const reader = await openTableFile(fixture('synapses.parquet'))
    const none = await readRows(
      reader,
      readRequest(reader.summary, { key: { names: ['pre_pt_root_id'], ids: [] } }),
    )
    expect(none).toMatchObject({ rows: 0, blocksRead: 0 })
    const capped = await readRows(reader, readRequest(reader.summary, { limit: 5 }))
    expect(capped).toMatchObject({ rows: 5, truncated: true })
  })

  it('refuses a file whose fingerprint no longer matches', async () => {
    const reader = await openTableFile(fixture('synapses.parquet'))
    await expect(
      readRows(reader, readRequest(reader.summary, { fingerprint: 'parquet:1:stale' })),
    ).rejects.toThrow(/changed since it was opened/)
  })
})

describe('decoded runs', () => {
  it('hands a scan Feather’s integer columns as their arrays, and nothing it would misread', async () => {
    const reader = await openTableFile(fixture('synapses.feather'))
    const block = await reader.readBlock(0, ['pre_pt_root_id', 'size', 'region'])
    const pre = block.runs?.pre_pt_root_id
    expect(pre?.[0]?.values).toBeInstanceOf(BigInt64Array)
    expect(pre?.reduce((n, run) => n + run.values.length, 0)).toBe(block.rows)
    // The run is the getter's column, value for value.
    expect(Array.from(pre![0]!.values)).toEqual(
      Array.from({ length: block.rows }, (_, row) => block.columns.pre_pt_root_id!(row)),
    )
    // Text is not a run of values: its buffer is bytes.
    expect(block.runs?.region).toBeUndefined()
  })
})

/** A lookup of one id's `size` in the Feather fixture, asking for the key's block index. */
async function featherLookup(id: bigint, rest: Partial<ReadRowsRequest> = {}) {
  const reader = await openTableFile(fixture('synapses.feather'))
  const all = readRequest(reader.summary)
  const lookup: ReadRowsRequest = {
    ...all,
    columns: all.columns.filter((c) => c.column.name === 'size'),
    key: { names: ['pre_pt_root_id'], ids: [String(id)], indexed: true },
    ...rest,
  }
  return { reader, lookup }
}

describe('the block index', () => {
  /** A lookup through the index `held`, and the index it built where it could complete one. */
  async function lookup(id: bigint, held?: BlockIndex, rest: Partial<ReadRowsRequest> = {}) {
    const { reader, lookup } = await featherLookup(id, rest)
    const indexed = withBlockIndex(reader, 'pre_pt_root_id', held)
    const result = await readRows(indexed, lookup)
    return { result, built: indexed.finish() }
  }

  it('is built by the first Feather lookup and skips blocks on every one after', async () => {
    // Feather keeps no statistics, so the first lookup reads every batch — and records each
    // one's range as it goes. The second reads only the batch that can hold the id.
    const first = await lookup(BASE + 3n)
    expect(first.result).toMatchObject({ blocksRead: 3, blocksSkipped: 0 })
    expect(first.built?.mins).toEqual([BASE, BASE + 1n, BASE + 2n])
    const second = await lookup(BASE + 3n, first.built)
    expect(second.result).toMatchObject({ blocksRead: 1, blocksSkipped: 2 })
    expect(second.built).toBeUndefined()
    expect(second.result.data.size).toEqual(first.result.data.size)
  })

  it('completes nothing from a lookup the row cap stopped short', async () => {
    expect((await lookup(BASE, undefined, { limit: 1 })).built).toBeUndefined()
  })
})

describe('the block index, kept in IndexedDB', () => {
  it('is found again by the next lookup of the same file', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetFileStore()
    const blob = new Blob([readFileSync('src/data/files/__fixtures__/synapses.feather')])
    const { lookup } = await featherLookup(BASE + 3n)
    // Through the page's reader, which loads and saves the index for the job it runs.
    const read = () => readTableFileRows({ kind: 'blob', blob }, lookup)
    expect(await read()).toMatchObject({ index: 'built' })
    expect(await read()).toMatchObject({ index: 'used', blocksRead: 1 })
  })
})
