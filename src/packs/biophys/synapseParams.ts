/**
 * The Compartment Model's two synapse sockets as params: one declaration, made twice. Each socket
 * reads its own cloud, so each carries its own pickers — the two wires may come from different
 * nodes — and its own mechanism, a preset (`synapsePresets.ts`) or Custom numbers.
 *
 * **The excitatory socket keeps the ids it had when it was the only one** (`synapses`, `gmax`,
 * `tau1`, …), so a saved graph loads with its wire and its numbers where they were, and a graph
 * with no `synapsePreset` stored reads Custom — the numbers it was saved with. The inhibitory
 * socket's ids are the same names prefixed `inh`.
 *
 * Under a preset its numbers are hidden, which takes them out of the provenance key (invariant 4),
 * and the preset's id is what the key sees — the membrane preset's rule. g max hides only where the
 * preset states one.
 */

import type { EvalContext, ParamDef, ParamValues } from '../../core/node'
import type { CellModelValue, SynapseSign } from '../../core/values'
import { findColumn } from '../../core/types'
import { getColumn, isPointsValue } from '../../core/values'
import { orientationParams } from '../../nodes/lib/synapseEdges'
import type { SynapseInput } from './build'
import { CUSTOM } from './presets'
import { SYNAPSE_PRESETS, synapsePreset } from './synapsePresets'

/** One socket: its port, its tab, how its params are named, and what a fresh card starts on. */
export interface SynapseSocket {
  readonly sign: SynapseSign
  /** The input port, which is also the id of its params' group (the inspector tab). */
  readonly port: string
  /** What the port, the tab and a note about its synapses are called. */
  readonly label: string
  /** A param's id on this socket, from the excitatory socket's. */
  readonly id: (name: string) => string
  /** The preset a fresh card starts on. */
  readonly preset: string
  /** The Custom numbers a fresh card starts from: g max in nS, times in ms, E in mV. */
  readonly custom: {
    readonly gmax: number
    readonly tau1: number
    readonly tau2: number
    readonly eRev: number
  }
}

export const EXCITATORY: SynapseSocket = {
  sign: 'excitatory',
  port: 'synapses',
  label: 'Synapses (exc.)',
  id: (name) => name,
  // Custom, so a graph from before presets keeps the numbers it was saved with.
  preset: CUSTOM.id,
  custom: { gmax: 0.5, tau1: 0.1, tau2: 10, eRev: 0 },
}

const GABA_A = synapsePreset('gaba-a')!

export const INHIBITORY: SynapseSocket = {
  sign: 'inhibitory',
  port: 'inhSynapses',
  label: 'Synapses (inh.)',
  id: (name) => `inh${name[0]!.toUpperCase()}${name.slice(1)}`,
  preset: GABA_A.id,
  custom: { gmax: 0.5, tau1: GABA_A.tau1, tau2: GABA_A.tau2, eRev: GABA_A.eRev },
}

/**
 * Both sockets, in the order everything indexed by socket follows: the ports, the tabs, and the
 * value's `synapseTypes`, so a synapse's `type` is its socket's place here.
 */
export const SYNAPSE_SOCKETS: readonly SynapseSocket[] = [EXCITATORY, INHIBITORY]

/** The preset a socket's params name, or undefined under Custom. */
function presetOf(p: ParamValues, socket: SynapseSocket) {
  const preset = synapsePreset(String(p[socket.id('synapsePreset')]))
  return preset?.sign === socket.sign ? preset : undefined
}

/** A socket's params, in the order its tab shows them: whose synapses, then their mechanism. */
export function synapseParams(socket: SynapseSocket): ParamDef[] {
  const { id, port: from } = socket
  const group = from
  const custom = (p: ParamValues) => presetOf(p, socket) === undefined
  const presets = SYNAPSE_PRESETS.filter((p) => p.sign === socket.sign)
  return [
    /*
     * Which end of a row is which, as Synapses to Edges asks it — `polarity` means the drawn end on
     * Synapses Between and the queried neuron's role on Synapses, so it cannot be read as either
     * without being told (`build.ts`). A row is an input when its postsynaptic end is this neuron.
     */
    {
      id: id('presynaptic'),
      kind: 'column',
      label: 'Presynaptic',
      group,
      from,
      default: 'neuronId',
      optional: true,
      help: 'The column naming each synapse’s partner, whose synapses fire together. On Synapses Between that is `neuronId`. None makes every synapse one partner, `-`. Any column will do: on points placed by hand in Skeleton to Points, `name` makes every point of one name a partner, and `strahler` each branch order, so tips and trunk can fire apart.',
    },
    {
      id: id('postsynaptic'),
      kind: 'column',
      label: 'Postsynaptic',
      group,
      from,
      default: 'partnerId',
      help: 'The column naming each synapse’s postsynaptic neuron. Rows where it is not this neuron are not its inputs, and are left out and counted. On Synapses Between that is `partnerId`.',
    },
    ...orientationParams(from, {
      group,
      unreadable:
        'Rows with any other value are left out of the model, and their number is reported.',
      ids: { orientation: id('orientation'), polarity: id('polarity') },
    }),
    {
      id: id('partnerType'),
      kind: 'column',
      label: 'Partner type',
      group,
      from,
      default: '',
      optional: true,
      help: 'Optionally, a column naming each presynaptic partner’s type, carried onto the model’s partner list.',
    },
    {
      id: id('synapsePreset'),
      kind: 'enum',
      label: 'Preset',
      group,
      default: socket.preset,
      options: [
        ...presets.map((p) => ({ value: p.id, label: p.label })),
        { value: CUSTOM.id, label: CUSTOM.label },
      ],
      help: `Published synapse kinetics and reversal. ${presets.map((p) => `${p.label}: ${p.source}.`).join(' ')} Custom shows the numbers.`,
    },
    {
      id: id('gmax'),
      kind: 'number',
      label: 'g max (nS)',
      group,
      default: socket.custom.gmax,
      min: 0,
      step: 0.1,
      // Shown unless the preset states one: most sources give kinetics and no conductance.
      visibleIf: (p) => presetOf(p, socket)?.gmax === undefined,
      help: 'Peak conductance of one synapse. A site holding several synapses gets that many times this.',
    },
    {
      id: id('tau1'),
      kind: 'number',
      label: 'τ rise (ms)',
      group,
      default: socket.custom.tau1,
      min: 0.001,
      step: 0.1,
      visibleIf: custom,
    },
    {
      id: id('tau2'),
      kind: 'number',
      label: 'τ decay (ms)',
      group,
      default: socket.custom.tau2,
      min: 0.001,
      visibleIf: custom,
    },
    {
      id: id('eRev'),
      kind: 'number',
      label: 'E rev (mV)',
      group,
      default: socket.custom.eRev,
      visibleIf: custom,
      help:
        socket.sign === 'excitatory'
          ? 'Synaptic reversal: near 0 mV for a nicotinic synapse.'
          : 'Synaptic reversal: near the chloride reversal, about −70 mV, for GABA_A and GluCl.',
    },
    {
      id: id('delay'),
      kind: 'number',
      label: 'Delay (ms)',
      group,
      default: 1,
      min: 0,
      help: 'From a partner’s spike to the conductance starting.',
    },
  ]
}

/**
 * Why a socket's pickers cannot say which synapses are this neuron's inputs, or undefined. Two
 * ways, both silent without this:
 *
 * - **Both ends on one column.** A Synapses cloud from neuPrint or CATMAID has no partner column,
 *   so `resolveColumn`'s rule 3 hands the required Postsynaptic picker `neuronId` too — this neuron
 *   on every row — and every synapse, outputs included, became an input with the neuron as its
 *   own partner. Synapses to Edges' refusal (`edgePlanRefusal`), for the same pairing.
 * - **Polarity with no Presynaptic column.** A `post` row has its ends swapped, so with only a
 *   Postsynaptic column the swap empties it: the real inputs were dropped as "outputs" and the
 *   outputs kept as inputs.
 */
export function socketRefusal(
  column: (paramId: string) => string | undefined,
  params: ParamValues,
  socket: SynapseSocket,
): string | undefined {
  const { id, label } = socket
  const pre = column(id('presynaptic'))
  const post = column(id('postsynaptic'))
  if (pre && post && pre === post) {
    return (
      `${label}: Presynaptic and Postsynaptic both read "${pre}", so every synapse would be ` +
      'this neuron’s own input, its outputs included. For points placed by hand, set Presynaptic ' +
      'to the column naming each one’s partner, or to None for one partner. A Synapses cloud ' +
      'has no partner column: use Synapses Between, which returns both ends of each synapse.'
    )
  }
  if (params[id('orientation')] === 'polarity' && !pre) {
    return (
      `${label}: reading ends from a polarity column needs a Presynaptic column as well — with ` +
      'None, swapping a row’s ends empties it, and inputs and outputs trade places. Pick a ' +
      'Presynaptic column, or use columns that are already oriented.'
    )
  }
  return undefined
}

/** A socket's cloud and the columns its pickers resolved, or undefined while it is unwired. */
export function synapseInput(
  ctx: EvalContext,
  socket: SynapseSocket,
): SynapseInput | undefined {
  const points = ctx.input(socket.port)
  if (!isPointsValue(points)) return undefined
  const refusal = socketRefusal((param) => ctx.column(param), ctx.params, socket)
  if (refusal) throw new Error(refusal)
  const { id } = socket
  // The one pairing the columns cannot give away: Presynaptic None under fixed orientation is
  // right for points placed by hand and wrong for a Synapses cloud, whose outputs it reads as
  // inputs. A polarity column holding `pre` rows is the cloud's tell, so it is warned on.
  if (!ctx.column(id('presynaptic')) && ctx.params[id('orientation')] !== 'polarity') {
    const hasPolarity = findColumn(points.attributes.schema, 'polarity') !== undefined
    if (
      hasPolarity &&
      getColumn(points.attributes, 'polarity').some((cell) => cell === 'pre')
    ) {
      ctx.warn(
        `${socket.label}: this cloud has a polarity column with outputs (\`pre\`) in it, and ` +
          'Presynaptic is None under fixed orientation, so they are read as inputs. For a ' +
          'Synapses cloud use Synapses Between, which names each synapse’s partner.',
      )
    }
  }
  const column = (param: string) => {
    const name = ctx.column(id(param))
    return name ? getColumn(points.attributes, name) : undefined
  }
  const byPolarity = ctx.params[id('orientation')] === 'polarity'
  return {
    points,
    presynaptic: column('presynaptic'),
    postsynaptic: column('postsynaptic'),
    orientation: byPolarity ? 'polarity' : 'fixed',
    polarity: byPolarity ? column('polarity') : undefined,
    partnerType: column('partnerType'),
  }
}

/** A socket's mechanism: its preset's numbers, the card's where the preset states none. */
export function synapseType(
  p: ParamValues,
  socket: SynapseSocket,
): CellModelValue['synapseTypes'][number] {
  const { id } = socket
  const preset = presetOf(p, socket)
  return {
    scheme: 'exp2syn',
    sign: socket.sign,
    ...(preset ? { preset: { id: preset.id, label: preset.label } } : {}),
    tau1: preset?.tau1 ?? Number(p[id('tau1')]),
    tau2: preset?.tau2 ?? Number(p[id('tau2')]),
    eRev: preset?.eRev ?? Number(p[id('eRev')]),
    // nS on the card, µS in the value.
    gmax: (preset?.gmax ?? Number(p[id('gmax')])) / 1000,
    delay: Number(p[id('delay')]),
  }
}
