import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  ANY_OPTION,
  datasetInfoFromType,
  requireDataset,
  schemasFromType,
} from '../lib/datasetParam'

/**
 * Find neurons matching a pattern. The workhorse entry query.
 *
 * Expensive: it hits the backend, so it goes stale on edit and waits for Run rather than
 * firing a query on every keystroke in the type field.
 */
export const findNeuronsNode = registerNode({
  type: 'neuron.findNeurons',
  label: 'Find Neurons',
  category: 'query',
  description: 'Search a dataset for neurons by type, instance, status, size or ROI.',
  guide:
    'The workhorse query: narrow a dataset down to the neurons you mean, by type, instance, status, synapse count or region. Patterns are regular expressions and neuPrint anchors them at both ends, so LC.* matches LC4 but not LPLC1 — that is Neo4j’s behaviour rather than ours. The limit defaults to 0, meaning everything, which is deliberate and worth respecting: these queries run against a shared production server.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
  params: [
    {
      id: 'typePattern',
      kind: 'string',
      label: 'Type',
      placeholder: 'e.g. LC.* or ^KC',
      help: 'Regular expression matched against the neuron type. Empty matches everything.',
      default: '',
    },
    {
      id: 'status',
      kind: 'enum',
      label: 'Status',
      default: 'Traced',
      options: (ctx) => {
        const info = datasetInfoFromType(ctx.inputs.dataset)
        const statuses = info?.statuses ?? ['Traced']
        return [ANY_OPTION, ...statuses.map((s) => ({ value: s, label: s }))]
      },
    },
    {
      id: 'roi',
      kind: 'enum',
      label: 'In ROI',
      help: 'Restrict to neurons with synapses in this ROI.',
      default: '',
      advanced: true,
      options: (ctx) => {
        const info = datasetInfoFromType(ctx.inputs.dataset)
        return [ANY_OPTION, ...(info?.rois ?? []).map((r) => ({ value: r, label: r }))]
      },
    },
    {
      id: 'instancePattern',
      kind: 'string',
      label: 'Instance',
      placeholder: 'regex',
      default: '',
      advanced: true,
    },
    {
      id: 'minSize',
      kind: 'int',
      label: 'Min size',
      help: 'Minimum voxel count — a cheap proxy for filtering out fragments.',
      default: 0,
      min: 0,
      step: 10_000,
      advanced: true,
    },
    {
      id: 'limit',
      kind: 'int',
      label: 'Limit',
      help: '0 returns everything that matches.',
      default: 0,
      min: 0,
      step: 10,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => ({
    neurons: T.neurons(schemasFromType(ctx.inputs.dataset).neurons),
  }),

  validate: (ctx) => {
    const pattern = ctx.params.typePattern
    if (typeof pattern === 'string' && pattern) {
      try {
        new RegExp(pattern)
      } catch (err) {
        return [`Invalid type regex: ${(err as Error).message}`]
      }
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const status = String(ctx.params.status ?? '')

    ctx.progress(0.1, 'querying')
    const neurons = await source.findNeurons({
      datasetId: dataset.datasetId,
      typePattern: String(ctx.params.typePattern ?? '') || undefined,
      instancePattern: String(ctx.params.instancePattern ?? '') || undefined,
      statuses: status ? [status] : undefined,
      minSize: Number(ctx.params.minSize ?? 0) || undefined,
      roi: String(ctx.params.roi ?? '') || undefined,
      limit: Number(ctx.params.limit ?? 0) || undefined,
      signal: ctx.signal,
    })

    if (!isTableValue(neurons)) throw new Error('Source returned a non-table result')
    return { neurons }
  },
})
