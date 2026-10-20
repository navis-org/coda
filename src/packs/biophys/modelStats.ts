/**
 * A built Compartment Model in a few numbers — the Model tab's, each one a check a broken model
 * fails visibly: a soma holding nearly all of the membrane, an input resistance nothing like the
 * cell's.
 *
 * **Passive**: the input resistance and the time constant are the leak's alone, the model's channels
 * left out — what a current-clamp step from rest measures before any channel opens, and what Fit
 * Model fits (`passive.ts`, the one passive copy).
 */

import { csr } from '../../core/stats'
import type { CellModelValue } from '../../core/values'
import type { CableConstants } from '../../nodes/lib/arborOps'
import { channelOption, regionAreas } from './channelRows'
import { passiveInputResistance } from './passive'
import { SOMA_REGION } from './regions'

export interface ModelStats {
  /** µm², all of it and per region (regions with none left out), each with its index in `regionNames`. */
  readonly area: number
  readonly areaByRegion: readonly {
    readonly region: string
    readonly index: number
    readonly area: number
  }[]
  /**
   * The soma's membrane, µm², and its share of all of it, 0–1: the idealised soma's own
   * (`somaMembrane`, the section the solver has, whatever region it was painted) where one is
   * made, else the `soma` region's.
   */
  readonly somaArea: number
  readonly somaShare: number
  /** MΩ, at the soma: the passive steady state under 1 nA there. */
  readonly inputResistance: number
  /** ms: Rm × Cm, the membrane's own, uniform as the model's is. */
  readonly timeConstant: number
}

/** What a set of compartments carries beyond its cable: the leak, each channel on it, its synapses. */
export interface CompartmentLoad {
  /** The leak's conductance, nS: area / Rm. */
  readonly leak: number
  /** Each channel placed on any of them, in the model's order, with its conductance there, nS. */
  readonly channels: readonly {
    readonly label: string
    /** S/cm², as placed. */
    readonly density: number
    readonly conductance: number
    readonly shift?: { readonly activation?: number; readonly inactivation?: number }
  }[]
  readonly excitatory: number
  readonly inhibitory: number
  /** Distinct presynaptic partners among those synapses. */
  readonly partners: number
}

/** S/cm² × µm² is this many nS: 1e-8 cm² per µm², 1e9 nS per S. */
const NS_PER_S_CM2_UM2 = 10

/**
 * A reader of what compartments carry, for the Model tab's hover: the synapses indexed by
 * compartment once, so a pointer move reads only its own. Built from what it reads alone.
 */
export function compartmentLoads(
  value: CellModelValue,
): (compartments: readonly number[]) => CompartmentLoad {
  const { area, region, count } = value.compartments
  const { compartment, type, partner } = value.synapses
  // Every placed synapse has a compartment (one on an ignored branch is never placed).
  const { start, list: rows } = csr(count, compartment)
  const inhibitory = value.synapseTypes.map((t) => t.sign === 'inhibitory')
  const { rm } = value.membrane
  const { channels, regionNames } = value
  return (compartments) => {
    let excitatoryCount = 0
    let inhibitoryCount = 0
    const partners = new Set<number>()
    for (const c of compartments) {
      for (let k = start[c]!; k < start[c + 1]!; k++) {
        const i = rows[k]!
        if (inhibitory[type[i]!]) inhibitoryCount++
        else excitatoryCount++
        partners.add(partner[i]!)
      }
    }
    const areaOf = (on: (c: number) => boolean) =>
      compartments.reduce((a, c) => (on(c) ? a + area[c]! : a), 0)
    const total = areaOf(() => true)
    return {
      leak: (total * NS_PER_S_CM2_UM2) / rm,
      channels: channels.flatMap((ch) => {
        // Empty regions is everywhere, unlabelled cable included: `densityByRegion`'s rule.
        const placed = areaOf(
          (c) => ch.regions.length === 0 || ch.regions.includes(regionNames[region[c]!]!),
        )
        if (placed === 0) return []
        return [
          {
            label: channelOption(ch.id)?.label ?? ch.id,
            density: ch.density,
            conductance: ch.density * placed * NS_PER_S_CM2_UM2,
            ...(ch.shift ? { shift: ch.shift } : {}),
          },
        ]
      }),
      excitatory: excitatoryCount,
      inhibitory: inhibitoryCount,
      partners: partners.size,
    }
  }
}

/**
 * A made soma's membrane, µm²: a cylinder as long as it is wide, its side π·d², times the area
 * factor as every compartment's is; undefined where none is made.
 */
export function somaMembrane(value: CellModelValue): number | undefined {
  const d = value.soma.diameter
  return d ? Math.PI * d * d * (value.areaFactor ?? 1) : undefined
}

/**
 * What a length constant is worked out from, for a reader that has only the reconstruction's
 * radii: Rm per µm² of *reconstructed* surface, which the area factor's extra membrane divides.
 */
export function cableConstants(value: CellModelValue): CableConstants {
  return { rm: value.membrane.rm / (value.areaFactor ?? 1), ri: value.membrane.ra }
}

export function modelStats(value: CellModelValue): ModelStats {
  const { rm, cm } = value.membrane
  const byRegion = regionAreas({ ...value.compartments, regionNames: value.regionNames })
  const total = byRegion.reduce((a, b) => a + b, 0)
  // The soma section whichever region it carries, where the `soma` region can be painted away from
  // it or onto cable elsewhere; the region's own area where no soma is made.
  const soma = somaMembrane(value) ?? byRegion[SOMA_REGION]!
  return {
    area: total,
    areaByRegion: value.regionNames
      .map((region, index) => ({ region, index, area: byRegion[index]! }))
      .filter((r) => r.area > 0),
    somaArea: soma,
    somaShare: total > 0 ? soma / total : 0,
    inputResistance: passiveInputResistance(value),
    timeConstant: (rm * cm) / 1000,
  }
}
