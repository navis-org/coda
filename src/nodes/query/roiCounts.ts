import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  requireDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
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
  guide:
    'Where these neurons put their synapses: one row per neuron per region, pre and post counted separately. Long form rather than wide, so it composes with Group By and Pivot instead of needing a reshape of its own, and so the column set does not change with the dataset’s region list. Note that neuPrint’s region counts nest — a synapse in LO(R) is counted again in OL(R) — so summing across every region roughly doubles the total.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  outputs: [{ id: 'counts', label: 'Counts', type: T.table() }],

  inferOutputs: (ctx) => ({
    counts: T.table(schemasFromType(ctx.inputs.dataset).roiCounts),
  }),

  /*
   * Gated like the two volume-level ROI nodes beside it, and it was the one that was not — so a
   * source with no per-region counts said nothing at edit time and failed at Run. `sourceSupports`
   * answers true for an unwired socket, which is what keeps a node that has not been given a
   * dataset from complaining about one.
   */
  validate: (ctx) => {
    if (!sourceSupports(ctx, 'roiCounts')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      return [`${label} does not publish per-region synapse counts`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const neurons = ctx.input('neurons')
    if (!isTableValue(neurons)) throw new Error('Neurons input is not a table')

    const neuronIds = idColumn(neurons, 'neuronId')
    if (neuronIds.length === 0) throw new Error('No neuronIds in the incoming neuron table')

    if (!source.fetchRoiCounts) {
      throw new Error(`${source.label} does not publish per-region synapse counts`)
    }

    ctx.progress(0.2, `${neuronIds.length} neurons`)
    const counts = await source.fetchRoiCounts({
      datasetId: dataset.datasetId,
      neuronIds,
      signal: ctx.signal,
    })

    return { counts }
  },
})
