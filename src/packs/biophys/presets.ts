/**
 * Named sets of passive membrane constants: what the Compartment Model's `Preset` offers.
 *
 * A preset is the one copy of its numbers. Each is a published fit with its source named, and a
 * set is added only when its source states Rm, Ra and Cm. The leak reversal is the one number a
 * source may leave out: a model in voltage relative to rest (Meier & Borst's) states none, and in a
 * passive model it only sets the baseline a synapse's driving force is measured from. Where it is
 * not the source's, the preset uses −60 mV (the PN fit's) and its `source` says so.
 */

export interface MembranePreset {
  readonly id: string
  readonly label: string
  /** Where the numbers come from, for the help and the card. */
  readonly source: string
  /** Specific membrane resistance, Ω·cm². */
  readonly rm: number
  /** Axial resistivity, Ω·cm. */
  readonly ra: number
  /** Specific capacitance, µF/cm². */
  readonly cm: number
  /** Leak reversal, mV — the resting potential of a passive model. */
  readonly eLeak: number
}

/** The leak reversal a preset uses where its source states none: the PN fit's. */
const UNSTATED_E_LEAK = -60

export const MEMBRANE_PRESETS: readonly MembranePreset[] = [
  {
    id: 'drosophila-pn',
    label: 'Drosophila PN',
    source: 'Tobin et al. 2017, after Gouwens & Wilson 2009 (antennal-lobe projection neurons)',
    rm: 20_800,
    ra: 266.1,
    cm: 0.8,
    eLeak: -60,
  },
  {
    id: 'meier-borst-ct1',
    label: 'Fly visual (Meier & Borst)',
    source:
      'Meier & Borst 2019 (CT1, fitted to calcium imaging; consistent with Yang et al. 2016’s Mi1). E leak is not theirs: their model is in voltage relative to rest',
    // Their CT1 model reproduced: 13.21% of the voltage reaching ten neighbouring terminals, the
    // gap to their 15.41% being their mean-diameter cylinders (`docs/biophys.md`).
    rm: 8_000,
    ra: 400,
    cm: 0.6,
    eLeak: UNSTATED_E_LEAK,
  },
  /*
   * Vieira et al. 2026, SI "Multi-compartment models": T4 and T5 in Jaxley. Three things the preset
   * does not carry, each a deviation from their models to keep in mind:
   * - **E leak is not theirs**: the SI states none (Jaxley's own leak default is −70 mV).
   * - **Their Fig. 1 HH model used a different leak**, gLeak 25 µS/cm² (40 kΩ·cm²) beside Jaxley's
   *   Na/K, not 1/Rm; this preset is their passive constants, which the T4/T5 models used.
   * - **Their added 2.6 µm soma** (the reconstructions have none) is `Soma diameter`, a separate
   *   setting, as is their dt of 25 µs, Simulate's default.
   */
  {
    id: 'vieira-optic-lobe',
    label: 'Fly optic lobe (Vieira et al.)',
    source:
      'Vieira et al. 2026 (T4/T5 models; "standard values for invertebrate neurons, consistent with T4 input resistance"). E leak is not theirs: the source states none. Their models add a 2.6 µm soma (Soma diameter), and their Fig. 1 HH model used a leak of 25 µS/cm² instead of 1/Rm',
    rm: 20_000,
    ra: 250,
    cm: 1,
    eLeak: UNSTATED_E_LEAK,
  },
]

/** The preset that means "the four numbers on the card", and what it is called. */
export const CUSTOM = { id: 'custom', label: 'Custom' } as const

export function membranePreset(id: string): MembranePreset | undefined {
  return MEMBRANE_PRESETS.find((p) => p.id === id)
}
