import { describe, expect, it } from 'vitest'

import {
  MANIFEST_SCHEMA,
  checkManifest,
  completeVariants,
  fileUrl,
  type LoadedManifest,
  type ModelManifest,
} from './manifest'

function file(
  variant: string,
  part: 'encoder' | 'decoder',
  over: Record<string, unknown> = {},
) {
  return {
    variant,
    part,
    file: `${variant}/${part}.onnx`,
    url: null,
    bytes: 10,
    sha256: 'a'.repeat(64),
    quantisation: { kind: 'nbits' as const, bits: 8, blockSize: 128 },
    ...over,
  }
}

function manifest(over: Partial<ModelManifest> = {}): ModelManifest {
  return {
    id: 'affinity-flywire',
    manifestSchema: MANIFEST_SCHEMA,
    model: 'ae_d1024_m512',
    depth: 24,
    datasets: ['flywire'],
    license: 'MIT',
    citation: 'Troidl et al.',
    source: 'https://example.invalid',
    parameters: 380577793,
    opset: 17,
    upstreamCommit: 'abc123',
    randomWeights: false,
    preprocessing: {
      units: 'um',
      globalScale: 659.88367,
      centre: 'centroid',
      samplesPerNeuron: 1024,
      jitter: 1,
      translate: 20,
      padValue: -1,
    },
    clustering: { linkage: 'average', threshold: 0.8, minClusterSize: 30 },
    signatures: {
      encoder: { inputs: ['points', 'mask'], outputs: ['latents', 'point_emb'], dynamic: {} },
      decoder: {
        inputs: ['latents', 'point_emb', 'pairs'],
        outputs: ['affinity'],
        dynamic: {},
      },
    },
    files: [file('mixed', 'encoder'), file('mixed', 'decoder')],
    ...over,
  } as ModelManifest
}

const loaded = (m: ModelManifest, url: string): LoadedManifest => ({ manifest: m, url })

describe('fileUrl', () => {
  /**
   * The property the whole hosting story rests on: the same uploaded directory works at any host
   * and any path, because a file resolves against wherever its manifest was fetched from.
   */
  it('resolves a file against the manifest it came from', () => {
    const at = loaded(manifest(), 'https://example.org/deep/path/manifest.json')
    expect(fileUrl(at, 'mixed', 'encoder')).toBe(
      'https://example.org/deep/path/mixed/encoder.onnx',
    )
  })

  it('prefers an explicit url, for a file not served beside its manifest', () => {
    const m = manifest({
      files: [file('mixed', 'encoder', { url: 'https://cdn.invalid/e.onnx' })],
    })
    expect(fileUrl(loaded(m, 'https://example.org/manifest.json'), 'mixed', 'encoder')).toBe(
      'https://cdn.invalid/e.onnx',
    )
  })

  it('names what is missing rather than returning a broken address', () => {
    expect(() =>
      fileUrl(loaded(manifest(), 'https://e.org/m.json'), 'nbits4', 'encoder'),
    ).toThrow(/no nbits4\/encoder/)
  })
})

describe('completeVariants', () => {
  it('lists only variants carrying both halves', () => {
    const m = manifest({
      files: [file('mixed', 'encoder'), file('mixed', 'decoder'), file('fp16', 'encoder')],
    })
    expect(completeVariants(m)).toEqual(['mixed'])
  })
})

describe('checkManifest', () => {
  it('accepts a whole manifest', () => {
    expect(checkManifest(manifest()).id).toBe('affinity-flywire')
  })

  /** The converter stamps the schema precisely so a stale conversion is caught here. */
  it('refuses a schema it does not read', () => {
    expect(() => checkManifest(manifest({ manifestSchema: 99 }))).toThrow(/schema 99/)
  })

  /**
   * A shape-test export carries every other field of a real one -- citation, licence, training
   * constants -- so without this check the two are indistinguishable to every later reader.
   */
  it('refuses a random-weights export', () => {
    expect(() => checkManifest(manifest({ randomWeights: true }))).toThrow(/random-weights/)
  })

  it('refuses a manifest with no usable variant', () => {
    expect(() => checkManifest(manifest({ files: [file('mixed', 'encoder')] }))).toThrow(
      /no variant with both/,
    )
  })

  /** Without the signatures the worker cannot name a single tensor, so this is not optional. */
  it('refuses a manifest missing a part signature', () => {
    const broken = manifest()
    expect(() =>
      checkManifest({
        ...broken,
        signatures: { ...broken.signatures, decoder: { inputs: [], outputs: [], dynamic: {} } },
      }),
    ).toThrow(/no decoder signature/)
  })
})
