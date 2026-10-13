/**
 * Named synapse mechanisms: what the Compartment Model's two synapse tabs offer as `Preset`.
 *
 * The membrane presets' rule (`presets.ts`), for a synapse: every number is a published one, read
 * in the paper's own text, and its source line names where each came from. A preset may combine
 * sources or borrow a number when it says so — GABA_A's reversal is a different paper's from its
 * kinetics, and glutamate's kinetics are GABA_A's, there being no published GluCl synaptic
 * kinetics. A preset sets **g max only where its source states one**; elsewhere the card's stands.
 * The delay is never a preset's: it is a property of the circuit, not of the receptor.
 *
 * Rise times are Exp2Syn's τ1, solved from a measured 10–90% rise against the measured decay
 * (`docs/biophys.md`); a model's own τ1 is taken as it is.
 */

import type { SynapseSign } from '../../core/values'

export interface SynapsePreset {
  readonly id: string
  readonly label: string
  /** Which socket offers it. */
  readonly sign: SynapseSign
  /** Where each number comes from, for the help and the card. */
  readonly source: string
  /** Exp2Syn rise and decay, ms. */
  readonly tau1: number
  readonly tau2: number
  /** Reversal, mV. */
  readonly eRev: number
  /** Peak conductance of one synapse, nS — only where the source states one. */
  readonly gmax?: number
}

export const SYNAPSE_PRESETS: readonly SynapsePreset[] = [
  {
    id: 'orn-pn-nicotinic',
    label: 'ORN→PN nicotinic',
    sign: 'excitatory',
    source:
      'Gouwens & Wilson 2009 (ORN→PN model synapse: τ 0.2/1.1 ms, E −10 mV), with Tobin et al. 2017’s 0.1 nS per synapse (which also corrects Gouwens’ printed 2.7×10⁻⁴ nS). A model’s choice, fitted to unitary EPSPs',
    tau1: 0.2,
    tau2: 1.1,
    eRev: -10,
    gmax: 0.1,
  },
  {
    id: 'nicotinic-cultured',
    label: 'Fly nicotinic (cultured)',
    sign: 'excitatory',
    source:
      'Lee & O’Dowd 1999 (nAChR mEPSCs, cultured embryonic neurons, room temperature: 10–90% rise 0.61 ms, decay 2.1 ms, reversal near 0 mV). Measured at the soma, so likely slower than at the synapse',
    tau1: 0.64,
    tau2: 2.1,
    eRev: 0,
  },
  {
    id: 'pn-kc-nicotinic',
    label: 'PN→KC nicotinic',
    sign: 'excitatory',
    source:
      'Turner, Bazhenov & Laurent 2008 (Kenyon cell EPSCs in vivo: rise 0.9 ms, decay 2.8 ms; E 0 mV is their model’s). Not their 2.1/11.5 ms, which is the somatic EPSP',
    tau1: 1.0,
    tau2: 2.8,
    eRev: 0,
  },
  {
    id: 'gaba-a',
    label: 'GABA_A (Rdl)',
    sign: 'inhibitory',
    source:
      'Kinetics from Lee, Su & O’Dowd 2003 (mIPSCs in culture: rise about 1 ms, decay 5.4 ms); reversal from Groschner et al. 2022 (−68 mV, T4 in vivo). Their culture’s −41.5 mV is the culture’s chloride, not a neuron’s',
    tau1: 0.84,
    tau2: 5.4,
    eRev: -68,
  },
  {
    id: 'glutamate-glucl',
    label: 'Glutamate (GluClα)',
    sign: 'inhibitory',
    source:
      'Reversal from Groschner et al. 2022 (−71 mV, T4 in vivo). Kinetics are GABA_A’s (Lee, Su & O’Dowd 2003): no GluCl synaptic kinetics are published. In the fly central brain glutamate is usually inhibitory, through GluClα (Liu & Wilson 2013)',
    tau1: 0.84,
    tau2: 5.4,
    eRev: -71,
  },
]

export function synapsePreset(id: string): SynapsePreset | undefined {
  return SYNAPSE_PRESETS.find((p) => p.id === id)
}
