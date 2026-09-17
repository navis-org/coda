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
  getMeshUpload,
  getUpload,
  getUploadMeta,
  peekMeshUpload,
  peekUploadMeta,
  peekUploadSchema,
  putMeshUpload,
  putUpload,
  resetUploads,
  subscribeUploadLearned,
  uploadPeekSettled,
} from './uploads'
import { tetra } from '../test/meshes'

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
    // Narrowed rather than asserted through: the descriptor is a union now, and the `kind` is
    // what a card reads before it decides which of the two it can draw.
    if (meta?.kind !== 'table') throw new Error('expected a table descriptor')
    expect(meta.name).toBe('annotations.csv')
    expect(meta.rows).toBe(2)
    expect(meta.bytes).toBe(4096)
    expect(meta.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'cellType'])
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
    const meta = peekUploadMeta(id)
    expect(meta?.kind === 'table' && meta.rows).toBe(2)
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

  it('resolves a read to nothing', async () => {
    // @ts-expect-error — see above.
    delete globalThis.indexedDB
    resetUploads()
    expect(await getUpload('u_anything')).toBeUndefined()
  })
})

describe('meshes, in the same database', () => {
  it('stores typed arrays and hands back the same numbers', async () => {
    // IndexedDB's structured clone carries a `Float32Array` as one, which is the whole reason
    // geometry can live here rather than being re-encoded into something JSON can hold.
    const id = await putMeshUpload('2 files', [tetra('LO_R'), tetra('ME_R')], 512)
    const back = await getMeshUpload(id)
    expect(back?.map((mesh) => mesh.name)).toEqual(['LO_R', 'ME_R'])
    expect(back?.[0]?.positions).toBeInstanceOf(Float32Array)
    expect([...(back?.[0]?.positions ?? [])]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('keeps a descriptor that lists the meshes without loading them', async () => {
    const id = await putMeshUpload('2 files', [tetra('LO_R'), tetra('ME_R')], 512)
    const meta = await getUploadMeta(id)
    if (meta?.kind !== 'meshes') throw new Error('expected a mesh descriptor')
    expect(meta.items).toEqual([
      { name: 'LO_R', file: 'LO_R.obj', vertices: 4, triangles: 4 },
      { name: 'ME_R', file: 'ME_R.obj', vertices: 4, triangles: 4 },
    ])
  })

  it('addresses by content, over the names as well as the geometry', async () => {
    // Two files holding one shell under two names are two uploads: the name is what the region
    // is called downstream, so an id blind to it would hand back somebody else's labels.
    const a = await putMeshUpload('one', [tetra('LO_R')], 64)
    const again = await putMeshUpload('a different label', [tetra('LO_R')], 999)
    const renamed = await putMeshUpload('one', [tetra('ME_R')], 64)
    expect(again).toBe(a)
    expect(renamed).not.toBe(a)
  })

  it('does not run two items together, which would collide two different picks', async () => {
    // `['ab', 'c']` and `['a', 'bc']` concatenate to the same text — the separator's whole job,
    // and the same one `uploadId` uses for cells.
    const first = await putMeshUpload('x', [tetra('ab'), tetra('c')], 64)
    const second = await putMeshUpload('x', [tetra('a'), tetra('bc')], 64)
    expect(first).not.toBe(second)
  })

  it('answers the peek for its own kind and not for the other', async () => {
    /*
     * The two ids are indistinguishable strings, so a node handed the wrong one must reach its
     * own "not in this browser" rather than wait for a read that has already landed.
     */
    const meshes = await putMeshUpload('one', [tetra('LO_R')], 64)
    const table = await putUpload('annotations.csv', SAMPLE(), 128)

    expect(peekMeshUpload(meshes)?.items).toHaveLength(1)
    expect(peekUploadSchema(meshes)).toBeUndefined()
    expect(peekMeshUpload(table)).toBeUndefined()
    expect(peekUploadSchema(table)).toBeDefined()
    // Both settled either way: "the wrong kind" is an answer, not a wait.
    expect(uploadPeekSettled(meshes)).toBe(true)
    expect(uploadPeekSettled(table)).toBe(true)
  })

  it('reads a record written before meshes existed as a table', async () => {
    /*
     * Every upload any user already has was written by a build in which `kind` did not exist, so
     * this writes one the way that build did — straight into the store, with the field absent —
     * rather than deleting it from a copy, which would assert nothing. Read without the default
     * such a record is neither kind, so a perfectly good CSV draws as "not in this browser": the
     * one state whose sentence tells somebody to go and find a file they still have.
     */
    const id = await putUpload('annotations.csv', SAMPLE(), 128)
    const meta = await getUploadMeta(id)
    if (meta?.kind !== 'table') throw new Error('expected a table descriptor')
    const { kind: _kind, ...legacy } = meta
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('coda-uploads', 2)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(['meta'], 'readwrite')
        tx.objectStore('meta').put(legacy, id)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })

    resetUploads()
    expect(peekUploadMeta(id)).toBeUndefined()
    await vi.waitFor(() => expect(uploadPeekSettled(id)).toBe(true))
    expect(peekUploadMeta(id)?.kind).toBe('table')
    // And it is usable, not merely labelled: the schema is what every column picker reads.
    expect(peekUploadSchema(id)?.columns.map((c) => c.name)).toEqual(['neuronId', 'cellType'])
  })
})
