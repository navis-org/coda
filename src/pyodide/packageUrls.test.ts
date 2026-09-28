import { describe, expect, it } from 'vitest'
import { packageUrls } from './packageUrls'

describe('Python public wheel URLs', () => {
  it.each([
    [true, 'https://example.test/src/pyodide/runtime.ts', 'https://example.test/'],
    [true, 'https://example.test/coda/src/pyodide/runtime.ts', 'https://example.test/coda/'],
    [false, 'https://example.test/assets/worker-abcd.js', 'https://example.test/'],
    [false, 'https://example.test/coda/assets/worker-abcd.js', 'https://example.test/coda/'],
  ] as const)('uses the app root (dev=%s, runtime=%s)', (dev, runtime, root) => {
    expect(
      packageUrls(['wheels/dotmotif.whl', 'https://cdn.test/lark.whl'], runtime, dev),
    ).toEqual([`${root}wheels/dotmotif.whl`, 'https://cdn.test/lark.whl'])
  })
})
