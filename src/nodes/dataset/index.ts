/**
 * Dataset nodes — one per dataset, not one generic picker.
 *
 * The old `neuron.dataset` asked two questions before you could start: which backend, then which
 * dataset within it. Both are answerable from the node's *name*, so `Add ▶ Dataset ▶ MaleCNS`
 * replaces them and the node arrives already pointed somewhere. What is genuinely a choice — the
 * version — stays a dropdown, defaulting to the newest one the server reports.
 *
 * Every node here is built by the same factory from the table in `datasetFamilies.ts`, so a new
 * dataset is a table entry rather than a file. `Custom neuPrint` is the escape hatch for a
 * deployment or dataset the table does not know.
 */

import type { CompanionSpec } from '../../core/companion'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { DatasetValue } from '../../core/values'
import { getSource } from '../../data/source'
import { neuPrintSourceFor } from '../../data/neuprint/registry'
import { DEFAULT_SERVER, normaliseServer, serverLabel, sourceIdForServer } from '../../data/neuprint/servers'
import type { DatasetFamily } from '../lib/datasetFamilies'
import { DATASET_FAMILIES, resolveDatasetId, versionsFor } from '../lib/datasetFamilies'

/**
 * The `refresh` nonce every dataset node carries.
 *
 * Cache keys are provenance, so nothing downstream can see that a server's data changed. This is
 * the sanctioned escape hatch, and it is `advanced` because bumping it by hand is not the point —
 * the node body has a button.
 */
const REFRESH_PARAM = {
  id: 'refresh',
  kind: 'int',
  label: 'Refresh',
  help: 'Forces a re-fetch even when nothing else changed. Cache keys are provenance-based and cannot see server-side changes.',
  default: 0,
  min: 0,
  advanced: true,
} as const

/**
 * The Description card every published dataset arrives with.
 *
 * Below the node rather than beside it: a graph flows left to right, so a card to the right sits
 * where the next step of the pipeline goes and would read as part of the chain. 300px clears a
 * dataset card's own height — preview, fields and footer — with a visible gap.
 *
 * Not attached to the synthetic families: the card carries the credit and citation its publisher
 * asks for, and there is nobody to cite for a connectome generated in the browser on load.
 */
const DESCRIPTION_COMPANION: CompanionSpec = {
  type: 'dataset.description',
  from: 'dataset',
  to: 'dataset',
  offset: { x: 0, y: 300 },
}

function buildDatasetNode(family: DatasetFamily) {
  return registerNode({
    type: `dataset.${family.key}`,
    label: family.label,
    category: 'dataset',
    description: family.description,
    ...(family.synthetic ? {} : { companion: DESCRIPTION_COMPANION }),
    // Cheap: it only resolves metadata, so switching version updates every downstream column
    // picker instantly while the actual queries stay stale until Run.
    cost: 'cheap',
    outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
    params: [
      {
        id: 'version',
        kind: 'enum',
        label: 'Version',
        help: 'Which release of this dataset to query. Empty tracks the newest the server reports.',
        default: '',
        options: () => {
          const versions = versionsFor(family)
          const latest = versions[0]
          return [
            // Named, not blank: "Latest" that does not say *which* version is a provenance
            // question mark on every graph anyone shares.
            { value: '', label: latest?.version ? `Latest (${latest.version})` : 'Latest' },
            // A dataset whose id carries no version (mushroombody) has nothing to pin, and an
            // option sharing the empty value with "Latest" is a select with two identical keys.
            ...versions
              .filter((v) => v.version)
              .map((v) => ({ value: v.version, label: v.label })),
          ]
        },
      },
      REFRESH_PARAM,
    ],

    inferOutputs: (ctx) => ({
      dataset: T.dataset(family.sourceId, resolveDatasetId(family, ctx.params.version)),
    }),

    validate: (ctx) => {
      const source = getSource(family.sourceId)
      if (!source) return [`Data source "${family.sourceId}" is not registered`]
      const versions = versionsFor(family)
      // Empty means the listing has not arrived (or failed); that is the connection panel's
      // story to tell, not a per-node error on every dataset node in the graph.
      if (versions.length === 0) return []
      const chosen = String(ctx.params.version ?? '')
      if (chosen && !versions.some((v) => v.version === chosen)) {
        return [`${family.label} ${chosen} is not on this server — it offers ${versions.map((v) => v.version).join(', ')}`]
      }
      return []
    },

    evaluate: async (ctx) => {
      const source = ctx.resolveSource(family.sourceId)
      // Populates the synchronous peek cache the version dropdown reads from.
      const datasets = await source.listDatasets(ctx.signal)
      const datasetId = resolveDatasetId(family, ctx.params.version)
      const info = datasets.find((d) => d.id === datasetId)
      if (!info) {
        throw new Error(
          `${family.label}: no dataset "${datasetId ?? '(none)'}" on ${source.label}. Available: ${datasets.map((d) => d.id).join(', ')}`,
        )
      }
      const value: DatasetValue = {
        kind: 'dataset',
        sourceId: family.sourceId,
        datasetId: info.id,
        label: info.label,
      }
      return { dataset: value }
    },
  })
}

export const datasetNodes = DATASET_FAMILIES.map(buildDatasetNode)

/**
 * Any neuPrint deployment, any dataset.
 *
 * Exists because the family table is static: a dataset Janelia adds tomorrow, a private
 * deployment, or a version this build has never heard of all land here. The `server` field is a
 * *deployment* URL rather than a base path — `servers.ts` maps it to something a browser can
 * actually fetch, which is not the same string, because neuPrint sends no CORS headers.
 */
export const customNeuPrintNode = registerNode({
  type: 'dataset.neuprint',
  label: 'Custom neuPrint',
  category: 'dataset',
  description: 'Any neuPrint deployment and dataset, named by hand.',
  companion: DESCRIPTION_COMPANION,
  cost: 'cheap',
  outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  params: [
    {
      id: 'server',
      kind: 'string',
      label: 'Server',
      placeholder: DEFAULT_SERVER,
      help: 'neuPrint deployment URL. Anything other than the default needs a proxy that can reach it; `pnpm dev` provides one.',
      default: DEFAULT_SERVER,
    },
    {
      id: 'dataset',
      kind: 'string',
      label: 'Dataset',
      placeholder: 'hemibrain:v1.2.1',
      help: 'Dataset id exactly as the server names it, version included.',
      default: '',
    },
    REFRESH_PARAM,
  ],

  inferOutputs: (ctx) => {
    const server = normaliseServer(String(ctx.params.server ?? ''))
    // Registers the source if this is the first sight of the deployment. Synchronous and
    // network-free, which is what makes it safe to call from inference.
    neuPrintSourceFor(server)
    const datasetId = String(ctx.params.dataset ?? '').trim()
    return {
      dataset: T.dataset(sourceIdForServer(server), datasetId || undefined),
    }
  },

  validate: (ctx) => {
    const datasetId = String(ctx.params.dataset ?? '').trim()
    if (!datasetId) return ['Name a dataset, e.g. hemibrain:v1.2.1']
    const source = neuPrintSourceFor(normaliseServer(String(ctx.params.server ?? '')))
    const available = source.peekDatasets()
    // Undefined means the listing has not arrived; only complain once it has.
    if (available && !available.some((d) => d.id === datasetId)) {
      return [`No dataset "${datasetId}" on ${serverLabel(source.server)}`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const server = normaliseServer(String(ctx.params.server ?? ''))
    const registered = neuPrintSourceFor(server)
    const source = ctx.resolveSource(registered.id)
    const datasetId = String(ctx.params.dataset ?? '').trim()
    if (!datasetId) throw new Error('No dataset named')

    const datasets = await source.listDatasets(ctx.signal)
    const info = datasets.find((d) => d.id === datasetId)
    if (!info) {
      throw new Error(
        `No dataset "${datasetId}" on ${serverLabel(server)}. Available: ${datasets.map((d) => d.id).join(', ')}`,
      )
    }
    const value: DatasetValue = {
      kind: 'dataset',
      sourceId: registered.id,
      datasetId: info.id,
      label: info.label,
    }
    return { dataset: value }
  },
})
