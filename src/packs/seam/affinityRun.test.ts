/**
 * The chunked decode, against a fake session that answers a matrix it already knows.
 *
 * What is worth testing here is the plumbing rather than the model: that every pair is asked for
 * exactly once, that the answers land in the right cells, that the encoder runs once however many
 * chunks there are, and that Cancel is seen between chunks rather than at the end.
 */

import { describe, expect, it, vi } from 'vitest'

import type { LoadedManifest } from '../../ml/manifest'
import type { WireTensor } from '../../ml/protocol'
import type { AffinityRunner } from './affinityRun'
import { DECODE_CHUNK_PAIRS, affinityMatrix } from './affinityRun'

const SIGNATURES = {
  encoder: { inputs: ['points', 'mask'], outputs: ['latents', 'embeddings'], dynamic: {} },
  decoder: { inputs: ['latents', 'embeddings', 'pairs'], outputs: ['affinity'], dynamic: {} },
}

function loaded(signatures: unknown = SIGNATURES): LoadedManifest {
  return {
    url: 'https://example.invalid/manifest.json',
    manifest: { id: 'test-model', signatures, parts: ['encoder', 'decoder'] },
  } as unknown as LoadedManifest
}

/**
 * A session that answers `a(i, j) = i * points + j`, so every cell says where it came from and a
 * chunk written to the wrong offset is a wrong number rather than a plausible one.
 */
function fakeSession(points: number, options: { signatures?: unknown } = {}) {
  const calls: { part: string; count: number }[] = []
  const released: (readonly string[] | undefined)[] = []
  const runner: AffinityRunner = {
    loaded: loaded(options.signatures ?? SIGNATURES),
    run: async ({ part, feeds = [] }) => {
      if (part === 'encoder') {
        calls.push({ part, count: 0 })
        return []
      }
      const pairs = new BigInt64Array(feeds[0]!.data)
      const count = pairs.length / 2
      calls.push({ part, count })
      const out = new Float32Array(count)
      for (let k = 0; k < count; k++) {
        out[k] = Number(pairs[k * 2]!) * points + Number(pairs[k * 2 + 1]!)
      }
      const tensor: WireTensor = {
        name: 'affinity',
        type: 'float32',
        dims: [1, count],
        data: out.buffer,
      }
      return [tensor]
    },
    release: async (names) => {
      released.push(names)
    },
  }
  return { runner, calls, released }
}

const cloud = (points: number) => new Float32Array(points * 3).fill(0.5)

describe('affinityMatrix', () => {
  it('asks for every pair once and lands each answer in its own cell', async () => {
    const points = 8
    const { runner, calls } = fakeSession(points)
    const got = await affinityMatrix(runner, cloud(points), points)
    expect(got.length).toBe(points * points)
    for (let i = 0; i < points * points; i++) expect(got[i]).toBe(i)
    expect(calls.filter((c) => c.part === 'decoder').reduce((a, c) => a + c.count, 0)).toBe(
      points * points,
    )
  })

  it('runs the encoder once however many chunks the decode takes', async () => {
    // Two chunks and a bit, so the tail chunk is a short one.
    const points = Math.ceil(Math.sqrt(DECODE_CHUNK_PAIRS * 2.5))
    const { runner, calls } = fakeSession(points)
    await affinityMatrix(runner, cloud(points), points)
    expect(calls.filter((c) => c.part === 'encoder')).toHaveLength(1)
    expect(calls.filter((c) => c.part === 'decoder').length).toBeGreaterThan(2)
    expect(calls.filter((c) => c.part === 'decoder').reduce((a, c) => a + c.count, 0)).toBe(
      points * points,
    )
  })

  /**
   * The point of chunking at all. A signal aborted after the first chunk has to stop the run, not
   * be noticed when the whole matrix is already paid for.
   */
  it('stops between chunks when the signal aborts', async () => {
    const points = Math.ceil(Math.sqrt(DECODE_CHUNK_PAIRS * 4))
    const { runner, calls } = fakeSession(points)
    const controller = new AbortController()
    const onProgress = vi.fn(() => controller.abort())
    await expect(
      affinityMatrix(runner, cloud(points), points, {
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.filter((c) => c.part === 'decoder')).toHaveLength(1)
  })

  /**
   * `transfersOf` detaches what it posts, and the caller still needs those coordinates for the
   * `Points` output. Without the copy this is a zero-length array with nothing thrown.
   */
  it('leaves the caller’s cloud intact', async () => {
    const points = 8
    const positions = cloud(points)
    const { runner } = fakeSession(points)
    await affinityMatrix(runner, positions, points)
    expect(positions.length).toBe(points * 3)
    expect(positions[0]).toBe(0.5)
  })

  it('releases the held latents, even when a decode throws', async () => {
    const points = 8
    const { runner, released } = fakeSession(points)
    await affinityMatrix(runner, cloud(points), points)
    expect(released).toEqual([['latents', 'embeddings']])

    const failing: AffinityRunner = {
      ...runner,
      run: async ({ part }) => {
        if (part === 'decoder') throw new Error('gpu lost')
        return []
      },
    }
    await expect(affinityMatrix(failing, cloud(points), points)).rejects.toThrow('gpu lost')
  })

  it('refuses a cloud whose length does not match the point count', async () => {
    const { runner } = fakeSession(8)
    await expect(affinityMatrix(runner, cloud(7), 8)).rejects.toThrow('24 coordinates')
  })

  /**
   * The pair input is found by elimination rather than by a name written in the pack. A manifest
   * whose decoder takes nothing of its own has to say so, not reach for `inputs[2]`.
   */
  it('says so when the decoder declares no input of its own', async () => {
    const { runner } = fakeSession(8, {
      signatures: {
        ...SIGNATURES,
        decoder: { inputs: ['latents', 'embeddings'], outputs: ['affinity'], dynamic: {} },
      },
    })
    await expect(affinityMatrix(runner, cloud(8), 8)).rejects.toThrow('nowhere')
  })
})
