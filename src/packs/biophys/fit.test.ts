/**
 * The passive fit on recordings made from a known membrane: what it recovers, what it says it
 * cannot, and the two shortcuts it takes — the tree rescaled rather than rebuilt, and one
 * simulation shared by sweeps whose commands are scaled copies.
 */

import { describe, expect, it } from 'vitest'

import { seededRandom } from '../../nodes/lib/tableOps'
import type { RecordedSweep } from './fit'
import type { FitMembrane, Membrane } from './passive'
import { comparedSamples, fitPassive, passiveResponses, prepareFit, residualsAt } from './fit'
import { fittedModel } from './fitOps'
import { HH, build } from './testFixtures'

const TRUTH: Membrane = { rm: 15_000, cm: 1.1, ra: 180, eLeak: -55 }
const DT = 0.025

/** An I–V: steps of `amps` nA from 20 to 70 ms, sampled every 0.1 ms for 100 ms. */
function protocol(amps: readonly number[]): RecordedSweep[] {
  const t = Float64Array.from({ length: 1000 }, (_, i) => i * 0.1)
  return amps.map((a, k) => ({
    sweep: k + 1,
    t,
    v: new Float64Array(t.length),
    command: t.map((x) => (x >= 20 && x < 70 ? a : 0)),
  }))
}

/** `sweeps` with the voltage of the model at `membrane`, plus seeded Gaussian noise. */
function recorded(
  sweeps: RecordedSweep[],
  membrane: Membrane | FitMembrane,
  sigma: number,
): RecordedSweep[] {
  // Built at the true Ra, so the truth owes nothing to the rescaling being tested.
  const truth = build({
    membrane: { rm: membrane.rm, cm: membrane.cm, ra: membrane.ra, eLeak: membrane.eLeak },
  })
  const random = seededRandom(7)
  const noise = () =>
    sigma *
    Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) *
    Math.cos(2 * Math.PI * random())
  return passiveResponses(truth, membrane, sweeps, DT).map((v, k) => ({
    ...sweeps[k]!,
    v: v.map((x) => x + noise()),
  }))
}

describe('passiveResponses', () => {
  it('rescales the tree for Ra exactly as rebuilding at that Ra would', () => {
    const sweeps = protocol([0.02])
    const rebuilt = passiveResponses(build({ membrane: TRUTH }), TRUTH, sweeps, DT)[0]!
    const rescaled = passiveResponses(build(), TRUTH, sweeps, DT)[0]!
    expect(Math.max(...rescaled.map((v, i) => Math.abs(v - rebuilt[i]!)))).toBeLessThan(1e-9)
  })

  it('scales one simulation for every sweep whose command is a scaled copy', () => {
    const value = build()
    const together = passiveResponses(value, TRUTH, protocol([-0.02, 0.01, 0.03]), DT)
    const alone = passiveResponses(value, TRUTH, protocol([0.01]), DT)[0]!
    expect(Math.max(...together[1]!.map((v, i) => Math.abs(v - alone[i]!)))).toBeLessThan(1e-9)
    // No command, no response: the cell at rest.
    expect(passiveResponses(value, TRUTH, protocol([0]), DT)[0]!.every((v) => v === -55)).toBe(
      true,
    )
  })
})

describe('a recording under a holding current', () => {
  it('starts in the steady state that current holds, so a constant command draws a flat line', () => {
    const t = Float64Array.from({ length: 500 }, (_, i) => i * 0.1)
    const held = { sweep: 1, t, v: new Float64Array(t.length), command: t.map(() => 0.01) }
    const [v] = passiveResponses(build(), TRUTH, [held], DT)
    // Depolarised by the holding current, and settled there from the first sample.
    expect(v![0]!).toBeGreaterThan(TRUTH.eLeak + 1)
    expect(Math.max(...v!) - Math.min(...v!)).toBeLessThan(1e-6)
  })

  it('recovers the membrane from steps riding on a holding current', async () => {
    const sweeps = protocol([-0.03, 0.03]).map((s) => ({
      ...s,
      command: s.command.map((c) => c - 0.01),
    }))
    const fit = await fitPassive(build(), recorded(sweeps, TRUTH, 0.05), {
      free: ['rm', 'cm', 'ra', 'eLeak'],
      skipAfterSteps: 0,
      dt: DT,
    })
    expect(fit.membrane.rm).toBeCloseTo(TRUTH.rm, -2)
    expect(fit.membrane.eLeak).toBeCloseTo(TRUTH.eLeak, 0)
  })
})

describe('what is compared', () => {
  it('simulates a group whose compared samples all sit at or before t = 0', () => {
    // A pre-trigger baseline under a holding current, compared only before the trigger.
    const t = Float64Array.from({ length: 200 }, (_, i) => -10 + i * 0.1)
    const held = { sweep: 1, t, v: new Float64Array(t.length), command: t.map(() => 0.01) }
    const [v] = passiveResponses(build(), TRUTH, [held], DT)
    const setup = prepareFit(build(), [{ ...held, v: v! }], {
      window: { start: -10, end: 0.05 },
      skipAfterSteps: 0,
      dt: DT,
    })
    const r = residualsAt(setup, { ...TRUTH, area: 1, seal: 0 })
    expect(Math.max(...r.map(Math.abs))).toBeLessThan(1e-9)
  })

  it('reads a current that changes at every sample as no command, and skips nothing for it', () => {
    const [sweep] = protocol([0.02])
    const random = seededRandom(3)
    const monitor = {
      ...sweep!,
      command: sweep!.command.map((c) => c + 0.001 * (random() - 0.5)),
    }
    expect(comparedSamples(monitor, undefined, 1)).toHaveLength(monitor.t.length)
    expect(prepareFit(build(), [monitor], { skipAfterSteps: 1, dt: DT }).unstepped).toBe(1)
    expect(prepareFit(build(), [sweep!], { skipAfterSteps: 1, dt: DT }).unstepped).toBe(0)
  })
})

describe('shared simulations', () => {
  it('shares one only between sweeps on the same time grid', () => {
    const [a] = protocol([0.02])
    const slower = {
      ...a!,
      sweep: 2,
      t: a!.t.map((x) => x * 2),
      command: a!.command.map((c) => c * 2),
    }
    // Proportional sample for sample, but read at other times: two simulations.
    expect(
      prepareFit(build(), [a!, slower], { skipAfterSteps: 0, dt: DT }).groups,
    ).toHaveLength(2)
    expect(
      prepareFit(build(), protocol([0.01, 0.02]), { skipAfterSteps: 0, dt: DT }).groups,
    ).toHaveLength(1)
  })
})

describe('comparedSamples', () => {
  it('keeps the window and leaves out the samples just after each command edge', () => {
    const [sweep] = protocol([0.02])
    const kept = comparedSamples(sweep!, { start: 10, end: 90 }, 1)
    const times = Array.from(kept, (i) => Math.round(sweep!.t[i]! * 10) / 10)
    expect(times[0]).toBe(10)
    expect(times.at(-1)).toBe(89.9)
    expect(times).not.toContain(20)
    expect(times).not.toContain(20.9)
    expect(times).toContain(21)
    expect(times).not.toContain(70.5)
  })
})

describe('fitPassive', () => {
  it('recovers the membrane from a noisy I–V, each within its standard errors', async () => {
    const sweeps = recorded(protocol([-0.03, -0.015, 0.015, 0.03]), TRUTH, 0.1)
    const fit = await fitPassive(build(), sweeps, {
      free: ['rm', 'cm', 'ra', 'eLeak'],
      skipAfterSteps: 0,
      dt: DT,
    })
    expect(fit.reason).toBe('converged')
    expect(fit.simulationsPerEvaluation).toBe(1)
    for (const p of fit.parameters.filter((q) => q.free)) {
      const truth = TRUTH[p.key as keyof Membrane]
      expect(Math.abs(p.fitted - truth), p.key).toBeLessThan(4 * p.standardError!)
    }
    // The noise is what is left.
    expect(fit.rms).toBeCloseTo(0.1, 1)
    expect(fit.startRms).toBeGreaterThan(fit.rms * 5)
    const rm = fit.parameters.find((p) => p.key === 'rm')!
    const ra = fit.parameters.find((p) => p.key === 'ra')!
    // A soma recording pins Rm down far better than Ra: the shares say so.
    expect(rm.standardError! / rm.fitted).toBeLessThan(ra.standardError! / ra.fitted)
  })

  it('holds a fixed parameter where the model had it, and fits the rest around it', async () => {
    const sweeps = recorded(protocol([-0.03, 0.03]), TRUTH, 0.05)
    const fit = await fitPassive(build({ membrane: { ...TRUTH, ra: 180 } }), sweeps, {
      free: ['rm', 'cm', 'eLeak'],
      skipAfterSteps: 0,
      dt: DT,
    })
    const ra = fit.parameters.find((p) => p.key === 'ra')!
    expect(ra.free).toBe(false)
    expect(ra.fitted).toBe(180)
    expect(ra.standardError).toBeUndefined()
    expect(fit.membrane.rm).toBeCloseTo(TRUTH.rm, -2)
  })

  it('fits the area factor against a pinned Cm, and refuses to fit it beside Cm and Rm', async () => {
    const truth = { ...TRUTH, cm: 1, area: 2.2, seal: 0 }
    const sweeps = recorded(protocol([-0.03, -0.015, 0.015, 0.03]), truth, 0.1)
    const start = build({ membrane: { rm: 25_000, cm: 1, ra: 120, eLeak: -60 } })
    const fit = await fitPassive(start, sweeps, {
      free: ['rm', 'ra', 'eLeak', 'area'],
      skipAfterSteps: 0,
      dt: DT,
    })
    expect(fit.reason).toBe('converged')
    for (const p of fit.parameters.filter((q) => q.free)) {
      expect(Math.abs(p.fitted - truth[p.key]), p.key).toBeLessThan(4 * p.standardError!)
    }
    // The fitted model, its area scaled as the build scales one, is the same cell.
    const fitted = fittedModel(start, fit)
    const asFitted = passiveResponses(start, fit.membrane, sweeps, DT)[0]!
    const asBuilt = passiveResponses(fitted, fitted.membrane, sweeps, DT)[0]!
    expect(Math.max(...asBuilt.map((v, i) => Math.abs(v - asFitted[i]!)))).toBeLessThan(1e-9)
    expect(fitted.areaFactor).toBeCloseTo(fit.membrane.area, 12)
    await expect(
      fitPassive(start, sweeps, { free: ['rm', 'cm', 'area'], skipAfterSteps: 0, dt: DT }),
    ).rejects.toThrow(/cannot all be fitted/)
  })

  it('fits the electrode’s seal, which E leak absorbs when it is left out, and leaves it off the fitted cell', async () => {
    const truth = { ...TRUTH, area: 1, seal: 0.5 }
    const sweeps = recorded(protocol([-0.03, -0.015, 0, 0.015]), truth, 0.05)
    // A seal keeps the cell linear about a rest it moves towards 0 mV: one simulation still serves
    // every scaled sweep, scaled about that rest, and the sweep with no command sits there.
    const start = build({ membrane: TRUTH })
    const shared = passiveResponses(start, truth, sweeps, DT)
    const alone = passiveResponses(start, truth, [sweeps[1]!], DT)[0]!
    expect(Math.max(...shared[1]!.map((v, i) => Math.abs(v - alone[i]!)))).toBeLessThan(1e-9)
    expect(shared[2]![0]!).toBeGreaterThan(TRUTH.eLeak + 1)

    const from = build({ membrane: { rm: 25_000, cm: 1.1, ra: 180, eLeak: -60 } })
    const fit = await fitPassive(from, sweeps, {
      free: ['rm', 'eLeak', 'seal'],
      seal: 0.2,
      skipAfterSteps: 0,
      dt: DT,
    })
    expect(fit.reason).toBe('converged')
    for (const p of fit.parameters.filter((q) => q.free)) {
      expect(Math.abs(p.fitted - truth[p.key]), p.key).toBeLessThan(4 * p.standardError!)
    }
    // Without it, the seal's pull towards 0 mV is read as the cell's own: E leak depolarised.
    const sealless = await fitPassive(from, sweeps, {
      free: ['rm', 'eLeak'],
      skipAfterSteps: 0,
      dt: DT,
    })
    expect(sealless.membrane.eLeak).toBeGreaterThan(TRUTH.eLeak + 1)
    expect(fittedModel(from, fit).membrane).not.toHaveProperty('seal')
  })

  it('fits the passive copy of a model with channels', async () => {
    const sweeps = recorded(protocol([-0.02, 0.02]), TRUTH, 0.05)
    const fit = await fitPassive(build({ ...HH, membrane: TRUTH }), sweeps, {
      free: ['rm', 'eLeak'],
      skipAfterSteps: 0,
      dt: DT,
    })
    expect(fit.membrane.rm).toBeCloseTo(TRUTH.rm, -2)
  })

  it('says what is wrong rather than fitting nothing', async () => {
    const sweeps = protocol([0.02])
    await expect(
      fitPassive(build(), sweeps, { free: [], skipAfterSteps: 0, dt: DT }),
    ).rejects.toThrow(/No parameter is free/)
    await expect(
      fitPassive(build(), sweeps, {
        free: ['rm'],
        window: { start: 200, end: 300 },
        skipAfterSteps: 0,
        dt: DT,
      }),
    ).rejects.toThrow(/Too few samples/)
  })
})
