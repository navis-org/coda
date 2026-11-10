/**
 * The decoder, against the reference encoder's own output.
 *
 * Every case in `__fixtures__/compressedSegmentation.json` was produced by the Python
 * `compressed_segmentation` package — the library cloudvolume calls — and its `values` are the
 * array flattened `order='F'`, which is the order the format stores and the order this decoder
 * must produce. Pinning against goldens rather than against a hand-written expectation is the
 * point: the format has three places where a plausible misreading decodes *something*, and a
 * test written from the same misreading as the code would agree with it.
 *
 * The cases are chosen for those places. `uniform` is the zero-bits path, where a block stores
 * no packed values at all. `ragged` has a chunk extent that is not a multiple of the block in
 * any axis, so the last block of each row is partial. `asymmetric-block` uses `8×4×2`, because
 * a cubic block size hides an axis swap completely — with `8×8×8` a transposed decode has the
 * right shape and the right labels and is simply in the wrong place.
 */

import { describe, expect, it } from 'vitest'

import cases from './__fixtures__/compressedSegmentation.json'
import { decodeCompressedSegmentation, expandLabels } from './compressedSegmentation'

type Case = {
  size: number[]
  block: number[]
  dtype: string
  bytes: string
  values: string[]
}

const named = cases as unknown as Record<string, Case>

function bufferOf(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

const triple = (xs: number[]) => [xs[0]!, xs[1]!, xs[2]!] as [number, number, number]

function decode(one: Case, lo?: [number, number, number], hi?: [number, number, number]) {
  return decodeCompressedSegmentation(
    bufferOf(one.bytes),
    { size: triple(one.size), block: triple(one.block) },
    one.dtype === 'uint64' ? 'uint64' : 'uint32',
    lo,
    hi,
  )
}

describe('decodeCompressedSegmentation', () => {
  it.each(Object.keys(named))(
    'decodes %s exactly as the reference encoder wrote it',
    (name) => {
      const one = named[name]!
      const box = decode(one)
      expect([...box.size]).toEqual(one.size)
      expect([...expandLabels(box)].map(String)).toEqual(one.values)
    },
  )

  /**
   * The factored form is the one callers get, so it is worth asserting directly rather than only
   * through `expandLabels`: the labels are the distinct values and nothing else.
   */
  it('returns the distinct labels, ascending, with indices into them', () => {
    const one = named['multi-block']!
    const box = decode(one)
    const expected = [...new Set(one.values)].map(BigInt).sort((a, b) => (a < b ? -1 : 1))
    expect([...box.labels]).toEqual(expected)
    expect(Math.max(...box.index)).toBe(expected.length - 1)
  })

  /**
   * Ascending regardless of the order the blocks happened to be walked in. Without the sort the
   * table's order is an artefact of the loop, which two cutouts of the same region could differ
   * on after any change to the traversal.
   */
  it('sorts the labels rather than returning them in block order', () => {
    const box = decode(named['wide-table']!)
    const ascending = [...box.labels].every((v, i, all) => i === 0 || all[i - 1]! < v)
    expect(ascending).toBe(true)
  })

  /** A block of one label encodes zero bits a voxel, so nothing is read from the packed area. */
  it('reads a block that stores no bits at all', () => {
    const box = decode(named['uniform']!)
    expect([...box.labels]).toEqual([12345678901234n])
    expect([...new Set(box.index)]).toEqual([0])
  })
})

describe('decoding a sub-box', () => {
  /**
   * The reason the decoder takes a box: a cutout sits inside chunks much larger than itself, so
   * decoding the whole chunk is several times the work for the same answer. It has to agree with
   * the full decode voxel for voxel, which is what this checks.
   */
  it('agrees with the full decode over the same region', () => {
    const one = named['multi-block']!
    const whole = decode(one)
    const lo: [number, number, number] = [3, 5, 2]
    const hi: [number, number, number] = [14, 11, 9]
    const part = decode(one, lo, hi)
    expect([...part.size]).toEqual([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])

    const full = expandLabels(whole)
    const cut = expandLabels(part)
    const [sx, sy] = [one.size[0]!, one.size[1]!]
    for (let z = lo[2]; z < hi[2]; z++) {
      for (let y = lo[1]; y < hi[1]; y++) {
        for (let x = lo[0]; x < hi[0]; x++) {
          const at =
            x - lo[0] + (y - lo[1]) * part.size[0] + (z - lo[2]) * part.size[0] * part.size[1]
          expect(cut[at], `${x},${y},${z}`).toBe(full[x + y * sx + z * sx * sy])
        }
      }
    }
  })

  /**
   * A box inside one block still has to land on the right voxels — this is the case where an
   * off-by-one in the block-local index is invisible in a whole-chunk decode, because there the
   * block-local and chunk-local walks happen to agree at the origin.
   */
  it('reads a box that lies inside a single block', () => {
    const one = named['multi-block']!
    const full = expandLabels(decode(one))
    const part = expandLabels(decode(one, [9, 9, 9], [12, 11, 10]))
    const [sx, sy] = [one.size[0]!, one.size[1]!]
    const expected: bigint[] = []
    for (let z = 9; z < 10; z++) {
      for (let y = 9; y < 11; y++) {
        for (let x = 9; x < 12; x++) expected.push(full[x + y * sx + z * sx * sy]!)
      }
    }
    expect([...part]).toEqual(expected)
  })

  /**
   * The labels are the sub-box's own. A corner of a chunk holding four objects should not come
   * back carrying the table of all forty — a caller sizes work off that list.
   */
  it('names only the labels the box actually holds', () => {
    const one = named['multi-block']!
    const part = decode(one, [0, 0, 0], [2, 2, 2])
    expect(part.labels.length).toBeLessThan(decode(one).labels.length)
    expect(new Set([...expandLabels(part)]).size).toBe(part.labels.length)
  })
})

describe('refusals', () => {
  /**
   * The old behaviour was the dangerous one: the block loops clamped but `size` came from the
   * unclamped `end`, so the caller got a box of the size it asked for with the overhang left as
   * index 0 — a band of "no object" along one face, indistinguishable from the real edge of a
   * segmentation.
   */
  it('refuses a box that reaches past the chunk', () => {
    const one = named['multi-block']!
    expect(() => decode(one, [0, 0, 0], [20, 16, 16])).toThrow(
      /ask only for what the chunk holds/,
    )
  })

  /**
   * A truncated chunk must not become a *different* label. The low word was checked and the
   * high word defaulted to 0, so a chunk cut between the two halves of a 64-bit id returned a
   * plausible 18-digit segment id for a different neuron — invariant 8's hazard, arriving as
   * data rather than as an error.
   */
  it('refuses a chunk that ends between the halves of a 64-bit label', () => {
    const one = named['wide-table']!
    const whole = bufferOf(one.bytes)
    // Keep the header and the start of the table; cut inside it.
    const short = whole.slice(0, 24)
    expect(() =>
      decodeCompressedSegmentation(
        short,
        { size: triple(one.size), block: triple(one.block) },
        'uint64',
      ),
    ).toThrow(/compressed_segmentation/)
  })

  it('refuses an empty box rather than returning an empty answer', () => {
    expect(() => decode(named['uniform']!, [4, 0, 0], [4, 8, 8])).toThrow(/empty/)
  })

  /**
   * A truncated chunk is a real failure mode — a Range request that came back short, a store
   * that served a partial object — and it must say so rather than decoding whatever happens to
   * be in the last word.
   */
  it('refuses a chunk that ends inside its own tables', () => {
    const one = named['multi-block']!
    const whole = bufferOf(one.bytes)
    const short = whole.slice(0, Math.floor(whole.byteLength / 3))
    expect(() =>
      decodeCompressedSegmentation(
        short,
        { size: triple(one.size), block: triple(one.block) },
        'uint64',
      ),
    ).toThrow(/compressed_segmentation/)
  })
})
