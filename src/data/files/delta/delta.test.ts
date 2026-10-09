/**
 * Delta tables read the way every table file is read — `readRows` over the reader — held against
 * what delta-rs reads from the same tables (`__fixtures__/delta/expected.json`, written by
 * `expected.py`). Four tables: a synthetic edge list reaching every path of the log (checkpoint,
 * commits after it, removes, partitions, ZSTD, eighteen-digit stats), and three from delta-rs's
 * own test data for what delta-rs cannot write — a deletion vector, column mapping, a renamed
 * partition column.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { blobBytes } from '../bytes'
import { readRows } from '../read'
import type { DeltaSnapshot, DeltaStore } from './log'
import { parseStats, readDeltaSnapshot } from './log'
import { openDelta } from './reader'
import { readRequest } from '../../../test/tableFiles'

const DIR = 'src/data/files/__fixtures__/delta/'
const expected = JSON.parse(readFileSync(DIR + 'expected.json', 'utf8')) as Record<
  string,
  { version: number; columns: string[]; rows: Array<Record<string, unknown>> }
>

/** A table off disk: listed where `list`, asked for commit by commit otherwise. */
function store(name: string, list = true): DeltaStore {
  const root = DIR + name
  return {
    root,
    read: async (path) =>
      existsSync(`${root}/${path}`)
        ? new Uint8Array(readFileSync(`${root}/${path}`))
        : undefined,
    ...(list
      ? {
          listLog: async (from: string) =>
            readdirSync(`${root}/_delta_log`)
              .sort()
              .filter((n) => `_delta_log/${n}` >= from),
        }
      : {}),
  }
}

const open = (url: string) => blobBytes(new Blob([readFileSync(decodeURIComponent(url))]))

async function table(name: string, list = true) {
  const snapshot = await readDeltaSnapshot(store(name, list))
  const reader = await openDelta(snapshot, open)
  return { snapshot, reader, request: readRequest(reader.summary) }
}

/** A row as text with its keys in one order, which is what rows are sorted and compared by. */
const key = (row: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))))

const sorted = (rows: Array<Record<string, unknown>>) =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : 1))

/** Rows as objects, in a stable order — delta-rs promises none. */
function rowsOf(data: Record<string, unknown[]>): Array<Record<string, unknown>> {
  const names = Object.keys(data)
  const length = data[names[0]!]?.length ?? 0
  return sorted(
    Array.from({ length }, (_, i) => Object.fromEntries(names.map((n) => [n, data[n]![i]]))),
  )
}

describe('a Delta table', () => {
  for (const name of Object.keys(expected)) {
    it(`reads ${name} as delta-rs does`, async () => {
      const { snapshot, reader, request } = await table(name)
      expect(snapshot.version).toBe(expected[name]!.version)
      const out = await readRows(reader, request)
      // In delta-rs' column order, which is the table's.
      const data = Object.fromEntries(expected[name]!.columns.map((c) => [c, out.data[c]!]))
      expect(rowsOf(data)).toEqual(sorted(expected[name]!.rows))
      expect(reader.summary.rows).toBe(expected[name]!.rows.length)
    })
  }

  it('finds the commits after a checkpoint without listing them, reading each once', async () => {
    const listed = await table('edges')
    const unlisted = store('edges', false)
    const reads: string[] = []
    const probed = await readDeltaSnapshot({
      ...unlisted,
      read: (path) => (reads.push(path), unlisted.read(path)),
    })
    expect(probed.fingerprint).toBe(listed.snapshot.fingerprint)
    // Asking whether a commit is there is reading it: the replay uses those bytes.
    expect(new Set(reads).size).toBe(reads.length)
  })

  it('stops a capped read at the rows it was asked for, and says it was cut short', async () => {
    // One data file of three row groups of four rows — no Delta fixture here has more than one.
    const file = DIR + '../synapses.parquet'
    const size = readFileSync(file).byteLength
    const fields = ['pre_pt_root_id', 'size'].map((name) => ({
      name,
      physical: name,
      type: 'long',
    }))
    const snapshot: DeltaSnapshot = {
      root: DIR + '..',
      version: 0,
      fields,
      partitionColumns: [],
      files: [{ path: 'synapses.parquet', size, partition: {} }],
      fingerprint: 'delta:test',
    }
    const reader = await openDelta(snapshot, open)
    // The first group of four whole and two rows of the second; the third is never read.
    expect((await reader.readBlock(0, ['size'], 6)).rows).toBe(6)
    expect((await reader.readBlock(0, ['size'])).rows).toBe(12)
    const whole = await readRows(reader, readRequest(reader.summary))
    const capped = await readRows(reader, readRequest(reader.summary, { limit: 5 }))
    expect(capped.rows).toBe(5)
    expect(capped.truncated).toBe(true)
    expect(capped.data.size).toEqual(whole.data.size!.slice(0, 5))
  })

  it('skips the files a lookup cannot be in on the log’s stats, and reads only one', async () => {
    const { reader, request } = await table('edges')
    const id = String(720575940600000013n)
    const out = await readRows(reader, {
      ...request,
      key: { names: ['pre_pt_root_id'], ids: [id] },
    })
    expect(out.data.pre_pt_root_id).toEqual([id])
    expect(out.blocksRead).toBe(1)
    expect(out.blocksSkipped).toBe(reader.summary.blocks - 1)
  })

  it('names what it cannot read rather than reading it as plain', async () => {
    // Unlisted and with no checkpoint — which holds the protocol too — so the first commit,
    // edited, is what says what the table needs.
    const plain = store('edges', false)
    const future: DeltaStore = {
      ...plain,
      read: async (path) => {
        if (path.includes('checkpoint')) return undefined
        const bytes = await plain.read(path)
        if (!bytes || !path.endsWith('00000000000000000000.json')) return bytes
        return new TextEncoder().encode(
          new TextDecoder()
            .decode(bytes)
            .replace(
              /"protocol":\{[^}]*\}/,
              '"protocol":{"minReaderVersion":3,"minWriterVersion":7,"readerFeatures":["variantType"]}',
            ),
        )
      },
    }
    await expect(readDeltaSnapshot(future)).rejects.toThrow(/variantType/)
  })
})

describe('the log’s stats', () => {
  it('keeps an eighteen-digit id exact, and leaves digits inside a string alone', () => {
    const stats = parseStats(
      '{"numRecords":2,"minValues":{"id":720575940600000013,"name":"a,720575940600000013,b","n":7}}',
    )
    expect(stats.minValues).toEqual({
      id: '720575940600000013',
      name: 'a,720575940600000013,b',
      n: 7,
    })
  })
})
