/**
 * Ion channels as data.
 *
 * A model crosses to a worker, so a channel cannot be a closure: it is a description — gates with
 * an exponent and a named kinetic scheme — that `compileChannel` turns into rate functions on the
 * far side. The leak is a channel with no gates; the squid Hodgkin–Huxley sodium and potassium
 * currents are the first two with gates. Channels fitted to measurements (Boltzmann steady state,
 * bell-shaped τ) arrive as a second `GateKinetics` kind without the integrator changing.
 *
 * Units throughout: membrane potential in mV, time in ms, temperature in °C.
 */

/**
 * How a gate's opening depends on voltage. `hh` names one of the squid gates in NEURON's `hh.mod`,
 * transcribed below and evaluated directly, as `hh.mod` itself does since its lookup table was
 * commented out.
 */
export type GateKinetics =
  | { readonly kind: 'hh'; readonly gate: 'm' | 'h' | 'n' }
  /**
   * Pospischil et al. 2008's Traub-style gates, as Jaxley implements them (`jaxley.channels.
   * pospischil`, `vt` = −60 mV): what Vieira et al. 2026's Fig. 1 calls "the default active sodium
   * and potassium conductances implemented in Jaxley". No temperature dependence.
   */
  | { readonly kind: 'pospischil'; readonly gate: 'm' | 'h' | 'n' }

/**
 * Whether a gate opens with depolarisation (`activation`) or closes with it (`inactivation`) —
 * which of a channel's gates a "ΔV50 activation" or "ΔV50 inactivation" shift moves. Read off the
 * steady state's slope rather than the gate's name, so a fitted kinetics kind needs no naming rule.
 */
/**
 * A gate's letter in a channel's gating formula (`m³h`). Asked of the kinetics kind, so a kind that
 * names no gates says what it is by role rather than borrowing another kind's letters.
 */
export function gateSymbol(kinetics: GateKinetics): string {
  switch (kinetics.kind) {
    case 'hh':
    case 'pospischil':
      return kinetics.gate
  }
}

function gateRole(kinetics: GateKinetics): 'activation' | 'inactivation' {
  const { inf } = compileKinetics(kinetics, 1)
  return inf(0) >= inf(-80) ? 'activation' : 'inactivation'
}

export interface GateSpec {
  /** The exponent: `m³h` is `m` at 3 and `h` at 1. */
  readonly power: number
  readonly kinetics: GateKinetics
  /**
   * mV the gate's whole voltage dependence is moved by — steady state and time constant alike,
   * read at `v − shift`. Positive moves it depolarised. The "−15 mV inactivation shift" is −15 on
   * the inactivation gate. Any kinetics kind takes it, so a shift is never a property of the scheme.
   */
  readonly shift?: number
}

export interface ChannelSpec {
  readonly id: string
  /** Reversal potential, mV. */
  readonly eRev: number
  readonly gates: readonly GateSpec[]
  /**
   * Rates scale by `q10^((T − temperature) / 10)`. Absent for a channel with no gates, or one
   * whose kinetics were not given a temperature.
   */
  readonly q10?: { readonly q10: number; readonly temperature: number }
}

/** A channel with every activation gate moved by `activation` mV and every inactivation gate by `inactivation`. */
export function shiftedChannel(
  spec: ChannelSpec,
  shift: { readonly activation?: number; readonly inactivation?: number },
): ChannelSpec {
  const by = (gate: GateSpec) => shift[gateRole(gate.kinetics)] ?? 0
  if (spec.gates.every((gate) => by(gate) === 0)) return spec
  return {
    ...spec,
    gates: spec.gates.map((gate) => ({ ...gate, shift: (gate.shift ?? 0) + by(gate) })),
  }
}

/** A passive leak: a conductance with no gates. Its reversal is the model's resting potential. */
export function leakChannel(eRev: number): ChannelSpec {
  return { id: 'leak', eRev, gates: [] }
}

/** The temperature the squid axon was recorded at, °C — what `hh.mod`'s rates are fitted for. */
export const HH_TEMPERATURE = 6.3

/** `hh.mod`'s temperature dependence: Q10 of 3 about that temperature. */
const HH_Q10 = { q10: 3, temperature: HH_TEMPERATURE } as const

/** Squid fast sodium, `gna = gnabar·m³h`, ENa 50 mV as in `hh.mod`. */
export const HH_NA: ChannelSpec = {
  id: 'hh.na',
  eRev: 50,
  gates: [
    { power: 3, kinetics: { kind: 'hh', gate: 'm' } },
    { power: 1, kinetics: { kind: 'hh', gate: 'h' } },
  ],
  q10: HH_Q10,
}

/** Squid delayed rectifier, `gk = gkbar·n⁴`, EK −77 mV as in `hh.mod`. */
export const HH_K: ChannelSpec = {
  id: 'hh.k',
  eRev: -77,
  gates: [{ power: 4, kinetics: { kind: 'hh', gate: 'n' } }],
  q10: HH_Q10,
}

/**
 * A channel's density per compartment from the compartments' regions: `density` (S/cm²) where
 * the region is one of `regions`, zero elsewhere — or everywhere, unlabelled cable included,
 * where `regions` is empty. How a channel is placed by region.
 */
export function densityByRegion(
  region: ArrayLike<number>,
  regions: readonly number[],
  density: number,
): Float64Array {
  if (regions.length === 0) return new Float64Array(region.length).fill(density)
  return Float64Array.from(region, (r) => (regions.includes(r) ? density : 0))
}

/** Pospischil et al. 2008 / Jaxley fast sodium, `gNa·m³h`, ENa 50 mV. */
export const POSPISCHIL_NA: ChannelSpec = {
  id: 'pospischil.na',
  eRev: 50,
  gates: [
    { power: 3, kinetics: { kind: 'pospischil', gate: 'm' } },
    { power: 1, kinetics: { kind: 'pospischil', gate: 'h' } },
  ],
}

/** Pospischil et al. 2008 / Jaxley delayed rectifier, `gK·n⁴`, EK −90 mV. */
export const POSPISCHIL_K: ChannelSpec = {
  id: 'pospischil.k',
  eRev: -90,
  gates: [{ power: 4, kinetics: { kind: 'pospischil', gate: 'n' } }],
}

/**
 * Every gated channel a model may name, by `ChannelSpec.id` — the library fitted channels join.
 * The leak is not in it: its reversal is a model's, so it is built per model by `leakChannel`.
 */
const LIBRARY: ReadonlyMap<string, ChannelSpec> = new Map(
  [HH_NA, HH_K, POSPISCHIL_NA, POSPISCHIL_K].map((c) => [c.id, c]),
)

/** A library channel by id, or undefined — for a reader that must not throw (a param's `visibleIf`). */
export function findChannel(id: string): ChannelSpec | undefined {
  return LIBRARY.get(id)
}

/** Every channel in the library, in its order: what the editor offers. */
export function libraryChannels(): readonly ChannelSpec[] {
  return [...LIBRARY.values()]
}

export function channelById(id: string): ChannelSpec {
  const spec = LIBRARY.get(id)
  if (!spec) throw new Error(`This build has no channel called ${id}.`)
  return spec
}

/** `hh.mod`'s densities, S/cm². Its own leak (0.0003, −54.3 mV) is the model's leak here. */
export const HH_GBAR = { na: 0.12, k: 0.036 } as const

/** `hh.mod`'s `vtrap`: `x / (exp(x/y) − 1)`, which is `y · efun(x/y)` — one singularity fill. */
function vtrap(x: number, y: number): number {
  return y * efun(x / y)
}

/** `hh.mod`'s opening and closing rates per gate, ms⁻¹ at 6.3 °C. */
const HH_RATES: Record<'m' | 'h' | 'n', { alpha(v: number): number; beta(v: number): number }> =
  {
    m: { alpha: (v) => 0.1 * vtrap(-(v + 40), 10), beta: (v) => 4 * Math.exp(-(v + 65) / 18) },
    h: {
      alpha: (v) => 0.07 * Math.exp(-(v + 65) / 20),
      beta: (v) => 1 / (Math.exp(-(v + 35) / 10) + 1),
    },
    n: {
      alpha: (v) => 0.01 * vtrap(-(v + 55), 10),
      beta: (v) => 0.125 * Math.exp(-(v + 65) / 80),
    },
  }

/** Jaxley's spike threshold offset for the Pospischil gates, mV (`vt`, a global parameter there). */
const POSPISCHIL_VT = -60

/** Jaxley's `efun`: `x / (exp(x) − 1)`, the removable singularity at 0 filled in. */
function efun(x: number): number {
  return Math.abs(x) < 1e-6 ? 1 - x / 2 : x / (Math.exp(x) - 1)
}

/** Jaxley's Pospischil rates per gate, ms⁻¹ (`pospischil.py`'s `m_gate`, `h_gate`, `n_gate`). */
const POSPISCHIL_RATES: Record<
  'm' | 'h' | 'n',
  { alpha(v: number): number; beta(v: number): number }
> = {
  m: {
    alpha: (v) => (0.32 * efun(-0.25 * (v - POSPISCHIL_VT - 13))) / 0.25,
    beta: (v) => (0.28 * efun(0.2 * (v - POSPISCHIL_VT - 40))) / 0.2,
  },
  h: {
    alpha: (v) => 0.128 * Math.exp(-(v - POSPISCHIL_VT - 17) / 18),
    beta: (v) => 4 / (Math.exp(-(v - POSPISCHIL_VT - 40) / 5) + 1),
  },
  n: {
    alpha: (v) => (0.032 * efun(-0.2 * (v - POSPISCHIL_VT - 15))) / 0.2,
    beta: (v) => 0.5 * Math.exp(-(v - POSPISCHIL_VT - 10) / 40),
  },
}

/** A gate bound to a temperature: its steady state, and one exponential-Euler step. */
export interface CompiledGate {
  readonly power: number
  inf(v: number): number
  /**
   * `x` after `dt` ms at voltage `v`: `x + (1 − e^{−dt/τ})(x∞ − x)`. One call evaluates the rates
   * once — the integrator's innermost loop — where separate `inf` and `tau` would evaluate them
   * twice.
   */
  advance(x: number, v: number, dt: number): number
}

/** A channel ready to integrate. */
export interface CompiledChannel {
  readonly spec: ChannelSpec
  readonly gates: readonly CompiledGate[]
}

function compileGate(gate: GateSpec, phi: number): CompiledGate {
  const unshifted = compileKinetics(gate.kinetics, phi)
  const shift = gate.shift ?? 0
  if (shift === 0) return { power: gate.power, ...unshifted }
  return {
    power: gate.power,
    inf: (v) => unshifted.inf(v - shift),
    advance: (x, v, dt) => unshifted.advance(x, v - shift, dt),
  }
}

function compileKinetics(kinetics: GateKinetics, phi: number): Omit<CompiledGate, 'power'> {
  switch (kinetics.kind) {
    case 'hh':
    case 'pospischil': {
      // x∞ = α/(α+β) and τ = 1/(φ(α+β)): hh.mod multiplies α + β by the temperature factor, and a
      // Pospischil channel carries no Q10, so φ is 1 for it.
      const { alpha, beta } = (kinetics.kind === 'hh' ? HH_RATES : POSPISCHIL_RATES)[
        kinetics.gate
      ]
      return {
        inf: (v) => {
          const a = alpha(v)
          return a / (a + beta(v))
        },
        advance: (x, v, dt) => {
          const a = alpha(v)
          const sum = a + beta(v)
          return x + (1 - Math.exp(-dt * phi * sum)) * (a / sum - x)
        },
      }
    }
  }
}

/**
 * Bind a channel's gates to a temperature. The factor speeds every gate's kinetics and leaves
 * the steady states alone. Exponents must be whole numbers — every scheme here is `m^p h^q` —
 * which lets the integrator multiply rather than call `**`.
 */
export function compileChannel(spec: ChannelSpec, temperature: number): CompiledChannel {
  const phi = spec.q10 ? spec.q10.q10 ** ((temperature - spec.q10.temperature) / 10) : 1
  for (const g of spec.gates) {
    if (!Number.isInteger(g.power) || g.power < 1) {
      throw new Error(`Channel ${spec.id} has a gate exponent that is not a positive integer.`)
    }
  }
  return { spec, gates: spec.gates.map((g) => compileGate(g, phi)) }
}
