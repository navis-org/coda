/**
 * The assessor patch wrapper's marshalling, against a bridge that answers as the real one does.
 *
 * `cutoutSummary.test.ts`' arrangement, and it exists for that file's reason: a wrapper on this
 * bridge is pure between `callPython` and its caller, so "vitest has neither Pyodide nor a
 * `Worker`" is not an excuse for leaving it untested. What a `Worker` would add is the crossing,
 * and `pnpm probe:assessor-patch` is what drives that — against SEAM's own published patches,
 * byte for byte.
 *
 * What is worth pinning here is **`useAssessorBox`' closing**. A held box is 11 MB in a wasm
 * heap that is never given back, and a caller that throws without closing leaks it silently —
 * nothing reports memory a failed run forgot to release. So the tests are mostly about what
 * happens when the body fails.
 */

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_CANDIDATES_PER_BOX,
  closeAssessorBox,
  cutAssessorPatches,
  openAssessorBox,
  useAssessorBox,
} from './assessorPatches'
import type { AssessorBoxRequest } from './assessorPatches'
import { callPython } from './engine'
import type { PyCall } from './types'

vi.mock('./engine', () => ({ callPython: vi.fn() }))

const mockedCall = vi.mocked(callPython)

const REQUEST: AssessorBoxRequest = {
  labels: BigUint64Array.from([0n, 73889314911551537n, 73889314911551600n]),
  index: Uint32Array.from([0, 1, 2, 1, 0, 2, 2, 1]),
  size: [2, 2, 2],
  roots: BigUint64Array.from([0n, 864691128455770000n, 864691128455770001n]),
  queryRoot: 864691128455770000n,
  candRoots: BigUint64Array.from([864691128455770001n]),
  centresNm: Float64Array.from([64, 64, 90]),
  resolutionNm: [32, 32, 45],
  loVoxels: [0, 0, 0],
}

function opened(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    box: 7,
    present: Int32Array.from([0]),
    absent: Int32Array.from([]),
    patchSize: 129,
    patchNm: 32,
    boxVoxels: 8,
    ms: 58,
    ...overrides,
  }
}

function cut(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patches: Uint8Array.from([0, 1, 2, 0]),
    given: Int32Array.from([0]),
    outside: Int32Array.from([]),
    ms: 10,
    ...overrides,
  }
}

/*
 * The one number both sides declare, held to the Python rather than hand-kept — `patchBox.ts`
 * makes the same bargain with the vendored file, for the same reason. A caller grouping by a
 * stale limit would send a box the bridge refuses, which is at least loud; one grouping by a
 * limit that has *grown* would be refused for no reason a reader could see.
 */
it('agrees with the bridge about how many candidates a box holds', () => {
  const py = readFileSync(new URL('./assessorPatches.py', import.meta.url), 'utf8')
  const found = /^MAX_CANDIDATES = (\d+)/m.exec(py)
  expect(found, 'MAX_CANDIDATES is no longer a module-level constant').toBeTruthy()
  expect(MAX_CANDIDATES_PER_BOX).toBe(Number(found![1]))
})

describe('openAssessorBox', () => {
  beforeEach(() => {
    mockedCall.mockReset()
  })

  it('names the module and the function the bridge exports', async () => {
    mockedCall.mockResolvedValue(opened())
    await openAssessorBox(REQUEST)
    const call = mockedCall.mock.calls[0]![0] as PyCall
    expect(call.module).toBe('assessorPatches')
    expect(call.fn).toBe('coda_assessor_open')
  })

  /*
   * The request crosses as given. Spelled out because `queryRoot` and `candRoots` are ids: a
   * root narrowed to a double on the way over is a different neuron, and every patch after it
   * would be a perfectly ordinary patch of somewhere else (invariant 8).
   */
  it('hands the ids over as bigints and uint64, never as numbers', async () => {
    mockedCall.mockResolvedValue(opened())
    await openAssessorBox(REQUEST)
    const sent = (mockedCall.mock.calls[0]![0] as PyCall).args[0] as AssessorBoxRequest
    expect(typeof sent.queryRoot).toBe('bigint')
    expect(sent.candRoots).toBeInstanceOf(BigUint64Array)
    expect(sent.labels).toBeInstanceOf(BigUint64Array)
    expect(sent.roots).toBeInstanceOf(BigUint64Array)
  })

  it('reads the patch geometry back from the vendored file rather than assuming it', async () => {
    mockedCall.mockResolvedValue(opened({ patchSize: 65, patchNm: 16 }))
    const box = await openAssessorBox(REQUEST)
    expect(box.patchSize).toBe(65)
    expect(box.patchNm).toBe(16)
  })

  /*
   * An absent candidate is a state, not a failure — it becomes SEAM's `missing_patch_score`
   * downstream. A wrapper that dropped it would silently rank that candidate last instead of
   * at its floor.
   */
  it('carries the candidates with no voxel in the box', async () => {
    mockedCall.mockResolvedValue(
      opened({ present: Int32Array.from([1]), absent: Int32Array.from([0, 2]) }),
    )
    const box = await openAssessorBox(REQUEST)
    expect([...box.absent]).toEqual([0, 2])
    expect([...box.present]).toEqual([1])
  })
})

describe('cutAssessorPatches', () => {
  beforeEach(() => {
    mockedCall.mockReset()
  })

  /**
   * The group is named, never defaulted: "the rest of them" is up to a hundred 2.1 MB patches,
   * which is the message size these three calls exist to avoid.
   */
  it('passes the box and the group through as given', async () => {
    mockedCall.mockResolvedValue(cut())
    await cutAssessorPatches({ box: 7, count: 4 })
    const call = mockedCall.mock.calls[0]![0] as PyCall
    expect(call.fn).toBe('coda_assessor_patches')
    expect(call.args[0]).toEqual({ box: 7, count: 4 })
  })

  it('passes a group through', async () => {
    mockedCall.mockResolvedValue(cut())
    await cutAssessorPatches({ box: 7, from: 4, count: 2 })
    expect((mockedCall.mock.calls[0]![0] as PyCall).args[0]).toEqual({
      box: 7,
      from: 4,
      count: 2,
    })
  })

  it('keeps the patches as bytes', async () => {
    mockedCall.mockResolvedValue(cut())
    const got = await cutAssessorPatches({ box: 7, count: 4 })
    expect(got.patches).toBeInstanceOf(Uint8Array)
    expect([...got.given]).toEqual([0])
  })

  it('carries the candidates whose patch left the box', async () => {
    mockedCall.mockResolvedValue(
      cut({ given: Int32Array.from([]), outside: Int32Array.from([0]) }),
    )
    const got = await cutAssessorPatches({ box: 7, count: 4 })
    expect([...got.outside]).toEqual([0])
    expect(got.patches.length).toBe(4)
  })
})

describe('useAssessorBox', () => {
  beforeEach(() => {
    mockedCall.mockReset()
  })

  const fnsCalled = () => mockedCall.mock.calls.map((one) => (one[0] as PyCall).fn)

  it('opens, runs and closes', async () => {
    mockedCall.mockResolvedValueOnce(opened()).mockResolvedValueOnce({ dropped: true })
    const got = await useAssessorBox(REQUEST, async ({ box }) => box.present.length)
    expect(got).toBe(1)
    expect(fnsCalled()).toEqual(['coda_assessor_open', 'coda_assessor_close'])
  })

  /* The one that matters: 11 MB stays held if this is wrong, and nothing says so. */
  it('closes when the body throws, and reports the body’s failure', async () => {
    mockedCall.mockResolvedValueOnce(opened()).mockResolvedValueOnce({ dropped: true })
    await expect(
      useAssessorBox(REQUEST, () => Promise.reject(new Error('the model refused'))),
    ).rejects.toThrow('the model refused')
    expect(fnsCalled()).toEqual(['coda_assessor_open', 'coda_assessor_close'])
  })

  /*
   * A close that fails must not replace the caller's error. After a failed body it would report
   * the wrong thing; after a successful one it costs memory, not an answer.
   */
  it('does not let a failing close hide the body’s error', async () => {
    mockedCall.mockResolvedValueOnce(opened()).mockRejectedValueOnce(new Error('worker gone'))
    await expect(
      useAssessorBox(REQUEST, () => Promise.reject(new Error('the model refused'))),
    ).rejects.toThrow('the model refused')
  })

  it('does not let a failing close fail a successful run', async () => {
    mockedCall.mockResolvedValueOnce(opened()).mockRejectedValueOnce(new Error('worker gone'))
    await expect(useAssessorBox(REQUEST, async () => 'done')).resolves.toBe('done')
  })

  /*
   * **The commonest way to reach the `finally` is a Cancel**, and `callPython` throws `Aborted`
   * at its first line when handed an aborted signal — so a close that forwarded the caller's
   * options would be refused, the swallow would hide it, and the labelled box would stay held
   * in the worker. That is the leak this wrapper exists to prevent, arriving by the path most
   * likely to reach it, and nothing covered it.
   */
  it('closes without the caller’s signal, so a Cancel cannot refuse the close', async () => {
    const control = new AbortController()
    mockedCall.mockResolvedValueOnce(opened()).mockResolvedValueOnce({ dropped: true })
    await expect(
      useAssessorBox(
        REQUEST,
        async () => {
          control.abort()
          throw new Error('cancelled')
        },
        { signal: control.signal },
      ),
    ).rejects.toThrow('cancelled')
    const close = mockedCall.mock.calls.at(-1)!
    expect((close[0] as PyCall).fn).toBe('coda_assessor_close')
    expect(close[1]?.signal).toBeUndefined()
  })

  it('does not close a box it never opened', async () => {
    mockedCall.mockRejectedValueOnce(new Error('the query root is 0'))
    await expect(useAssessorBox(REQUEST, async () => 'done')).rejects.toThrow(
      'the query root is 0',
    )
    expect(fnsCalled()).toEqual(['coda_assessor_open'])
  })
})

describe('closeAssessorBox', () => {
  /**
   * **It names the box**, and that is not decoration. The bridge holds one, so a close that said
   * nothing would drop whatever is open — and the commonest way to get a late close is a Cancel,
   * by which time the box open may be the next tip's.
   */
  it('asks the bridge to drop the box it names', async () => {
    mockedCall.mockReset()
    mockedCall.mockResolvedValue({ dropped: true })
    await closeAssessorBox(7)
    const call = mockedCall.mock.calls[0]![0] as PyCall
    expect(call.fn).toBe('coda_assessor_close')
    expect(call.args[0]).toEqual({ box: 7 })
  })
})

/*
 * The handle, which is the other half of what `useAssessorBox` exists for. The bridge holds one
 * box and `cutAssessorPatches` addresses it implicitly, so handing the body a cutter bound to
 * this open box is what stops a caller pairing a box with a cutter for a different one.
 */
describe('the handle useAssessorBox hands over', () => {
  beforeEach(() => {
    mockedCall.mockReset()
  })

  it('cuts from the box it opened', async () => {
    mockedCall
      .mockResolvedValueOnce(opened())
      .mockResolvedValueOnce(cut())
      .mockResolvedValueOnce({ dropped: true })
    const given = await useAssessorBox(REQUEST, async ({ cut: take }) => {
      const group = await take({ from: 0, count: 1 })
      return [...group.given]
    })
    expect(given).toEqual([0])
    expect(mockedCall.mock.calls.map((one) => (one[0] as PyCall).fn)).toEqual([
      'coda_assessor_open',
      'coda_assessor_patches',
      'coda_assessor_close',
    ])
  })

  it('still closes when cutting throws', async () => {
    mockedCall
      .mockResolvedValueOnce(opened())
      .mockRejectedValueOnce(new Error('no box is open'))
      .mockResolvedValueOnce({ dropped: true })
    await expect(
      useAssessorBox(REQUEST, async ({ cut: take }) => take({ count: 1 })),
    ).rejects.toThrow('no box is open')
    expect(mockedCall.mock.calls.map((one) => (one[0] as PyCall).fn).at(-1)).toBe(
      'coda_assessor_close',
    )
  })
})
