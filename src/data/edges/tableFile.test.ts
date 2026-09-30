/**
 * A whole edge list read out of a table file, against the pyarrow fixtures (`__fixtures__/make.py`):
 * twelve synapse-like rows, four pre ids of three rows each.
 *
 * Pinned: that the three layouts — sorted and shuffled Parquet, lz4 Feather, and Parquet split into
 * per-page chunks — encode to the same edge set, that an eighteen-digit id arrives exact from a
 * 64-bit column, and that a file rewritten since it was linked is refused rather than read.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { EncodedEdges } from './encode'
import { residentEdgeSet } from './store'
import { edgesFrom } from './query'
import type { FileSpec } from '../files/bytes'
import { blobBytes } from '../files/bytes'
import type { ReadEdgesRequest } from './tableFile'
import { readTableFileEdgesJob } from './tableFile'
import { openTableFile } from '../files/read'

const BASE = 720575940600000000n
const id = (offset: number) => (BASE + BigInt(offset)).toString()

function blob(name: string): Blob {
  return new Blob([readFileSync(`src/data/files/__fixtures__/${name}`)])
}

async function read(name: string, columns: Omit<ReadEdgesRequest, 'fingerprint'>) {
  const file = blob(name)
  const { summary } = await openTableFile(blobBytes(file))
  const spec: FileSpec = { kind: 'blob', blob: file }
  return readTableFileEdgesJob(
    { spec, request: { fingerprint: summary.fingerprint, ...columns } },
    {},
  )
}

/** Every edge, as `pre→post:weight` text, in a stable order. */
function edgeList(encoded: EncodedEdges): string[] {
  const set = residentEdgeSet(encoded)
  return edgesFrom(set, set.ids, 'outputs')
    .map((edge) => `${edge.pre}→${edge.post}:${edge.weight}`)
    .sort()
}

const ENDS = { pre: 'pre_pt_root_id', post: 'post_pt_root_id' }

describe('an edge list read from a table file', () => {
  it('reads every row, with the ids exact', async () => {
    const encoded = await read('synapses.parquet', { ...ENDS, weight: 'size' })
    expect(encoded.report).toMatchObject({ rowsRead: 12, droppedId: 0, droppedWeight: 0 })
    expect(encoded.edges).toBe(12)
    // Eighteen digits, as text: past 2^53, so a double would have changed them.
    expect(encoded.ids).toContain(id(0))
    expect(encoded.ids).toContain(id(1000))
    // Row 0: pre BASE, post BASE + 1000, size 10.
    expect(edgeList(encoded)).toContain(`${id(0)}→${id(1000)}:10`)
  })

  it('encodes the same set from every layout of the same rows', async () => {
    const want = edgeList(await read('synapses.parquet', { ...ENDS, weight: 'size' }))
    for (const name of [
      'synapses-unsorted.parquet',
      'synapses.feather',
      'synapses-required.parquet',
    ]) {
      expect(edgeList(await read(name, { ...ENDS, weight: 'size' }))).toEqual(want)
    }
  })

  it('counts each row as one when no weight is chosen', async () => {
    const encoded = await read('synapses.parquet', ENDS)
    expect(edgeList(encoded).every((edge) => edge.endsWith(':1'))).toBe(true)
  })

  it('refuses a file that is not the one the columns were chosen from', async () => {
    const spec: FileSpec = { kind: 'blob', blob: blob('synapses.parquet') }
    await expect(
      readTableFileEdgesJob({ spec, request: { fingerprint: 'stale', ...ENDS } }, {}),
    ).rejects.toThrow(/changed since it was opened/)
  })

  it('names a column the file does not have', async () => {
    await expect(read('synapses.parquet', { ...ENDS, weight: 'weight' })).rejects.toThrow(
      /no column "weight"/,
    )
  })
})
