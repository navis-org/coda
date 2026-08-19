import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { DatasetValue } from '../../core/values'
import { allSources, getSource } from '../../data/source'
import { resolveDatasetId, resolveSourceId } from '../lib/datasetParam'

/**
 * The original generic dataset picker: choose a backend, then a dataset within it.
 *
 * **Superseded by the per-dataset nodes in `src/nodes/dataset/`,** which arrive already pointed
 * at something and ask only for a version. Kept registered, and `hidden`, so every graph saved
 * before that change still loads with its params intact — an unregistered type renders as
 * "Unknown node" and loses them.
 */
export const datasetNode = registerNode({
  type: 'neuron.dataset',
  label: 'Dataset (generic)',
  category: 'dataset',
  description: 'Select a data source and dataset. Superseded by the per-dataset nodes.',
  hidden: true,
  cost: 'cheap',
  outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  params: [
    {
      id: 'source',
      kind: 'enum',
      label: 'Source',
      help: 'Which backend to query. neuPrint arrives behind this same interface.',
      default: '',
      options: () => allSources().map((s) => ({ value: s.id, label: s.label })),
    },
    {
      id: 'dataset',
      kind: 'enum',
      label: 'Dataset',
      default: '',
      options: (ctx) => {
        const sourceId = resolveSourceId(ctx.params.source)
        const datasets = getSource(sourceId)?.peekDatasets() ?? []
        return datasets.map((d) => ({ value: d.id, label: d.label }))
      },
    },
    {
      id: 'refresh',
      kind: 'int',
      label: 'Refresh',
      help: 'Bumped by the Refresh button. Forces a re-fetch even when nothing else changed — needed because cache keys are provenance-based and cannot see server-side changes.',
      default: 0,
      min: 0,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => {
    const sourceId = resolveSourceId(ctx.params.source)
    const datasetId = resolveDatasetId(sourceId, ctx.params.dataset)
    return { dataset: T.dataset(sourceId, datasetId) }
  },

  validate: (ctx) => {
    const sourceId = resolveSourceId(ctx.params.source)
    const source = getSource(sourceId)
    if (!source) return [`Data source "${sourceId}" is not registered`]
    if (!resolveDatasetId(sourceId, ctx.params.dataset)) {
      return [`No datasets available from ${source.label}`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const sourceId = resolveSourceId(ctx.params.source)
    const source = ctx.resolveSource(sourceId)
    // Populates the synchronous peek cache that edit-time enums read from.
    const datasets = await source.listDatasets(ctx.signal)
    const datasetId = resolveDatasetId(sourceId, ctx.params.dataset)
    const info = datasets.find((d) => d.id === datasetId)
    if (!info) {
      throw new Error(
        `Dataset "${datasetId ?? '(none)'}" not found in ${source.label}. Available: ${datasets.map((d) => d.id).join(', ')}`,
      )
    }
    const value: DatasetValue = {
      kind: 'dataset',
      sourceId,
      datasetId: info.id,
      label: info.label,
    }
    return { dataset: value }
  },
})
