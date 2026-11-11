/**
 * `scoreCandidates`, against a session and a bridge that answer what the test already knows.
 *
 * The property worth pinning is **what happens to a candidate that never got a patch**. Its
 * logit goes into a softmax over the tip's list, so a dropped row silently changes every other
 * row's share, and a row left at zero outranks half the list — zero is a perfectly good logit.
 * Neither failure throws, and neither shows in a count.
 */

import { describe, expect, it, vi } from 'vitest'

import type { GraphRunner } from '../../ml/session'
import type {
  AssessorBox,
  AssessorPatches,
  OpenAssessorBox,
} from '../../pyodide/assessorPatches'
import type { AssessorConfig } from './assessorModel'
import { PATCH_GROUP, scoreCandidates } from './assessorRun'

/** The bridge's cutter, bound to one open box — what `useAssessorBox` hands a body. */
type CutPatches = OpenAssessorBox['cut']

/** A patch of two voxels a side, so a test's arrays are readable. */
const SIDE = 2
const VOXELS = SIDE ** 3

const CONFIG: AssessorConfig = {
  seed: 0,
  patchVoxels: SIDE,
  patchNm: 32,
  batch: 1,
  missingPatchScore: -58.722,
  gflopPerPatch: 86.8,
}

/**
 * The floor as it comes back out.
 *
 * `logits` is a `Float32Array` — the model's own answers are float32, and holding them at a
 * wider precision would be a second story about what a logit is. So the manifest's float64
 * `missingPatchScore` narrows on the way in, and the test says so rather than quietly rounding.
 */
const FLOOR = Math.fround(CONFIG.missingPatchScore)

function runner(answer: (call: number) => number): GraphRunner {
  let call = 0
  return {
    loaded: {
      url: 'https://host/manifest.json',
      manifest: {
        id: 'sa2_mask_s0',
        parts: ['assess'],
        signatures: { assess: { inputs: ['lab'], outputs: ['logit'], dynamic: {} } },
      },
    },
    run: vi.fn(async () => {
      const value = answer(call++)
      return [
        {
          name: 'logit',
          type: 'float32' as const,
          dims: [1],
          data: Float32Array.from([value]).buffer,
        },
      ]
    }),
  } as unknown as GraphRunner
}

function box(present: number[], absent: number[] = [], patchSize = SIDE): AssessorBox {
  return {
    id: 1,
    present: Int32Array.from(present),
    absent: Int32Array.from(absent),
    patchSize,
    patchNm: 32,
    boxVoxels: 1000,
    ms: 10,
  }
}

/** Hands back one patch per present candidate, with `outside` taken out of the middle. */
function cutter(present: number[], outside: number[] = []): CutPatches {
  return async ({ from = 0, count }) => {
    const want = present.slice(from, count === undefined ? undefined : from + count)
    const given = want.filter((one) => !outside.includes(one))
    return {
      patches: new Uint8Array(given.length * VOXELS),
      given: Int32Array.from(given),
      outside: Int32Array.from(want.filter((one) => outside.includes(one))),
      ms: 5,
    } satisfies AssessorPatches
  }
}

/** The handle `useAssessorBox` hands a body: a box, and a cutter bound to that box. */
function open(
  present: number[],
  absent: number[] = [],
  outside: number[] = [],
  cut: CutPatches = cutter(present, outside),
): OpenAssessorBox {
  return { box: box(present, absent), cut }
}

describe('scoreCandidates', () => {
  it('puts each logit at its own candidate’s index', async () => {
    const got = await scoreCandidates(
      runner((call) => [1.5, -2.5, 0.25][call] ?? 0),
      CONFIG,
      open([0, 1, 2]),
    )
    expect([...got.logits]).toEqual([1.5, -2.5, 0.25])
    expect([...got.missing]).toEqual([])
    expect(got.scored).toBe(3)
  })

  /* The order the box answers in is the *present* order, which need not be 0,1,2… */
  it('follows the candidate index, not the position in the group', async () => {
    const got = await scoreCandidates(
      runner((call) => [10, 20][call] ?? 0),
      CONFIG,
      open([3, 1], [0, 2, 4]),
    )
    expect(got.logits[3]).toBe(10)
    expect(got.logits[1]).toBe(20)
  })

  it('gives an absent candidate the checkpoint’s floor, not a zero', async () => {
    const got = await scoreCandidates(
      runner(() => 2),
      CONFIG,
      open([0, 2], [1]),
    )
    expect(got.logits[1]).toBe(FLOOR)
    expect([...got.missing]).toEqual([1])
    expect(got.scored).toBe(2)
  })

  it('gives a candidate whose patch left the box the same floor', async () => {
    const got = await scoreCandidates(
      runner(() => 3),
      CONFIG,
      open([0, 1, 2], [], [1]),
    )
    expect(got.logits[1]).toBe(FLOOR)
    expect([...got.missing]).toEqual([1])
    expect(got.scored).toBe(2)
  })

  it('merges the two kinds of missing, in order', async () => {
    const got = await scoreCandidates(
      runner(() => 1),
      CONFIG,
      open([0, 2, 3], [1, 4], [2]),
    )
    /* 1 and 4 have no voxel in the box; 2's patch left it. All three take the floor. */
    expect([...got.missing]).toEqual([1, 2, 4])
    expect(got.scored).toBe(2)
  })

  it('scores nothing when the box could cut nothing', async () => {
    const seen: number[] = []
    const got = await scoreCandidates(
      runner(() => 1),
      CONFIG,
      open([], [0, 1]),
      { onProgress: (f) => seen.push(f) },
    )
    expect([...got.logits]).toEqual([FLOOR, FLOOR])
    expect(got.scored).toBe(0)
    /* A bar that never reaches its end reads as a stall, not as a tip with no work in it. */
    expect(seen).toEqual([1])
  })

  /*
   * The list's length is the box's own business — `present` and `absent` partition the candidate
   * roots it was opened with. Taking a count from the caller let a third state exist: a
   * candidate in neither list, floor-filled and absent from `missing`, which is exactly the
   * silence this file exists to prevent.
   */
  it('takes the list’s length from the box, not from a caller', async () => {
    const got = await scoreCandidates(
      runner(() => 1),
      CONFIG,
      open([0, 3], [1, 2]),
    )
    expect(got.logits).toHaveLength(4)
    expect([...got.missing]).toEqual([1, 2])
  })

  it('feeds one patch per run, with the batch axis at 1', async () => {
    const session = runner(() => 1)
    await scoreCandidates(session, CONFIG, open([0, 1]))
    const calls = vi.mocked(session.run).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]![0].feeds?.[0]?.dims).toEqual([1, SIDE, SIDE, SIDE])
    expect(calls[0]![0].feeds?.[0]?.name).toBe('lab')
  })

  /*
   * The buffer handed to the worker is transferred, so each run must own its own. A view into
   * the group's array would detach every patch after the first — and the symptom is a zero-byte
   * tensor two candidates later, nowhere near the cause.
   */
  it('gives each run its own buffer', async () => {
    const session = runner(() => 1)
    await scoreCandidates(session, CONFIG, open([0, 1]))
    const calls = vi.mocked(session.run).mock.calls
    const first = calls[0]![0].feeds?.[0]?.data
    const second = calls[1]![0].feeds?.[0]?.data
    expect(first).not.toBe(second)
    expect(first?.byteLength).toBe(VOXELS * 4)
  })

  it('asks for patches in groups', async () => {
    const present = [0, 1, 2, 3, 4]
    const cut = vi.fn(cutter(present))
    await scoreCandidates(
      runner(() => 1),
      CONFIG,
      open(present, [], [], cut),
    )
    expect(cut).toHaveBeenCalledTimes(Math.ceil(present.length / PATCH_GROUP))
    expect(cut.mock.calls[0]![0]).toEqual({ from: 0, count: PATCH_GROUP })
  })

  /*
   * The cut runs in the Pyodide worker and the scoring on the GPU, so the next group is asked
   * for before this one is scored. Visible here as the second `cut` landing before the first
   * group's runs — without the prefetch it would land after all of them.
   */
  it('asks for the next group before scoring this one', async () => {
    const order: string[] = []
    const present = [0, 1, 2, 3, 4]
    const base = cutter(present)
    const cut: CutPatches = (ask) => {
      order.push(`cut ${ask.from}`)
      return base(ask)
    }
    const session = runner(() => 1)
    vi.mocked(session.run).mockImplementation(async () => {
      order.push('run')
      return [
        {
          name: 'logit',
          type: 'float32' as const,
          dims: [1],
          data: Float32Array.from([1]).buffer,
        },
      ]
    })
    await scoreCandidates(session, CONFIG, open(present, [], [], cut))
    expect(order.slice(0, 3)).toEqual(['cut 0', `cut ${PATCH_GROUP}`, 'run'])
  })

  it('reports progress through the tip', async () => {
    const seen: number[] = []
    await scoreCandidates(
      runner(() => 1),
      CONFIG,
      open([0, 1, 2, 3, 4]),
      { onProgress: (f) => seen.push(f) },
    )
    expect(seen.at(-1)).toBe(1)
    expect(seen.every((one) => one > 0 && one <= 1)).toBe(true)
  })

  /* A NaN would sort unpredictably and then poison the softmax over the whole list. */
  it('refuses a logit that is not a number', async () => {
    await expect(
      scoreCandidates(
        runner(() => Number.NaN),
        CONFIG,
        open([0]),
      ),
    ).rejects.toThrow(/answered NaN/)
  })

  /*
   * Three places state the patch's size — the checkpoint, this build's constants, and the
   * vendored cutter. Two of them meet here, and slicing a buffer by a number that did not
   * produce it is the one outcome that must not be possible.
   */
  it('refuses a box cut at a different size from the one the model reads', async () => {
    const wrong: OpenAssessorBox = { box: box([0], [], SIDE + 1), cut: cutter([0]) }
    await expect(
      scoreCandidates(
        runner(() => 1),
        CONFIG,
        wrong,
      ),
    ).rejects.toThrow(/reads 2³ patches and the box cut 3³/)
  })

  it('stops when the signal is aborted', async () => {
    const control = new AbortController()
    control.abort()
    await expect(
      scoreCandidates(
        runner(() => 1),
        CONFIG,
        open([0]),
        { signal: control.signal },
      ),
    ).rejects.toThrow()
  })

  /*
   * A prefetch in flight when the loop throws must not become an unhandled rejection — it would
   * surface as a crash naming the cut, long after the real failure.
   */
  it('does not leak a rejected prefetch when scoring fails', async () => {
    const present = [0, 1, 2, 3, 4, 5, 6, 7]
    const cut: CutPatches = (ask) =>
      (ask.from ?? 0) === 0
        ? cutter(present)(ask)
        : Promise.reject(new Error('the box closed under us'))
    const caught: unknown[] = []
    const onRejection = (error: unknown) => caught.push(error)
    process.on('unhandledRejection', onRejection)
    try {
      await expect(
        scoreCandidates(
          runner(() => Number.NaN),
          CONFIG,
          open(present, [], [], cut),
        ),
      ).rejects.toThrow(/answered NaN/)
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(caught).toEqual([])
  })

  it('refuses a manifest that declares no graph', async () => {
    const broken = {
      loaded: { url: 'x', manifest: { id: 'm', parts: [], signatures: {} } },
      run: vi.fn(),
    } as unknown as GraphRunner
    await expect(scoreCandidates(broken, CONFIG, open([0]))).rejects.toThrow(
      /declares no graph/,
    )
  })
})
