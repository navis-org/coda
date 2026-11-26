/**
 * `runCutoutSummary`'s marshalling, against a bridge that answers the way the real one does.
 *
 * `warp.test.ts`'s arrangement, and it exists for `warp.test.ts`' reason: a wrapper on this
 * bridge is pure between `callPython` and its caller, so the argument that "vitest has neither
 * Pyodide nor a `Worker`" excuses testing it is wrong — and this file's own first draft made
 * that argument, which is why it is written down here. What a `Worker` would add is the
 * crossing, and `pnpm probe:cutout-summary` is what drives that.
 *
 * `pnpm probe:cutout-summary` drives the other half: it hands the module a plain JS object the
 * way the worker does — which is what exercises `request.to_py()` — and reads the result back
 * as JavaScript, so the uint64 columns are checked crossing rather than inside Python.
 *
 * The thing worth pinning is the **id columns**. Everything else here is a measurement that
 * would look wrong if it were wrong; a root id silently narrowed to a double is a different
 * neuron with no symptom at all (invariant 8), so the dtype is asserted rather than the values.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { callPython } from './engine'
import type {
  CandidatePoolRequest,
  CutoutSummaryRequest,
  PoolSizesRequest,
} from './cutoutSummary'
import { runCandidatePool, runCutoutSummary, runPoolSizes } from './cutoutSummary'
import type { PyCall } from './types'

vi.mock('./engine', () => ({ callPython: vi.fn() }))

const mockedCall = vi.mocked(callPython)

const REQUEST = {
  labels: BigUint64Array.from([0n, 73889314911551537n, 73889314911551600n]),
  index: Uint32Array.from([0, 1, 2, 1, 0, 2, 2, 1]),
  // Plain arrays, as the type asks: `callPython` transfers views, and a three-element one
  // would be detached on the caller's side for nothing.
  size: [2, 2, 2],
  roots: BigUint64Array.from([0n, 864691128455770000n, 864691128455770001n]),
  queryRoot: 864691128455770000n,
  resolutionNm: [32, 32, 45],
  loVoxels: [0, 0, 0],
  pointNm: [64, 64, 90],
}

/** What the Python side returns: flat columns, ids 64-bit, measurements float64. */
function answered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rows: 2,
    missingQuery: false,
    root: BigUint64Array.from([864691128455770001n, 864691128455770002n]),
    rep_svid: BigUint64Array.from([73889314911551600n, 73889314911551700n]),
    min_dist_um: Float64Array.from([0.03, 0.4]),
    vol_um3: Float64Array.from([1.5, 0.2]),
    caliber_um: Float64Array.from([0.3, Number.NaN]),
    ms: 540,
    ...overrides,
  }
}

beforeEach(() => {
  mockedCall.mockReset()
})

describe('runCutoutSummary', () => {
  it('calls the capability its Python lives in, passing the request through', async () => {
    mockedCall.mockResolvedValue(answered())
    await runCutoutSummary(REQUEST)
    const call = mockedCall.mock.calls[0]![0] as PyCall
    expect(call.module).toBe('cutoutSummary')
    expect(call.fn).toBe('coda_cutout_summary')
    // Handed over as it stands: `callPython` transfers the typed arrays, and a copy here would
    // be 19 MB on the real box for a caller that is normally finished with it.
    expect(call.args[0]).toBe(REQUEST as unknown as CutoutSummaryRequest)
  })

  /**
   * The columns are told apart by dtype, so a float64 column is a measurement and a uint64 one
   * is an identity. Pinning this is what lets the name list go.
   */
  it('splits measurements from ids by dtype, not by name', async () => {
    mockedCall.mockResolvedValue(answered())
    const summary = await runCutoutSummary(REQUEST)
    expect(Object.keys(summary.columns).sort()).toEqual([
      'caliber_um',
      'min_dist_um',
      'vol_um3',
    ])
    expect(summary.columns['min_dist_um']).toEqual(Float64Array.from([0.03, 0.4]))
    // The scalars are not columns.
    expect(summary.columns['rows']).toBeUndefined()
    expect(summary.columns['ms']).toBeUndefined()
  })

  /**
   * Invariant 8, at the one place it can still be caught. `864691128455770001` and
   * `...770002` are both past 2^53, so as doubles they are the same number — a summary naming
   * the wrong neuron, with every measurement beside it perfectly ordinary.
   */
  it('keeps the id columns 64-bit', async () => {
    mockedCall.mockResolvedValue(answered())
    const summary = await runCutoutSummary(REQUEST)
    expect(summary.root).toBeInstanceOf(BigUint64Array)
    expect([...summary.root]).toEqual([864691128455770001n, 864691128455770002n])
    expect([...summary.repSupervoxel]).toEqual([73889314911551600n, 73889314911551700n])
    // The pair a double would have collapsed.
    expect(summary.root[0]).not.toBe(summary.root[1])
  })

  /** An id column that arrived as float64 is a narrowing somewhere, and says so by name. */
  it('refuses an id column that came back as a measurement', async () => {
    mockedCall.mockResolvedValue(answered({ root: Float64Array.from([8.6e17, 8.6e17]) }))
    await expect(runCutoutSummary(REQUEST)).rejects.toThrow(/an id does not survive one/)
  })

  /**
   * A query root with no voxel in its own box is a real state, not a failure — a tip whose
   * neuron does not reach its cutout is one worth looking at. Python answers it with empty id
   * columns so this has one exit.
   */
  it('reports a missing query without rows, and without throwing', async () => {
    mockedCall.mockResolvedValue({
      rows: 0,
      missingQuery: true,
      root: new BigUint64Array(0),
      rep_svid: new BigUint64Array(0),
      ms: 12,
    })
    const summary = await runCutoutSummary(REQUEST)
    expect(summary.missingQuery).toBe(true)
    expect(summary.rows).toBe(0)
    expect(summary.columns).toEqual({})
    expect(summary.root).toHaveLength(0)
  })

  it('carries Python’s own timing through, for a caller pricing a search', async () => {
    mockedCall.mockResolvedValue(answered({ ms: 537 }))
    expect((await runCutoutSummary(REQUEST)).ms).toBe(537)
  })
})

/**
 * The pool's wrapper. The measuring itself is SEAM's and is checked against SEAM's own answer
 * for a real end by `pnpm probe:candidate-search`; what is testable here is the marshalling.
 */
describe('runCandidatePool', () => {
  const POOL: CandidatePoolRequest = {
    ...(REQUEST as unknown as CutoutSummaryRequest),
    endNm: [64, 64, 90],
  }

  const measured = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rows: 2,
    missingQuery: false,
    candRoot: BigUint64Array.from([864691128455770001n, 864691128455770002n]),
    rep_svid: BigUint64Array.from([73889314911551655n, 73889314911551656n]),
    min_dist_um: Float64Array.from([0.032, 0.032]),
    end_dist_um: Float64Array.from([0.41, 1.07]),
    ms: 2338,
    ...overrides,
  })

  it('runs in the capability the vendored code lives in', async () => {
    mockedCall.mockResolvedValue(measured())
    await runCandidatePool(POOL)
    const call = mockedCall.mock.calls[0]![0] as PyCall
    expect(call.module).toBe('cutoutSummary')
    expect(call.fn).toBe('coda_candidate_pool')
  })

  it('names the columns SEAM names, and keeps the ids 64-bit', async () => {
    mockedCall.mockResolvedValue(measured())
    const found = await runCandidatePool(POOL)
    expect(found.rows).toBe(2)
    expect(found.candRoot).toBeInstanceOf(BigUint64Array)
    expect(Object.keys(found.columns).sort()).toEqual(['end_dist_um', 'min_dist_um'])
  })

  /**
   * SEAM's `rep_svid` — each candidate's supervoxel nearest the neuron — kept 64-bit and out of
   * the float columns: it is the supervoxel a review card follows a split candidate by.
   */
  it('keeps each candidate’s contact supervoxel, 64-bit and exact', async () => {
    mockedCall.mockResolvedValue(measured())
    const found = await runCandidatePool(POOL)
    expect([...found.repSupervoxel].map(String)).toEqual([
      '73889314911551655',
      '73889314911551656',
    ])
    expect(found.columns['rep_svid']).toBeUndefined()
  })

  /**
   * The open end is this request's one addition over the summary's, and `summary_args` decides
   * everything else — so a caller cannot ask for a cutout the features were not fitted against.
   */
  it('hands the open end over, which the summary does not require', async () => {
    mockedCall.mockResolvedValue(measured())
    await runCandidatePool(POOL)
    const sent = (mockedCall.mock.calls[0]![0] as PyCall).args[0] as CandidatePoolRequest
    expect(sent.endNm).toEqual([64, 64, 90])
  })

  /**
   * **The pool's roots come out early, and are read with the final answer's own guard.** An
   * 18-digit id is the one value a wrong conversion turns into another neuron in silence, and the
   * early roots are what the counts are asked about (`searchRun.ts`).
   */
  it('hands the pool’s roots to `onPool` before it returns, as the same 64-bit ids', async () => {
    const seen: string[] = []
    mockedCall.mockImplementation(async (_call, options) => {
      options?.onPartial?.({
        candRoot: BigUint64Array.from([864691128455770001n, 864691128455770002n]),
      })
      seen.push('returned')
      return measured()
    })
    await runCandidatePool(POOL, {
      onPool: (candRoot) => seen.push(...[...candRoot].map(String)),
    })
    expect(seen).toEqual(['864691128455770001', '864691128455770002', 'returned'])
  })

  it('passes over an early answer whose ids are not 64-bit, and leaves the refusal to the end', async () => {
    const onPool = vi.fn()
    mockedCall.mockImplementation(async (_call, options) => {
      options?.onPartial?.({ candRoot: Float64Array.from([8.6e17]) })
      return measured()
    })
    await runCandidatePool(POOL, { onPool })
    expect(onPool).not.toHaveBeenCalled()
  })

  it('asks for no partial answer when nobody wants one', async () => {
    mockedCall.mockResolvedValue(measured())
    await runCandidatePool(POOL)
    expect(mockedCall.mock.calls[0]![1]?.onPartial).toBeUndefined()
  })

  it('reports a query root missing from its own box without throwing', async () => {
    mockedCall.mockResolvedValue({
      rows: 0,
      missingQuery: true,
      candRoot: new BigUint64Array(0),
      rep_svid: new BigUint64Array(0),
      ms: 9,
    })
    const found = await runCandidatePool(POOL)
    expect(found.missingQuery).toBe(true)
    expect(found.rows).toBe(0)
  })
})

/**
 * The second crossing. The arithmetic is SEAM's; what is testable here is that the counts travel
 * **by position** — the id-keyed form made Python re-join an alignment this side already had —
 * and that a root the chunkedgraph answered short is refused **by name**, before the bridge.
 */
describe('runPoolSizes', () => {
  const SIZES: PoolSizesRequest = {
    candRoot: BigUint64Array.from([864691128455770001n, 864691128455770002n]),
    candCount: Float64Array.from([12, 4310]),
    queryRoot: 864691128455770003n,
    queryCount: 90210,
  }

  it('unpacks the two columns from the capability’s own function', async () => {
    mockedCall.mockResolvedValue({
      l2c: Float64Array.from([1.0792, 3.6345]),
      l2x: Float64Array.from([1.0718, 3.6096]),
    })
    const found = await runPoolSizes(SIZES)
    expect((mockedCall.mock.calls[0]![0] as PyCall).fn).toBe('coda_pool_sizes')
    expect(found.l2c).toHaveLength(2)
    expect(found.l2x[1]).toBeCloseTo(3.6096, 4)
  })

  it('refuses counts that do not line up with the candidates', async () => {
    await expect(
      runPoolSizes({ ...SIZES, candCount: Float64Array.from([12]) }),
    ).rejects.toThrow(/2 candidates and 1 counts/)
  })
})
