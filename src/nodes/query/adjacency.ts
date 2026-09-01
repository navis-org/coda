import { registerNode } from '../../core/registry'
import { connectivityRequest } from '../lib/datasetParam'
import { adjacencyFor } from '../../data/queries'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { requireDataset } from '../lib/datasetParam'
import { idColumn, matrixLinksSchema, matrixToLinks } from '../lib/tableOps'

/**
 * Connection matrix between two neuron sets.
 *
 * Two inputs rather than one because the interesting question is almost always
 * "A onto B", and forcing that through a single collection would lose the grouping.
 *
 * **Two outputs describing one fetch**, which is `neuron.roiConnectivity`'s arrangement and
 * `core.pivot`'s before it. `Matrix` is what the Heatmap takes and is a dead end for every table
 * op, since a matrix carries no schema; `Links` is the same connections long, so they sort,
 * filter, join, export — and, the reason it was added, reach `Build Network` at all. Before it
 * existed a connection matrix could be drawn by the Heatmap and nothing else: no node in the
 * registry turned one back into an edge list, so a matrix was a dead end for everything that
 * thinks in links. Its columns are named for `net.build`'s pickers, which makes the two
 * dropdowns obvious rather than unnecessary — see `matrixLinksSchema` on why not unnecessary.
 *
 * `Links` is derived *from the matrix* rather than fetched again, so the two cannot disagree
 * about labels, grouping or weights — the same rule ROI Connectivity follows in the opposite
 * direction. It carries only the non-zero cells; `matrixToLinks` argues that at length, and the
 * short version is that the zeros were manufactured by the reshape rather than measured.
 *
 * `Matrix` stays first, so a link dragged off the node starts there and the footer reads `N × M`.
 */
export const adjacencyNode = registerNode({
  type: 'neuron.adjacency',
  label: 'Adjacency',
  category: 'query',
  description: 'Synapse counts from one neuron set onto another, as a matrix and a link table.',
  guide:
    'Synapse counts from one neuron set onto another, as a matrix for the Heatmap and the same connections long for everything else — Build Network above all, which a matrix could not reach before. Two inputs rather than one because the question is nearly always “A onto B”, and pushing both through a single collection would lose exactly the grouping that makes the picture readable. Links holds one row per non-zero cell: a matrix cell is 0 where nothing was found, and keeping those would make a complete graph of zero-weight links. Its columns are source, target and weight, which are the names Build Network asks for — set Target and Weight there, since its pickers take the first column that fits rather than the one that matches. Feed the matrix through Normalize first if the counts are dominated by whichever type happens to be numerous.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'sources', label: 'Sources', type: T.neurons() },
    { id: 'targets', label: 'Targets', type: T.neurons() },
  ],
  outputs: [
    { id: 'matrix', label: 'Matrix', type: T.matrix() },
    { id: 'links', label: 'Links', type: T.table(matrixLinksSchema()) },
  ],
  params: [
    {
      id: 'groupByType',
      kind: 'boolean',
      label: 'Group by type',
      help: 'On: one row/column per neuron type, weights summed. Off: one per neuron id.',
      default: true,
    },
  ],

  // Both exact before anything runs: a matrix carries no schema, and the link table's shape is
  // decided by "a matrix has two axes and a value" rather than by the data — so a picker
  // downstream of `Links` fills the moment the wire is drawn.
  inferOutputs: () => ({ matrix: T.matrix(), links: T.table(matrixLinksSchema()) }),

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
    const matrix = await adjacencyFor(source, {
      ...connectivityRequest(dataset),
      sourceIds,
      targetIds,
      groupByType: ctx.params.groupByType !== false,
      signal: ctx.signal,
    })

    return { matrix, links: matrixToLinks(matrix) }
  },
})
