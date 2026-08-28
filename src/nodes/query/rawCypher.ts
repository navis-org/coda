/**
 * Run Cypher directly against the dataset.
 *
 * The escape hatch: neuPrint's graph has far more in it than the typed query nodes expose,
 * and waiting for a node per question would make the tool useless for the question you
 * actually have. Whatever the query returns becomes a table, with column types sniffed from
 * the values.
 *
 * The awkward part is inference. `inferOutputs` must never fetch, so before the first run
 * this node cannot say what its columns are — downstream pickers would be empty forever.
 * `observesOutputSchema` closes that: the store feeds the last realised schema back in, so
 * the moment a query returns, everything downstream can see its columns. That schema is
 * runtime state and is not saved, so after a reload the node is unknown-shaped again until
 * re-run — the same lifetime as the results it describes.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { requireDataset, sourceLabel, sourceSupports } from '../lib/datasetParam'

export const rawCypherNode = registerNode({
  type: 'neuron.rawCypher',
  label: 'Cypher',
  category: 'query',
  description: 'Run a Cypher query against the dataset and return its columns as a table.',
  guide:
    'Run a custom Cypher against a neuPrint dataset. Data is returned as an ordinary table and ' +
    'everything downstream works normally, with one caveat: the server decides the shape of the ' +
    'result, so the column pickers are empty until the first run and empty again after a reload. ' +
    'Queries are sent as typed, against a shared production Neo4j that takes read-only ones only.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [{ id: 'result', label: 'Result', type: T.table() }],
  observesOutputSchema: true,
  params: [
    {
      id: 'query',
      kind: 'string',
      label: 'Cypher',
      multiline: true,
      default:
        'MATCH (n:Neuron)\nWHERE n.type = "LC4"\nRETURN n.bodyId AS neuronId, n.type, n.pre, n.post\nLIMIT 25',
      placeholder: 'MATCH (n:Neuron) RETURN n.bodyId AS neuronId LIMIT 10',
      help: 'Runs as-is against the connected dataset. Column names come back from the server.',
    },
  ],

  // The output schema is whatever the last run produced; `T.table()` with no schema until
  // then, which reads downstream as "unknown columns" rather than as an empty table.
  inferOutputs: (ctx) => ({ result: T.table(ctx.observed) }),

  validate: (ctx) => {
    const query = String(ctx.params.query ?? '').trim()
    if (!query) return ['Query is empty']
    if (!sourceSupports(ctx.inputs.dataset, 'rawQuery')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      return [`${label} has no query engine — connect a neuPrint dataset.`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.rawQuery) {
      throw new Error(`${source.label} does not support raw queries`)
    }
    const query = String(ctx.params.query ?? '').trim()
    if (!query) throw new Error('Query is empty')

    ctx.progress(0.1, 'querying')
    const result = await source.rawQuery({
      datasetId: dataset.datasetId,
      query,
      signal: ctx.signal,
    })
    if (!isTableValue(result)) throw new Error('Source returned a non-table result')
    return { result }
  },
})
