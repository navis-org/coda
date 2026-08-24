import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { TableValue } from '../../core/values'
import { getColumn, selectRows } from '../../core/values'
import { ROI_COMPLETENESS_SCHEMA, capabilityOf } from '../../data/source'
import { requireDataset, sourceLabel, sourceSupports } from '../lib/datasetParam'

/**
 * How completely each region of a dataset has been reconstructed.
 *
 * The one query node here that asks about the *volume* rather than about neurons: no neuron id
 * list, no pattern, nothing wired but a Dataset. neuPrint precomputes it, so a whole connectome
 * comes back in 9 kB for hemibrain — the answer to "where in here can I trust the numbers?",
 * which is otherwise not askable at all.
 *
 * Each row pairs the synapses belonging to reconstructed neurons with the synapses that are
 * there at all. The gap is real and large: hemibrain is 91% complete on presynaptic sites and
 * 39% on postsynaptic ones, and a connectivity result from a region at the bottom of that
 * range means something quite different from one at the top.
 *
 * **`Primary regions only` defaults to on, and that default is the whole node.** The published
 * list *nests* — hemibrain returns `AL(R)` and `AL-DA1(R)` as sibling rows, male-CNS returns
 * 5,412 rows that are mostly medulla columns inside `ME(R)` — so a Bar Chart or a Group By over
 * the raw table double counts, silently and plausibly. Summing hemibrain's totals unfiltered
 * gives 21.0M presynaptic sites against a true 9.43M — a 2.2x overcount, and the true figure is
 * the one that matches `Meta.totalPreCount`. The filter is a param rather than a fixed
 * rule because the nested rows are real data and somebody comparing sub-regions of one antennal
 * lobe wants exactly them; what they must not be is the *default*.
 */
export const roiCompletenessNode = registerNode({
  type: 'neuron.roiCompleteness',
  label: 'ROI Completeness',
  category: 'query',
  description:
    'How completely each region of the dataset has been reconstructed: traced synapses against the total present.',
  guide:
    'How completely each region has been reconstructed as a percentage of pre- and postsynapses associated with proofread neurons.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [
    { id: 'completeness', label: 'Completeness', type: T.table(ROI_COMPLETENESS_SCHEMA) },
  ],
  params: [
    {
      id: 'primaryOnly',
      kind: 'boolean',
      label: 'Primary regions only',
      help: 'Keep only the regions that tile the volume. The published list nests — a synapse in AL-DA1(R) is counted again in AL(R) — so totalling the full table double counts.',
      default: true,
    },
  ],

  /*
   * Fixed, and known before anything runs — unlike most query nodes here, whose columns depend
   * on what schema discovery found. Every source that can answer this answers it in the same
   * terms, so a column picker downstream is populated the moment the wire is made.
   */
  inferOutputs: () => ({ completeness: T.table(ROI_COMPLETENESS_SCHEMA) }),

  validate: (ctx) => {
    if (!sourceSupports(ctx, 'roiSummary')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      return [`${label} does not publish a per-region completeness summary`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const fetch = source.fetchRoiCompleteness?.bind(source)
    if (!fetch || !capabilityOf(source, dataset.datasetId, 'roiSummary')) {
      throw new Error(`${source.label} does not publish a per-region completeness summary`)
    }

    ctx.progress(0.2, 'regions')
    const table = await fetch({ datasetId: dataset.datasetId, signal: ctx.signal })

    if (ctx.params.primaryOnly === false) return { completeness: table }
    return { completeness: primaryRows(table) }
  },
})

/**
 * Keep the rows that tile the volume.
 *
 * A null `primary` is kept, not dropped, and that is the load-bearing case. Null means the
 * source could not say — `Meta.primaryRois` had not arrived — which is a different answer from
 * "this region nests inside another one". Dropping those would empty the table on a dataset
 * whose metadata is merely late, and an empty result reads as a dataset with no regions rather
 * than as an answer nobody has yet. The nested rows are still there to be seen; what is lost is
 * only the promise that totalling them is safe, and that is what the column is for.
 */
function primaryRows(table: TableValue): TableValue {
  const primary = getColumn(table, 'primary')
  const keep: number[] = []
  for (let row = 0; row < table.length; row++) {
    if (primary[row] !== false) keep.push(row)
  }
  // The same value back when nothing was cut, so an unfiltered run costs no copy and the
  // provenance key upstream keeps its identity.
  return keep.length === table.length ? table : selectRows(table, keep)
}
