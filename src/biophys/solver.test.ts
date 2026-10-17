import { describe, expect, it } from 'vitest'
import reference from './__fixtures__/neuron-reference.json'
import { HH_NA, compileChannel, leakChannel } from './channels'
import type { CableTree, CompartmentTree } from './discretize'
import { discretize } from './discretize'
import {
  BRANCHED_NODES,
  buildCase,
  caseNamed,
  caseTree,
  cutMaxLength as cut,
  hhPoint,
  straightCable,
} from './referenceCases'
import type { CellModel, CurrentClamp, SynapseSlots } from './solver'
import {
  NO_SYNAPSES,
  Simulation,
  exp2synNorm,
  settle,
  settleSliced,
  simulate,
  steadyState,
  synapticInput,
} from './solver'

/** A uniform passive model: Rm Ω·cm², cm µF/cm², resting at `e`. */
function passive(
  tree: CompartmentTree,
  rm: number,
  cm: number,
  e: number,
  synapses: SynapseSlots = NO_SYNAPSES,
): CellModel {
  return {
    tree,
    cm: new Float64Array(tree.count).fill(cm),
    channels: [{ spec: leakChannel(e), gbar: new Float64Array(tree.count).fill(1 / rm) }],
    temperature: 22,
    synapses,
  }
}

/** A tree re-rooted at `root`, same nodes, same indices. */
function reroot(tree: CableTree, root: number): CableTree {
  const n = tree.parent.length
  const neighbours: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const p = tree.parent[i]!
    if (p >= 0) {
      neighbours[i]!.push(p)
      neighbours[p]!.push(i)
    }
  }
  const parent = new Int32Array(n).fill(-2)
  parent[root] = -1
  const queue = [root]
  while (queue.length > 0) {
    const v = queue.shift()!
    for (const u of neighbours[v]!) {
      if (parent[u] !== -2) continue
      parent[u] = v
      queue.push(u)
    }
  }
  return { ...tree, parent }
}

/** Max |a − b| over two traces. */
function maxDiff(a: Float64Array, b: Float64Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
  return m
}

const RM = 20_000
// `cutMaxLength`'s defaults, which the closed forms below are computed with.
const RA = 100
const CM = 1
const E = -65

describe('agreement with NEURON', () => {
  // `pnpm biophys:reference` ran these cases in NEURON 8.2 on our sections and segment counts.
  // Measured agreement: 2e-6 mV or better on every case, the fixture itself being rounded to
  // 1e-7 mV — so this tolerance leaves room for rounding and none for a different scheme.
  for (const fixture of reference.cases) {
    it(`matches NEURON on ${fixture.name}`, () => {
      const result = simulate(buildCase(caseNamed(fixture.name)).request)
      fixture.traces.forEach((trace, r) => {
        trace.forEach((v, i) => {
          expect(Math.abs(result.v[r]![i * reference.stride]! - v)).toBeLessThan(1e-5)
        })
      })
    })
  }

  it('spikes where NEURON spikes, so the fixture is not all subthreshold', () => {
    const crossings = (name: string) => {
      const trace = reference.cases.find((c) => c.name === name)!.traces[0]!
      return trace.filter((v, i) => i > 0 && trace[i - 1]! < 0 && v >= 0).length
    }
    expect(crossings('hh-point')).toBeGreaterThan(1)
    expect(crossings('branched-hh-soma')).toBeGreaterThan(0)
  })
})

describe('closed forms', () => {
  it('charges one isopotential compartment with τ = Rm·Cm to ΔV = I·R', () => {
    // 20 µm long and 20 µm across, one segment: all the membrane on one node.
    const tree = cut(straightCable([0, 20], [10, 10]), 100)
    const centre = tree.sections[0]!.first
    const area = tree.area[centre]!
    const model = passive(tree, RM, CM, E)
    const amplitude = 0.01 // nA
    const dt = 0.01
    const run = simulate({
      model,
      dt,
      // Fifteen time constants, so the last sample is at the asymptote to well under 1e-3 mV.
      duration: 300,
      initial: { v: E },
      clamps: [{ compartment: centre, delay: 0, duration: 1000, amplitude }],
      record: Int32Array.of(centre),
    })
    // R = Rm / area: Ω·cm² over µm² is 1e8 Ω, so 1e2 MΩ. τ = Rm·Cm: Ω·cm² × µF/cm² is µs.
    const r = (RM / area) * 1e2
    const tau = (RM * CM) / 1000
    const vInf = E + amplitude * r
    // Backward Euler is first order; against its own exact recursion the match is to rounding.
    const v = run.v[0]!
    for (let n = 0; n < v.length; n += 750) {
      const recursion = vInf + (E - vInf) * (1 + dt / tau) ** -n
      expect(v[n]!).toBeCloseTo(recursion, 8)
    }
    expect(v[v.length - 1]!).toBeCloseTo(vInf, 3)
  })

  it('gives a sealed cylinder R∞·coth(L/λ) and attenuates as 1/cosh(L/λ)', () => {
    const d = 2 // µm
    const length = 500 // µm
    const tree = cut(straightCable([0, length], [d / 2, d / 2]), 1)
    const injection = new Float64Array(tree.count)
    injection[0] = 0.1 // nA, at the root end
    const v = steadyState(passive(tree, RM, CM, 0), injection)

    const dcm = d * 1e-4
    const rm = RM / (Math.PI * dcm) // Ω·cm
    const ri = (4 * RA) / (Math.PI * dcm * dcm) // Ω/cm
    const lambda = Math.sqrt(rm / ri) * 1e4 // µm
    const rInf = Math.sqrt(rm * ri) * 1e-6 // MΩ
    const rIn = rInf / Math.tanh(length / lambda)

    expect(v[0]! / 0.1 / rIn).toBeCloseTo(1, 4)
    const end = tree.sections[0]!.first + tree.sections[0]!.nseg
    expect(v[end]! / v[0]!).toBeCloseTo(1 / Math.cosh(length / lambda), 4)
  })

  it('collapses a Y obeying Rall’s 3/2 rule to its equivalent cylinder', () => {
    // Thin and long: the step in diameter at the fork is a cone shoulder of area ≈ π(r₀² − r₁²),
    // membrane NEURON counts too and Rall's cylinders do not. At 2 µm and 100 µm it measured as
    // 0.2% of the input resistance; at these sizes it is under 0.03%.
    const d0 = 1
    const d1 = (d0 ** 1.5 / 2) ** (2 / 3)
    const l0 = 300
    const l1 = 400
    // Stem along x, two daughters fanning out symmetrically. Each daughter starts with a 0.01 µm
    // piece narrowing from the stem's radius to its own, so the step in diameter sits at the fork.
    const fork = l0
    const stepped: CableTree = {
      positions: Float64Array.of(
        0,
        0,
        0,
        fork,
        0,
        0,
        fork + 0.8 * l1,
        0.6 * l1,
        0,
        fork + 0.8 * l1,
        -0.6 * l1,
        0,
        fork + 0.008,
        0.006,
        0,
        fork + 0.008,
        -0.006,
        0,
      ),
      radii: Float64Array.of(d0 / 2, d0 / 2, d1 / 2, d1 / 2, d1 / 2, d1 / 2),
      parent: Int32Array.of(-1, 0, 4, 5, 1, 1),
    }
    const y = cut(stepped, 0.5)
    const injection = new Float64Array(y.count)
    injection[0] = 0.1
    const rY = steadyState(passive(y, RM, CM, 0), injection)[0]! / 0.1

    const lambda = (dum: number) => Math.sqrt((RM * dum * 1e-4) / (4 * RA)) * 1e4
    const lEq = l0 + l1 * (lambda(d0) / lambda(d1))
    const dcm = d0 * 1e-4
    const rInf = Math.sqrt((RM / (Math.PI * dcm)) * ((4 * RA) / (Math.PI * dcm * dcm))) * 1e-6
    const rEq = rInf / Math.tanh(lEq / lambda(d0))
    expect(rY / rEq).toBeCloseTo(1, 3)
  })
})

describe('invariants', () => {
  it('does not depend on where the tree is rooted', () => {
    // Root it at the stub's tip and again at the long branch's tip: the same landmarks either
    // way, so the same compartments, and the traces at every node must agree to rounding.
    const c = caseNamed('branched-passive')
    const base = caseTree(c)
    const nodes = Array.from({ length: base.parent.length }, (_, i) => i)
    const run = (tree: CableTree) => {
      const t = discretize(tree, { rule: c.rule, ra: c.ra, cm: c.cm })
      const at = (node: number) => t.nodeCompartment[node]!
      const result = simulate({
        model: passive(t, 1 / c.gLeak, c.cm, c.eLeak, {
          kinds: [{ scheme: 'exp2syn' as const, tau1: 0.1, tau2: 10, eRev: 0 }],
          kindOf: Int32Array.of(0, 0),
          compartment: Int32Array.of(at(BRANCHED_NODES.twigA), at(12)),
        }),
        dt: 0.025,
        duration: 30,
        initial: { v: c.eLeak },
        events: {
          time: Float64Array.of(2, 4),
          slot: Int32Array.of(0, 1),
          weight: Float64Array.of(0.002, 0.001),
        },
        clamps: [
          { compartment: at(BRANCHED_NODES.fork), delay: 10, duration: 5, amplitude: 0.05 },
        ],
        record: Int32Array.from(nodes, at),
      })
      return { result, count: t.count }
    }
    const a = run(reroot(base, BRANCHED_NODES.stub))
    const b = run(reroot(base, BRANCHED_NODES.longTip))
    expect(a.count).toBe(b.count)
    for (const node of nodes)
      expect(maxDiff(a.result.v[node]!, b.result.v[node]!)).toBeLessThan(1e-9)
  })

  it('counts n synapses on one compartment as n times the conductance', () => {
    const {
      request: { model },
      tree,
    } = buildCase(caseNamed('branched-passive'))
    const site = tree.nodeCompartment[BRANCHED_NODES.twigA]!
    const base = {
      dt: 0.025,
      duration: 20,
      initial: { v: -60 },
      record: Int32Array.of(0, site),
    }
    const kinds = [{ scheme: 'exp2syn' as const, tau1: 0.2, tau2: 5, eRev: 0 }]
    const withSlots = (compartment: Int32Array) => ({
      ...model,
      synapses: { kinds, kindOf: new Int32Array(compartment.length), compartment },
    })
    const two = simulate({
      ...base,
      model: withSlots(Int32Array.of(site, site)),
      events: {
        time: Float64Array.of(1, 1),
        slot: Int32Array.of(0, 1),
        weight: Float64Array.of(0.001, 0.001),
      },
    })
    const doubled = simulate({
      ...base,
      model: withSlots(Int32Array.of(site)),
      events: {
        time: Float64Array.of(1),
        slot: Int32Array.of(0),
        weight: Float64Array.of(0.002),
      },
    })
    expect(maxDiff(two.v[0]!, doubled.v[0]!)).toBeLessThan(1e-12)
    expect(maxDiff(two.v[1]!, doubled.v[1]!)).toBeLessThan(1e-12)
  })

  it('leaves a passive model at its leak reversal exactly', () => {
    const { model } = buildCase(caseNamed('branched-passive')).request
    const result = simulate({
      model,
      dt: 0.025,
      duration: 100,
      initial: { v: -60 },
      record: Int32Array.from({ length: model.tree.count }, (_, i) => i),
    })
    let drift = 0
    for (const trace of result.v)
      for (const v of trace) drift = Math.max(drift, Math.abs(v + 60))
    expect(drift).toBeLessThan(1e-12)
  })

  it('settles the same when sliced, handing control back between chunks, and stops when told', async () => {
    const c = caseNamed('branched-hh-soma')
    const { model } = buildCase(c).request
    let chunks = 0
    const sliced = await settleSliced(model, c.eLeak, () => {
      chunks++
    })
    const whole = settle(model, c.eLeak)
    expect(sliced.time).toBe(whole.time)
    expect(Array.from(sliced.state.v)).toEqual(Array.from(whole.state.v))
    expect(chunks).toBeGreaterThan(0)
    await expect(
      settleSliced(model, c.eLeak, () => {
        throw new Error('Aborted')
      }),
    ).rejects.toThrow('Aborted')
  })

  it('settles an active model somewhere other than its leak reversal, and it stays there', () => {
    const c = caseNamed('branched-hh-soma')
    const {
      request: { model },
      tree,
    } = buildCase(c)
    const settled = settle(model, c.eLeak)
    expect(settled.converged).toBe(true)
    const soma = tree.nodeCompartment[BRANCHED_NODES.soma]!
    // HH at the soma pulls the rest away from −60: starting there would open on a drift.
    expect(Math.abs(settled.state.v[soma]! - c.eLeak)).toBeGreaterThan(0.1)
    const after = simulate({
      model,
      dt: 0.025,
      duration: 50,
      initial: settled.state,
      record: Int32Array.from({ length: model.tree.count }, (_, i) => i),
    })
    after.v.forEach((trace, comp) => {
      expect(
        maxDiff(trace, new Float64Array(trace.length).fill(settled.state.v[comp]!)),
      ).toBeLessThan(1e-3)
    })
  })

  it('converges: halving dt and the compartment length barely moves the soma', () => {
    const c = caseNamed('branched-passive')
    const run = (dt: number, length: number) => {
      const { request } = buildCase({
        ...c,
        rule: { kind: 'maxLength', length },
        dt,
        clamps: [],
      })
      const result = simulate({ ...request, sampleEvery: Math.round(0.1 / dt) })
      return result.v[1]!
    }
    const coarse = run(0.025, 10)
    const fine = run(0.0125, 5)
    let peak = 0
    for (const v of fine) peak = Math.max(peak, v + 60)
    expect(maxDiff(coarse, fine) / peak).toBeLessThan(0.01)
  })

  it('slices a run without changing it', () => {
    const { request } = buildCase(caseNamed('branched-hh-soma'))
    const whole = simulate(request)
    const sliced = new Simulation(request)
    while (!sliced.advance(37));
    expect(maxDiff(sliced.result().v[0]!, whole.v[0]!)).toBe(0)
  })

  it('refuses a cable with no membrane, rather than answering NaN', () => {
    const { request } = buildCase(caseNamed('branched-passive'))
    const tree = { ...request.model.tree, area: new Float64Array(request.model.tree.count) }
    expect(() => new Simulation({ ...request, model: { ...request.model, tree } })).toThrow(
      /no membrane/,
    )
  })

  it('refuses events out of time order', () => {
    const { request } = buildCase(caseNamed('branched-passive'))
    expect(
      () =>
        new Simulation({
          ...request,
          events: {
            time: Float64Array.of(2, 1),
            slot: Int32Array.of(0, 0),
            weight: Float64Array.of(1e-3, 1e-3),
          },
        }),
    ).toThrow(/time order/)
  })
})

describe('Hodgkin–Huxley', () => {
  /** `hhPoint`'s squid compartment, stepped for 95 ms at a density in µA/cm². */
  function squid(density: number, temperature: number) {
    const c = hhPoint('squid', temperature, density)
    const clamps = c.clamps!.map((k) => ({ ...k, duration: 95 }))
    return simulate(buildCase({ ...c, dt: 0.01, duration: 100, clamps }).request).v[0]!
  }
  const spikes = (v: Float64Array) =>
    v.filter((x, i) => i > 0 && v[i - 1]! < 0 && x >= 0).length
  /** Width at half height of the first spike, ms. */
  function halfWidth(v: Float64Array, dt: number): number {
    let peak = 0
    for (let i = 1; i < v.length; i++) if (v[i]! > v[peak]!) peak = i
    const half = (v[peak]! + -65) / 2
    let a = peak
    while (a > 0 && v[a]! > half) a--
    let b = peak
    while (b < v.length - 1 && v[b]! > half) b++
    return (b - a) * dt
  }

  it('stays below threshold at 1 µA/cm² and fires repetitively at 10', () => {
    expect(spikes(squid(1, 6.3))).toBe(0)
    expect(spikes(squid(10, 6.3))).toBeGreaterThan(4)
  })

  it('narrows the spike when warmer, as Q10 = 3 has it', () => {
    expect(halfWidth(squid(20, 16.3), 0.01)).toBeLessThan(halfWidth(squid(20, 6.3), 0.01) * 0.7)
  })
})

describe('read-outs', () => {
  it('keeps every compartment’s peak, read every step', () => {
    const { request } = buildCase(caseNamed('branched-hh-soma'))
    const all = Int32Array.from({ length: request.model.tree.count }, (_, i) => i)
    const result = simulate({ ...request, record: all, peaks: true })
    result.v.forEach((trace, c) => expect(result.peak![c]).toBe(Math.max(...trace)))
    // Sampling every 40 steps would miss the spike's top; the peak is read every step regardless.
    const sparse = simulate({ ...request, record: all, peaks: true, sampleEvery: 40 })
    expect(Array.from(sparse.peak!)).toEqual(Array.from(result.peak!))
  })

  it('records every compartment every few steps as a movie, the start included', () => {
    const { request } = buildCase(caseNamed('branched-hh-soma'))
    const count = request.model.tree.count
    const all = Int32Array.from({ length: count }, (_, i) => i)
    const every = 8
    const traced = simulate({ ...request, record: all, sampleEvery: every })
    const { frames } = simulate({ ...request, frames: every })
    expect(frames).toHaveLength(traced.t.length * count)
    // Frame f of compartment c is the trace sampled at the same step, in float32.
    for (const f of [0, 1, Math.floor(traced.t.length / 2), traced.t.length - 1]) {
      for (let c = 0; c < count; c++) {
        expect(frames![f * count + c]).toBeCloseTo(traced.v[c]![f]!, 4)
      }
    }
  })

  it('keeps each record site’s peak without `peaks`, read every step', () => {
    const { request } = buildCase(caseNamed('branched-hh-soma'))
    const all = Int32Array.from({ length: request.model.tree.count }, (_, i) => i)
    const full = simulate({ ...request, record: all, peaks: true })
    const sites = Int32Array.of(0, 3)
    const sparse = simulate({ ...request, record: sites, sampleEvery: 40 })
    expect(Array.from(sparse.recordPeak)).toEqual(Array.from(sites, (c) => full.peak![c]!))
  })

  it('times every upward crossing of a threshold within its step', () => {
    const { request } = buildCase(caseNamed('hh-point'))
    const dt = request.dt
    const result = simulate({ ...request, threshold: 0 })
    const v = result.v[0]!
    const expected: number[] = []
    for (let i = 1; i < v.length; i++) {
      if (v[i - 1]! < 0 && v[i]! >= 0)
        expected.push((i - 1 + -v[i - 1]! / (v[i]! - v[i - 1]!)) * dt)
    }
    expect(expected.length).toBeGreaterThan(1)
    expect(Array.from(result.spikes![0]!)).toEqual(expected)
  })

  it('reuses one model across runs and steps without either seeing the other', () => {
    const { request } = buildCase(caseNamed('branched-hh-soma'))
    const fresh = (dt: number) =>
      simulate({ ...buildCase({ ...caseNamed('branched-hh-soma'), dt }).request })
    const coarse = simulate({ ...request, dt: 0.05 })
    const fine = simulate(request)
    expect(maxDiff(coarse.v[0]!, fresh(0.05).v[0]!)).toBe(0)
    expect(maxDiff(fine.v[0]!, fresh(0.025).v[0]!)).toBe(0)
  })
})

describe('synapticInput', () => {
  it('shares a slot per kind and compartment, weights by count and orders by time', () => {
    const kinds = [
      { scheme: 'exp2syn' as const, tau1: 0.1, tau2: 10, eRev: 0 },
      { scheme: 'exp2syn' as const, tau1: 0.5, tau2: 20, eRev: -70 },
    ]
    const { synapses, events } = synapticInput(kinds, [
      { compartment: 4, kind: 0, count: 2, weight: 0.001, times: [3, 1] },
      { compartment: 4, kind: 0, count: 1, weight: 0.001, times: [1] },
      { compartment: 4, kind: 1, count: 1, weight: 0.002, times: [2] },
      { compartment: 9, kind: 0, count: 3, weight: 0.001, times: [1] },
    ])
    expect(Array.from(synapses.kindOf)).toEqual([0, 1, 0])
    expect(Array.from(synapses.compartment)).toEqual([4, 4, 9])
    expect(Array.from(events.time)).toEqual([1, 1, 1, 2, 3])
    // Ties keep the order the sites were listed in.
    expect(Array.from(events.slot)).toEqual([0, 0, 2, 1, 0])
    const weights = Array.from(events.weight, (w) => Math.round(w * 1e6))
    expect(weights).toEqual([2000, 1000, 3000, 2000, 2000])
  })

  it('refuses an event aimed at a slot the model does not have', () => {
    const { request } = buildCase(caseNamed('branched-passive'))
    expect(
      () =>
        new Simulation({
          ...request,
          events: {
            time: Float64Array.of(1),
            slot: Int32Array.of(99),
            weight: Float64Array.of(1e-3),
          },
        }),
    ).toThrow(/slot 99/)
  })
})

describe('gate shift', () => {
  it('moves a gate’s whole voltage dependence by its shift', () => {
    const shifted = compileChannel(
      { ...HH_NA, gates: HH_NA.gates.map((g) => ({ ...g, shift: -15 })) },
      6.3,
    )
    const plain = compileChannel(HH_NA, 6.3)
    for (const v of [-80, -60, -40, -20, 0]) {
      shifted.gates.forEach((gate, j) => {
        expect(gate.inf(v)).toBe(plain.gates[j]!.inf(v + 15))
        expect(gate.advance(0.3, v, 0.025)).toBe(plain.gates[j]!.advance(0.3, v + 15, 0.025))
      })
    }
  })
})

describe('Exp2Syn', () => {
  it('peaks at its weight, equal time constants included', () => {
    for (const [tau1, tau2] of [
      [0.1, 10],
      [1, 3],
      [2, 2],
    ] as const) {
      const k = exp2synNorm({ scheme: 'exp2syn', tau1, tau2, eRev: 0 })
      expect(Number.isFinite(k.factor)).toBe(true)
      let peak = 0
      for (let t = 0; t < 50; t += 0.001) {
        peak = Math.max(peak, k.factor * (Math.exp(-t / tau2) - Math.exp(-t / k.tau1)))
      }
      expect(peak).toBeCloseTo(1, 4)
    }
  })
})

describe('clamp shapes', () => {
  const { request } = buildCase(caseNamed('branched-passive'))
  const soma = request.record[1]!
  const run = (clamp: Omit<CurrentClamp, 'compartment'>) =>
    simulate({ ...request, events: undefined, clamps: [{ compartment: soma, ...clamp }] }).v[1]!
  const window = { delay: 5.01, duration: 20 }

  it('reads a step shape as the plain IClamp, and every shape as one where they agree', () => {
    const step = run({ ...window, amplitude: 0.02 })
    expect(maxDiff(run({ ...window, amplitude: 0.02, shape: { kind: 'step' } }), step)).toBe(0)
    // A ramp from its own end is flat; a sine at 0 Hz is its offset; pulses as wide as their
    // interval never switch off. Each the step, to the last bit of arithmetic.
    const ramp = run({ ...window, amplitude: 0.02, shape: { kind: 'ramp', from: 0.02 } })
    const sine = run({
      ...window,
      amplitude: 1,
      shape: { kind: 'sine', frequency: 0, offset: 0.02 },
    })
    const pulses = run({
      ...window,
      amplitude: 0.02,
      shape: { kind: 'pulses', width: 4, interval: 4 },
    })
    for (const shaped of [ramp, sine, pulses]) expect(maxDiff(shaped, step)).toBeLessThan(1e-12)
  })

  it('switches each pulse as a step clamp of its own would', () => {
    const pulses = run({
      ...window,
      amplitude: 0.02,
      shape: { kind: 'pulses', width: 1, interval: 5 },
    })
    const separate = simulate({
      ...request,
      events: undefined,
      clamps: [0, 1, 2, 3].map((k) => ({
        compartment: soma,
        delay: window.delay + 5 * k,
        duration: 1,
        amplitude: 0.02,
      })),
    }).v[1]!
    expect(maxDiff(pulses, separate)).toBeLessThan(1e-12)
  })
})
