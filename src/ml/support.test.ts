import { describe, expect, it } from 'vitest'

import type { ModelManifest } from './manifest'
import { preferredVariant } from './support'

function file(variant: string, part: string, bytes: number, emits: string) {
  return {
    variant,
    part,
    file: `${variant}/${part}.onnx`,
    url: null,
    bytes,
    sha256: 'a'.repeat(64),
    quantisation: { kind: 'x', emits: [emits] },
  }
}

const manifest = (files: unknown[]) =>
  ({ id: 'm', parts: ['encoder', 'decoder'], files }) as unknown as ModelManifest

describe('preferredVariant', () => {
  /**
   * The finding this exists for. int8 is the smallest complete variant here, and choosing by size
   * alone would take it — a model that loads, answers, and runs on the CPU 16x slow with nothing
   * to say about it.
   */
  it('refuses a variant whose graph emits an op WebGPU does not implement', () => {
    expect(
      preferredVariant(
        manifest([
          file('int8', 'encoder', 10, 'MatMulInteger'),
          file('int8', 'decoder', 10, 'MatMulInteger'),
          file('mixed', 'encoder', 50, 'MatMulNBits'),
          file('mixed', 'decoder', 50, 'MatMul'),
        ]),
      ),
    ).toBe('mixed')
  })

  it('takes the smallest of the variants it can run', () => {
    expect(
      preferredVariant(
        manifest([
          file('fp16', 'encoder', 400, 'MatMul'),
          file('fp16', 'decoder', 400, 'MatMul'),
          file('nbits4', 'encoder', 100, 'MatMulNBits'),
          file('nbits4', 'decoder', 100, 'MatMulNBits'),
        ]),
      ),
    ).toBe('nbits4')
  })

  /** A variant missing a declared part is not runnable whatever its ops say. */
  it('ignores an incomplete variant', () => {
    expect(
      preferredVariant(
        manifest([
          file('half', 'encoder', 1, 'MatMul'),
          file('whole', 'encoder', 90, 'MatMul'),
          file('whole', 'decoder', 90, 'MatMul'),
        ]),
      ),
    ).toBe('whole')
  })

  it('answers undefined when nothing can run', () => {
    expect(
      preferredVariant(
        manifest([
          file('int8', 'encoder', 1, 'MatMulInteger'),
          file('int8', 'decoder', 1, 'MatMulInteger'),
        ]),
      ),
    ).toBeUndefined()
  })
})
