/**
 * Annotate: a table of a selection's annotations, live from a backend, where editing a cell writes
 * it back.
 *
 * **Nothing here writes.** Writing is the card's (`ui/nodes/AnnotateBody.tsx`), on a gesture, through
 * `data/annotations/targets`: a write reached from `evaluate` would be pushed again by auto-run on
 * every edit anywhere upstream (invariant 4). So the node is a tap — it passes its neurons on
 * unchanged and can sit mid-chain — and every param is presentational, none of them able to change
 * what `evaluate` returns.
 *
 * Several targets, a tab each (`targets.ts`): a FlyTable/SeaTable table, a Clio dataset or a CSV
 * file on this computer. A
 * selection mixing datasets is routed to each tab by its `serves` (`routing.ts`); a neuron no tab
 * serves is counted rather than written under somebody else's id.
 */

import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { readSpecs, specConfig, specLabel } from './targets'

export const editorNode = packNode({
  type: 'annotation:editor',
  label: 'Annotate',
  category: 'utility',
  cardWidth: 520,
  description:
    'Edit the annotations of a selection of neurons in FlyTable, SeaTable, Clio or a local CSV ' +
    'file, written back as you type.',
  guide:
    'Shows the annotations of the incoming neurons, read live from FlyTable, SeaTable, Clio or a ' +
    'CSV file on your computer, ' +
    'and lets you edit them on the card. Every edit is written back immediately. Wire in any ' +
    'set of neurons, e.g. a Find Neurons result or a Scatter Plot selection; the neurons are ' +
    'passed on unchanged.',
  cost: 'cheap',

  inputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
  // Passed through, as Copy IDs and the viewers do, so the node can sit mid-chain.
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],

  params: [
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      from: 'neurons',
      default: 'neuronId',
      presentational: true,
    },
    {
      id: 'datasetColumn',
      kind: 'column',
      label: 'Dataset column',
      from: 'neurons',
      default: '',
      optional: true,
      help: 'The column saying which dataset each neuron is from, e.g. a BigClust project’s `dataset`. Used to match a tab’s Serves. Not needed for qualified ids.',
      advanced: true,
      presentational: true,
    },
    {
      // One JSON text per tab, written by the card (`targets.ts`), never typed.
      id: 'targets',
      kind: 'ids',
      label: 'Targets',
      default: [],
      advanced: true,
      presentational: true,
    },
  ],

  inferOutputs: (ctx) => ({ neurons: ctx.inputs.neurons ?? T.neurons() }),

  validate: (ctx) => {
    const specs = readSpecs(ctx.params.targets as readonly string[])
    return specs.flatMap((spec, i) => {
      const named = specConfig(spec)
      if ('config' in named) return []
      const where = specs.length > 1 ? `${specLabel(spec)} (tab ${i + 1}): ` : ''
      return [
        'refused' in named
          ? `${where}${named.refused}`
          : `${where}Set ${named.missing.join(', ')}`,
      ]
    })
  },

  evaluate: (ctx) => {
    const value = ctx.input('neurons')
    if (value === undefined)
      throw new Error('Nothing is wired into `Neurons`. Wire in a table of neurons.')
    return { neurons: value }
  },
})
