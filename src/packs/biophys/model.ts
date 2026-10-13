/**
 * Compartment Model: one neuron's skeleton and input synapses as a compartment model, ready to
 * simulate. The work is `build.ts`; this is its card.
 *
 * **`cheap`**: everything here is geometry over one neuron — a re-root, a walk, a projection of
 * its synapses — tens of milliseconds, so it re-runs on every edit like any transform.
 *
 * **The preset is the key, not a copy of its numbers.** Under a preset the four membrane params
 * are hidden, which takes them out of the provenance key (invariant 4), and the preset's id is
 * what the key sees; under Custom they show and count. The card can therefore never disagree with
 * the numbers a run used.
 */

import type { ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { isSkeletonsValue } from '../../core/values'
import type { SynapseInputs } from './build'
import { buildCellModel } from './build'
import {
  EXCITATORY,
  INHIBITORY,
  SYNAPSE_SOCKETS,
  socketRefusal,
  synapseInput,
  synapseParams,
  synapseType,
} from './synapseParams'
import { CUSTOM, MEMBRANE_PRESETS, membranePreset } from './presets'
import { HH_TEMPERATURE, findChannel } from '../../biophys/channels'
import { CHANNELS_PARAM, readChannelRows } from './channelRows'
import { REGIONS_PARAM, readRegionStrokes } from './regions'

// Custom is any id that is not a preset — the reading `evaluate` takes, so a file naming a preset
// this build lacks shows the four numbers it is built from and keys on them (invariant 4).
const custom = (p: ParamValues) => membranePreset(String(p.preset)) === undefined
const byLambda = (p: ParamValues) => p.discretisation === 'dLambda'
/** The custom numbers start from the first preset's: one copy of each number, in `presets.ts`. */
const DEFAULT_PRESET = MEMBRANE_PRESETS[0]!

export const modelNode = packNode({
  type: 'biophys:model',
  label: 'Compartment Model',
  category: 'analysis',
  description:
    'Builds one neuron’s skeleton into a compartment model — passive cable, voltage-gated ' +
    'channels by region, and its input synapses placed where they sit — for Simulate to run.',
  guide:
    'Turns one neuron into a compartment model: its skeleton cut into compartments, a passive ' +
    'membrane from a published preset, and a wired synapse cloud placed on the arbour, grouped by ' +
    'presynaptic partner. Wire Skeletons for one neuron and Synapses Between with this neuron as ' +
    'the target.',
  cost: 'cheap',
  inputs: [
    { id: 'neuron', label: 'Skeleton', type: T.skeletons() },
    // `synapses` keeps its id from before there were two, so a saved graph's wire stays on it.
    ...SYNAPSE_SOCKETS.map((s) => ({
      id: s.port,
      label: s.label,
      type: T.points(),
      required: false,
    })),
  ],
  outputs: [{ id: 'model', label: 'Model', type: T.cellModel() }],
  paramGroups: [
    { id: 'membrane', label: 'Membrane', affectsData: true },
    { id: 'soma', label: 'Soma', affectsData: true },
    { id: 'channels', label: 'Channels', affectsData: true },
    ...SYNAPSE_SOCKETS.map((s) => ({ id: s.port, label: s.label, affectsData: true })),
  ],
  params: [
    {
      id: 'preset',
      kind: 'enum',
      label: 'Preset',
      group: 'membrane',
      default: DEFAULT_PRESET.id,
      options: [
        ...MEMBRANE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        { value: CUSTOM.id, label: CUSTOM.label },
      ],
      help: `Published passive membrane constants. ${MEMBRANE_PRESETS.map((p) => `${p.label}: ${p.source}.`).join(' ')} Custom shows the four numbers.`,
    },
    {
      id: 'rm',
      kind: 'number',
      label: 'Rm (Ω·cm²)',
      group: 'membrane',
      default: DEFAULT_PRESET.rm,
      min: 1,
      visibleIf: custom,
      help: 'Specific membrane resistance.',
    },
    {
      id: 'ra',
      kind: 'number',
      label: 'Ra (Ω·cm)',
      group: 'membrane',
      default: DEFAULT_PRESET.ra,
      min: 1,
      visibleIf: custom,
      help: 'Axial resistivity of the cytoplasm.',
    },
    {
      id: 'cm',
      kind: 'number',
      label: 'Cm (µF/cm²)',
      group: 'membrane',
      default: DEFAULT_PRESET.cm,
      min: 0.01,
      step: 0.1,
      visibleIf: custom,
      help: 'Specific membrane capacitance.',
    },
    {
      id: 'eLeak',
      kind: 'number',
      label: 'E leak (mV)',
      group: 'membrane',
      default: DEFAULT_PRESET.eLeak,
      visibleIf: custom,
      help: 'Leak reversal: where a passive model rests.',
    },
    {
      id: 'defaultRadius',
      kind: 'number',
      label: 'Default radius (nm)',
      group: 'membrane',
      default: 100,
      min: 1,
      help: 'Given to every node the skeleton has no radius for. The card says how many.',
    },
    {
      id: 'smooth',
      kind: 'int',
      label: 'Smooth radii (nodes)',
      group: 'membrane',
      default: 0,
      min: 0,
      max: 51,
      advanced: true,
      help: 'Average each radius with its neighbours along unbranched stretches, over this many nodes, centred, so an even number acts as the next odd one. The soma is left out. Noisy skeleton radii make axial resistance spiky; 0 leaves them as they are.',
    },
    {
      id: 'discretisation',
      kind: 'enum',
      label: 'Compartments',
      group: 'membrane',
      default: 'dLambda',
      options: [
        { value: 'dLambda', label: 'd_lambda rule' },
        { value: 'maxLength', label: 'Fixed length' },
      ],
      advanced: true,
      help: 'd_lambda cuts each section by its length constant at 100 Hz, as NEURON’s rule does. Fixed length caps each compartment at a length.',
    },
    {
      id: 'dLambda',
      kind: 'number',
      label: 'd_lambda',
      group: 'membrane',
      default: 0.1,
      min: 0.001,
      max: 1,
      step: 0.01,
      advanced: true,
      visibleIf: byLambda,
      help: 'Longest compartment as a fraction of the length constant at 100 Hz. Smaller is finer and slower.',
    },
    {
      id: 'maxLength',
      kind: 'number',
      label: 'Max length (µm)',
      group: 'membrane',
      default: 10,
      min: 0.1,
      advanced: true,
      visibleIf: (p) => !byLambda(p),
      help: 'Longest compartment.',
    },
    {
      id: 'somaDiameter',
      kind: 'number',
      label: 'Soma diameter (µm)',
      group: 'soma',
      default: 0,
      min: 0,
      step: 0.1,
      help: 'A soma of this diameter, as a sphere. 0 uses the soma the skeleton labels, if it labels one; reconstructions without somata usually need one added.',
    },
    {
      id: REGIONS_PARAM,
      kind: 'ids',
      label: 'Painted regions',
      noun: 'strokes',
      group: 'channels',
      default: [],
      help: 'Regions painted onto the neuron in the expanded view’s Regions tab (⤢): everything distal of a point, or everything else, under a name the channel list can then place channels on. Later strokes paint over earlier ones.',
    },
    {
      id: CHANNELS_PARAM,
      kind: 'ids',
      label: 'Channels',
      noun: 'channels',
      group: 'channels',
      default: [],
      help: 'Voltage-gated channels, each placed on regions of the cell at a density, or as a total per cell spread over them. Add and edit them in the expanded view (⤢). None is a passive cell.',
    },
    {
      id: 'temperature',
      kind: 'number',
      label: 'Temperature (°C)',
      group: 'channels',
      default: HH_TEMPERATURE,
      // Shown while some channel's kinetics depend on temperature: the squid ones, not Pospischil's.
      visibleIf: (p) =>
        readChannelRows(p[CHANNELS_PARAM]).some((row) => findChannel(row.channel)?.q10),
      help: 'The squid channels’ kinetics speed up threefold per 10 °C. 6.3 °C is what the squid model was recorded at.',
    },
    ...SYNAPSE_SOCKETS.flatMap(synapseParams),
    {
      id: 'maxSnap',
      kind: 'number',
      label: 'Max distance (µm)',
      group: 'synapses',
      default: 2,
      min: 0,
      advanced: true,
      help: 'A synapse further than this from the arbour is left out, and counted.',
    },
  ],

  inferOutputs: () => ({ model: T.cellModel() }),

  validate: (ctx) =>
    SYNAPSE_SOCKETS.flatMap((socket) => {
      if (!ctx.inputs[socket.port]) return []
      const refusal = socketRefusal((id) => ctx.column(id), ctx.params, socket)
      return refusal ? [refusal] : []
    }),

  evaluate: (ctx) => {
    const skeletons = ctx.input('neuron')
    if (!isSkeletonsValue(skeletons)) throw new Error('Wire a Skeleton for one neuron.')
    const p = ctx.params
    const preset = membranePreset(String(p.preset))
    const membrane = preset
      ? { rm: preset.rm, ra: preset.ra, cm: preset.cm, eLeak: preset.eLeak }
      : { rm: Number(p.rm), ra: Number(p.ra), cm: Number(p.cm), eLeak: Number(p.eLeak) }
    const inputs: SynapseInputs = Object.fromEntries(
      SYNAPSE_SOCKETS.map((s) => [s.sign, synapseInput(ctx, s)]),
    )
    const value = buildCellModel(skeletons, inputs, {
      preset: preset ? { id: preset.id, label: preset.label } : CUSTOM,
      membrane,
      rule: byLambda(p)
        ? { kind: 'dLambda', dLambda: Number(p.dLambda), frequency: 100 }
        : { kind: 'maxLength', length: Number(p.maxLength) },
      defaultRadius: Number(p.defaultRadius),
      smoothWindow: Number(p.smooth),
      somaDiameter: Number(p.somaDiameter),
      regionStrokes: readRegionStrokes(p[REGIONS_PARAM]),
      channels: readChannelRows(p[CHANNELS_PARAM]),
      temperature: Number(p.temperature),
      excitatory: synapseType(p, EXCITATORY),
      inhibitory: synapseType(p, INHIBITORY),
      maxSnap: Number(p.maxSnap),
    })
    for (const note of value.notes) ctx.warn(note)
    return { model: value }
  },
})
