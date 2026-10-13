/**
 * A compartment model as the solver takes it: the one bridge from `CellModelValue` to
 * `src/biophys`. Its own module so the Simulate worker imports this and the solver, and none of
 * the geometry `build.ts` needs to make a model in the first place.
 *
 * **One solver model per value, events per run.** The solver prepares a model once and reuses the
 * preparation for every run of that same object (`solver.ts`), and a settled state belongs to it
 * too — so a value's `CellModel`, slots included, is built once and kept beside the value. What
 * changes between Phase 2's runs, one per partner, is only which partner fires: `eventsFor`.
 */

import type { CellModelValue } from '../../core/values'
import { csr } from '../../core/stats'
import {
  HH_TEMPERATURE,
  channelById,
  densityByRegion,
  shiftedChannel,
  leakChannel,
} from '../../biophys/channels'
import type { CellModel, ChannelPlacement, SynapticEvents } from '../../biophys/solver'
import { synapseSlots } from '../../biophys/solver'

/**
 * What the solver needs of a model: everything but the skeleton it was built from, its notes, the
 * node mapping and where each compartment is — the parts a worker never reads, the skeleton alone
 * ~6 MB at 300k nodes. A full `CellModelValue` is one, so the main thread passes the value itself.
 */
export type SolverModelValue = Omit<
  CellModelValue,
  'skeleton' | 'notes' | 'nodeCompartment' | 'sites' | 'compartments'
> & { readonly compartments: Omit<CellModelValue['compartments'], 'position'> }

/** A value with just the solver's part — what a Simulate job carries to its worker. */
export function solverPart(value: CellModelValue): SolverModelValue {
  // One per value, so a job planned twice from it — a Run, then Playback's replay — meets the
  // solver's per-value caches (`solvable`) on the page's own thread rather than missing them.
  const hit = PARTS.get(value)
  if (hit) return hit
  const part = solverPartOf(value)
  PARTS.set(value, part)
  return part
}

const PARTS = new WeakMap<CellModelValue, SolverModelValue>()

function solverPartOf(value: CellModelValue): SolverModelValue {
  const {
    skeleton: _skeleton,
    notes: _notes,
    nodeCompartment: _nodes,
    sites: _sites,
    ...part
  } = value
  const { position: _position, ...compartments } = value.compartments
  return { ...part, compartments }
}

interface Solvable {
  readonly model: CellModel
  /** Per synapse, its slot. */
  readonly slotOf: Int32Array
  /** Each partner's synapses, as compressed rows: partner `p`'s are `bySynapse[start[p]..start[p+1])`. */
  readonly start: Int32Array
  readonly bySynapse: Int32Array
  /** Per synapse, its type's peak conductance (µS) and delay (ms). */
  readonly gmax: Float64Array
  readonly delay: Float64Array
}

const SOLVABLE = new WeakMap<SolverModelValue, Solvable>()

function solvable(value: SolverModelValue): Solvable {
  const hit = SOLVABLE.get(value)
  if (hit) return hit
  const { compartments: k, membrane, regionNames: names } = value
  const channels: ChannelPlacement[] = [
    {
      spec: leakChannel(membrane.eLeak),
      gbar: new Float64Array(k.count).fill(1 / membrane.rm),
    },
  ]
  for (const { id, regions, density, shift } of value.channels) {
    const codes = regions.map((region) => {
      const code = names.indexOf(region)
      if (code < 0)
        throw new Error(`Channel ${id} names a region the model has none of: ${region}.`)
      return code
    })
    const spec = shiftedChannel(channelById(id), shift ?? {})
    channels.push({ spec, gbar: densityByRegion(k.region, codes, density) })
  }
  const { synapses, slotOf } = synapseSlots(
    value.synapseTypes,
    Array.from(value.synapses.compartment, (compartment, s) => ({
      compartment,
      kind: value.synapses.type[s]!,
    })),
  )
  // Partner → synapses, so a run touches only the partners that fire.
  const { type } = value.synapses
  const { start, list: bySynapse } = csr(value.partners.id.length, value.synapses.partner)
  const built = {
    model: {
      tree: k,
      cm: new Float64Array(k.count).fill(membrane.cm),
      channels,
      // A passive cable does not depend on temperature, so a passive model stores none; any
      // value runs it the same.
      temperature: value.temperature ?? HH_TEMPERATURE,
      synapses,
    },
    slotOf,
    start,
    bySynapse,
    gmax: Float64Array.from(type, (t) => value.synapseTypes[t]!.gmax),
    delay: Float64Array.from(type, (t) => value.synapseTypes[t]!.delay),
  }
  SOLVABLE.set(value, built)
  return built
}

/** The solver's model for a value: the same object every time, so its preparation is shared. */
export function cellModelOf(value: SolverModelValue): CellModel {
  return solvable(value).model
}

/** The compartments partner `p`'s synapses sit on, each once, in synapse order. */
export function partnerCompartments(value: SolverModelValue, p: number): Int32Array {
  const { start, bySynapse } = solvable(value)
  const seen = new Set<number>()
  for (let k = start[p]!; k < start[p + 1]!; k++)
    seen.add(value.synapses.compartment[bySynapse[k]!]!)
  return Int32Array.from(seen)
}

/** Per partner, its synapses' delays, ms: the shortest, the longest, and each one there is. */
export interface PartnerDelays {
  /** When its spike first reaches it; NaN for a partner with no synapses, which no build makes. */
  readonly min: Float64Array
  /** When its spike last reaches it. */
  readonly max: Float64Array
  /** Every distinct delay, ascending: one arrival each, for Playback's ticks. */
  readonly each: readonly (readonly number[])[]
}

/**
 * Keyed on the synapse table, which a value and its `solverPart` share: one pass per model however
 * many places ask — the plan, the cut, the summary, the table, the ticks, the note.
 */
const DELAYS = new WeakMap<object, PartnerDelays>()

export function partnerDelays(
  value: Pick<SolverModelValue, 'synapses' | 'synapseTypes' | 'partners'>,
): PartnerDelays {
  const hit = DELAYS.get(value.synapses)
  if (hit) return hit
  const n = value.partners.id.length
  const min = new Float64Array(n).fill(NaN)
  const max = new Float64Array(n).fill(NaN)
  const sets = Array.from({ length: n }, () => new Set<number>())
  value.synapses.partner.forEach((p, s) => {
    const d = value.synapseTypes[value.synapses.type[s]!]!.delay
    if (!(d >= min[p]!)) min[p] = d
    if (!(d <= max[p]!)) max[p] = d
    sets[p]!.add(d)
  })
  const delays = { min, max, each: sets.map((set) => [...set].sort((a, b) => a - b)) }
  DELAYS.set(value.synapses, delays)
  return delays
}

/**
 * Events for one run: `firing` gives each partner that fires (by index into `partners`) its spike
 * times, ms, and every one of that partner's synapses receives them after its type's delay.
 *
 * A map from partner to train rather than a function asked per synapse, so a partner's train is
 * drawn **once** whatever draws it — a seeded noise source asked per synapse would hand each of a
 * partner's synapses its own train, which is not what one neuron firing means. Walks only the
 * firing partners' synapses; time order out, ties in synapse order, as NEURON's queue delivers.
 */
export function eventsFor(
  value: SolverModelValue,
  firing: ReadonlyMap<number, readonly number[]>,
): SynapticEvents {
  const { slotOf, start, bySynapse, gmax, delay } = solvable(value)
  let count = 0
  for (const [p, times] of firing) count += times.length * (start[p + 1]! - start[p]!)
  const time = new Float64Array(count)
  const slot = new Int32Array(count)
  const weight = new Float64Array(count)
  let e = 0
  let ordered = true
  for (const [p, times] of firing) {
    for (const t of times) {
      for (let k = start[p]!; k < start[p + 1]!; k++) {
        const s = bySynapse[k]!
        time[e] = t + delay[s]!
        slot[e] = slotOf[s]!
        weight[e] = gmax[s]!
        if (e > 0 && time[e]! < time[e - 1]!) ordered = false
        e++
      }
    }
  }
  if (ordered) return { time, slot, weight }
  // A stable sort of an index by time, then the three arrays in that order.
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => time[a]! - time[b]!)
  return {
    time: Float64Array.from(order, (i) => time[i]!),
    slot: Int32Array.from(order, (i) => slot[i]!),
    weight: Float64Array.from(order, (i) => weight[i]!),
  }
}
