import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { SampleMode } from '../lib/tableOps'
import { SAMPLE_OPTIONS, sampleTable } from '../lib/tableOps'

/**
 * Row sampler: the top, the bottom, every Nth, or a seeded random draw.
 *
 * The mode a workflow is actually reaching for is usually not the obvious one. `Top N` after a
 * Sort is "the strongest partners"; `Every Nth` over an ordered table is a thinning that keeps
 * the shape of the whole rather than one end of it, which is what a scatter of 165,122 neurons
 * wants; and `Random` is the only one of the four that answers "is this result an artefact of
 * how the table happens to be ordered?".
 *
 * `Sort`'s own `Top N` overlaps the first mode and is deliberately left alone — it is a limit
 * on an ordering, applied where the ordering is decided, and taking rows off a table nobody
 * sorted is a different act.
 */
export const sampleNode = registerNode({
  type: 'core.sample',
  label: 'Sample',
  category: 'transform',
  description: 'Keep a subset of the rows: the top, the bottom, every Nth, or a random draw.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    { id: 'mode', kind: 'enum', label: 'Mode', default: 'head', options: SAMPLE_OPTIONS },
    {
      id: 'count',
      kind: 'int',
      label: 'Rows',
      help: 'A ceiling: a smaller table comes through whole.',
      default: 100,
      min: 0,
      step: 10,
      visibleIf: (params) => params.mode !== 'stride',
    },
    {
      id: 'step',
      kind: 'int',
      label: 'Every',
      help: 'Keep one row in N, starting with the first.',
      default: 10,
      min: 1,
      step: 1,
      visibleIf: (params) => params.mode === 'stride',
    },
    {
      id: 'seed',
      kind: 'int',
      label: 'Seed',
      help: 'The same seed always draws the same rows. Bump it for a different draw.',
      default: 1,
      min: 0,
      step: 1,
      visibleIf: (params) => params.mode === 'random',
    },
  ],

  // Sampling takes rows away and leaves every column alone — including `bodyId`, so a
  // sampled neuron table is still pluggable into Connectivity.
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
  },

  // Zero rows is a legitimate thing to ask for and the empty table says so plainly, so the
  // only thing worth reporting is the state where the node is silently doing nothing at all.
  validate: (ctx) => {
    const mode = String(ctx.params.mode ?? 'head') as SampleMode
    if (mode === 'stride' && Number(ctx.params.step ?? 1) <= 1) {
      return ['Every 1 keeps every row — raise it, or the node is a pass-through']
    }
    return []
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: sampleTable(table, {
        mode: String(ctx.params.mode ?? 'head') as SampleMode,
        count: Number(ctx.params.count ?? 0),
        step: Number(ctx.params.step ?? 1),
        seed: Number(ctx.params.seed ?? 0),
      }),
    }
  },
})
