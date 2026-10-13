/**
 * Cases run by both this solver and NEURON.
 *
 * A case is a cable tree plus everything that drives it, written once here. `buildCase` turns it
 * into a compartment tree and a `SimulationRequest`; `neuronExport` turns it into what `scripts/biophys_neuron.py` builds a
 * NEURON model from — **our** sections, segment counts and densities, so NEURON is handed the
 * discretisation rather than re-deriving it (its own d_lambda count is computed there and checked
 * against ours). `scripts/biophys-reference.py` runs the synthetic cases below and writes
 * `__fixtures__/neuron-reference.json`, which `solver.test.ts` compares against; the probe runs a
 * real skeleton through the same two halves.
 */

import { HH_GBAR, HH_K, HH_NA, densityByRegion, leakChannel } from './channels'
import type { CableTree, CompartmentTree, SegmentRule } from './discretize'
import { discretize } from './discretize'
import type { CellModel, ChannelPlacement, SimulationRequest, SynapseKind } from './solver'
import { synapticInput } from './solver'

/** One synaptic site: a skeleton node, how many synapses it holds, and when they fire (ms). */
export interface CaseSynapse {
  readonly node: number
  readonly count: number
  readonly times: readonly number[]
}

export interface ReferenceCase {
  readonly name: string
  readonly tree: {
    readonly positions: readonly number[]
    readonly radii: readonly number[]
    readonly parent: readonly number[]
    readonly labels?: readonly number[]
    /** `CableTree.startRadius`: where a section begins at a radius of its own. */
    readonly startRadius?: readonly number[]
  }
  readonly rule: SegmentRule
  /** Ω·cm */
  readonly ra: number
  /** µF/cm² */
  readonly cm: number
  /** Leak conductance, S/cm², and its reversal, mV. */
  readonly gLeak: number
  readonly eLeak: number
  /** Squid HH where the region label is one of these; densities in S/cm². */
  readonly hh?: {
    readonly regions: readonly number[]
    readonly gna: number
    readonly gk: number
  }
  readonly temperature: number
  readonly vInit: number
  readonly synapse?: SynapseKind & { readonly gmax: number }
  readonly synapses?: readonly CaseSynapse[]
  readonly clamps?: readonly {
    readonly node: number
    readonly delay: number
    readonly duration: number
    readonly amplitude: number
  }[]
  readonly record: readonly number[]
  readonly dt: number
  readonly duration: number
}

/** A case by name; throws on a typo rather than handing a test `undefined`. */
export function caseNamed(name: string): ReferenceCase {
  const c = REFERENCE_CASES.find((r) => r.name === name)
  if (!c) throw new Error(`No reference case named ${name}.`)
  return c
}

/** A case's tree, or any plain one, as the typed arrays `discretize` takes. */
export function caseTree(c: Pick<ReferenceCase, 'tree'>): CableTree {
  return {
    positions: Float64Array.from(c.tree.positions),
    radii: Float64Array.from(c.tree.radii),
    parent: Int32Array.from(c.tree.parent),
    // Int32, not Uint8: `discretize` refuses a label outside 0–255 rather than seeing it wrapped.
    ...(c.tree.labels ? { labels: Int32Array.from(c.tree.labels) } : {}),
    ...(c.tree.startRadius ? { startRadius: Float64Array.from(c.tree.startRadius) } : {}),
  }
}

/** Nodes along x at the given positions (µm) with the given radii: an unbranched cable. */
export function straightCable(
  xs: readonly number[],
  radii: readonly number[],
  labels?: readonly number[],
): CableTree {
  return caseTree({
    tree: {
      positions: xs.flatMap((x) => [x, 0, 0]),
      radii,
      parent: xs.map((_, i) => i - 1),
      ...(labels ? { labels } : {}),
    },
  })
}

/** Cut a tree into compartments no longer than `length` µm; the tests' default Ra and cm. */
export function cutMaxLength(
  tree: CableTree,
  length: number,
  ra = 100,
  cm = 1,
): CompartmentTree {
  return discretize(tree, { rule: { kind: 'maxLength', length }, ra, cm })
}

/** The densities a case puts in each compartment, one placement per channel. */
function caseChannels(c: ReferenceCase, tree: CompartmentTree): ChannelPlacement[] {
  const leak: ChannelPlacement = {
    spec: leakChannel(c.eLeak),
    gbar: new Float64Array(tree.count).fill(c.gLeak),
  }
  if (!c.hh) return [leak]
  const { regions, gna, gk } = c.hh
  return [
    leak,
    { spec: HH_NA, gbar: densityByRegion(tree.region, regions, gna) },
    { spec: HH_K, gbar: densityByRegion(tree.region, regions, gk) },
  ]
}

export function buildCase(c: ReferenceCase): {
  tree: CompartmentTree
  request: SimulationRequest
} {
  const tree = discretize(caseTree(c), { rule: c.rule, ra: c.ra, cm: c.cm })
  const { synapse } = c
  const { synapses, events } = synapticInput(
    synapse ? [synapse] : [],
    synapse
      ? (c.synapses ?? []).map((site) => ({
          compartment: tree.nodeCompartment[site.node]!,
          kind: 0,
          count: site.count,
          weight: synapse.gmax,
          times: site.times,
        }))
      : [],
  )
  const model: CellModel = {
    tree,
    cm: new Float64Array(tree.count).fill(c.cm),
    channels: caseChannels(c, tree),
    temperature: c.temperature,
    synapses,
  }
  const request: SimulationRequest = {
    model,
    dt: c.dt,
    duration: c.duration,
    initial: { v: c.vInit },
    events,
    clamps: (c.clamps ?? []).map((k) => ({
      compartment: tree.nodeCompartment[k.node]!,
      delay: k.delay,
      duration: k.duration,
      amplitude: k.amplitude,
    })),
    record: Int32Array.from(c.record, (node) => tree.nodeCompartment[node]!),
  }
  return { tree, request }
}

/**
 * The case as NEURON should build it: sections as lists of skeleton nodes with our `nseg`, each
 * node's `x` along its section, the radius a section starts at where it starts at its own, and the
 * HH densities per segment. Takes the tree when the caller has already built it — a real skeleton
 * is not discretised twice.
 */
export function neuronExport(c: ReferenceCase, tree: CompartmentTree = buildCase(c).tree) {
  const channels = caseChannels(c, tree)
  const na = channels.find((p) => p.spec === HH_NA)
  const k = channels.find((p) => p.spec === HH_K)
  // The first section hung from the root is NEURON's root section; the root is its 0 end, and
  // every other section from the root hangs from that end too.
  const rootSection = tree.sections.findIndex((s) => s.parentSection < 0)
  const location = Array.from(c.tree.parent, (_, node) => {
    const section = tree.nodeSection[node]!
    return section < 0
      ? { section: rootSection, x: 0 }
      : { section, x: tree.sections[section]!.x[tree.nodeIndex[node]!]! }
  })
  const sections = tree.sections.map((s, i) => {
    const start = c.tree.startRadius?.[s.nodes[1]!]
    return {
      nodes: Array.from(s.nodes),
      nseg: s.nseg,
      ...(start !== undefined && start > 0 ? { startDiameter: 2 * start } : {}),
      parent: s.parentSection < 0 ? (i === rootSection ? -1 : rootSection) : s.parentSection,
      parentX: s.parentSection < 0 ? 0 : 1,
      hh:
        na && k
          ? Array.from({ length: s.nseg }, (_, n) => ({
              gna: na.gbar[s.first + n]!,
              gk: k.gbar[s.first + n]!,
            }))
          : undefined,
    }
  })
  return { ...c, sections, location }
}

/* ------------------------------------------------------------------------------------------
 * The synthetic cases.
 * ---------------------------------------------------------------------------------------- */

/** A small arbour: a 6 µm soma, a root that branches, a tapering neurite, a fork of a fork. */
function branchedTree(): ReferenceCase['tree'] {
  const positions: number[] = []
  const radii: number[] = []
  const parent: number[] = []
  const labels: number[] = []
  const add = (x: number, y: number, z: number, r: number, p: number, label: number) => {
    positions.push(x, y, z)
    radii.push(r)
    parent.push(p)
    labels.push(label)
    return radii.length - 1
  }
  const root = add(0, 0, 0, 3, -1, 1)
  const soma = add(6, 0, 0, 3, root, 1)
  // Primary neurite, tapering 1.0 → 0.6 µm over 60 µm, gently curved.
  let v = soma
  for (let i = 1; i <= 6; i++)
    v = add(6 + 10 * i, 2 * Math.sin(i / 2), 0, 1 - 0.4 * (i / 6), v, 3)
  const fork = v
  // Long branch, 0.5 → 0.2 µm.
  v = fork
  for (let i = 1; i <= 8; i++)
    v = add(66 + 12 * i, 15 * Math.sin(i / 4), 3 * i, 0.5 - 0.3 * (i / 8), v, 3)
  // Short branch that forks again.
  v = fork
  for (let i = 1; i <= 4; i++) v = add(66 + 5 * i, -20 * i, 0, 0.4, v, 3)
  const fork2 = v
  v = fork2
  for (let i = 1; i <= 4; i++) v = add(86 + 10 * i, -80 - 3 * i, 2 * i, 0.25, v, 3)
  v = fork2
  for (let i = 1; i <= 4; i++) v = add(86 - 4 * i, -80 - 10 * i, -2 * i, 0.25, v, 3)
  // A second process from the root, so the root is a branch point too.
  v = root
  for (let i = 1; i <= 3; i++) v = add(-10 * i, 0, 1, 0.8, v, 2)
  return { positions, radii, parent, labels }
}

const BRANCHED = branchedTree()
/** Nodes the branched cases stimulate and record at, by role, so tests can name them. */
export const BRANCHED_NODES = {
  root: 0,
  soma: 1,
  fork: 7,
  longTip: 15,
  fork2: 19,
  twigA: 23,
  twigB: 27,
  stub: 30,
} as const

/**
 * One isopotential compartment of the squid model — 20 µm long, 20 µm across, hh.mod's leak and
 * densities — stepped at a current density in µA/cm².
 */
export function hhPoint(name: string, temperature: number, uAPerCm2: number): ReferenceCase {
  const areaCm2 = Math.PI * 20 * 20 * 1e-8
  return {
    name,
    tree: { positions: [0, 0, 0, 20, 0, 0], radii: [10, 10], parent: [-1, 0], labels: [1, 1] },
    rule: { kind: 'maxLength', length: 100 },
    ra: 35.4,
    cm: 1,
    gLeak: 0.0003,
    eLeak: -54.3,
    hh: { regions: [1], gna: HH_GBAR.na, gk: HH_GBAR.k },
    temperature,
    vInit: -65,
    // µA/cm² × cm² is µA; ×1e3 is nA.
    clamps: [{ node: 1, delay: 5, duration: 40, amplitude: uAPerCm2 * areaCm2 * 1e3 }],
    record: [1],
    dt: 0.025,
    duration: 50,
  }
}

/**
 * A soma meeting two thin fibres: a 2.6 µm sphere as an equal-area cylinder (2.6 µm long, 1.3 µm
 * radius), whose end is a branch point where 0.2 and 0.15 µm fibres begin at their own radius.
 * Without `startRadius` each fibre's first piece would be a cone from 1.3 µm down, and with a
 * coincident duplicate node instead a shoulder of π(r₀² − r₁²) — a quarter of the soma's area.
 */
function somaStepTree(): ReferenceCase['tree'] {
  const positions = [0, 0, 0, 2.6, 0, 0]
  const radii = [1.3, 1.3]
  const parent = [-1, 0]
  const labels = [1, 1]
  const startRadius = [NaN, NaN]
  for (const [dx, dy, r] of [
    [10, 0, 0.2],
    [0, 8, 0.15],
  ] as const) {
    let p = 1
    for (let i = 1; i <= 5; i++) {
      positions.push(2.6 + dx * i, dy * i, 0)
      radii.push(r)
      parent.push(p)
      labels.push(3)
      startRadius.push(i === 1 ? r : NaN)
      p = radii.length - 1
    }
  }
  return { positions, radii, parent, labels, startRadius }
}

export const SOMA_STEP_NODES = { root: 0, soma: 1, tipA: 6, tipB: 11 } as const

/**
 * The Compartment Model's soma since the third audit: a cylinder centred on its node, laid along
 * the first fibre, with every fibre wired to the centre (NEURON's soma(0.5)) — here one fibre along
 * the soma's axis and one at right angles to it, each starting at its own radius.
 */
function somaCentreTree(): ReferenceCase['tree'] {
  const positions = [-1.3, 0, 0, 0, 0, 0, 1.3, 0, 0]
  const radii = [1.3, 1.3, 1.3]
  const parent = [-1, 0, 1]
  const labels = [1, 1, 1]
  const startRadius = [NaN, NaN, NaN]
  for (const [dx, dy, r] of [
    [10, 0, 0.2],
    [0, 8, 0.15],
  ] as const) {
    let p = 1
    for (let i = 1; i <= 5; i++) {
      positions.push(dx * i, dy * i, 0)
      radii.push(r)
      parent.push(p)
      labels.push(3)
      startRadius.push(i === 1 ? r : NaN)
      p = radii.length - 1
    }
  }
  return { positions, radii, parent, labels, startRadius }
}

const SOMA_CENTRE_NODES = { start: 0, centre: 1, tipA: 7, tipB: 12 } as const

const FLY_PASSIVE = { ra: 266.1, cm: 0.8, gLeak: 1 / 20_800, eLeak: -60 } as const

export const REFERENCE_CASES: readonly ReferenceCase[] = [
  hhPoint('hh-point', 6.3, 10),
  hhPoint('hh-point-warm', 16.3, 20),
  {
    // A radius step at a junction: the fibres start thin, as NEURON sections may.
    name: 'soma-step',
    tree: somaStepTree(),
    rule: { kind: 'maxLength', length: 5 },
    ra: 266.1,
    cm: 0.8,
    gLeak: 1 / 20_800,
    eLeak: -60,
    temperature: 22,
    vInit: -60,
    synapse: { scheme: 'exp2syn', tau1: 0.1, tau2: 10, eRev: 0, gmax: 0.0005 },
    synapses: [{ node: SOMA_STEP_NODES.tipA, count: 2, times: [5] }],
    clamps: [{ node: SOMA_STEP_NODES.soma, delay: 15, duration: 5, amplitude: 0.01 }],
    record: [
      SOMA_STEP_NODES.root,
      SOMA_STEP_NODES.soma,
      SOMA_STEP_NODES.tipA,
      SOMA_STEP_NODES.tipB,
    ],
    dt: 0.025,
    duration: 30,
  },
  {
    // Passive, fly constants, d_lambda: synapses with counts, a clamp at a tip.
    name: 'branched-passive',
    tree: BRANCHED,
    rule: { kind: 'dLambda', dLambda: 0.1, frequency: 100 },
    ...FLY_PASSIVE,
    temperature: 22,
    vInit: -60,
    synapse: { scheme: 'exp2syn', tau1: 0.1, tau2: 10, eRev: 0, gmax: 0.0005 },
    synapses: [
      { node: BRANCHED_NODES.longTip, count: 3, times: [5, 7.5] },
      { node: 12, count: 1, times: [10] },
      // Two sites close together. No event sits exactly on a half step: NEURON accumulates `t`,
      // so whether it delivers one there or a step later depends on how the sum rounded.
      { node: BRANCHED_NODES.twigA, count: 2, times: [12.01, 12.5, 30] },
      { node: 21, count: 1, times: [12.5] },
    ],
    clamps: [{ node: BRANCHED_NODES.twigB, delay: 20, duration: 5, amplitude: 0.02 }],
    record: [
      BRANCHED_NODES.root,
      BRANCHED_NODES.soma,
      BRANCHED_NODES.fork,
      BRANCHED_NODES.longTip,
      BRANCHED_NODES.twigA,
      BRANCHED_NODES.stub,
    ],
    dt: 0.025,
    duration: 40,
  },
  {
    // The same arbour, HH at the soma and axon at room temperature, cut by a fixed length, spiking.
    name: 'branched-hh-soma',
    tree: BRANCHED,
    rule: { kind: 'maxLength', length: 5 },
    ...FLY_PASSIVE,
    // The soma and the axon stub (region 2): a soma compartment alone cannot drive the arbour.
    hh: { regions: [1, 2], gna: HH_GBAR.na, gk: HH_GBAR.k },
    temperature: 22,
    vInit: -65,
    synapse: { scheme: 'exp2syn', tau1: 0.1, tau2: 10, eRev: 0, gmax: 0.002 },
    synapses: [
      { node: 10, count: 5, times: [5, 5.5, 6] },
      { node: BRANCHED_NODES.fork2, count: 4, times: [6] },
    ],
    clamps: [{ node: BRANCHED_NODES.soma, delay: 15, duration: 10, amplitude: 0.2 }],
    record: [BRANCHED_NODES.soma, BRANCHED_NODES.fork, BRANCHED_NODES.twigA],
    dt: 0.025,
    duration: 40,
  },
  {
    // The soma as the model now builds it: fibres wired to its centre, one leaving at right angles.
    name: 'soma-centre',
    tree: somaCentreTree(),
    rule: { kind: 'dLambda', dLambda: 0.1, frequency: 100 },
    ...FLY_PASSIVE,
    temperature: 22,
    vInit: -60,
    synapse: { scheme: 'exp2syn', tau1: 0.1, tau2: 10, eRev: 0, gmax: 0.0005 },
    synapses: [{ node: SOMA_CENTRE_NODES.tipB, count: 2, times: [5] }],
    clamps: [{ node: SOMA_CENTRE_NODES.centre, delay: 15, duration: 5, amplitude: 0.01 }],
    record: [
      SOMA_CENTRE_NODES.start,
      SOMA_CENTRE_NODES.centre,
      SOMA_CENTRE_NODES.tipA,
      SOMA_CENTRE_NODES.tipB,
    ],
    dt: 0.025,
    duration: 30,
  },
  // Two nodes at one point with different radii: the annulus between them is membrane, and the
  // answer must not depend on where the segment cuts fall — one compartment, then seven.
  duplicateNode('duplicate-node-nseg1', 20),
  duplicateNode('duplicate-node-nseg7', 3),
  // The same pair at a section's start, at its end, and with a segment cut on it (nseg 3 over
  // 30 µm puts a cut at 10): NEURON gives a cut's annulus to the segment that ends there.
  duplicateNode('duplicate-node-root', 20, [0, 0, 10], [1, 0.3, 0.3]),
  duplicateNode('duplicate-node-tip', 20, [0, 10, 10], [1, 1, 0.3]),
  duplicateNode('duplicate-node-cut', 10, [0, 10, 10, 30], [1, 1, 0.3, 0.3]),
  {
    // At a branch point: the parent section ends on a pair (1, 2), and one child starts on a node
    // (3) coincident with the branch.
    ...duplicateNode('duplicate-node-branch', 5),
    tree: {
      positions: [
        [0, 0],
        [10, 0],
        [10, 0],
        [10, 0],
        [20, 0],
        [10, 10],
      ].flatMap(([x, y]) => [x!, y!, 0]),
      radii: [1, 1, 0.6, 0.3, 0.3, 0.5],
      parent: [-1, 0, 1, 2, 3, 2],
    },
    record: [0, 4, 5],
  },
]

/**
 * A straight cable with a duplicated node somewhere along it, clamped at the root: by default 1 µm
 * then 0.3 µm in radius, the step the pair at 10 µm.
 */
function duplicateNode(
  name: string,
  maxLength: number,
  xs: readonly number[] = [0, 10, 10, 20],
  radii: readonly number[] = [1, 1, 0.3, 0.3],
): ReferenceCase {
  return {
    name,
    tree: {
      positions: xs.flatMap((x) => [x, 0, 0]),
      radii,
      parent: xs.map((_, i) => i - 1),
    },
    rule: { kind: 'maxLength', length: maxLength },
    ...FLY_PASSIVE,
    temperature: 22,
    vInit: -60,
    // Small, so the deflection stays physiological: a large one into a few µm² of membrane runs
    // to thousands of mV, where float rounding alone passes the fixture's tolerance.
    clamps: [{ node: 0, delay: 2, duration: 10, amplitude: 0.001 }],
    record: [0, xs.length - 1],
    dt: 0.025,
    duration: 15,
  }
}
