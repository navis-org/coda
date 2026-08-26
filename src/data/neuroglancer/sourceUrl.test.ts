/**
 * Source-spec parsing.
 *
 * The property that matters most is not any single case: it is that the **three spellings of one
 * address collapse onto one canonical string**. That string is the registry key, so if they did
 * not, pasting a bucket URL with a trailing slash would register a second `PrecomputedSource`,
 * re-probe the same `info`, and give two nodes pointing at the same directory two different
 * dataset ids — which downstream reads as two datasets.
 */

import { describe, expect, it } from 'vitest'

import { parseNgSource } from './sourceUrl'

const MALECNS = 'precomputed://gs://flyem-male-cns/v1.0/segmentation'

describe('parseNgSource', () => {
  it('reads all three spellings of one address as the same source', () => {
    const spellings = [
      'precomputed://gs://flyem-male-cns/v1.0/segmentation/',
      'gs://flyem-male-cns/v1.0/segmentation/|neuroglancer-precomputed:',
      'gs://flyem-male-cns/v1.0/segmentation',
    ]
    const canonical = spellings.map((text) => parseNgSource(text)?.canonical)
    expect(canonical).toEqual([MALECNS, MALECNS, MALECNS])
  })

  it('keeps the location in its own scheme and resolves the URL separately', () => {
    // The object-store spelling is what a neuroglancer layer's `source` field wants back, so it
    // has to survive the round trip; the HTTP form is only for `fetch`.
    const ref = parseNgSource(MALECNS)
    expect(ref?.location).toBe('gs://flyem-male-cns/v1.0/segmentation')
    expect(ref?.url).toBe('https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation')
  })

  it('records whether the format was stated or guessed', () => {
    expect(parseNgSource('gs://b/p')?.stated).toBe(false)
    expect(parseNgSource('gs://b/p')?.scheme).toBe('precomputed')
    expect(parseNgSource('precomputed://gs://b/p')?.stated).toBe(true)
    expect(parseNgSource('gs://b/p|neuroglancer-precomputed:')?.stated).toBe(true)
  })

  it('normalises the zarr aliases the pipe syntax uses', () => {
    expect(parseNgSource('gs://b/p|zarr2:')?.scheme).toBe('zarr')
    expect(parseNgSource('gs://b/p|zarr3:')?.scheme).toBe('zarr')
    expect(parseNgSource('n5://gs://b/p')?.scheme).toBe('n5')
  })

  it('skips a pipe segment that names no format it knows', () => {
    // The options half of a segment can hold anything, including a colon of its own. Adopting an
    // unrecognised name would make `subsources=default` a data format.
    expect(parseNgSource('gs://b/p|subsources=default|neuroglancer-precomputed:')?.scheme).toBe(
      'precomputed',
    )
  })

  it('does not read a location scheme as a format', () => {
    // The first `://` in `gs://bucket/path` belongs to the location. Read as a format it leaves
    // no location at all.
    const ref = parseNgSource('https://example.org/data/seg/')
    expect(ref?.scheme).toBe('precomputed')
    expect(ref?.location).toBe('https://example.org/data/seg')
    expect(ref?.url).toBe('https://example.org/data/seg')
  })

  it('strips middleauth+, which is an instruction to a viewer rather than an address', () => {
    // Otherwise the same graphene source pasted out of spelunker and out of the Seung-lab fork
    // are two different locations — see `scene.ts`, where the two disagree about the prefix.
    const ref = parseNgSource('graphene://middleauth+https://cave.example.org/segmentation/table/x')
    expect(ref?.scheme).toBe('graphene')
    expect(ref?.location).toBe('https://cave.example.org/segmentation/table/x')
  })

  it('uses virtual-hosted style for S3', () => {
    // The path-style endpoint 301s, and fetch will not follow a redirect that drops CORS headers.
    expect(parseNgSource('precomputed://s3://bucket/a/b')?.url).toBe(
      'https://bucket.s3.amazonaws.com/a/b',
    )
  })

  it('parses a scheme it cannot fetch, and says so by leaving the URL off', () => {
    // Parsing and reachability are different questions: the node reports the second one, and it
    // can only do that if the first one succeeded.
    const ref = parseNgSource('dvid://https://emdata5.janelia.org/8e29f/segmentation')
    expect(ref?.scheme).toBe('dvid')
    expect(ref?.url).toBe('https://emdata5.janelia.org/8e29f/segmentation')
    expect(parseNgSource('brainmaps://12345:fafb:v1')?.url).toBeUndefined()
  })

  it('answers undefined only for a string with nothing in it', () => {
    expect(parseNgSource('')).toBeUndefined()
    expect(parseNgSource('   ')).toBeUndefined()
    expect(parseNgSource('precomputed://')).toBeUndefined()
  })
})
