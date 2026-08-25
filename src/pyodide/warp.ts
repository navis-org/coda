/**
 * Landmark transforms' typed wrapper over the Python bridge, and the cache that keeps the fit
 * from being paid twice.
 *
 * The third capability, written to the shape `nblast.ts` set — a `.py` in `runtime.ts`'s
 * `MODULES`, the request and result types, and functions that call `callPython` and read the
 * answer by name. What is new here is the *caching*, and it is here rather than in `warp.py`
 * because only this side can see IndexedDB.
 *
 * ## Three layers, because the fit is four seconds and the apply is a third of one
 *
 * | | costs | lives |
 * | --- | --- | --- |
 * | `_FITTED` in `warp.py` | 0 | the session |
 * | coefficients in IndexedDB | 0.1–0.5 ms to rebuild from | the browser |
 * | the fit | 136–4,704 ms | once |
 *
 * All three numbers were measured in this runtime against the shipped landmark sets. The
 * effect is that the four seconds lands exactly once per browser per landmark set — on a run
 * that is already downloading ten megabytes of CPython — and never again.
 *
 * **Landmarks stay the shipped artifact and coefficients are a derived copy**, which is the
 * important half of that arrangement. A coefficient file would be smaller and would skip the
 * fit for everybody, but it is opaque, unregenerable, and tied to fastcore's internal
 * formulation of a spline. So the store's fingerprint carries the fastcore version: a wheel
 * bump invalidates every entry rather than quietly applying last year's weights.
 */

import { cacheDelete, cacheGet, cacheSet } from '../data/cache'
import type { LandmarkPairs } from '../data/transforms/landmarks'
import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float32From, numberFrom } from './types'
import sources from './sources.json'

/**
 * A fitted spline's non-affine weights and affine part, as float32.
 *
 * float32 rather than float64 because it halves what goes in the store and costs 0.026 nm
 * median / 0.061 nm maximum against the float64 fit, measured on FlyWire's 3,390 landmarks
 * over 4,000 test points. An EM voxel is 4 nm.
 */
export interface WarpCoefficients {
  /** `M * 3`, row-major. */
  weights: Float32Array
  /** `4 * 3`, row-major. Row 0 is the translation. */
  affine: Float32Array
}

/*
 * `type` rather than `interface` on anything crossing the bridge: TypeScript gives a type alias
 * an implicit index signature and an interface none, so an interface is not assignable to
 * `PyArg` and the call fails to compile with a message about `undefined`.
 */
type WarpRequest = {
  key: string
  /** `M * 3` float64, xyz interleaved, in nanometres. */
  source: Float64Array
  /** The other side of the landmark pairs. Absent when `coefficients` makes the fit unnecessary. */
  target?: Float64Array
  coefficients?: { weights: Float32Array; affine: Float32Array }
}

type ApplyRequest = WarpRequest & {
  /** `N * 3` float32, xyz interleaved. **Transferred, not copied** — see `warpPoints`. */
  points: Float32Array
}

/** What `cacheGet` compares before handing an entry back. */
function fingerprint(pairs: LandmarkPairs): string {
  // The fastcore version is in here because these are *its* coefficients: a wheel that changed
  // its kernel or its ordering would otherwise have last year's weights applied to this year's
  // spline, silently and with a perfectly plausible result.
  return `fastcore=${sources.fastcoreVersion} landmarks=${pairs.count}`
}

function cacheKey(pairs: LandmarkPairs): string {
  return `warp:${pairs.id}`
}

/**
 * Coefficients for this landmark set, from the store or by fitting.
 *
 * Never fatal on the cache: `cacheGet` resolves rather than rejecting and a miss and a broken
 * store look the same, which is what makes it safe to sit in front of a computation that can
 * always be redone. A *failed write* is likewise dropped — failing to remember something is
 * not failing to compute it.
 */
async function coefficientsFor(
  pairs: LandmarkPairs,
  options: CallOptions,
): Promise<WarpCoefficients> {
  const stored = await cacheGet<WarpCoefficients>(cacheKey(pairs), {
    fingerprint: fingerprint(pairs),
  })
  /*
   * The shape is re-checked rather than trusted. IndexedDB hands back whatever was put in it,
   * including from a build that stored a different shape under the same key — and the failure
   * downstream would be `from_coefs` raising inside Python about an array of the wrong size,
   * three layers from the cache entry that caused it.
   */
  if (
    stored?.weights instanceof Float32Array &&
    stored.affine instanceof Float32Array &&
    stored.weights.length === pairs.count * 3 &&
    stored.affine.length === 12
  ) {
    return stored
  }

  const result = await callPython(
    {
      module: 'warp',
      fn: 'coda_warp_fit',
      args: [{ key: pairs.id, source: copyOf(pairs.source), target: copyOf(pairs.target) }],
    },
    options,
  )
  const fitted: WarpCoefficients = {
    weights: float32From(result, 'weights'),
    affine: float32From(result, 'affine'),
  }
  // Awaited rather than fired and forgotten, so a run that finishes has actually written —
  // the alternative is a first mirror that pays four seconds and a second one that pays it
  // again because the write was still in flight when the tab moved on.
  await cacheSet(cacheKey(pairs), fitted, fingerprint(pairs))
  return fitted
}

/**
 * `callPython` **transfers** every typed array in a call's arguments, so anything that must
 * survive the call has to be copied first.
 *
 * The landmark buffers are memoised for the session by `landmarks.ts` and the point buffer
 * belongs to the upstream node's cached result — detaching either is a value that silently
 * becomes empty, with a viewer redrawing blank and nothing connecting that to the node that
 * ran. This is `linkage.ts`'s trap, and it bites harder here because *both* arguments are
 * borrowed rather than built for the call.
 */
function copyOf<T extends Float32Array | Float64Array>(buffer: T): T {
  return buffer.slice() as T
}

export interface WarpResult {
  /** `N * 3` float32, xyz interleaved. */
  positions: Float32Array
  /** How long the fit took, or 0 where it was already in hand. For the probe and the status bar. */
  fitMs: number
  applyMs: number
}

/**
 * Push points through a landmark set, fitting the spline once per browser.
 *
 * **`points` is consumed**: it is transferred to the worker and detached here, so a caller must
 * hand over a buffer nothing else holds. Every caller does — `warpGeometry` is the only one, and
 * it gathers into a fresh array. The landmark and coefficient buffers *are* copied, because both
 * are memoised for the session and detaching them would empty the cache they came from.
 */
export async function warpPoints(
  pairs: LandmarkPairs,
  points: Float32Array,
  options: CallOptions = {},
): Promise<WarpResult> {
  const coefficients = await coefficientsFor(pairs, options)

  // Read before the call, not after: `points` is *transferred*, so the moment `callPython`
  // posts the message this buffer is detached and its `length` reads 0. The guard below used
  // to ask the detached array how long it had been, and every warp of a non-empty geometry
  // failed with "returned N points for 0".
  const expected = points.length

  const request: ApplyRequest = {
    key: pairs.id,
    source: copyOf(pairs.source),
    coefficients: { weights: copyOf(coefficients.weights), affine: copyOf(coefficients.affine) },
    // Not copied. Every caller builds this for the call — `gatherPositions` concatenates into
    // a fresh buffer, and a multi-leg warp passes the previous leg's *result* — so the
    // transfer costs nothing and the copy was a second full-size allocation per hop: about
    // 8.7 MB for a 500-skeleton set and 36 MB for a mesh set near the ceiling.
    points,
  }
  const result = await callPython(
    { module: 'warp', fn: 'coda_warp_apply', args: [request] },
    options,
  )

  const positions = float32From(result, 'positions')
  const count = numberFrom(result, 'count')
  if (positions.length !== count * 3) {
    throw new Error(`Warp returned ${positions.length} numbers for ${count} points`)
  }
  if (count * 3 !== expected) {
    // A silent length change would scatter every coordinate after the discrepancy onto the
    // wrong point, which is a neuron that still draws.
    throw new Error(`Warp returned ${count} points for ${expected / 3}`)
  }
  return { positions, fitMs: numberFrom(result, 'fitMs'), applyMs: numberFrom(result, 'applyMs') }
}

/** Forget the stored coefficients for a landmark set. Tests; a wheel bump does it by fingerprint. */
export async function forgetWarpCoefficients(pairs: LandmarkPairs): Promise<void> {
  await cacheDelete(cacheKey(pairs))
}
