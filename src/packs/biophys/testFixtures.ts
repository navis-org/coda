/**
 * The synthetic neuron the biophysics pack's tests build models from, and the helpers around it —
 * shared by the builder's and Simulate's tests, which is why it is not in either.
 */

import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import { SQUID_SOMA } from './channelRows'
import type { ModelOptions, SynapseInput, SynapseInputs } from './build'
import { buildCellModel } from './build'

/**
 * One neuron, id 7, nm: a soma of two SWC-1 nodes (radius 3 µm at the widest), a dendrite along
 * x every 10 µm, a branch along y from x = 30 µm, one node with no radius — and a two-node fragment
 * that reaches nothing.
 */
export function neuron(
  overrides: { labels?: boolean; units?: 'nm' | 'voxels' } = {},
): SkeletonsValue {
  const nodes: [number, number, number, number, number][] = [
    // x, y, radius, parent, SWC
    [0, 0, 3000, -1, 1],
    [2000, 0, 2500, 0, 1],
    [10_000, 0, 300, 1, 3],
    [20_000, 0, 300, 2, 3],
    [30_000, 0, 300, 3, 3],
    [40_000, 0, 300, 4, 3],
    [50_000, 0, 0, 5, 3],
    [60_000, 0, 300, 6, 3],
    [30_000, 10_000, 200, 4, 3],
    [30_000, 20_000, 200, 8, 3],
    // The fragment, far off and radius-less.
    [500_000, 0, 0, -1, 3],
    [510_000, 0, 0, 10, 3],
  ]
  return {
    kind: 'skeletons',
    items: [
      {
        id: '7',
        positions: Float32Array.from(nodes.flatMap(([x, y]) => [x, y, 0])),
        radii: Float32Array.from(nodes, ([, , r]) => r),
        parents: Int32Array.from(nodes, ([, , , p]) => p),
        ...(overrides.labels === false
          ? {}
          : { compartments: Uint8Array.from(nodes, (n) => n[4]) }),
      },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['7'] }),
    bounds: { min: [0, 0, 0], max: [510_000, 20_000, 0] },
    units: overrides.units ?? 'nm',
  }
}

/** A synapse cloud: neuronId, partnerId, polarity, x, y — Synapses Between's columns. */
export type Row = [string, string, string, number, number]

export function cloud(rows: Row[]): PointsValue {
  return {
    kind: 'points',
    positions: Float32Array.from(rows.flatMap(([, , , x, y]) => [x, y, 0])),
    attributes: makeTable(
      tableSchema(
        column('neuronId', 'str'),
        column('partnerId', 'str'),
        column('polarity', 'str'),
      ),
      {
        neuronId: rows.map(([a]) => a),
        partnerId: rows.map(([, b]) => b),
        polarity: rows.map(([, , p]) => p),
      },
    ),
    bounds: { min: [0, 0, 0], max: [510_000, 100_000, 0] },
    units: 'nm',
  }
}

/** The node's defaults: Presynaptic `neuronId`, Postsynaptic `partnerId`, read as they say. */
export function input(
  rows: Row[],
  orientation: SynapseInput['orientation'] = 'fixed',
): SynapseInput {
  const points = cloud(rows)
  const col = (name: string) => getColumn(points.attributes, name)
  return {
    points,
    presynaptic: col('neuronId'),
    postsynaptic: col('partnerId'),
    orientation,
    ...(orientation === 'polarity' ? { polarity: col('polarity') } : {}),
  }
}

/** One cloud on the excitatory socket, as a graph from before there were two has it. */
export const exc = (synapses: SynapseInput): SynapseInputs => ({ excitatory: synapses })

export const OPTIONS: ModelOptions = {
  preset: { id: 'test', label: 'Test' },
  membrane: { rm: 20_800, ra: 266.1, cm: 0.8, eLeak: -60 },
  rule: { kind: 'maxLength', length: 5 },
  defaultRadius: 100,
  smoothWindow: 0,
  somaDiameter: 0,
  regionStrokes: [],
  channels: [],
  temperature: 22,
  excitatory: {
    scheme: 'exp2syn',
    sign: 'excitatory',
    tau1: 0.1,
    tau2: 10,
    eRev: 0,
    gmax: 0.001,
    delay: 1,
  },
  inhibitory: {
    scheme: 'exp2syn',
    sign: 'inhibitory',
    tau1: 0.84,
    tau2: 5.4,
    eRev: -68,
    gmax: 0.001,
    delay: 1,
  },
  maxSnap: 2,
}

/** Squid HH on the soma, as the editor's preset writes it. */
export const HH: Partial<ModelOptions> = { channels: SQUID_SOMA }

/** A model of `neuron()` (or another skeleton) under the test options, with some overridden. */
export const build = (
  over: Partial<ModelOptions> = {},
  inputs: SynapseInputs = {},
  skeletons = neuron(),
) => buildCellModel(skeletons, inputs, { ...OPTIONS, ...over })

/** Whether any of a model's notes matches. */
export const noted = (value: ReturnType<typeof build>, pattern: RegExp) =>
  value.notes.some((n) => pattern.test(n))
