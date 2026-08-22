/**
 * The uploads store.
 *
 * Three properties carry the feature, and none of them is the round trip:
 *
 *  - **The id is the content.** It is this node's entire contribution to the provenance key,
 *    so re-picking the same file must produce the same id (nothing downstream re-runs) and a
 *    file differing in one cell must produce a different one (everything downstream does).
 *    A uuid would pass a round-trip test and fail both of those.
 *  - **A failed write rejects.** Every other storage path here degrades silently, because
 *    failing to remember a fetched value is not failing to compute it. An upload has nothing
 *    to recompute from once the File handle is gone, so the no-storage case has to reject —
 *    and this is the test that would catch a well-meant `try/catch` added later for symmetry
 *    with `data/cache.ts`.
 *  - **The peek starts one read and announces it.** `inferOutputs` may not await, so the
 *    schema arrives through a mirror that fills itself. What has to be true is that a miss is
 *    *also* announced — otherwise a node whose rows are absent waits forever on a card that
 *    never stops saying "looking".
 *
 * Runs against `fake-indexeddb`: a persistence layer verified against an in-memory shim
 * verifies the shim.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { TableValue } from '../core/values'
import { tableFromRows } from '../core/values'
import {
  getUpload,
  getUploadMeta,
  peekUploadMeta,
  peekUploadSchema,
  putUpload,
  resetUploads,
  subscribeUploadLearned,
  uploadPeekSettled,
  uploadsAvailable,
} from './uploads'

const SCHEMA = tableSchema(column('neuronId', 'i64'), column('cellType', 'str'))

function annotations(rows: Array<{ neuronId: number; cellType: string }>): TableValue {
  return tableFromRows(SCHEMA, rows)
}

const SAMPLE = () =>
  annotations([
    { neuronId: 1, cellType: 'LC4' },
    { neuronId: 2, cellType: 'LC6' },
  ])

beforeEach(() => {
  // A fresh factory per case, and the module told to forget both the handle it opened against
  // the old one and its session mirror — without the second half every case after the first
  // writes into a dead database and peeks stale answers out of the first one's mirror.
  globalThis.indexedDB = new IDBFactory()
  resetUploads()
})

describe('storing', () => {
  it('round-trips a table', async () => {
    const id = await putUpload('annotations.csv', SAMPLE(), 42)
    const back = await getUpload(id)
    expect(back?.length).toBe(2)
    expect(back?.data['cellType']).toEqual(['LC4', 'LC6'])
    expect(back?.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'cellType'])
  })

  it('keeps a descriptor that can be read without the rows', async () => {
    const id = await putUpload('annotations.csv', SAMPLE(), 4096)
    const meta = await getUploadMeta(id)
    expect(meta?.name).toBe('annotations.csv')
    expect(meta?.rows).toBe(2)
    expect(meta?.bytes).toBe(4096)
    expect(meta?.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'cellType'])
  })

  it('resolves to nothing for an id this browser does not have', async () => {
    expect(await getUpload('u_nope')).toBeUndefined()
    expect(await getUploadMeta('u_nope')).toBeUndefined()
  })
})

describe('content addressing', () => {
  it('gives the same file the same id, whatever it was called', async () => {
    // The provenance consequence: re-picking a file you already imported re-runs nothing
    // downstream, because the node's params come out identical.
    const first = await putUpload('annotations.csv', SAMPLE(), 42)
    const second = await putUpload('annotations-copy.csv', SAMPLE(), 42)
    expect(second).toBe(first)
  })

  it('gives a different id for one changed cell', async () => {
    const first = await putUpload('a.csv', SAMPLE(), 42)
    const changed = await putUpload(
      'a.csv',
      annotations([
        { neuronId: 1, cellType: 'LC4' },
        { neuronId: 2, cellType: 'LC9' },
      ]),
      42,
    )
    expect(changed).not.toBe(first)
  })

  it('distinguishes files differing only in their schema', async () => {
    // Same values, different column names: a downstream picker points at a name that is now
    // gone, so this must not be read as the same import.
    const other = tableFromRows(tableSchema(column('neuronId', 'i64'), column('type', 'str')), [
      { neuronId: 1, type: 'LC4' },
      { neuronId: 2, type: 'LC6' },
    ])
    expect(await putUpload('a.csv', other, 42)).not.toBe(await putUpload('a.csv', SAMPLE(), 42))
  })

  it('does not collide when one cell ends where the next begins', async () => {
    // Two rows of one column, so nothing else is interleaved between the values: concatenated
    // without a separator both files are the string "abc", and the two imports become one.
    const stringy = tableSchema(column('a', 'str'))
    const left = tableFromRows(stringy, [{ a: 'ab' }, { a: 'c' }])
    const right = tableFromRows(stringy, [{ a: 'a' }, { a: 'bc' }])
    expect(await putUpload('l.csv', left, 1)).not.toBe(await putUpload('r.csv', right, 1))
  })
})

describe('the peek', () => {
  it('answers nothing at first and the schema once the read lands', async () => {
    const id = await putUpload('annotations.csv', SAMPLE(), 42)
    // `putUpload` warms the mirror itself, so drop it to reach the cold path a reload takes.
    resetUploads()

    expect(peekUploadSchema(id)).toBeUndefined()
    expect(uploadPeekSettled(id)).toBe(false)

    await vi.waitFor(() => expect(uploadPeekSettled(id)).toBe(true))
    expect(peekUploadSchema(id)?.columns.map((c) => c.name)).toEqual(['neuronId', 'cellType'])
    expect(peekUploadMeta(id)?.rows).toBe(2)
  })

  it('announces a miss too, so an absent upload stops looking', async () => {
    // Without this the card sits on "looking for the stored rows" forever, which is the one
    // state that must resolve into a sentence telling somebody to pick the file again.
    const seen = vi.fn()
    const off = subscribeUploadLearned(seen)
    expect(peekUploadSchema('u_missing')).toBeUndefined()
    await vi.waitFor(() => expect(seen).toHaveBeenCalled())
    expect(uploadPeekSettled('u_missing')).toBe(true)
    expect(peekUploadSchema('u_missing')).toBeUndefined()
    off()
  })

  it('is settled and silent for a node with no file yet', () => {
    // An empty id is not a pending read: nothing was ever asked for.
    expect(uploadPeekSettled('')).toBe(true)
    expect(peekUploadSchema('')).toBeUndefined()
    expect(peekUploadMeta('')).toBeUndefined()
  })

  it('starts one read however many times inference peeks', async () => {
    const id = await putUpload('annotations.csv', SAMPLE(), 42)
    resetUploads()
    const seen = vi.fn()
    const off = subscribeUploadLearned(seen)
    // Inference runs on every graph mutation, so this is a keystroke's worth of peeks. One
    // read per peek would be a request per keystroke — the thing `schemasFor` exists to avoid.
    for (let i = 0; i < 20; i++) peekUploadSchema(id)
    await vi.waitFor(() => expect(seen).toHaveBeenCalled())
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('announces a fresh upload without waiting to be peeked', async () => {
    const seen = vi.fn()
    const off = subscribeUploadLearned(seen)
    const id = await putUpload('annotations.csv', SAMPLE(), 42)
    // The schema is known the instant it is stored, so the node's pickers fill on import
    // rather than on the next reload.
    expect(seen).toHaveBeenCalled()
    expect(peekUploadSchema(id)?.columns).toHaveLength(2)
    off()
  })
})

describe('without storage', () => {
  it('rejects a write rather than pretending', async () => {
    // The inversion of this codebase's usual storage rule, and the whole reason there is no
    // in-memory fallback here: something that lives until the tab reloads is not a save.
    // @ts-expect-error — removing the global is the only way to reach the no-storage path.
    delete globalThis.indexedDB
    resetUploads()
    await expect(putUpload('annotations.csv', SAMPLE(), 42)).rejects.toThrow(/no storage/i)
  })

  it('resolves a read to nothing, and says it is unavailable', async () => {
    // @ts-expect-error — see above.
    delete globalThis.indexedDB
    resetUploads()
    expect(await uploadsAvailable()).toBe(false)
    expect(await getUpload('u_anything')).toBeUndefined()
  })
})
