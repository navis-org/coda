/**
 * The edge-set shelf, against real IndexedDB via `fake-indexeddb`.
 *
 * What is worth pinning here is not the round trip, which is a `put` and a `get`, but the four
 * places this module has to behave in a particular way or fail *plausibly*:
 *
 *  - **A chunk owns its bytes.** `subarray` shares a backing store and structured clone
 *    serialises the whole buffer behind a view, so chunking with one would store a hundred
 *    megabytes per chunk and round-trip perfectly while doing it. Only the record size shows it.
 *  - **A short read is no read.** A torn write must resolve `undefined`, not a truncated edge
 *    set — one is a state the caller already refuses on, the other is a wrong connectome.
 *  - **The id is the content**, so re-importing a file is free and a colleague importing the
 *    same file gets the same id. That is what makes a shared graph's refusal recoverable.
 *  - **Writes reject.** There is nothing to recompute an import from once the file handle is
 *    gone, so the no-storage case must not degrade quietly the way `cache.ts` does.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import { EdgeSetBuilder } from './encode'
import type { EncodedEdges } from './encode'
import {
  chunkArray,
  deleteEdgeSet,
  edgeSetsKnown,
  listEdgeSets,
  loadEdgeSet,
  peekEdgeSets,
  renameEdgeSet,
  resetEdgeSets,
  saveEdgeSet,
} from './store'

function encode(rows: [string, string, number][]): EncodedEdges {
  const b = new EdgeSetBuilder()
  for (const [pre, post, w] of rows) b.add(pre, post, w)
  return b.finish()
}

const WIDE = '720575940628857210'
const WIDER = '720575940628857211'

const SMALL: [string, string, number][] = [
  [WIDE, WIDER, 7],
  [WIDER, WIDE, 3],
  [WIDE, '1001', 250],
]

const save = (rows = SMALL, name = 'FlyWire 783') =>
  saveEdgeSet(encode(rows), { name, origin: 'edges.csv' })

beforeEach(() => {
  // A new factory per case, and the module told to forget the handle it opened against the old
  // one — without the second half every case after the first writes into a dead database.
  globalThis.indexedDB = new IDBFactory()
  resetEdgeSets()
})

describe('chunkArray', () => {
  it('gives every chunk its own buffer', () => {
    // The trap this exists for: structured clone serialises a view as its **whole** backing
    // store plus an offset — measured in node, a 2 MB subarray of an 8 MB array clones 8 MB —
    // so chunking with `subarray` stores the entire array once per chunk. The round trip stays
    // correct and the database is several times the size it should be.
    //
    // Asserted here rather than through the store because `fake-indexeddb` normalises views on
    // the way in, so every assertion routed through it passes under both spellings. Confirmed
    // by mutation: `slice` to `subarray` fails this and nothing else in the file.
    const array = new Uint32Array(2_000_000)
    const chunks = chunkArray(array, 1024 * 1024)
    expect(chunks.length).toBe(8)
    for (const chunk of chunks) {
      expect(chunk.buffer.byteLength).toBe(chunk.byteLength)
    }
  })

  it('covers the array exactly, with a short last chunk', () => {
    const array = Uint16Array.from({ length: 10 }, (_, i) => i)
    const chunks = chunkArray(array, 8)
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2])
    expect(chunks.flatMap((c) => [...c])).toEqual([...array])
  })

  it('is one empty chunk for an empty array, never none', () => {
    // The reader counts chunks off the meta, so zero would make a legitimately empty part
    // indistinguishable from a torn write.
    expect(chunkArray(new Uint8Array(0)).length).toBe(1)
  })
})

describe('the edge-set shelf', () => {
  it('round-trips an edge set, wide ids and both directions intact', async () => {
    const meta = await save()
    const set = await loadEdgeSet(meta.id)

    expect(set).toBeDefined()
    expect(set!.ids).toContain(WIDE)
    expect(set!.ids).toContain(WIDER)
    // The dictionary index has to survive, or every query resolves to the wrong neuron.
    expect(set!.index.get(WIDE)).toBe(set!.ids.indexOf(WIDE))

    const at = set!.index.get(WIDE)!
    const outs = []
    for (let i = set!.out.offsets[at]!; i < set!.out.offsets[at + 1]!; i++) {
      outs.push([set!.ids[set!.out.targets[i]!], set!.out.weights[i]])
    }
    expect(outs).toEqual(
      expect.arrayContaining([
        [WIDER, 7],
        ['1001', 250],
      ]),
    )
  })

  it('keeps the widths it was stored with', async () => {
    const meta = await save()
    const set = await loadEdgeSet(meta.id)
    // Three neurons and a max weight of 250: the narrowest rungs of both ladders. Reading them
    // back wider would work and reading them narrower would wrap, so the type is the assertion.
    expect(set!.out.targets).toBeInstanceOf(Uint16Array)
    expect(set!.out.weights).toBeInstanceOf(Uint8Array)
  })

  it('addresses by content, so re-importing the same file is free', async () => {
    const first = await save()
    const again = await save(SMALL, 'a different name')
    expect(again.id).toBe(first.id)
    // One entry, not two — the whole point of the catalogue at a hundred megabytes an item.
    expect(await listEdgeSets()).toHaveLength(1)
    expect((await listEdgeSets())[0]!.name).toBe('a different name')
  })

  it('gives two files over different neurons different ids, though the shape is identical', async () => {
    /*
     * The CSR holds *indices*, so `1→2` and `720575940628857210→720575940628857211` are
     * byte-for-byte the same arrays. Hashing only those made the second import answer "already
     * imported" and attach the first file's edges — a different connectome under the name
     * somebody just chose, with nothing to say so.
     */
    const small = await save([['1', '2', 5]], 'small ids')
    const wide = await save([[WIDE, WIDER, 5]], 'wide ids')
    expect(wide.id).not.toBe(small.id)
    expect(await listEdgeSets()).toHaveLength(2)
  })

  it('gives different content a different id', async () => {
    const a = await save()
    const b = await save([[WIDE, WIDER, 8]], 'other')
    expect(b.id).not.toBe(a.id)
    expect(await listEdgeSets()).toHaveLength(2)
  })

  it('reports what the loader had to say, so the panel can show it', async () => {
    const meta = await save([
      [WIDE, WIDER, 3],
      [WIDE, WIDER, 4],
      ['LC4', 'DNp01', 5],
    ])
    expect(meta.report.merged).toBe(1)
    expect(meta.report.nonNumericIds).toBe(2)
    expect(meta.edges).toBe(2)
    expect(meta.bytes).toBeGreaterThan(0)
  })

  it('renames without changing the id or losing the edges', async () => {
    const meta = await save()
    const renamed = await renameEdgeSet(meta.id, 'FlyWire 630')
    expect(renamed.id).toBe(meta.id)
    expect(renamed.name).toBe('FlyWire 630')
    // An attachment is by id, so a rename must not break one.
    expect((await loadEdgeSet(meta.id))!.ids).toContain(WIDE)
  })

  it('resolves undefined for a set this browser does not have', async () => {
    // The case the whole refusal rule rests on: not-here is distinguishable, so a dataset node
    // can refuse rather than quietly querying the backend and answering a different question.
    expect(await loadEdgeSet('nothing-by-that-name')).toBeUndefined()
  })

  it('deletes the entry and the bytes behind it', async () => {
    const meta = await save()
    await deleteEdgeSet(meta.id)
    expect(await listEdgeSets()).toEqual([])
    expect(await loadEdgeSet(meta.id)).toBeUndefined()
    // Nothing else can reclaim these bytes, so a delete that left the parts behind would be the
    // control that looks like it worked.
    expect(await partKeys(meta.id)).toEqual([])
  })

  it('reads a missing chunk as absent rather than as a shorter connectome', async () => {
    const meta = await save()
    await dropPart(`${meta.id}/out.targets/0`)
    resetEdgeSets()
    expect(await loadEdgeSet(meta.id)).toBeUndefined()
  })

  it('reads a short chunk as absent too, which the missing-chunk case cannot show', async () => {
    // A chunk that is *present but short* is the half a deleted record never reaches: the
    // per-chunk guard is satisfied and only the reconciliation against the meta's own length
    // catches it. Without that check the set loads with a truncated `targets` array — every
    // offset past the tear points into the wrong neuron's run, which is a wrong connectome
    // rather than a missing one.
    const meta = await save()
    await putPart(`${meta.id}/out.targets/0`, new Uint16Array(1))
    resetEdgeSets()
    expect(await loadEdgeSet(meta.id)).toBeUndefined()
  })

  it('peeks undefined before the catalogue is read, and the entries after', async () => {
    expect(edgeSetsKnown()).toBe(false)
    // Not an empty list: `inferOutputs` must be able to tell "no edge sets" from "not asked
    // yet", or a dataset node reports a missing set a second before the answer arrives.
    expect(peekEdgeSets()).toBeUndefined()
    await listEdgeSets()
    expect(edgeSetsKnown()).toBe(true)
    expect(peekEdgeSets()).toEqual([])
  })

  it('does not offer a set written by an older layout', async () => {
    const meta = await save()
    await rewriteMeta(meta.id, { ...meta, format: meta.format - 1 })
    resetEdgeSets()
    expect(await listEdgeSets()).toEqual([])
    expect(await loadEdgeSet(meta.id)).toBeUndefined()
  })

  describe('at a size that chunks', () => {
    // Two and a half million edges over seventy thousand neurons: `Uint32` targets, so the
    // targets array is 10 MB against an 8 MB chunk and really is split.
    const many = (): EncodedEdges => {
      const b = new EdgeSetBuilder()
      let seed = 0x9e3779b9
      const next = () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = seed
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) % 70_000
      }
      for (let i = 0; i < 2_500_000; i++) b.add(String(next()), String(next()), (i % 200) + 1)
      return b.finish()
    }

    it('stores each chunk as its own bytes, not a view onto the whole array', async () => {
      const encoded = many()
      const meta = await saveEdgeSet(encoded, { name: 'big', origin: 'big.csv' })
      expect(meta.parts['out.targets'].chunks).toBeGreaterThan(1)

      for (const size of await partSizes(meta.id, 'out.targets')) {
        expect(size).toBeLessThanOrEqual(8 * 1024 * 1024)
      }

      resetEdgeSets()
      const back = await loadEdgeSet(meta.id)
      expect(back!.out.targets.length).toBe(encoded.out.targets.length)
      expect(back!.out.targets.at(-1)).toBe(encoded.out.targets.at(-1))
      expect(back!.in.weights.at(-1)).toBe(encoded.in.weights.at(-1))
    }, 60_000)
  })

  describe('with no IndexedDB', () => {
    beforeEach(() => {
      // What a private window looks like from in here.
      // @ts-expect-error deliberately removing the platform API
      delete globalThis.indexedDB
      resetEdgeSets()
    })

    it('rejects a save rather than claiming to hold edges it does not', async () => {
      await expect(save()).rejects.toThrow(/no storage/i)
    })

    it('still reads as empty, so the catalogue degrades rather than throwing', async () => {
      expect(await listEdgeSets()).toEqual([])
      expect(await loadEdgeSet('anything')).toBeUndefined()
    })
  })
})

// --- reaching into the raw database, to assert what a public API cannot show -------------

function withParts<T>(
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve) => {
    const request = indexedDB.open('coda-edge-sets', 1)
    request.onsuccess = () => {
      const tx = request.result.transaction('parts', 'readwrite')
      run(tx.objectStore('parts'), resolve)
    }
  })
}

function partKeys(id: string): Promise<IDBValidKey[]> {
  return withParts<IDBValidKey[]>((store, done) => {
    const all = store.getAllKeys(IDBKeyRange.bound(`${id}/`, `${id}/￿`))
    all.onsuccess = () => done(all.result)
  })
}

function partSizes(id: string, part: string): Promise<number[]> {
  return withParts<number[]>((store, done) => {
    const all = store.getAll(IDBKeyRange.bound(`${id}/${part}/`, `${id}/${part}/￿`))
    all.onsuccess = () => done((all.result as ArrayBufferView[]).map((v) => v.byteLength))
  })
}

function putPart(key: string, value: ArrayBufferView): Promise<void> {
  return withParts<void>((store, done) => {
    const request = store.put(value, key)
    request.onsuccess = () => done()
  })
}

function dropPart(key: string): Promise<void> {
  return withParts<void>((store, done) => {
    const request = store.delete(key)
    request.onsuccess = () => done()
  })
}

function rewriteMeta(id: string, meta: unknown): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.open('coda-edge-sets', 1)
    request.onsuccess = () => {
      const tx = request.result.transaction('sets', 'readwrite')
      tx.objectStore('sets').put(meta, id)
      tx.oncomplete = () => resolve()
    }
  })
}
