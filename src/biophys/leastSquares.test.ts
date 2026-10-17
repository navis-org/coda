/**
 * The least-squares solver on problems with known answers: an exponential's three parameters out
 * of noise, a bound held, the covariance agreeing with the scatter of repeated fits, and a parameter
 * with no effect reported as undetermined rather than given a number.
 */

import { describe, expect, it } from 'vitest'

import { seededRandom } from '../nodes/lib/tableOps'
import type { Residuals } from './leastSquares'
import { leastSquares } from './leastSquares'

const T = Float64Array.from({ length: 200 }, (_, i) => i * 0.5)
const curve = (a: number, tau: number, c: number) => T.map((t) => a * Math.exp(-t / tau) + c)

/** Data from the curve plus Gaussian noise of `sigma`, seeded. */
function noisy(seed: number, sigma: number): Float64Array {
  const random = seededRandom(seed)
  const clean = curve(5, 12, -2)
  return clean.map((v) => {
    // Box–Muller.
    const u = Math.max(random(), 1e-12)
    return v + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
  })
}

const residualsFor =
  (data: Float64Array): Residuals =>
  async (points) =>
    points.map(([a, tau, c]) => curve(a!, tau!, c!).map((v, i) => v - data[i]!))

describe('leastSquares', () => {
  it('recovers an exponential from noise, with standard errors that cover the truth', async () => {
    const costs: number[] = []
    const fit = await leastSquares([1, 3, 0], residualsFor(noisy(1, 0.1)), {
      steps: [1e-4, 1e-4, 1e-4],
      onIteration: (record) => costs.push(record.cost),
    })
    expect(fit.reason).toBe('converged')
    const se = fit.covariance!.map((row, j) => Math.sqrt(row[j]!))
    ;[5, 12, -2].forEach((truth, j) => {
      expect(Math.abs(fit.theta[j]! - truth)).toBeLessThan(4 * se[j]!)
    })
    // The residuals are the noise: an RMS near its sigma.
    expect(Math.sqrt(fit.cost / T.length)).toBeCloseTo(0.1, 1)
    expect(costs[0]).toBeGreaterThan(fit.cost)
  })

  it('agrees with the scatter of fits to fresh noise', async () => {
    const taus: number[] = []
    let reported = 0
    for (let seed = 2; seed < 32; seed++) {
      const fit = await leastSquares([4, 10, -1], residualsFor(noisy(seed, 0.2)), {
        steps: [1e-4, 1e-4, 1e-4],
      })
      taus.push(fit.theta[1]!)
      reported += Math.sqrt(fit.covariance![1]![1]!) / 30
    }
    const mean = taus.reduce((s, v) => s + v, 0) / taus.length
    const scatter = Math.sqrt(taus.reduce((s, v) => s + (v - mean) ** 2, 0) / (taus.length - 1))
    // Thirty fits estimate a spread to about ±25%; the reported error must be that spread.
    expect(reported / scatter).toBeGreaterThan(0.7)
    expect(reported / scatter).toBeLessThan(1.4)
  })

  it('keeps a parameter inside its bounds, the best point on the boundary', async () => {
    const fit = await leastSquares([1, 3, 0], residualsFor(noisy(1, 0.1)), {
      steps: [1e-4, 1e-4, 1e-4],
      upper: [Infinity, 8, Infinity],
    })
    expect(fit.theta[1]).toBe(8)
    expect(fit.reason).toBe('converged')
    expect(fit.atBound).toEqual([false, true, false])
    // A parameter on its bound has no error the data set; the others still do.
    expect(Number.isNaN(fit.covariance![1]![1]!)).toBe(true)
    expect(fit.covariance![0]![0]!).toBeGreaterThan(0)
  })

  it('reports no covariance for a parameter that moves nothing', async () => {
    const data = noisy(1, 0.1)
    const fit = await leastSquares(
      [1, 3, 0, 7],
      async (points) =>
        points.map(([a, tau, c]) => curve(a!, tau!, c!).map((v, i) => v - data[i]!)),
      { steps: [1e-4, 1e-4, 1e-4, 1e-4] },
    )
    expect(fit.covariance).toBeUndefined()
  })

  it('stops at a minimum rounding has flattened, converged and without climbing the damping', async () => {
    // Quantised like a simulation's rounding: at the minimum no trial is any cheaper than the cost.
    const quantum = 1e-6
    let evaluations = 0
    const fit = await leastSquares(
      [0],
      async (points) => {
        evaluations += points.length
        return points.map(([x]) =>
          Float64Array.from(
            [1, 2, 3],
            (k) => Math.round(((x! - 3) * k) / quantum) * quantum + 1,
          ),
        )
      },
      { steps: [1e-3] },
    )
    expect(fit.reason).toBe('converged')
    // The offset moves the minimum to 3 − Σk/Σk² = 3 − 3/7.
    expect(fit.theta[0]).toBeCloseTo(3 - 3 / 7, 4)
    expect(evaluations).toBeLessThan(20)
  })

  it('hands every Jacobian column over in one batch, so they can run side by side', async () => {
    const batches: number[] = []
    const data = noisy(1, 0.1)
    await leastSquares(
      [1, 3, 0],
      async (points) => {
        batches.push(points.length)
        return points.map(([a, tau, c]) => curve(a!, tau!, c!).map((v, i) => v - data[i]!))
      },
      { steps: [1e-4, 1e-4, 1e-4], maxIterations: 2 },
    )
    // The start rides with its own Jacobian; every later Jacobian is a batch of its own.
    expect(batches[0]).toBe(4)
    expect(batches.filter((n) => n === 3).length).toBeGreaterThan(0)
  })
})
