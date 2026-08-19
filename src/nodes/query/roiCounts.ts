import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { requireDataset, schemasFromType } from '../lib/datasetParam'
import { idColumn } from '../lib/tableOps'

/**
 * Per-ROI synapse counts, long-form (one row per neuron × ROI).
 *
 * Long form rather than wide: it composes with GroupBy and Pivot instead of needing a
 * bespoke reshape, and the column set doesn't change with the dataset's ROI list.
 */
export const roiCountsNode = registerNode({
  type: 'neuron.roiCounts',
  label: 'ROI Counts',
  category: 'query',
  description: 'Pre/post synapse counts per ROI for the incoming neurons.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  outputs: [{ id: 'counts', label: 'Counts', type: T.table() }],

  inferOutputs: (ctx) => ({
    counts: T.table(schemasFromType(ctx.inputs.dataset).roiCounts),
  }),

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const neurons = ctx.input('neurons')
    if (!isTableValue(neurons)) throw new Error('Neurons input is not a table')

    const bodyIds = idColumn(neurons, 'bodyId')
    if (bodyIds.length === 0) throw new Error('No bodyIds in the incoming neuron table')

    ctx.progress(0.2, `${bodyIds.length} neurons`)
    const counts = await source.fetchRoiCounts({
      datasetId: dataset.datasetId,
      bodyIds,
      signal: ctx.signal,
    })

    return { counts }
  },
})
