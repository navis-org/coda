/**
 * `lz4Frame`, the LZ4 frame walk in front of `lz4js`' block decoder, on frames built by hand — so
 * each flag is exercised on its own, block by block, which a twelve-row fixture never reaches.
 */

import lz4 from 'lz4js'
import { describe, expect, it } from 'vitest'

import { lz4Frame } from './libraries'

/** A frame of stored (uncompressed) blocks, each followed by a junk "checksum" where flagged. */
function frame(blocks: number[][], options: { blockSums?: boolean; size?: number } = {}) {
  const flags = 0x40 | (options.blockSums ? 0x10 : 0) | (options.size === undefined ? 0 : 0x08)
  const bytes = [0x04, 0x22, 0x4d, 0x18, flags, 0x40]
  if (options.size !== undefined) {
    for (let i = 0; i < 8; i++) bytes.push(i < 4 ? (options.size >>> (8 * i)) & 0xff : 0)
  }
  bytes.push(0xaa) // header checksum, unchecked
  for (const block of blocks) {
    const word = (block.length | 0x80000000) >>> 0
    for (let i = 0; i < 4; i++) bytes.push((word >>> (8 * i)) & 0xff)
    bytes.push(...block)
    if (options.blockSums) bytes.push(0xde, 0xad, 0xbe, 0xef)
  }
  bytes.push(0, 0, 0, 0)
  return new Uint8Array(bytes)
}

const BLOCKS = [
  [1, 2, 3],
  [4, 5],
  [6, 7, 8, 9],
]

describe('an LZ4 frame', () => {
  it('reads each block, stepping past a block checksum after it, not before', () => {
    expect([...lz4Frame(lz4, frame(BLOCKS, { blockSums: true }))]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it('reads the same frame without checksums, and one declaring its size', () => {
    expect([...lz4Frame(lz4, frame(BLOCKS))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect([...lz4Frame(lz4, frame(BLOCKS, { blockSums: true, size: 9 }))]).toHaveLength(9)
  })

  it('refuses a frame that decodes to other than the size it declares', () => {
    expect(() => lz4Frame(lz4, frame(BLOCKS, { size: 12 }))).toThrow(/declares 12/)
  })

  it('takes the length the caller read when the frame declares none, and holds it to it', () => {
    // apache-arrow's case: the length is the prefix before the buffer, never in the frame.
    expect(lz4Frame(lz4, frame(BLOCKS, { blockSums: true }), 9).byteLength).toBe(9)
    expect(() => lz4Frame(lz4, frame(BLOCKS), 12)).toThrow(/declares 12/)
  })

  it('agrees with lz4js on a compressed frame of its own', () => {
    const data = new Uint8Array(200_000).map((_, i) => (i * 7) % 251)
    expect(lz4Frame(lz4, lz4.compress(data))).toEqual(data)
  })
})
