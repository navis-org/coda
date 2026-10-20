/**
 * Bounded nonlinear least squares by Levenberg–Marquardt: the textbook method for fitting a few
 * parameters of a smooth model to data, and what a passive membrane fit is (`packs/biophys/fit.ts`).
 *
 * Minimises `Σ r(θ)²` over a box. The Jacobian is by **finite differences**, one extra evaluation
 * per parameter, and every batch of evaluations an iteration needs is handed to `residuals` in **one
 * call** — so a caller with workers runs them side by side and an iteration costs about one
 * evaluation of wall time. Bounds are kept by projection: a trial point is clamped into the box,
 * and a difference step that would leave it goes the other way.
 *
 * The damping is Marquardt's (`λ · diag(JᵀJ)`, so each parameter is damped in its own scale): a
 * step that lowers the cost is taken and `λ` shrinks towards Gauss–Newton; one that does not is
 * retried with `λ` grown, towards gradient descent. **Deterministic**: no randomness anywhere, so a
 * fit is a function of its inputs (invariant 4).
 *
 * At the end, the **covariance** `s² (JᵀJ)⁻¹` with `s² = cost / (N − P)`: the standard error of each
 * parameter and how the parameters trade against each other — what says a parameter the data did
 * not determine was not determined. Undefined where `JᵀJ` is singular.
 *
 * Headless and knows nothing about neurons: `src/biophys` is the compute backend.
 */

import { throwIfAborted } from '../core/slice'

/** Residual vectors at each point asked for, in order; one call per batch, so it can be parallel. */
export type Residuals = (points: readonly Float64Array[]) => Promise<Float64Array[]>

export interface IterationRecord {
  /** 0 is the start. */
  readonly iteration: number
  /** `Σ r²` at `theta`. */
  readonly cost: number
  readonly theta: Float64Array
}

export interface LeastSquaresOptions {
  readonly lower?: ArrayLike<number>
  readonly upper?: ArrayLike<number>
  /** The finite-difference step per parameter, in its own units. */
  readonly steps: ArrayLike<number>
  /** Iterations at most; 50 by default. */
  readonly maxIterations?: number
  /** Stop when the undamped step promises to lower the cost by less than this share of it; 1e-9 by default. */
  readonly tolerance?: number
  readonly signal?: AbortSignal
  /** Called with every accepted point, the start included. */
  readonly onIteration?: (record: IterationRecord) => void
}

export interface LeastSquaresResult {
  readonly theta: Float64Array
  readonly cost: number
  /**
   * P × P, row by row, over the parameters off their bounds — NaN in the rows and columns of one on
   * a bound, whose error the data did not set. Undefined where `JᵀJ` cannot be inverted.
   */
  readonly covariance: Float64Array[] | undefined
  /** Which parameters ended on a bound: the data would have taken them further. */
  readonly atBound: readonly boolean[]
  /** Why it stopped: the cost settled, the step limit, or no step lowered it any more. */
  readonly reason: 'converged' | 'max-iterations' | 'stalled'
}

const LAMBDA_START = 1e-3
const LAMBDA_MAX = 1e12

export async function leastSquares(
  start: ArrayLike<number>,
  residuals: Residuals,
  options: LeastSquaresOptions,
): Promise<LeastSquaresResult> {
  const p = start.length
  const lower = Float64Array.from({ length: p }, (_, j) => options.lower?.[j] ?? -Infinity)
  const upper = Float64Array.from({ length: p }, (_, j) => options.upper?.[j] ?? Infinity)
  const clamp = (theta: Float64Array) =>
    theta.map((v, j) => Math.min(upper[j]!, Math.max(lower[j]!, v)))
  const maxIterations = options.maxIterations ?? 50
  const tolerance = options.tolerance ?? 1e-9

  let theta = clamp(Float64Array.from(start))
  // The start and its Jacobian's points in one batch: the points do not depend on the residuals.
  const first = jacobianPoints(theta, options.steps, lower, upper)
  const [start0, ...shifted] = await residuals([theta, ...first])
  let r = start0
  let cost = sumSquares(r!)
  options.onIteration?.({ iteration: 0, cost, theta })
  let lambda = LAMBDA_START
  let reason: LeastSquaresResult['reason'] = 'max-iterations'
  let jacobian = columnsOf(theta, first, shifted, r!)

  // One pass past the limit, which only asks whether the last step settled: its Jacobian is already
  // in hand, and a fit converging on its final step is not one that ran out of iterations.
  search: for (let iteration = 0; iteration <= maxIterations; iteration++) {
    throwIfAborted(options.signal)
    const { normal, gradient } = normalEquations(jacobian, r!)
    /*
     * The active set: a parameter on a bound that the descent would push further out is held there
     * for this step and the rest solved without it. Without this, projection alone clamps every
     * step back onto the bound and the fit creeps along it until the iteration limit.
     */
    const moving = Array.from(theta.keys()).filter(
      (j) =>
        !(theta[j]! <= lower[j]! && gradient[j]! > 0) &&
        !(theta[j]! >= upper[j]! && gradient[j]! < 0),
    )
    if (moving.length === 0) {
      reason = 'converged'
      break
    }
    /*
     * At a minimum when even the undamped (Gauss–Newton) step promises less than the tolerance —
     * asked of that step and not of the damped one about to be tried, whose λ is carried over from
     * earlier rejections and can promise a fraction of what is left. Without this a fit at its
     * minimum, rounding keeping every trial at or above the cost, climbs λ one serial evaluation at
     * a time, two dozen of them, and ends 'stalled' on an exact answer.
     */
    const gaussNewton = solve(
      moving.map((a) => Float64Array.from(moving, (b) => normal[a]![b]!)),
      Float64Array.from(moving, (j) => -gradient[j]!),
    )
    if (gaussNewton) {
      const full = new Float64Array(p)
      moving.forEach((j, k) => (full[j] = gaussNewton[k]!))
      if (predictedDrop(normal, gradient, full) <= tolerance * cost) {
        reason = 'converged'
        break
      }
    }
    if (iteration === maxIterations) break
    let accepted = false
    while (lambda <= LAMBDA_MAX) {
      const damped = moving.map((a) =>
        Float64Array.from(moving, (b) =>
          a === b ? normal[a]![a]! + lambda * Math.max(normal[a]![a]!, 1e-12) : normal[a]![b]!,
        ),
      )
      const reduced = solve(
        damped,
        Float64Array.from(moving, (j) => -gradient[j]!),
      )
      if (!reduced) {
        lambda *= 10
        continue
      }
      const step = new Float64Array(p)
      moving.forEach((j, k) => (step[j] = reduced[k]!))
      const trial = clamp(theta.map((v, j) => v + step[j]!))
      // A step too small to move anything is as far as this goes; the Jacobian held is still θ's.
      if (trial.every((v, j) => Math.abs(v - theta[j]!) <= 1e-12 * Math.max(1, Math.abs(v)))) {
        reason = 'converged'
        break search
      }
      const [rTrial] = await residuals([trial])
      const trialCost = sumSquares(rTrial!)
      if (trialCost < cost) {
        theta = trial
        r = rTrial
        cost = trialCost
        lambda = Math.max(lambda / 3, 1e-12)
        accepted = true
        options.onIteration?.({ iteration: iteration + 1, cost, theta })
        break
      }
      lambda *= 4
    }
    if (!accepted) {
      reason = 'stalled'
      break
    }
    const points = jacobianPoints(theta, options.steps, lower, upper)
    jacobian = columnsOf(theta, points, await residuals(points), r!)
  }

  const atBound = Array.from(theta, (v, j) => v <= lower[j]! || v >= upper[j]!)
  return {
    theta,
    cost,
    covariance: covarianceOf(jacobian, atBound, cost, r!.length),
    atBound,
    reason,
  }
}

/** Where the forward differences are taken, one per parameter; a step out of the box goes back. */
function jacobianPoints(
  theta: Float64Array,
  steps: ArrayLike<number>,
  lower: Float64Array,
  upper: Float64Array,
): Float64Array[] {
  return Array.from(theta, (v, j) => {
    const point = Float64Array.from(theta)
    point[j] = Math.max(lower[j]!, v + (v + steps[j]! > upper[j]! ? -steps[j]! : steps[j]!))
    return point
  })
}

/** Column `j` of the Jacobian, stored as a row: ∂r/∂θⱼ for every residual. */
function columnsOf(
  theta: Float64Array,
  points: readonly Float64Array[],
  shifted: readonly Float64Array[],
  r: Float64Array,
): Float64Array[] {
  return shifted.map((rj, j) => {
    const h = points[j]![j]! - theta[j]!
    return Float64Array.from(rj, (v, i) => (h === 0 ? 0 : (v - r[i]!) / h))
  })
}

/** What the linearised cost says a step gains: `−(2 gᵀs + sᵀ (JᵀJ) s)`, for cost `Σ r²`. */
function predictedDrop(
  normal: readonly Float64Array[],
  gradient: Float64Array,
  step: Float64Array,
) {
  let quadratic = 0
  for (let a = 0; a < step.length; a++) quadratic += step[a]! * dot(normal[a]!, step)
  return -(2 * dot(gradient, step) + quadratic)
}

/** `JᵀJ` and `Jᵀr`, the columns of `J` held as rows. */
function normalEquations(columns: Float64Array[], r: Float64Array) {
  const p = columns.length
  const normal = Array.from({ length: p }, () => new Float64Array(p))
  const gradient = new Float64Array(p)
  for (let a = 0; a < p; a++) {
    gradient[a] = dot(columns[a]!, r)
    for (let b = a; b < p; b++) {
      const v = dot(columns[a]!, columns[b]!)
      normal[a]![b] = v
      normal[b]![a] = v
    }
  }
  return { normal, gradient }
}

/**
 * `s² (JᵀJ)⁻¹` over the parameters off their bounds, NaN for the rest; undefined where a parameter
 * moved nothing.
 */
function covarianceOf(
  columns: Float64Array[],
  atBound: readonly boolean[],
  cost: number,
  n: number,
): Float64Array[] | undefined {
  const p = columns.length
  const inside = Array.from(columns.keys()).filter((j) => !atBound[j])
  if (n <= inside.length) return undefined
  const out = Array.from({ length: p }, () => new Float64Array(p).fill(Number.NaN))
  if (inside.length === 0) return out
  const { normal } = normalEquations(
    inside.map((j) => columns[j]!),
    new Float64Array(n),
  )
  const inverse = invert(normal)
  if (!inverse) return undefined
  const s2 = cost / (n - inside.length)
  inside.forEach((a, i) => inside.forEach((b, k) => (out[a]![b] = inverse[i]![k]! * s2)))
  return out
}

function sumSquares(r: Float64Array): number {
  let s = 0
  for (let i = 0; i < r.length; i++) s += r[i]! * r[i]!
  return s
}

export function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** `A x = b` by Gaussian elimination with partial pivoting; undefined when `A` is singular. */
function solve(a: readonly Float64Array[], b: Float64Array): Float64Array | undefined {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row
    }
    if (Math.abs(m[pivot]![col]!) < 1e-300) return undefined
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const f = m[row]![col]! / m[col]![col]!
      for (let k = col; k <= n; k++) m[row]![k]! -= f * m[col]![k]!
    }
  }
  return Float64Array.from(m, (row, i) => row[n]! / row[i]!)
}

/** `A⁻¹`, column by column through `solve`; undefined when `A` is singular. */
function invert(a: readonly Float64Array[]): Float64Array[] | undefined {
  const n = a.length
  const columns: Float64Array[] = []
  for (let j = 0; j < n; j++) {
    const e = new Float64Array(n)
    e[j] = 1
    const x = solve(a, e)
    if (!x || x.some((v) => !Number.isFinite(v))) return undefined
    columns.push(x)
  }
  return Array.from({ length: n }, (_, i) => Float64Array.from(columns, (c) => c[i]!))
}
