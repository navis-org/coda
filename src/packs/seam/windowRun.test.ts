/**
 * The batched scoring, against a fake session that answers scores it already knows.
 *
 * What is worth testing is the plumbing rather than the model: that every window is scored
 * exactly once, that the two heads land under the right names, that a batch's results go to the
 * right windows, and that Cancel is seen between batches rather than at the end.
 */

import { describe, expect, it, vi } from 'vitest'

import type { LoadedManifest } from '../../ml/manifest'
import type { WireTensor } from '../../ml/protocol'
import type { GraphRunner } from '../../ml/session'
import { WINDOW_BATCH, scoreWindows } from './windowRun'

const SIGNATURE = {
  model: {
    inputs: ['points', 'feats'],
    outputs: ['point_logits', 'window_logit'],
    dynamic: {},
  },
}

function loaded(signatures: unknown = SIGNATURE): LoadedManifest {
  return {
    url: 'https://example.invalid/manifest.json',
    manifest: { id: 'test-model', signatures, parts: ['model'] },
  } as unknown as LoadedManifest
}

/**
 * A session that scores window *w* as `w` and point *p* of it as `w * 1000 + p`, so every value
 * says where it came from: a batch written to the wrong offset is a wrong number, not a
 * plausible one. It reads the *first coordinate* of each window to learn which window it is,
 * which is what catches a batch sliced from the wrong place.
 */
function fakeSession(nPoints: number, options: { signatures?: unknown } = {}) {
  const batches: number[] = []
  const runner: GraphRunner = {
    loaded: loaded(options.signatures ?? SIGNATURE),
    run: async ({ feeds = [] }) => {
      const points = new Float32Array(feeds[0]!.data)
      const count = points.length / (nPoints * 3)
      batches.push(count)
      const windowLogit = new Float32Array(count)
      const pointLogits = new Float32Array(count * nPoints)
      for (let b = 0; b < count; b++) {
        const which = points[b * nPoints * 3]!
        windowLogit[b] = which
        for (let p = 0; p < nPoints; p++) pointLogits[b * nPoints + p] = which * 1000 + p
      }
      const out: WireTensor[] = [
        { name: 'window_logit', type: 'float32', dims: [count], data: windowLogit.buffer },
        {
          name: 'point_logits',
          type: 'float32',
          dims: [count, nPoints],
          data: pointLogits.buffer,
        },
      ]
      return out
    },
  }
  return { runner, batches }
}

/** `windows × nPoints × 3`, where every coordinate of window w is w. */
const cloud = (windows: number, nPoints: number) =>
  Float32Array.from({ length: windows * nPoints * 3 }, (_, i) => Math.floor(i / (nPoints * 3)))

describe('scoreWindows', () => {
  it('scores every window once and keeps them in order', async () => {
    const windows = 5
    const nPoints = 4
    const { runner, batches } = fakeSession(nPoints)
    const got = await scoreWindows(
      runner,
      cloud(windows, nPoints),
      cloud(windows, nPoints),
      windows,
      nPoints,
    )
    expect([...got.windowLogits]).toEqual([0, 1, 2, 3, 4])
    expect(batches.reduce((a, b) => a + b, 0)).toBe(windows)
  })

  it('puts each window’s point logits in its own slice', async () => {
    const windows = 3
    const nPoints = 4
    const { runner } = fakeSession(nPoints)
    const got = await scoreWindows(
      runner,
      cloud(windows, nPoints),
      cloud(windows, nPoints),
      windows,
      nPoints,
    )
    expect([...got.pointLogits.slice(0, 4)]).toEqual([0, 1, 2, 3])
    expect([...got.pointLogits.slice(8, 12)]).toEqual([2000, 2001, 2002, 2003])
  })

  /**
   * The heads are read **by name**. Returned in the other order they would otherwise be swapped,
   * and a per-point array read as per-window is a length error rather than a wrong picture — but
   * only by luck, and only while the two differ in length.
   */
  it('reads the two heads by name, not by position', async () => {
    const nPoints = 4
    const { runner } = fakeSession(nPoints)
    const reversed: GraphRunner = {
      ...runner,
      run: async (request) => [...(await runner.run(request))].reverse(),
    }
    const got = await scoreWindows(reversed, cloud(2, nPoints), cloud(2, nPoints), 2, nPoints)
    expect([...got.windowLogits]).toEqual([0, 1])
  })

  it('batches, and stops between batches when the signal aborts', async () => {
    const windows = WINDOW_BATCH * 4
    const nPoints = 2
    const { runner, batches } = fakeSession(nPoints)
    const controller = new AbortController()
    const onProgress = vi.fn(() => controller.abort())
    await expect(
      scoreWindows(runner, cloud(windows, nPoints), cloud(windows, nPoints), windows, nPoints, {
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(batches).toEqual([WINDOW_BATCH])
  })

  /** What crosses the worker boundary is transferred, so the caller's buffer must survive. */
  it('leaves the caller’s arrays intact', async () => {
    const points = cloud(3, 2)
    const feats = cloud(3, 2)
    const { runner } = fakeSession(2)
    await scoreWindows(runner, points, feats, 3, 2)
    expect(points.length).toBe(18)
    expect(feats.length).toBe(18)
  })

  it('refuses a window count the arrays cannot hold', async () => {
    const { runner } = fakeSession(4)
    await expect(scoreWindows(runner, cloud(2, 4), cloud(2, 4), 3, 4)).rejects.toThrow(
      'need 36',
    )
  })
})
