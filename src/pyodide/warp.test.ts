/**
 * `warpPoints` against a bridge that behaves like the real one: `callPython` **transfers**
 * every typed array in a call's arguments, so `points` is detached by the time the promise
 * resolves. Nothing else in the suite exercises that — `xform.test.ts` and `mirror.test.ts`
 * both mock this module out, and jsdom has neither a `Worker` nor Pyodide — which is how the
 * post-call `points.length` read survived: it reads 0 on a detached buffer, so every warp of a
 * non-empty geometry failed with "Warp returned 642 points for 0".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callPython } from './engine'
import { forgetWarpCoefficients, warpPoints } from './warp'
import type { LandmarkPairs } from '../data/transforms/landmarks'
import type { PyCall } from './types'

vi.mock('./engine', () => ({ callPython: vi.fn() }))

const mockedCall = vi.mocked(callPython)

const PAIRS: LandmarkPairs = {
  id: 'test-landmarks',
  source: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  target: new Float64Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2]),
  count: 4,
}

/** What `postMessage` does to a transferred buffer, without a `Worker` to do it. */
function detach(buffer: Float32Array): void {
  structuredClone(buffer.buffer, { transfer: [buffer.buffer] })
}

beforeEach(async () => {
  await forgetWarpCoefficients(PAIRS)
  mockedCall.mockReset()
  mockedCall.mockImplementation(async (call: PyCall) => {
    if (call.fn === 'coda_warp_fit') {
      return {
        weights: new Float32Array(PAIRS.count * 3),
        affine: new Float32Array(12),
        fitMs: 1,
      }
    }
    const request = call.args[0] as { points: Float32Array }
    const points = request.points
    const positions = points.map((v) => v + 1)
    detach(points)
    return { positions, count: positions.length / 3, fitMs: 0, applyMs: 1 }
  })
})

describe('warpPoints', () => {
  it('accepts a result whose length matches the points it was handed, detached or not', async () => {
    const points = new Float32Array([1, 2, 3, 4, 5, 6])

    const result = await warpPoints(PAIRS, points)

    expect(points.length).toBe(0) // the bridge took it, as the real one does
    expect(Array.from(result.positions)).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('still refuses a result of a different length', async () => {
    mockedCall.mockImplementation(async (call: PyCall) => {
      if (call.fn === 'coda_warp_fit') {
        return { weights: new Float32Array(PAIRS.count * 3), affine: new Float32Array(12), fitMs: 1 }
      }
      const request = call.args[0] as { points: Float32Array }
      detach(request.points)
      const positions = new Float32Array(3)
      return { positions, count: 1, fitMs: 0, applyMs: 1 }
    })

    await expect(warpPoints(PAIRS, new Float32Array([1, 2, 3, 4, 5, 6]))).rejects.toThrow(
      'Warp returned 1 points for 2',
    )
  })
})
