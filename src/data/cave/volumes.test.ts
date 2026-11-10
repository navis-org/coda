/**
 * Where a datastack's voxels are, which is two different answers by two different routes.
 *
 * Worth testing apart from the readers because the failure is an address: a bucket resolved
 * wrongly 404s per chunk, and a 404 means "nothing is written here" to the volume reader — so a
 * mistake here arrives as an empty region rather than as an error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DatastackInfo } from './api'
import { resetCredentials, setToken } from './credentials'
import { DEFAULT_CAVE_SERVER } from './deployments'
import { imageVolumeOf, supervoxelVolumeOf } from './volumes'

const AEDES: DatastackInfo = {
  local_server: 'https://cave.fanc-fly.com',
  segmentation_source:
    'graphene://https://cave.fanc-fly.com/segmentation/table/wclee_aedes_brain',
  aligned_volume: {
    name: 'wclee_aedes_brain',
    image_source: 'precomputed://gs://zetta_lee_mosquito_001_alignment_central/img/v2_sharded',
  },
}

describe('imageVolumeOf', () => {
  /** The real record, so the prefix stripping and the bucket rewrite are both exercised. */
  it('strips the viewer prefix and rewrites the bucket', () => {
    expect(imageVolumeOf(AEDES)).toBe(
      'https://storage.googleapis.com/zetta_lee_mosquito_001_alignment_central/img/v2_sharded',
    )
  })

  /** An image source is optional — a datastack of segmentation alone is valid. */
  it('is undefined where the datastack publishes none', () => {
    expect(imageVolumeOf({ local_server: 'x' })).toBeUndefined()
    expect(imageVolumeOf({ local_server: 'x', aligned_volume: { name: 'a' } })).toBeUndefined()
  })

  /**
   * A scheme nothing here can rewrite is undefined rather than guessed onto a host. A bucket
   * mapped onto the wrong host answers 404 per chunk, which the reader takes for empty space.
   */
  it('refuses a scheme it cannot rewrite rather than guessing a host', () => {
    expect(
      imageVolumeOf({
        local_server: 'x',
        aligned_volume: { image_source: 'precomputed://zarr://b/c' },
      }),
    ).toBeUndefined()
  })

  /** A plain https source is already an address. */
  it('passes an https source through', () => {
    expect(
      imageVolumeOf({
        local_server: 'x',
        aligned_volume: { image_source: 'precomputed://https://h/v/' },
      }),
    ).toBe('https://h/v')
  })
})

describe('supervoxelVolumeOf', () => {
  // The chunkedgraph is not public even where the bucket it names is, which is half of what
  // this function is for: one authenticated request, then an address anyone can read.
  beforeEach(() => setToken(DEFAULT_CAVE_SERVER, 'test-token'))
  afterEach(() => resetCredentials())

  /**
   * The supervoxels are **not** at the graphene address: that is the chunkedgraph, whose `info`
   * names the bucket the watershed voxels are actually in. Reading the graphene URL as a volume
   * is the plausible mistake, and it would 404 on every chunk.
   */
  it('reads the bucket out of the chunkedgraph’s own info', async () => {
    const original = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return new Response(
        JSON.stringify({ data_dir: 'gs://fanc-fly_segmentation/wclee_aedes_brain' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      await expect(
        supervoxelVolumeOf(AEDES, { deployment: DEFAULT_CAVE_SERVER }),
      ).resolves.toBe('https://storage.googleapis.com/fanc-fly_segmentation/wclee_aedes_brain')
      // The chunkedgraph's own info, not the bucket and not the datastack record.
      expect(asked).toEqual([
        'https://cave.fanc-fly.com/segmentation/table/wclee_aedes_brain/info',
      ])
    } finally {
      globalThis.fetch = original
    }
  })

  it('is undefined where the datastack names no segmentation', async () => {
    await expect(
      supervoxelVolumeOf({ local_server: 'x' }, { deployment: DEFAULT_CAVE_SERVER }),
    ).resolves.toBeUndefined()
  })
})
