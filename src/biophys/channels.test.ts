/**
 * The channel library: Jaxley's Pospischil gates against Jaxley's own rates, the gate roles a
 * ΔV50 shift reads, and placement by region with "everywhere".
 */

import { describe, expect, it } from 'vitest'

import jaxley from './__fixtures__/jaxley-reference.json'
import {
  HH_NA,
  POSPISCHIL_K,
  POSPISCHIL_NA,
  channelById,
  compileChannel,
  densityByRegion,
  leakChannel,
  shiftedChannel,
} from './channels'
import { caseTree, cutMaxLength, straightCable } from './referenceCases'
import { NO_SYNAPSES, simulate } from './solver'

/**
 * `jaxley.channels.pospischil` 0.14.0's `Na.m_gate`, `Na.h_gate` and `K.n_gate` at `vt` = −60 mV:
 * α and β per gate, ms⁻¹, computed in float32 by Jaxley itself. Jaxley's `efun` answers NaN at its
 * removable singularity (−47 mV for m's α, −20 mV for m's β); those two are the limit instead.
 */
const JAXLEY: Record<number, readonly number[]> = {
  [-90]: [0.000295095, 19.6000156, 1.74261391, 3.32611216e-6, 0.000177732, 1.35914087],
  [-73]: [0.0125274472, 14.8403702, 0.677694738, 9.96615199e-5, 0.00332558388, 0.888565242],
  [-60]: [0.167807296, 11.2037582, 0.329137236, 0.00134140055, 0.0251499359, 0.642012715],
  [-47]: [1.28, 7.5943003, 0.159852669, 0.0179850906, 0.130127698, 0.463871747],
  [-35]: [4.04119921, 4.42006159, 0.0820710957, 0.189703494, 0.370085657, 0.343644649],
  [-20]: [8.65012836, 1.4, 0.0356679522, 2.0, 0.805426955, 0.236183271],
  [0]: [15.0401182, 0.104481213, 0.01174164, 3.92805505, 1.4401778, 0.143252403],
  [25]: [23.039999, 0.0015551555, 0.00292780413, 3.99950647, 2.24000192, 0.0766774863],
}

/** α and β back out of a compiled gate: x∞ = α/(α+β), and one step gives α+β. */
function rates(gate: ReturnType<typeof compileChannel>['gates'][number], v: number) {
  const inf = gate.inf(v)
  const dt = 1e-4
  // From x = 0 one exponential-Euler step reaches inf·(1 − e^{−dt(α+β)}).
  const sum = -Math.log(1 - gate.advance(0, v, dt) / inf) / dt
  return [inf * sum, (1 - inf) * sum]
}

describe('the Pospischil (Jaxley) channels', () => {
  const na = compileChannel(POSPISCHIL_NA, 22)
  const k = compileChannel(POSPISCHIL_K, 22)

  it('have Jaxley’s rates, the singularities filled with their limits', () => {
    for (const [v, [am, bm, ah, bh, an, bn]] of Object.entries(JAXLEY)) {
      const at = Number(v)
      const got = [
        ...rates(na.gates[0]!, at),
        ...rates(na.gates[1]!, at),
        ...rates(k.gates[0]!, at),
      ]
      ;[am, bm, ah, bh, an, bn].forEach((want, i) => {
        expect(got[i]!, `gate ${i} at ${at} mV`).toBeCloseTo(
          want!,
          Math.max(3, -Math.log10(want!) + 4),
        )
      })
    }
  })

  it('give Jaxley’s own run of one compartment, spikes and all', () => {
    // `scripts/jaxley-reference.py`'s case: a 20 µm cylinder 20 µm across, Jaxley's densities.
    const c = jaxley.case
    const tree = cutMaxLength(straightCable([0, c.length], [c.radius, c.radius]), 100)
    const centre = tree.sections[0]!.first
    const fill = (x: number) => new Float64Array(tree.count).fill(x)
    const run = simulate({
      model: {
        tree,
        cm: fill(c.capacitance),
        channels: [
          { spec: leakChannel(c.eLeak), gbar: fill(c.gLeak) },
          { spec: POSPISCHIL_NA, gbar: fill(c.gNa) },
          { spec: POSPISCHIL_K, gbar: fill(c.gK) },
        ],
        temperature: 22,
        synapses: NO_SYNAPSES,
      },
      dt: jaxley.dt,
      duration: (jaxley.v.length - 1) * jaxley.stride * jaxley.dt,
      initial: { v: c.vInit },
      clamps: [{ compartment: centre, ...c.clamp }],
      record: Int32Array.of(centre),
    })
    const ours = run.v[0]!.filter((_, i) => i % jaxley.stride === 0)
    let worst = 0
    jaxley.v.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - ours[i]!))))
    // Measured 5e-8 mV, the fixture's rounding; the NEURON harness's bound.
    expect(worst).toBeLessThan(1e-5)
  })

  it('give Jaxley’s branched cable, its threshold raised 5 mV, with every gate shifted +5 here', () => {
    // `scripts/jaxley-reference.py`'s second case: three branches of five 16 µm compartments,
    // Pospischil everywhere, Jaxley's shared `vt` at −55 — every gate of both channels moved +5 mV.
    // The sign of a shift, and a multi-compartment Pospischil cable, checked from outside.
    const b = jaxley.branched
    const c = jaxley.case
    const length = b.ncomp * b.compLength
    const tree = cutMaxLength(
      caseTree({
        tree: {
          positions: [0, 0, 0, length, 0, 0, 2 * length, 0, 0, length, length, 0],
          radii: [b.radius, b.radius, b.radius, b.radius],
          parent: [-1, 0, 1, 1],
        },
      }),
      b.compLength,
      b.axialResistivity,
      c.capacitance,
    )
    // Compartment centres: the clamped first, then each child's last.
    const at = (x: number, y: number) =>
      Array.from({ length: tree.count }, (_, k) => k).find(
        (k) =>
          Math.abs(tree.position[k * 3]! - x) < 1e-9 &&
          Math.abs(tree.position[k * 3 + 1]! - y) < 1e-9,
      )!
    const half = b.compLength / 2
    const record = Int32Array.of(
      at(half, 0),
      at(2 * length - half, 0),
      at(length, length - half),
    )
    const fill = (x: number) => new Float64Array(tree.count).fill(x)
    const shift = b.vt - -60
    const run = simulate({
      model: {
        tree,
        cm: fill(c.capacitance),
        channels: [
          { spec: leakChannel(c.eLeak), gbar: fill(c.gLeak) },
          {
            spec: shiftedChannel(POSPISCHIL_NA, { activation: shift, inactivation: shift }),
            gbar: fill(c.gNa),
          },
          { spec: shiftedChannel(POSPISCHIL_K, { activation: shift }), gbar: fill(c.gK) },
        ],
        temperature: 22,
        synapses: NO_SYNAPSES,
      },
      dt: jaxley.dt,
      duration: b.duration,
      initial: { v: c.vInit },
      clamps: [{ compartment: record[0]!, ...b.clamp }],
      record,
    })
    let worst = 0
    b.v.forEach((trace, r) =>
      trace.forEach((v, i) => {
        worst = Math.max(worst, Math.abs(v - run.v[r]![i * jaxley.stride]!))
      }),
    )
    // Measured 5e-9 mV; the opposite sign of shift is 115 mV out.
    expect(worst).toBeLessThan(1e-5)
    expect(Math.max(...b.v[0]!)).toBeGreaterThan(0)
  })

  it('carry no temperature dependence', () => {
    const cold = compileChannel(POSPISCHIL_NA, 6.3)
    expect(cold.gates[0]!.advance(0, -40, 0.025)).toBe(na.gates[0]!.advance(0, -40, 0.025))
  })

  it('are in the library by id', () => {
    expect(channelById('pospischil.na')).toBe(POSPISCHIL_NA)
    expect(channelById('pospischil.k')).toBe(POSPISCHIL_K)
  })
})

describe('shifts by gate role', () => {
  it('moves activation and inactivation gates separately, by which way each opens', () => {
    expect(shiftedChannel(HH_NA, { activation: 5 }).gates.map((g) => g.shift ?? 0)).toEqual([
      5, 0,
    ])
    // Pospischil's gates read the same way from their steady states, with no naming rule.
    expect(shiftedChannel(POSPISCHIL_K, { activation: 5 }).gates[0]!.shift).toBe(5)
    const shifted = shiftedChannel(HH_NA, { inactivation: -15 })
    expect(shifted.gates.map((g) => g.shift ?? 0)).toEqual([0, -15])
    // Unshifted, the spec comes back as it was.
    expect(shiftedChannel(HH_NA, {})).toBe(HH_NA)
  })
})

describe('densityByRegion', () => {
  it('places by region, or everywhere where no region is named', () => {
    const region = Int32Array.of(0, 1, 2, 2)
    expect(Array.from(densityByRegion(region, [2], 5))).toEqual([0, 0, 5, 5])
    expect(Array.from(densityByRegion(region, [], 5))).toEqual([5, 5, 5, 5])
  })
})
