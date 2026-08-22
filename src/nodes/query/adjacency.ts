import { registerNode } from '../../core/registry'
import { datasetRequest } from '../lib/datasetParam'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { requireDataset } from '../lib/datasetParam'
import { idColumn } from '../lib/tableOps'

/**
 * Connection matrix between two neuron sets.
 *
 * Two inputs rather than one because the interesting question is almost always
 * "A onto B", and forcing that through a single collection would lose the grouping.
 */
export const adjacencyNode = registerNode({
  type: 'neuron.adjacency',
  label: 'Adjacency',
  category: 'query',
  description: 'Synapse counts from one neuron set onto another, as a matrix.',
  guide:
    'Synapse counts from one neuron set onto another, as a matrix ready for the Heatmap. Two inputs rather than one because the question is nearly always “A onto B”, and pushing both through a single collection would lose exactly the grouping that makes the picture readable. Feed it through Normalize first if the counts are dominated by whichever type happens to be numerous.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'sources', label: 'Sources', type: T.neurons() },
    { id: 'targets', label: 'Targets', type: T.neurons() },
  ],
  outputs: [{ id: 'matrix', label: 'Matrix', type: T.matrix() }],
  params: [
    {
      id: 'groupByType',
      kind: 'boolean',
      label: 'Group by type',
      help: 'On: one row/column per neuron type, weights summed. Off: one per neuron id.',
      default: true,
    },
  ],

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const sources = ctx.input('sources')
    const targets = ctx.input('targets')
    if (!isTableValue(sources)) throw new Error('Sources input is not a table')
    if (!isTableValue(targets)) throw new Error('Targets input is not a table')

    const sourceIds = idColumn(sources, 'neuronId')
    const targetIds = idColumn(targets, 'neuronId')
    if (sourceIds.length === 0) throw new Error('Sources table has no neuronIds')
    if (targetIds.length === 0) throw new Error('Targets table has no neuronIds')

    ctx.progress(0.2, `${sourceIds.length} × ${targetIds.length}`)
    const matrix = await source.fetchAdjacency({
      ...datasetRequest(dataset),
      sourceIds,
      targetIds,
      groupByType: ctx.params.groupByType !== false,
      signal: ctx.signal,
    })

    return { matrix }
  },
})
