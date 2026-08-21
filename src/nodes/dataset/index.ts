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
import {
  DEFAULT_SERVER,
  normaliseServer,
  serverLabel,
  sourceIdForServer,
} from '../../data/neuprint/servers'
import type { DatasetFamily } from '../lib/datasetFamilies'
import {
  BACKENDS,
  DATASET_FAMILIES,
  familyLabel,
  resolveDatasetId,
  versionsFor,
} from '../lib/datasetFamilies'
import { DATASTACK_SPECS, datasetIdFor, registerDatastackSpec } from '../../data/cave/spec'
import { ANNOTATIONS_INPUT, annotationSchemaFrom, annotationsFrom } from '../lib/annotationParams'
import { refreshParam } from '../../core/node'

/** The `refresh` nonce every dataset node carries. See `refreshParam`. */
const REFRESH_PARAM = refreshParam(
  'Forces a re-fetch even when nothing else changed. Cache keys are provenance-based and cannot see server-side changes.',
)

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
    // The backend is part of the name, because one dataset can be published on more than one and
    // they do not behave alike — see `familyLabel`. The *type id* is untouched: it is what a
    // saved graph carries, and renaming one would drop the node from every file that has it.
    label: familyLabel(family),
    category: 'dataset',
    description: family.description,
    guide: family.guide,
    ...(family.synthetic ? {} : { companion: DESCRIPTION_COMPANION }),
    // Cheap: it only resolves metadata, so switching version updates every downstream column
    // picker instantly while the actual queries stay stale until Run.
    cost: 'cheap',
    // Only the backends whose labels come from a table — see `DatasetBackend.acceptsAnnotations`.
    ...(BACKENDS[family.backend]?.acceptsAnnotations ? { inputs: [ANNOTATIONS_INPUT] } : {}),
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
      dataset: T.dataset(
        family.sourceId,
        resolveDatasetId(family, ctx.params.version),
        annotationSchemaFrom(ctx.inputs.annotations),
      ),
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
        return [
          `${familyLabel(family)} ${chosen} is not on this server — it offers ${versions.map((v) => v.version).join(', ')}`,
        ]
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
          `${familyLabel(family)}: no dataset "${datasetId ?? '(none)'}" on ${source.label}. Available: ${datasets.map((d) => d.id).join(', ')}`,
        )
      }
      const value: DatasetValue = {
        kind: 'dataset',
        sourceId: family.sourceId,
        datasetId: info.id,
        label: info.label,
        ...annotationsFrom(ctx.input('annotations')),
      }
      return { dataset: value }
    },
  })
}

/**
 * `Custom CAVE` — a datastack named by hand, and the CAVE twin of `Custom neuPrint`.
 *
 * It has to carry more than its neuPrint counterpart, and the reason is the difference between
 * the two backends rather than an inconsistency. A neuPrint dataset id is enough to query,
 * because the server knows what a `:Neuron` is; a CAVE datastack is a bag of tables with no
 * privileged one, so the node has to say which of them is the neuron set — which is exactly what
 * `DATASTACK_SPECS` says for the datastacks Coda ships an entry for. `registerDatastackSpec`
 * takes it from the params.
 *
 * The rest is left off deliberately. Annotations come from whatever is wired to the Annotations
 * socket, so there is nothing to name here; connectivity needs a server-side roll-up view, which
 * a datastack either publishes or does not, and naming one that is not there would turn a clean
 * refusal into a 404. Both are `advanced` params rather than absent, because somebody who knows
 * their datastack has them should not need a code change.
 */
export const customCaveNode = registerNode({
  type: 'dataset.cave',
  label: 'Custom CAVE',
  category: 'dataset',
  description: 'Any CAVE datastack and materialization, named by hand.',
  guide:
    'The escape hatch for a CAVE datastack Coda ships no node for. Unlike its neuPrint twin it ' +
    'needs more than a name: a datastack is a segmentation plus whatever tables somebody ' +
    'attached to it, with nothing marking one of them as the neurons — so name that table and ' +
    'the column its root ids are in. Annotations come from an Annotations source wired to the ' +
    'socket rather than from here. Version is a materialization number, and materializations ' +
    'expire, so pin one you have checked.',
  companion: DESCRIPTION_COMPANION,
  cost: 'cheap',
  inputs: [ANNOTATIONS_INPUT],
  outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  params: [
    {
      id: 'datastack',
      kind: 'string',
      label: 'Datastack',
      placeholder: 'flywire_fafb_public',
      help: 'Datastack name exactly as the CAVE info service lists it.',
      default: '',
    },
    {
      id: 'version',
      kind: 'string',
      label: 'Materialization',
      placeholder: '783',
      help: 'Materialization number. These expire — pin one you have checked.',
      default: '',
    },
    {
      id: 'neuronTable',
      kind: 'string',
      label: 'Neuron table',
      placeholder: 'proofread_neurons',
      help: 'The table listing this datastack’s neurons. Nothing in CAVE marks one, so it has to be named.',
      default: '',
      advanced: true,
    },
    {
      id: 'idColumn',
      kind: 'string',
      label: 'ID column',
      placeholder: 'pt_root_id',
      help: 'Column holding the root id. `pt_root_id` on every CAVE table Coda has seen.',
      default: 'pt_root_id',
      advanced: true,
    },
    {
      id: 'connectionView',
      kind: 'string',
      label: 'Connection view',
      placeholder: 'valid_connection_v2',
      help: 'A server-side roll-up of synapses into connections, if this datastack publishes one. Without it, Connectivity declines.',
      default: '',
      advanced: true,
    },
    REFRESH_PARAM,
  ],

  inferOutputs: (ctx) => {
    const datasetId = customCaveDatasetId(ctx.params)
    // Registers the spec if this is the first sight of the datastack. Synchronous and
    // network-free, which is what makes it safe from inference — `neuPrintSourceFor`'s rule.
    registerCustomCaveSpec(ctx.params)
    return {
      dataset: T.dataset(
        'cave',
        datasetId,
        annotationSchemaFrom(ctx.inputs.annotations),
      ),
    }
  },

  validate: (ctx) => {
    const datastack = String(ctx.params.datastack ?? '').trim()
    if (!datastack) return ['Name a datastack, e.g. flywire_fafb_public']
    const version = String(ctx.params.version ?? '').trim()
    if (!version) return ['Name a materialization, e.g. 783']
    if (!Number.isInteger(Number(version))) {
      return [`"${version}" is not a materialization number — CAVE numbers them, e.g. 783`]
    }
    if (!String(ctx.params.neuronTable ?? '').trim()) {
      return ['Name the table listing this datastack’s neurons, e.g. proofread_neurons']
    }
    /*
     * A built-in datastack wins, and silently. `specFor` prefers the static table over anything
     * registered by hand, which is the right precedence — a shipped node's spec is checked and a
     * typed one is not — but it makes every setting on this card inert while the card still shows
     * them being edited. That reads as the fields not working, so it is said rather than fixed:
     * the node those settings belong to is one menu entry away.
     */
    if (DATASTACK_SPECS.some((spec) => spec.datastack === datastack)) {
      return [
        `Coda ships a node for "${datastack}" — use it instead; this card’s table and column ` +
          `settings are ignored for a datastack that already has a spec.`,
      ]
    }
    return []
  },

  evaluate: async (ctx) => {
    const datasetId = customCaveDatasetId(ctx.params)
    if (!datasetId) throw new Error('Name a datastack and a materialization')
    registerCustomCaveSpec(ctx.params)
    // Not checked against the listing, unlike the named families: a private datastack the
    // account can query need not appear in the public one, and refusing on that would make the
    // escape hatch useless for the case it exists for.
    return {
      dataset: {
        kind: 'dataset',
        sourceId: 'cave',
        datasetId,
        label: `${String(ctx.params.datastack ?? '')} ${String(ctx.params.version ?? '')}`.trim(),
        ...annotationsFrom(ctx.input('annotations')),
      } satisfies DatasetValue,
    }
  },
})

function customCaveDatasetId(params: Record<string, unknown>): string | undefined {
  const datastack = String(params.datastack ?? '').trim()
  const version = Number(String(params.version ?? '').trim())
  // Through `datasetIdFor`, which `splitDatasetId` is the reader for — a third spelling of the
  // `datastack:materialization` grammar is a third place it can drift.
  return datastack && Number.isInteger(version) ? datasetIdFor(datastack, version) : undefined
}

function registerCustomCaveSpec(params: Record<string, unknown>): void {
  const datastack = String(params.datastack ?? '').trim()
  const table = String(params.neuronTable ?? '').trim()
  if (!datastack || !table) return
  const view = String(params.connectionView ?? '').trim()
  registerDatastackSpec({
    datastack,
    label: datastack,
    description: 'A CAVE datastack named by hand.',
    neurons: { table, idColumn: String(params.idColumn ?? 'pt_root_id').trim() || 'pt_root_id' },
    ...(view
      ? {
          connections: {
            view,
            preColumn: 'pre_pt_root_id',
            postColumn: 'post_pt_root_id',
            weightColumn: 'n_syn',
          },
        }
      : {}),
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
  guide:
    'The escape hatch for a dataset Coda ships no node for: a release newer than this build, a ' +
    'private deployment, or a neuPrint instance somewhere else entirely. Type the server and the ' +
    'dataset id exactly as that server names it, version included. Note that Server here means a ' +
    'neuPrint deployment, not the Base URL override under Connections — the two are different ' +
    'settings and naming one does not set the other.',
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
