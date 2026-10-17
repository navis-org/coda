/**
 * The Model tab's numbers on a built model: the input resistance the solver itself settles to under
 * a long step, the membrane shared out by region, the time constant Rm × Cm.
 */

import { describe, expect, it } from 'vitest'

import { simulate } from '../../biophys/solver'
import type { ModelCable } from './build'
import { buildCellModel, cableCompartmentAt, modelCable } from './build'
import { cableConstants, compartmentLoads, modelStats } from './modelStats'
import { cellModelOf } from './solverInputs'
import { HH, OPTIONS, build, emSoma, input } from './testFixtures'

describe('modelStats', () => {
  it('gives the input resistance a long step settles to, and the membrane by region', () => {
    const value = buildCellModel(emSoma(), {}, OPTIONS)
    const stats = modelStats(value)
    // 0.01 nA for 400 ms, far past the 16.6 ms time constant: ΔV / I is the input resistance.
    const run = simulate({
      model: cellModelOf(value),
      dt: 0.1,
      duration: 400,
      initial: { v: -60 },
      clamps: [
        { compartment: value.soma.compartment, delay: 0, duration: 400, amplitude: 0.01 },
      ],
      record: Int32Array.of(value.soma.compartment),
    })
    const settled = run.v[0]![run.v[0]!.length - 1]! + 60
    expect(stats.inputResistance).toBeCloseTo(settled / 0.01, 2)
    expect(stats.timeConstant).toBeCloseTo((20_800 * 0.8) / 1000, 9)
    expect(stats.area).toBeCloseTo(
      stats.areaByRegion.reduce((a, r) => a + r.area, 0),
      9,
    )
    expect(stats.somaShare).toBeGreaterThan(0)
    expect(stats.somaShare).toBeLessThan(1)
  })
})

/**
 * Every kept edge covered end to end by compartments that exist, and wherever two different
 * compartments meet — along an edge, or from an edge into those leaving its node — their shades
 * differ. Returns how many meetings it checked.
 */
function checkEdges(cable: ModelCable, compartments: number): number {
  const { edges, skeleton } = cable
  const n = skeleton.parents.length
  let met = 0
  for (let v = 0; v < n; v++) {
    const [a, b] = [edges.start[v]!, edges.start[v + 1]!]
    if (v === 0) {
      expect(b - a).toBe(0)
      continue
    }
    expect(b - a).toBeGreaterThan(0)
    // From its parent, or from a parent soma's surface (what is inside is no cable), to its end.
    const fromSoma = skeleton.parents[v] === 0
    if (!fromSoma) expect(edges.t0[a]).toBeCloseTo(0, 6)
    expect(edges.t0[a]).toBeGreaterThanOrEqual(0)
    expect(edges.t1[b - 1]).toBeCloseTo(1, 6)
    for (let k = a + 1; k < b; k++) expect(edges.t0[k]).toBeCloseTo(edges.t1[k - 1]!, 6)
    for (let k = a; k < b; k++) {
      expect(edges.compartment[k]).toBeGreaterThanOrEqual(0)
      expect(edges.compartment[k]).toBeLessThan(compartments)
    }
    const meet = (i: number, j: number) => {
      if (edges.compartment[i] === edges.compartment[j]) return
      met++
      expect(edges.shade[i]).not.toBe(edges.shade[j])
    }
    for (let k = a + 1; k < b; k++) meet(k - 1, k)
    const p = skeleton.parents[v]!
    if (p > 0) meet(edges.start[p + 1]! - 1, a)
  }
  return met
}

describe('the area factor', () => {
  it('scales every compartment’s membrane, the soma’s included, and what is read off it', () => {
    const one = build(HH)
    const two = build({ ...HH, areaFactor: 2 })
    const total = (v: typeof one) => v.compartments.area.reduce((a, b) => a + b, 0)
    // However d_lambda cuts it, the integral of the membrane is the membrane.
    expect(total(two)).toBeCloseTo(2 * total(one), 6)
    expect(two.areaFactor).toBe(2)
    expect(one.areaFactor).toBeUndefined()
    const [a, b] = [modelStats(one), modelStats(two)]
    expect(b.somaArea).toBeCloseTo(2 * a.somaArea, 9)
    expect(b.somaShare).toBeCloseTo(a.somaShare, 9)
    // Twice the membrane in parallel: half the input resistance, near enough on a compact cell.
    expect(b.inputResistance).toBeLessThan(a.inputResistance * 0.6)
    expect(b.timeConstant).toBe(a.timeConstant)
    // The channels on the soma carry twice the conductance at the same density.
    const soma = (v: typeof one) => compartmentLoads(v)(modelCable(v)!.somaCompartments)
    expect(soma(two).channels[0]!.conductance).toBeCloseTo(
      2 * soma(one).channels[0]!.conductance,
      6,
    )
    // A length constant from the reconstruction's radii: Rm over the factor.
    expect(cableConstants(two).rm).toBe(cableConstants(one).rm / 2)
  })
})

describe('compartmentLoads', () => {
  it('says what a compartment carries: its leak, the channels placed on it, its synapses', () => {
    // Two excitatory partners and one inhibitory, all three at one spot on the dendrite.
    const value = build(HH, {
      excitatory: input([
        ['A', '7', 'pre', 45_000, 0],
        ['B', '7', 'pre', 45_000, 0],
      ]),
      inhibitory: input([['C', '7', 'pre', 45_000, 0]]),
    })
    const loads = compartmentLoads(value)
    const c = value.synapses.compartment[0]!
    const here = loads([c])
    expect([here.excitatory, here.inhibitory, here.partners]).toEqual([2, 1, 3])
    // µm² × 1e-8 cm²/µm² over Ω·cm², in nS.
    expect(here.leak).toBeCloseTo((value.compartments.area[c]! * 10) / 20_800, 9)
    // Squid HH is placed on the soma alone.
    expect(here.channels).toEqual([])

    const soma = loads(modelCable(value)!.somaCompartments)
    const somaArea = Math.PI * value.soma.diameter! ** 2
    expect(soma.excitatory + soma.inhibitory).toBe(0)
    expect(soma.channels.map((ch) => ch.label)).toEqual(['Na (squid HH)', 'K (squid HH)'])
    expect(soma.channels[0]!.conductance).toBeCloseTo(0.12 * somaArea * 10, 6)
    expect(soma.leak).toBeCloseTo((somaArea * 10) / 20_800, 6)
  })
})

describe('modelCable', () => {
  it('is the cable as built: rooted at the soma centre, nothing the soma replaced, neurites at their own radius', () => {
    const value = buildCellModel(emSoma(), {}, OPTIONS)
    const cable = modelCable(value)!
    // emSoma keeps nodes 5–8 as cable; the soma took 1–4, and its section is its centre alone.
    expect(cable.skeleton.parents.length).toBe(5)
    expect(cable.skeleton.parents[0]).toBe(-1)
    expect(value.soma.diameter).toBeCloseTo(6, 9)
    // The fibre leaving the soma starts at its own 1.6 µm, not the soma's 3.
    const fibre = Array.from(cable.skeleton.parents.keys()).find(
      (v) => cable.skeleton.parents[v] === 0 && cable.skeleton.radii[v]! > 1000,
    )!
    expect(cable.edgeRadius[fibre]).toBeCloseTo(1600, 3)
    // Its first 3 µm of 10 are inside the soma: no cable, so neither drawn nor counted as length.
    expect(cable.edges.t0[cable.edges.start[fibre]!]).toBeCloseTo(0.3, 6)
    expect(cable.edgeLength[fibre]).toBeCloseTo(7000, 0)
    expect(checkEdges(cable, value.compartments.count)).toBeGreaterThan(0)
  })

  it('says what each compartment is: its cable, its width, its place in its section', () => {
    const value = buildCellModel(emSoma(), {}, OPTIONS)
    const cable = modelCable(value)!
    const { length, diameter, segment, of } = cable.compartments
    // The segments share out the cable exactly. The soma, drawn whole, covers none of it: its two
    // halves are compartments 1 and 3, each side of the junction at its centre.
    const cableUm = cable.edgeLength.reduce((a, b) => a + b, 0) / 1000
    expect(length.reduce((a, b) => a + b, 0)).toBeCloseTo(cableUm, 6)
    expect(value.soma.compartment).toBe(1)
    for (let c = 0; c < length.length; c++) {
      if (c === 1 || c === 3) expect(length[c]).toBe(0)
      if (segment[c]! < 0 || c === 1 || c === 3) continue
      expect(segment[c]).toBeLessThan(of[c]!)
      expect(length[c]).toBeGreaterThan(0)
    }
    const fibre = Array.from(cable.skeleton.parents.keys()).find(
      (v) => cable.skeleton.parents[v] === 0 && cable.skeleton.radii[v]! > 1000,
    )!
    // Inside the soma is the soma's; past its surface, a segment of the fibre at its own width.
    expect(cableCompartmentAt(cable, fibre, 0.2)).toBeUndefined()
    const c = cableCompartmentAt(cable, fibre, 0.5)!
    expect(segment[c]).toBeGreaterThanOrEqual(0)
    expect(diameter[c]).toBeCloseTo(3.2, 3)
    expect(cableCompartmentAt(cable, 0, 0.5)).toBeUndefined()
  })

  it('alternates shade across a run of one-segment sections, as a fine dendrite is', () => {
    // A comb: a soma, then a branch point every 2 µm with a 1 µm twig at each, all cut at 100 µm
    // so every section is one segment — where compartment numbers all share one parity.
    const nodes: [number, number, number, number, number][] = [[0, 0, 3000, -1, 1]]
    let spine = 0
    for (let k = 1; k <= 12; k++) {
      nodes.push([k * 2000, 0, 300, spine, 0])
      spine = nodes.length - 1
      nodes.push([k * 2000, 1000, 300, spine, 0])
    }
    const comb = {
      ...emSoma(),
      items: [
        {
          id: '7',
          positions: Float32Array.from(nodes.flatMap(([x, y]) => [x, y, 0])),
          radii: Float32Array.from(nodes, ([, , r]) => r),
          parents: Int32Array.from(nodes, ([, , , p]) => p),
          compartments: Uint8Array.from(nodes, (n) => n[4]),
        },
      ],
    }
    const value = buildCellModel(
      comb,
      {},
      { ...OPTIONS, rule: { kind: 'maxLength', length: 100 } },
    )
    expect(checkEdges(modelCable(value)!, value.compartments.count)).toBeGreaterThan(5)
  })
})
