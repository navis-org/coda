/**
 * Reading voxels: the addressing, which is where this is silent when wrong.
 *
 * Almost nothing here is about whether a fetch works. It is about whether the right bytes are
 * asked for, and the three traps the module header names — the grid anchored on `voxel_offset`,
 * the last chunk of an axis named for where the data ends, and x-fastest order — all produce a
 * perfectly ordinary-looking box of segmentation when got wrong. The numbers in these tests are
 * Aedes' real ones (`32_32_45`, offset `[1024, 1536, 0]`, chunks `256×256×64`) because a scale
 * whose offset is zero, which is most test data, exercises none of it.
 */

import { describe, expect, it } from 'vitest'

import morton from './__fixtures__/mortonCodes.json'
import {
  boxAround,
  chunksCovering,
  compressedMortonCode,
  overlapOf,
  gridShapeOf,
  parseVolumeInfo,
  readLabelBox,
  readScalarBox,
  scaleNear,
} from './volume'
import type { Triple, VolumeScale } from './volume'

/** The Aedes segmentation's own `info`, trimmed to what this reader reads. */
const AEDES = {
  data_type: 'uint64',
  num_channels: 1,
  type: 'segmentation',
  scales: [
    {
      key: '16_16_45',
      resolution: [16, 16, 45],
      size: [41984, 29696, 7482],
      voxel_offset: [2048, 3072, 0],
      chunk_sizes: [[256, 256, 64]],
      encoding: 'compressed_segmentation',
      compressed_segmentation_block_size: [8, 8, 8],
    },
    {
      key: '32_32_45',
      resolution: [32, 32, 45],
      size: [20992, 14848, 7482],
      voxel_offset: [1024, 1536, 0],
      chunk_sizes: [[256, 256, 64]],
      encoding: 'compressed_segmentation',
      compressed_segmentation_block_size: [8, 8, 8],
    },
  ],
}

const coarse = () => parseVolumeInfo(AEDES).scales[1]!

describe('parseVolumeInfo', () => {
  it('reads the scales, their grids and their encodings', () => {
    const info = parseVolumeInfo(AEDES)
    expect(info.dataType).toBe('uint64')
    expect(info.volumeType).toBe('segmentation')
    expect(info.scales.map((s) => s.key)).toEqual(['16_16_45', '32_32_45'])
    expect(coarse().voxelOffset).toEqual([1024, 1536, 0])
    expect(coarse().blockSize).toEqual([8, 8, 8])
  })

  /**
   * The dtype is a volume-level field and every decode needs it, so it is copied down. Asserted
   * because the copy is the kind of thing a later refactor removes as redundant, and the symptom
   * would be every 64-bit label read as two 32-bit ones.
   */
  it('copies the dtype onto each scale', () => {
    expect(parseVolumeInfo(AEDES).scales.every((s) => s.dataType === 'uint64')).toBe(true)
  })

  /**
   * Throwing rather than defaulting, because each of these is a number a later step computes an
   * address from: a guessed resolution or chunk size reads real chunks from the wrong place.
   */
  it('refuses an info that is missing what addressing needs', () => {
    expect(() => parseVolumeInfo({})).toThrow(/names no scales/)
    expect(() => parseVolumeInfo({ scales: [{ resolution: [1, 1, 1] }] })).toThrow(/no key/)
    expect(() => parseVolumeInfo({ scales: [{ key: 'a', resolution: [1, 1, 1] }] })).toThrow(
      /no chunk size/,
    )
    expect(() =>
      parseVolumeInfo({
        scales: [{ key: 'a', resolution: [1, 1], size: [1, 1, 1], chunk_sizes: [[1, 1, 1]] }],
      }),
    ).toThrow(/not three numbers/)
  })

  /**
   * `voxel_offset` is genuinely optional in the spec, so defaulting it is following the spec
   * rather than guessing — the distinction the parser's comment draws.
   */
  it('defaults only the field the spec says is optional', () => {
    const info = parseVolumeInfo({
      data_type: 'uint32',
      scales: [{ key: 'a', resolution: [4, 4, 4], size: [8, 8, 8], chunk_sizes: [[8, 8, 8]] }],
    })
    expect(info.scales[0]!.voxelOffset).toEqual([0, 0, 0])
  })

  /**
   * A mip this reader cannot decode is dropped, not fatal. A volume publishing a `jxl` level
   * beside readable ones is ordinary, and `scaleNear` would never pick it — refusing the whole
   * document made such a volume unreadable over a level nobody asked for.
   */
  it('leaves out a scale it cannot decode and keeps the rest', () => {
    const info = parseVolumeInfo({
      data_type: 'uint64',
      scales: [
        {
          key: 'fine',
          resolution: [8, 8, 8],
          size: [8, 8, 8],
          chunk_sizes: [[8, 8, 8]],
          encoding: 'jxl',
        },
        {
          key: 'coarse',
          resolution: [16, 16, 16],
          size: [4, 4, 4],
          chunk_sizes: [[8, 8, 8]],
          encoding: 'raw',
        },
      ],
    })
    expect(info.scales.map((one) => one.key)).toEqual(['coarse'])
  })

  /** Only when *nothing* is left, and then the message names what was found. */
  it('refuses a volume whose every encoding it cannot decode, by name', () => {
    expect(() =>
      parseVolumeInfo({
        scales: [
          {
            key: 'a',
            resolution: [4, 4, 4],
            size: [8, 8, 8],
            chunk_sizes: [[8, 8, 8]],
            encoding: 'compresso',
          },
        ],
      }),
    ).toThrow(/compresso/)
  })

  /** The block size is not optional for the encoding that needs it to decode anything. */
  it('refuses compressed_segmentation with no block size', () => {
    expect(() =>
      parseVolumeInfo({
        scales: [
          {
            key: 'a',
            resolution: [4, 4, 4],
            size: [8, 8, 8],
            chunk_sizes: [[8, 8, 8]],
            encoding: 'compressed_segmentation',
          },
        ],
      }),
    ).toThrow(/block size/)
  })
})

describe('scaleNear', () => {
  /** SEAM asks for 64 nm; Aedes publishes 16 and 32, so the answer is the coarsest there is. */
  it('takes the nearest xy resolution', () => {
    expect(scaleNear(parseVolumeInfo(AEDES), 64).key).toBe('32_32_45')
    expect(scaleNear(parseVolumeInfo(AEDES), 16).key).toBe('16_16_45')
  })

  /**
   * Coarser on a tie, because the caller is stating a budget and the finer of a pair is four
   * times the voxels for one box.
   */
  it('prefers the coarser of two equally distant scales', () => {
    const info = parseVolumeInfo({
      data_type: 'uint64',
      scales: [8, 32].map((r) => ({
        key: `${r}`,
        resolution: [r, r, 40],
        size: [100, 100, 100],
        chunk_sizes: [[64, 64, 64]],
      })),
    })
    expect(scaleNear(info, 20).key).toBe('32')
  })
})

describe('boxAround', () => {
  /** The tip the Phase 6 measurement was taken on, so these are the real numbers. */
  it('converts a cube of nanometres into the scale’s own voxels', () => {
    const box = boxAround(coarse(), [250173, 313173, 276480], 3000)
    expect(box.lo).toEqual([7723, 9692, 6077])
    expect(box.hi).toEqual([7911, 9880, 6211])
    expect([box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]]).toEqual([
      188, 188, 134,
    ])
  })

  /**
   * Clamped, not refused: an end near the edge of a volume is ordinary, and the part of the box
   * that exists is a perfectly good answer.
   */
  it('clamps a box that reaches past the data', () => {
    const box = boxAround(coarse(), [1024 * 32, 1536 * 32, 0], 3000)
    expect(box.lo).toEqual([1024, 1536, 0])
  })

  /** A box entirely outside is a caller asking about somewhere else, and says so. */
  it('refuses a box with no overlap at all', () => {
    expect(() => boxAround(coarse(), [0, 0, 0], 1000)).toThrow(/lies outside/)
  })
})

describe('chunksCovering', () => {
  /**
   * The eight chunks measured against the live store, named exactly as the objects are. If the
   * grid were anchored on zero rather than on `voxel_offset` these would all still be real
   * chunks — just not the ones under the point.
   */
  it('names the chunks a real cutout needs, anchored on the voxel offset', () => {
    const chunks = chunksCovering(coarse(), boxAround(coarse(), [250173, 313173, 276480], 3000))
    expect(chunks).toHaveLength(8)
    expect(chunks.map((c) => c.name)).toEqual([
      '7680-7936_9472-9728_6016-6080',
      '7680-7936_9728-9984_6016-6080',
      '7680-7936_9472-9728_6080-6144',
      '7680-7936_9728-9984_6080-6144',
      '7680-7936_9472-9728_6144-6208',
      '7680-7936_9728-9984_6144-6208',
      '7680-7936_9472-9728_6208-6272',
      '7680-7936_9728-9984_6208-6272',
    ])
  })

  /**
   * The last chunk of an axis is named for where the volume ends. Writing `start + chunkSize`
   * instead 404s at exactly the three far faces of the volume and nowhere else.
   */
  it('names the final chunk of an axis by where the data actually ends', () => {
    const scale = coarse()
    const far = scale.voxelOffset[2] + scale.size[2] - 1
    const box = { lo: [7680, 9472, far - 1] as Triple, hi: [7700, 9500, far + 1] as Triple }
    const [chunk] = chunksCovering(scale, box)
    expect(chunk!.name.endsWith('_7424-7482')).toBe(true)
  })

  /** A box inside one chunk is one request, not four. */
  it('asks for one chunk where the box sits inside one', () => {
    const box = { lo: [1100, 1600, 10] as Triple, hi: [1120, 1620, 20] as Triple }
    expect(chunksCovering(coarse(), box)).toHaveLength(1)
  })
})

describe('overlapOf', () => {
  /**
   * Exported and, until now, untested — which its own doc argues is the worst state for it to
   * be in: it exists because the per-axis arithmetic was written three times, and the failure it
   * prevents (pairing one box's axis with another's) is a box shifted along one axis that
   * nothing downstream notices.
   */
  it('gives the wanted part in the chunk’s voxels and where it lands in the box’s', () => {
    const chunk = {
      lo: [100, 200, 300] as Triple,
      hi: [120, 220, 320] as Triple,
      grid: [1, 2, 3] as Triple,
      name: 'c',
    }
    // A box overlapping the chunk's near corner in x and lying inside it in y and z.
    const part = overlapOf(chunk, { lo: [90, 205, 310], hi: [110, 215, 400] })
    expect(part.lo).toEqual([0, 5, 10])
    expect(part.hi).toEqual([10, 15, 20])
    // The box starts 10 voxels before the chunk in x, so the chunk's first voxel lands at 10.
    expect(part.origin).toEqual([10, 0, 0])
    expect(part.extent).toEqual([20, 20, 20])
  })

  it('is the whole chunk where the box covers it', () => {
    const chunk = {
      lo: [0, 0, 0] as Triple,
      hi: [4, 4, 2] as Triple,
      grid: [0, 0, 0] as Triple,
      name: 'c',
    }
    const part = overlapOf(chunk, { lo: [0, 0, 0], hi: [8, 4, 2] })
    expect(part.lo).toEqual([0, 0, 0])
    expect(part.hi).toEqual([4, 4, 2])
    expect(part.origin).toEqual([0, 0, 0])
  })
})

describe('what a label volume may hold', () => {
  const raw = (dataType: string): VolumeScale => ({
    key: 's',
    resolution: [1, 1, 1],
    size: [8, 8, 8],
    voxelOffset: [0, 0, 0],
    chunkSize: [8, 8, 8],
    encoding: 'raw',
    dataType,
  })

  /**
   * The decode reads anything that is not `uint32` as `uint64`. On a `raw` scale that shows up
   * as a length disagreement, but a `compressed_segmentation` chunk has no length to disagree
   * with — it would come back holding plausible 18-digit labels made of paired 32-bit words.
   */
  it('refuses a dtype no label volume has', async () => {
    await expect(
      readLabelBox('https://store/v', raw('uint16'), { lo: [0, 0, 0], hi: [4, 4, 4] }),
    ).rejects.toThrow(/uint32 or uint64/)
  })

  /** Both readers answer about channel 0 and neither can be asked for another. */
  it('refuses a multi-channel volume rather than answering about the first', async () => {
    await expect(
      readLabelBox(
        'https://store/v',
        raw('uint64'),
        { lo: [0, 0, 0], hi: [4, 4, 4] },
        {
          info: { numChannels: 3 },
        },
      ),
    ).rejects.toThrow(/answers about one/)
  })
})

describe('a box outside the scale', () => {
  /**
   * The failure this prevents is the quiet one. Past the grid, `chunksCovering` mints a name
   * whose start is beyond its clamped end (`22784-22016`); that 404s, a 404 means "nothing is
   * written here", and the box comes back with a band of zeros along the face — indistinguishable
   * from the real edge of a segmentation. On a sharded scale the morton code of an out-of-grid
   * position can alias onto a key that exists, which fills the box with somewhere else entirely.
   */
  /** Empty before a request, rather than after one and then blamed on the chunk. */
  it('refuses a degenerate box without fetching anything', async () => {
    await expect(
      readLabelBox('https://store/v', coarse(), { lo: [2000, 2000, 10], hi: [2000, 2100, 20] }),
    ).rejects.toThrow(/is empty along x/)
  })

  it('refuses rather than returning a band of zeros', async () => {
    const scale = coarse()
    const past = scale.voxelOffset[0] + scale.size[0] + 1000
    await expect(
      readLabelBox('https://store/v', scale, {
        lo: [past, 1600, 10],
        hi: [past + 200, 1700, 20],
      }),
    ).rejects.toThrow(/not inside scale/)
  })

  /** `boxAround` clamps, so the ordinary path is unaffected — which the refusal names. */
  it('does not refuse a box boxAround produced at the very edge', () => {
    const scale = coarse()
    const edge = boxAround(
      scale,
      [scale.voxelOffset[0] * 32, scale.voxelOffset[1] * 32, 0],
      3000,
    )
    expect(edge.lo[0]).toBe(scale.voxelOffset[0])
    expect(edge.lo[1]).toBe(scale.voxelOffset[1])
  })
})

describe('the crash floor', () => {
  /**
   * The rail that catches a mistaken centre or half-width — the caller error this module's
   * header is written against. Pure arithmetic on the box, so it refuses before a single
   * request: no stub needed, and that is the point.
   */
  const huge = { lo: [0, 0, 0] as Triple, hi: [20000, 20000, 20000] as Triple }

  it('refuses a label box no runtime could allocate, naming a remedy', async () => {
    const scale: VolumeScale = {
      key: 's',
      resolution: [1, 1, 1],
      size: [20000, 20000, 20000],
      voxelOffset: [0, 0, 0],
      chunkSize: [64, 64, 64],
      encoding: 'compressed_segmentation',
      blockSize: [8, 8, 8],
      dataType: 'uint64',
    }
    await expect(readLabelBox('https://store/v', scale, huge)).rejects.toThrow(/coarser scale/)
  })

  it('refuses a scalar box the same way', async () => {
    const scale: VolumeScale = {
      key: 's',
      resolution: [1, 1, 1],
      size: [20000, 20000, 20000],
      voxelOffset: [0, 0, 0],
      chunkSize: [64, 64, 64],
      encoding: 'raw',
      dataType: 'uint8',
    }
    await expect(readScalarBox('https://store/v', scale, huge)).rejects.toThrow(/coarser scale/)
  })
})

describe('compressedMortonCode', () => {
  /**
   * Against cloudvolume's own `compressed_morton_code`, for grids that are *not* cubes — the
   * skip-an-exhausted-axis rule is the whole difficulty, and a plain Morton code agrees exactly
   * while all three axes are the same size.
   */
  it.each(morton as { grid: number[]; point: number[]; code: string }[])(
    'matches the reference at $point in a $grid grid',
    ({ grid, point, code }) => {
      expect(
        compressedMortonCode(
          [point[0]!, point[1]!, point[2]!],
          [grid[0]!, grid[1]!, grid[2]!],
        ).toString(),
      ).toBe(code)
    },
  )
})

describe('gridShapeOf', () => {
  it('counts the chunks per axis, rounding up for a partial one', () => {
    expect(gridShapeOf(coarse())).toEqual([82, 58, 117])
  })
})

/**
 * A store that computes each chunk's body from its name.
 *
 * Generative rather than the fixed URL→bytes map `src/test/precomputedStubs.ts`' `serveBytes`
 * gives: the point of these tests is *which* chunks are asked for, so building the map from
 * `chunksCovering` would make the naming assertions circular. `fill` is distinctive per voxel,
 * so a transposed or shifted read cannot match.
 */
function serveChunks(
  fill: (x: number, y: number, z: number) => number | bigint,
  Array_: typeof Uint8Array | typeof BigUint64Array,
  missing: Set<string> = new Set(),
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const name = url.slice(url.lastIndexOf('/') + 1)
    const match = /^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)$/.exec(name)
    if (missing.has(name) || !match) return new Response('no', { status: 404 })
    const [x0, x1, y0, y1, z0, z1] = match.slice(1).map(Number) as number[]
    const out = new Array_((x1! - x0!) * (y1! - y0!) * (z1! - z0!))
    let at = 0
    for (let z = z0!; z < z1!; z++) {
      for (let y = y0!; y < y1!; y++) {
        for (let x = x0!; x < x1!; x++) {
          ;(out as unknown as Record<number, unknown>)[at++] = fill(x, y, z)
        }
      }
    }
    return new Response(out.buffer as ArrayBuffer, { status: 200 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

/**
 * The assembly, driven through a stub store rather than the network.
 *
 * `raw` is used here because it needs no encoder to build a fixture, and the assembly — which
 * chunk's voxels land where in the box, and how two chunks' label tables are folded into one —
 * is the same code either way. The encoding-specific half is pinned in
 * `compressedSegmentation.test.ts` against the reference encoder.
 */
describe('readLabelBox', () => {
  const scale: VolumeScale = {
    key: 's',
    resolution: [1, 1, 1],
    size: [8, 4, 2],
    voxelOffset: [0, 0, 0],
    chunkSize: [4, 4, 2],
    encoding: 'raw',
    dataType: 'uint64',
  }

  /** `label(x, y, z)` — distinctive per voxel, so a transposition cannot pass. */
  const label = (x: number, y: number, z: number) => BigInt(100 + x * 10 + y * 2 + z)
  const stubFetch = (missing?: Set<string>) => serveChunks(label, BigUint64Array, missing)

  it('assembles a box that spans two chunks, in x-fastest order', async () => {
    const restore = stubFetch()
    try {
      const box = { lo: [2, 1, 0] as Triple, hi: [6, 3, 2] as Triple }
      const read = await readLabelBox('https://store/v', scale, box)
      expect([...read.size]).toEqual([4, 2, 2])
      const expected: bigint[] = []
      for (let z = 0; z < 2; z++) {
        for (let y = 1; y < 3; y++) {
          for (let x = 2; x < 6; x++) expected.push(label(x, y, z))
        }
      }
      expect([...read.index].map((i) => read.labels[i]!)).toEqual(expected)
    } finally {
      restore()
    }
  })

  /**
   * A 404 is "nothing is written here", which is ordinary at the edge of a segmentation — so
   * those voxels read as 0 and the rest of the box still arrives.
   */
  it('reads an absent chunk as zero rather than failing the box', async () => {
    const restore = stubFetch(new Set(['0-4_0-4_0-2']))
    try {
      const read = await readLabelBox('https://store/v', scale, {
        lo: [0, 0, 0],
        hi: [8, 4, 2],
      })
      expect(read.labels[0]).toBe(0n)
      expect(read.index[0]).toBe(0)
      // The chunk that does exist is unaffected.
      const at = 4 + 0 * 8 + 0 * 32
      expect(read.labels[read.index[at]!]).toBe(label(4, 0, 0))
    } finally {
      restore()
    }
  })

  /**
   * The table must be a function of the data, not of which response landed first. Chunks are
   * fetched concurrently, so without the final sort two reads of one box could hand back the
   * same voxels under different indices — and anything caching or comparing a cutout would see
   * them differ for no reason. Reversing the arrival order is the cheapest way to show it.
   */
  it('gives the same answer whichever order the chunks arrive in', async () => {
    const box = { lo: [0, 0, 0] as Triple, hi: [8, 4, 2] as Triple }
    const restore = stubFetch()
    try {
      const forwards = await readLabelBox('https://store/v', scale, box, { concurrency: 1 })
      // The same store, with the first request answering last — which is what concurrency can
      // do anyway. Wrapped in place rather than stubbed a second time.
      const served = globalThis.fetch
      let first = true
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const wait = first ? 20 : 0
        first = false
        await new Promise((resolve) => setTimeout(resolve, wait))
        return served(input, init)
      }) as typeof fetch
      const backwards = await readLabelBox('https://store/v', scale, box, { concurrency: 4 })
      expect([...backwards.labels]).toEqual([...forwards.labels])
      expect([...backwards.index]).toEqual([...forwards.index])
    } finally {
      restore()
    }
  })

  /**
   * A table naming an object no voxel has is a lie about the box — and label 0 is seeded into
   * the table so that an absent chunk needs no special case, so it is the one that can be left
   * over. A caller sizing work off `labels.length` would be counting it.
   */
  it('builds one table: ascending, and no slot unused', async () => {
    const restore = stubFetch()
    try {
      const read = await readLabelBox('https://store/v', scale, {
        lo: [0, 0, 0],
        hi: [8, 4, 2],
      })
      // Two chunks naming one object share an index, so the table is the box's own.
      expect(read.labels.length).toBe(new Set([...read.index]).size)
      expect([...read.labels].every((v, i, all) => i === 0 || all[i - 1]! < v)).toBe(true)
      // Seeded for the absent-chunk case; no voxel here is 0, so it must not survive.
      expect(read.labels).not.toContain(0n)
    } finally {
      restore()
    }
  })

  /** An image encoding is a different read, and says so rather than decoding noise. */
  it('refuses an image-encoded scale by name', async () => {
    await expect(
      readLabelBox(
        'https://store/v',
        { ...scale, encoding: 'jpeg' },
        {
          lo: [0, 0, 0],
          hi: [4, 4, 2],
        },
      ),
    ).rejects.toThrow(/readScalarBox/)
  })
})

/**
 * The scalar read, over `raw` only.
 *
 * The image half (`jpeg`, `png`) decodes through `createImageBitmap` and a canvas, neither of
 * which jsdom has — so what can be checked here is that it says so rather than failing somewhere
 * further in, and `pnpm probe:volume` checks the decode itself in a browser. That split is the
 * house rule for pixels, not a gap.
 */
describe('readScalarBox', () => {
  const scale: VolumeScale = {
    key: 'em',
    resolution: [8, 8, 40],
    size: [8, 4, 2],
    voxelOffset: [0, 0, 0],
    chunkSize: [4, 4, 2],
    encoding: 'raw',
    dataType: 'uint8',
  }

  it('reads a raw image box in x-fastest order', async () => {
    const restore = serveChunks((x, y, z) => x * 10 + y * 2 + z, Uint8Array)
    try {
      const read = await readScalarBox('https://store/v', scale, {
        lo: [2, 1, 0],
        hi: [6, 3, 2],
      })
      expect([...read.size]).toEqual([4, 2, 2])
      const expected: number[] = []
      for (let z = 0; z < 2; z++) {
        for (let y = 1; y < 3; y++) {
          for (let x = 2; x < 6; x++) expected.push(x * 10 + y * 2 + z)
        }
      }
      expect([...read.values]).toEqual(expected)
    } finally {
      restore()
    }
  })

  /**
   * A segmentation's absent chunk means "no object", which is what 0 says. An image's means
   * black, which is a real value — so absence has to be countable or a black slab in the middle
   * of a box is indistinguishable from data.
   */
  it('counts the chunks that were not there', async () => {
    const restore = serveChunks(
      (x, y, z) => x * 10 + y * 2 + z,
      Uint8Array,
      new Set(['0-4_0-4_0-2']),
    )
    try {
      const read = await readScalarBox('https://store/v', scale, {
        lo: [0, 0, 0],
        hi: [8, 4, 2],
      })
      expect(read.missingChunks).toBe(1)
      expect(read.values[0]).toBe(0)
      // The chunk that does exist is unaffected.
      expect(read.values[4]).toBe(40)
    } finally {
      restore()
    }
  })

  it('reports no missing chunks where every one answered', async () => {
    const restore = serveChunks((x, y, z) => x * 10 + y * 2 + z, Uint8Array)
    try {
      const read = await readScalarBox('https://store/v', scale, {
        lo: [0, 0, 0],
        hi: [8, 4, 2],
      })
      expect(read.missingChunks).toBe(0)
    } finally {
      restore()
    }
  })

  it('refuses a label encoding by name', async () => {
    await expect(
      readScalarBox(
        'https://store/v',
        { ...scale, encoding: 'compressed_segmentation', blockSize: [8, 8, 8] },
        { lo: [0, 0, 0], hi: [4, 4, 2] },
      ),
    ).rejects.toThrow(/readLabelBox/)
  })

  /** An image scale claiming a wide dtype is a disagreement worth naming, not rounding away. */
  it('refuses an image scale that claims it holds more than 8 bits', async () => {
    await expect(
      readScalarBox(
        'https://store/v',
        { ...scale, encoding: 'jpeg', dataType: 'uint16' },
        { lo: [0, 0, 0], hi: [4, 4, 2] },
      ),
    ).rejects.toThrow(/decodes to 8-bit/)
  })
})
