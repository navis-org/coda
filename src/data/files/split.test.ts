/**
 * A keyed read split across workers must answer what one pass answers — the rows in the same
 * order, the cap in the same place, the block index the same — which is checked here by running the
 * parts' job directly over the pyarrow fixtures, no worker needed.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { blobBytes } from './bytes'
import type { ReadRowsJob, ReadRowsRequest } from './read'
import { openTableFile, readRowsJob } from './read'
import type { BlockRange } from './reader'
import { mergeParts, partCount, splitBlocks } from './split'
import { readRequest } from '../../test/tableFiles'

const BASE = 720575940600000000n
const IDS = [BASE, BASE + 2n, BASE + 3n].map(String)

async function setup(name: string, rest: Partial<ReadRowsRequest> = {}, only?: string) {
  const blob = new Blob([readFileSync(`src/data/files/__fixtures__/${name}`)])
  const { summary } = await openTableFile(blobBytes(blob))
  const request = readRequest(
    summary,
    { key: { names: ['pre_pt_root_id'], ids: IDS }, ...rest },
    only ? [only] : undefined,
  )
  const job = (blocks?: BlockRange): ReadRowsJob => ({
    spec: { kind: 'blob', blob },
    request: blocks ? { ...request, blocks } : request,
  })
  return { summary, request, job }
}

async function split(name: string, ranges: BlockRange[], rest: Partial<ReadRowsRequest> = {}) {
  const { request, job } = await setup(name, rest)
  const whole = await readRowsJob(job(), {})
  const parts = await Promise.all(ranges.map((range) => readRowsJob(job(range), {})))
  return { whole, merged: mergeParts(parts, ranges, request.limit, 3) }
}

describe('a split read', () => {
  it('keeps the rows one pass keeps, in the same order', async () => {
    const { whole, merged } = await split('synapses-unsorted.parquet', [
      { from: 0, to: 1 },
      { from: 1, to: 3 },
    ])
    expect(merged.rows).toBeGreaterThan(0)
    expect(merged.data).toEqual(whole.data)
    expect(merged).toMatchObject({ rows: whole.rows, truncated: false })
  })

  it('reads both ends in one pass: the rows either end matches, once each', async () => {
    const names = ['pre_pt_root_id', 'post_pt_root_id']
    const { request, job } = await setup('synapses-unsorted.parquet', {
      key: { names, ids: IDS },
    })
    const both = await readRowsJob(job(), {})
    const alone = await Promise.all(
      names.map((name) =>
        readRowsJob(
          { ...job(), request: { ...request, key: { names: [name], ids: IDS } } },
          {},
        ),
      ),
    )
    const overlap = both.data.pre_pt_root_id!.filter(
      (pre, i) =>
        IDS.includes(String(pre)) && IDS.includes(String(both.data.post_pt_root_id![i])),
    ).length
    expect(both.rows).toBe(alone[0]!.rows + alone[1]!.rows - overlap)
    const ranges = [
      { from: 0, to: 1 },
      { from: 1, to: 3 },
    ]
    const parts = await Promise.all(ranges.map((range) => readRowsJob(job(range), {})))
    expect(mergeParts(parts, ranges, Infinity, 3).data).toEqual(both.data)
  })

  it('applies the row cap to the whole, and says rows were left', async () => {
    const ranges = [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]
    const { whole, merged } = await split('synapses-unsorted.parquet', ranges, { limit: 2 })
    expect(merged.data).toEqual(whole.data)
    expect(merged).toMatchObject({ rows: 2, truncated: true })
  })

  it('joins the parts’ block-index builds into the index one pass builds', async () => {
    const ranges = [
      { from: 0, to: 2 },
      { from: 2, to: 3 },
    ]
    // Only `size`: a Feather file keeps no statistics to type its 64-bit `hash` column by.
    const { job } = await setup(
      'synapses.feather',
      { key: { names: ['pre_pt_root_id'], ids: IDS, indexed: true } },
      'size',
    )
    const parts = await Promise.all(ranges.map((range) => readRowsJob(job(range), {})))
    const whole = await readRowsJob(job(), {})
    expect(whole.built?.pre_pt_root_id).toBeDefined()
    expect(mergeParts(parts, ranges, Infinity, 3).built).toEqual(whole.built)
  })
})

describe('a split read with a gap between its parts', () => {
  // What a split sized on the live blocks produces when statistics rule out a block between two
  // parts: that block is in no part, so no index may be joined across it — joined, every later
  // entry lands on the wrong block and a later lookup skips the block holding its id.
  it('joins no block index, and a stored index of the wrong length is not skipped by', async () => {
    const { job } = await setup(
      'synapses.feather',
      { key: { names: ['pre_pt_root_id'], ids: IDS, indexed: true } },
      'size',
    )
    const ranges = [
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ]
    const parts = await Promise.all(ranges.map((range) => readRowsJob(job(range), {})))
    expect(parts.every((part) => part.built?.pre_pt_root_id)).toBe(true)
    expect(mergeParts(parts, ranges, Infinity, 3).built).toBeUndefined()

    // An index one block short, as the join used to save, whose ranges rule every id out: used,
    // it would skip the first two blocks; ignored, every block is read.
    const short = { mins: [BASE + 100n, BASE + 100n], maxs: [BASE + 100n, BASE + 100n] }
    const read = await readRowsJob({ ...job(), held: { pre_pt_root_id: short } }, {})
    expect(read.blocksSkipped).toBe(0)
  })
})

describe('how a read is split', () => {
  const all = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('covers every block once, in order', () => {
    expect(splitBlocks(all(184), 7).reduce((n, r) => n + r.to - r.from, 0)).toBe(184)
    expect(splitBlocks(all(10), 3)).toEqual([
      { from: 0, to: 3 },
      { from: 3, to: 6 },
      { from: 6, to: 10 },
    ])
  })

  it('shares out the blocks a read can still find anything in, not the file’s', () => {
    // A sorted file: statistics leave eight blocks of two hundred, bunched at the start.
    const live = [0, 1, 2, 3, 4, 5, 6, 150]
    expect(splitBlocks(live, 2)).toEqual([
      { from: 0, to: 4 },
      { from: 4, to: 151 },
    ])
    expect(partCount(live.length, 14)).toBe(2)
  })

  it('takes every core but the page’s, and never a part too small to pay for its worker', () => {
    expect(partCount(184, 14)).toBe(13)
    expect(partCount(184, 64)).toBe(16)
    expect(partCount(3, 14)).toBe(1)
    expect(partCount(184, 1)).toBe(1)
  })
})
