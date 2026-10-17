/**
 * A Compartment Model's passive copy: its tree, a uniform leak and capacitance, no channels — what
 * Fit Model fits, and what the Model tab's input resistance is measured on. One definition, so the
 * two cannot describe different cells. Rescaled rather than rebuilt: the membrane reaches the solver
 * as densities and the axial conductances, which scale as 1/Ra for a uniform Ra (`solverInputs.ts`).
 */

import { leakChannel } from '../../biophys/channels'
import type { CellModel } from '../../biophys/solver'
import { NO_SYNAPSES, steadyState } from '../../biophys/solver'
import type { CellModelValue } from '../../core/values'

export type Membrane = CellModelValue['membrane']
/**
 * A membrane as a fit holds it: the model's, and its area factor — the Compartment Model's own
 * `Area factor`, membrane per µm² of reconstructed surface, not a share of the model's.
 */
export type FitMembrane = Membrane & { readonly area: number }

/**
 * The model's passive parts, held once for every evaluation: the tree, the axial conductances it
 * was built with and the Ra they were built at, the area factor its areas were built at, the soma.
 */
export interface PassiveBase {
  readonly tree: CellModel['tree']
  readonly ra0: number
  readonly area0: number
  readonly soma: number
}

export function passiveBase(value: CellModelValue): PassiveBase {
  // What the solver reads and no more: the setup is cloned into every worker.
  const { count, parent, area, gAxial } = value.compartments
  return {
    tree: { count, parent, area, gAxial },
    ra0: value.membrane.ra,
    area0: value.areaFactor ?? 1,
    soma: value.soma.compartment,
  }
}

/** The axial conductances of a tree built at `ra0`, at `ra` instead: they scale as 1/Ra. */
export function rescaledAxial(gAxial: Float64Array, ra0: number, ra: number): Float64Array {
  const scale = ra0 / ra
  return gAxial.map((g) => g * scale)
}

/**
 * The model at a membrane: the tree rescaled for Ra, capacitance and leak uniform and both scaled by
 * the area factor's share of the one the tree was built at, no channels.
 */
export function passiveModel(base: PassiveBase, m: FitMembrane): CellModel {
  const { tree } = base
  const area = m.area / base.area0
  return {
    tree: { ...tree, gAxial: rescaledAxial(tree.gAxial, base.ra0, m.ra) },
    cm: new Float64Array(tree.count).fill(m.cm * area),
    channels: [
      {
        spec: leakChannel(m.eLeak),
        gbar: new Float64Array(tree.count).fill(area / m.rm),
      },
    ],
    temperature: 22,
    synapses: NO_SYNAPSES,
  }
}

/**
 * Every compartment's voltage held at a constant soma current, nA: the passive cell's steady state
 * (`steadyState`), so a replay from it starts with no transient — a backward-Euler run's steady
 * state being exactly that solve.
 */
export function steadyUnder(
  model: CellModel,
  soma: number,
  current: number,
  eLeak: number,
): Float64Array {
  if (current === 0) return new Float64Array(model.tree.count).fill(eLeak)
  const injection = new Float64Array(model.tree.count)
  injection[soma] = current
  return steadyState(model, injection)
}

/**
 * The model's passive input resistance at the soma, MΩ: the passive copy Fit Model fits — the same
 * model, the same steady state — under 1 nA there. What the Model tab reports beside the drawing.
 */
export function passiveInputResistance(value: CellModelValue): number {
  const base = passiveBase(value)
  const m = startMembrane(value)
  return steadyUnder(passiveModel(base, m), base.soma, 1, m.eLeak)[base.soma]! - m.eLeak
}

/** The membrane a fit starts from: the model's, at the area factor it was built with. */
export function startMembrane(value: CellModelValue): FitMembrane {
  return { ...value.membrane, area: value.areaFactor ?? 1 }
}
