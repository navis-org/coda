import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { idColumn } from '../lib/tableOps'
import { requireDataset, schemasForDataset, schemasFromType } from '../lib/datasetParam'
import type { TraversalDirection } from '../lib/connectivityOps'
import { connectivityOutputSchema, traverseConnectivity } from '../lib/connectivityOps'

/** Above this the fan-out is worth saying out loud. A warning, never a refusal. */
const NOISY_HOPS = 3

function readDirection(raw: unknown): TraversalDirection {
  return raw === 'inputs' || raw === 'both' ? raw : 'outputs'
}

/**
 * Synaptic partners of a set of neurons, one or more hops out.
 *
 * Takes the whole neuron collection and issues one batched request per hop and direction —
 * the collection-level semantics Coda uses everywhere. A per-neuron variant would be a
 * ForEach around this node, not a different node.
 *
 * The output is an **edge list**, not a partner list: `preId → postId`, always oriented the
 * way the synapse points, with `hop` and `direction` saying how the traversal got there. See
 * `lib/connectivityOps.ts` for why the source's query-relative shape is reoriented here
 * rather than at the seam.
 */
export const connectivityNode = registerNode({
  type: 'neuron.connectivity',
  label: 'Connectivity',
  category: 'query',
  description: 'Fetch synaptic partners for the incoming neurons, one or more hops out.',
  guide:
    'Who is wired to these neurons. The output is an edge list rather than a partner list — every row is preId → postId oriented the way the synapse points, whichever direction you asked for, so Build Network downstream is correct with nothing to think about. Past one hop the traversal expands every neuron it reached, so Min weight is what keeps a two-hop query from pulling half the connectome; both is the undirected ball rather than two cones, which is what finds the neurons sharing input with your seed.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  outputs: [{ id: 'connections', label: 'Connections', type: T.table() }],
  params: [
    {
      id: 'direction',
      kind: 'enum',
      label: 'Direction',
      default: 'outputs',
      options: [
        { value: 'outputs', label: 'downstream (outputs)' },
        { value: 'inputs', label: 'upstream (inputs)' },
        { value: 'both', label: 'both (in + out)' },
      ],
    },
    {
      id: 'hops',
      kind: 'int',
      label: 'Hops',
      help: 'How many synapses out to travel. 1 is direct partners. Every neuron reached by one hop is expanded by the next, so Min weight is what keeps this bounded.',
      default: 1,
      min: 1,
      step: 1,
    },
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min weight',
      help: 'Discard connections below this synapse count. Raise it to cut noise — and, past one hop, to keep the traversal from expanding every weak partner.',
      default: 1,
      min: 1,
      step: 1,
    },
  ],

  inferOutputs: (ctx) => ({
    connections: T.table(
      connectivityOutputSchema(schemasFromType(ctx.inputs.dataset).connectivity),
    ),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    const hops = Number(ctx.params.hops ?? 1)
    const minWeight = Number(ctx.params.minWeight ?? 1)
    /*
     * A warning rather than a cap, deliberately — the same call Find Neurons makes about
     * `limit: 0`. What is worth saying is that the two params multiply: the frontier grows by
     * the average partner count each hop, and Min weight is the only thing dividing it.
     */
    if (hops >= NOISY_HOPS && minWeight <= 1) {
      issues.push(
        `${hops} hops at Min weight ${minWeight} expands every partner of every partner — this can reach a large fraction of the dataset. Raise Min weight.`,
      )
    }
    if (hops >= NOISY_HOPS && ctx.params.direction === 'both') {
      issues.push(
        `Direction "both" expands upstream and downstream at every hop, so ${hops} hops covers the undirected neighbourhood.`,
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const neurons = ctx.input('neurons')
    if (!isTableValue(neurons)) throw new Error('Neurons input is not a table')

    const bodyIds = idColumn(neurons, 'bodyId')
    if (bodyIds.length === 0) throw new Error('No bodyIds in the incoming neuron table')

    const direction = readDirection(ctx.params.direction)
    const hops = Math.max(1, Math.floor(Number(ctx.params.hops ?? 1)))
    const minWeight = Number(ctx.params.minWeight ?? 1)

    ctx.progress(0.15, `${bodyIds.length} neurons`)
    const connections = await traverseConnectivity({
      seeds: bodyIds,
      direction,
      hops,
      schema: connectivityOutputSchema(
        schemasForDataset(source, dataset.datasetId).connectivity,
      ),
      signal: ctx.signal,
      // A hop's cost is unknown until its frontier is known, so progress is per round rather
      // than per row: the fraction paces the hops and the note carries the frontier size.
      onHop: (hop, total, frontier) =>
        ctx.progress(
          0.15 + (0.8 * (hop - 1)) / total,
          total > 1 ? `hop ${hop}/${total} · ${frontier} neurons` : `${frontier} neurons`,
        ),
      fetch: (frontier, hopDirection) =>
        source.fetchConnectivity({
          datasetId: dataset.datasetId,
          bodyIds: frontier,
          direction: hopDirection,
          minWeight,
          signal: ctx.signal,
        }),
    })

    return { connections }
  },
})
