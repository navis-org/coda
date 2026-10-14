import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  decodeNrrd,
  maxProjection,
  planePixels,
  readNrrdHeader,
  slicePlane,
  turnedPlanePixels,
} from './nrrd'

const header = (extra: string) =>
  new TextEncoder().encode(
    `NRRD0004\n# Created by Nrrd_Writer\ntype: uint8\ndimension: 3\nsizes: 3 2 2\n` +
      `space directions: (0.519,0,0) (0,0.519,0) (0,0,1)\n${extra}\n`,
  )
const voxels = Uint8Array.from({ length: 12 }, (_, i) => i * 10)
const file = (head: Uint8Array, body: Uint8Array) => {
  const bytes = new Uint8Array(head.length + body.length)
  bytes.set(head)
  bytes.set(body, head.length)
  return bytes
}

describe('NRRD stacks', () => {
  it('reads the header and body of a gzip-encoded 8-bit stack, as VFB serves them', async () => {
    const stack = await decodeNrrd(file(header('encoding: gzip\n'), gzipSync(voxels)))
    expect(stack).toMatchObject({ width: 3, height: 2, depth: 2, spacing: [0.519, 0.519, 1] })
    expect([...stack.data]).toEqual([...voxels])
    // The second slice, grey: each voxel's value in R, G and B, opaque.
    expect([...planePixels(slicePlane(stack, 1)).slice(0, 8)]).toEqual([
      60, 60, 60, 255, 70, 70, 70, 255,
    ])
  })

  it('reads a raw body, and fills a slice into the array it is handed', async () => {
    const stack = await decodeNrrd(file(header('encoding: raw\n'), voxels))
    expect([...stack.data]).toEqual([...voxels])
    const out = new Uint8ClampedArray(3 * 2 * 4)
    expect(planePixels(slicePlane(stack, 0), out)).toBe(out)
    expect([...out.slice(4, 8)]).toEqual([10, 10, 10, 255])
  })

  it('reads a header written with Windows line endings', async () => {
    const crlf = new TextEncoder().encode(
      'NRRD0004\r\ntype: uint8\r\ndimension: 3\r\nsizes: 3 2 2\r\nencoding: raw\r\n\r\n',
    )
    const stack = await decodeNrrd(file(crlf, voxels))
    expect(stack).toMatchObject({ width: 3, height: 2, depth: 2 })
    expect([...stack.data]).toEqual([...voxels])
  })

  it('refuses a stack that is not 8-bit, or shorter than its header says', async () => {
    expect(readNrrdHeader(header('encoding: raw\n')).fields.get('sizes')).toBe('3 2 2')
    const wide = new TextEncoder().encode(
      'NRRD0004\ntype: uint16\nsizes: 1 1 1\nencoding: raw\n\n\0\0',
    )
    await expect(decodeNrrd(wide)).rejects.toThrow(/uint16; only 8-bit/)
    await expect(
      decodeNrrd(file(header('encoding: gzip\n'), gzipSync(voxels.subarray(0, 5)))),
    ).rejects.toThrow(/holds 5 voxels where its header says 12/)
  })

  it('stops inflating once nobody is waiting for the stack', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      decodeNrrd(file(header('encoding: gzip\n'), gzipSync(voxels)), controller.signal),
    ).rejects.toThrow()
  })
})

describe('NRRD projection', () => {
  it('is the brightest voxel along z at each pixel', async () => {
    const stack = await decodeNrrd(file(header('encoding: raw\n'), voxels))
    // Two slices of six: 0..50 then 60..110, so the second wins everywhere.
    expect([...maxProjection(stack)]).toEqual([60, 70, 80, 90, 100, 110])
  })
})

describe('turning a plane', () => {
  it('turns a quarter clockwise as it writes the pixels, the left column becoming the top row', () => {
    // 3 wide, 2 tall:  1 2 3      turned: 4 1
    //                  4 5 6              5 2
    //                                     6 3
    const pixels = turnedPlanePixels(Uint8Array.of(1, 2, 3, 4, 5, 6), 3, 2)
    expect([...pixels].filter((_, i) => i % 4 === 0)).toEqual([4, 1, 5, 2, 6, 3])
  })
})
