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
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { peekRootCheck, startRootCheck } from '../../data/cave/rootIds'
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
import { materializationsFor, peekMaterializations } from '../../data/cave/datastack'
import {
  ANNOTATIONS_INPUT,
  annotationIssues,
  annotationSchemaFrom,
  annotationsFrom,
} from '../lib/annotationParams'
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
      return [
        ...annotationIssues(ctx.inputs.annotations),
        ...rootDriftIssues(resolveDatasetId(family, ctx.params.version)),
      ]
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
        ...annotationsFrom(ctx.input('annotations'), ctx.inputKey('annotations')),
      }
      watchRootDrift(value)
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
      kind: 'enum',
      label: 'Materialization',
      help: 'Which materialization to query. Empty tracks the newest the datastack reports. These expire, so a pinned one eventually stops working — the card says so when it does.',
      default: '',
      /*
       * Filled from `peekMaterializations`, which is empty until the datastack has been named
       * *and* its metadata has landed. Both intermediate states are real and are said in words
       * rather than left as an empty select: a dropdown with nothing in it reads as a broken
       * control, where "name a datastack first" reads as an instruction.
       */
      options: (ctx) => {
        const datastack = String(ctx.params.datastack ?? '').trim()
        const chosen = String(ctx.params.version ?? '').trim()
        if (!datastack) return [{ value: '', label: 'Name a datastack first' }]
        const known = peekMaterializations(datastack)
        if (!known) {
          return [
            { value: '', label: 'Latest' },
            // The stored value is kept as an option while the list is unknown, which the family
            // nodes do not need to do: their listing is one call that every dataset node shares,
            // where this is per-datastack and so is absent on *every* reload. Without it a
            // pinned materialization shows an empty select for a second and reads as having been
            // forgotten.
            ...(chosen ? [{ value: chosen, label: chosen }] : []),
          ]
        }
        return [
          // Named rather than blank, for `resolveDatasetId`'s reason: a "Latest" that does not
          // say which one is a provenance question mark on every graph anyone shares.
          { value: '', label: known[0] ? `Latest (${known[0]})` : 'Latest' },
          ...known.map((v) => ({ value: String(v), label: String(v) })),
          // A pinned materialization the datastack no longer lists is kept rather than silently
          // dropped, so the select still shows what the graph says. `validate` reports it.
          ...(chosen && !known.includes(Number(chosen))
            ? [{ value: chosen, label: `${chosen} (not listed)` }]
            : []),
        ]
      },
    },
    {
      id: 'neuronTable',
      kind: 'string',
      label: 'Neuron table',
      placeholder: 'proofread_neurons',
      help: 'Any table with one row per neuron carrying a root id — a proofreading list, a nuclei table. Nothing in CAVE marks one, so it has to be named. Leave empty where the datastack has none: the Annotations source then supplies the neuron list.',
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
    /*
     * Checked before anything else on the card, because it makes everything else on the card
     * moot: `specFor` prefers the static table over a hand-registered spec — the right
     * precedence, since a shipped spec is checked and a typed one is not — so every setting here
     * is inert for a datastack that already has one. Asking for a neuron table first would be
     * answering a question that does not matter.
     */
    if (DATASTACK_SPECS.some((spec) => spec.datastack === datastack)) {
      return [
        `Coda ships a node for "${datastack}" — use it instead; this card's table and column ` +
          `settings are ignored for a datastack that already has a spec.`,
      ]
    }
    const version = String(ctx.params.version ?? '').trim()
    if (version && !Number.isInteger(Number(version))) {
      return [`"${version}" is not a materialization number — CAVE numbers them, e.g. 783`]
    }
    /*
     * A neuron table or a wired chain, but not neither: those are the only two things that can
     * say which neurons exist, and with neither the node runs and refuses. Deliberately not a
     * demand for the table — several datastacks publish no equivalent, and for those the chain
     * is the answer rather than a workaround.
     */
    if (!String(ctx.params.neuronTable ?? '').trim() && !ctx.inputs.annotations) {
      return [
        'Name a table listing this datastack\u2019s neurons (e.g. proofread_neurons), or wire ' +
          'an Annotations source to supply the neuron list',
      ]
    }
    /*
     * Undefined means the metadata has not arrived, which is not a problem to report — the same
     * silence `versionsFor` keeps for a listing in flight, since otherwise every Custom CAVE
     * card in the graph warns for the first second of every load.
     */
    const known = peekMaterializations(datastack)
    if (known && version && !known.includes(Number(version))) {
      return [
        known.length
          ? `Materialization ${version} is not on ${datastack} — it offers ${known.slice(0, 8).join(', ')}${known.length > 8 ? ', \u2026' : ''}`
          : `${datastack} reports no usable materializations`,
      ]
    }
    return [
      ...annotationIssues(ctx.inputs.annotations),
      // Through the same resolver the node's own id goes through, unpinned case included — a
      // second spelling of the `datastack:materialization` grammar is a second place to drift.
      ...rootDriftIssues(customCaveDatasetId(ctx.params)),
    ]
  },

  evaluate: async (ctx) => {
    const datastack = String(ctx.params.datastack ?? '').trim()
    if (!datastack) throw new Error('Name a datastack, e.g. flywire_fafb_public')
    const pinned = String(ctx.params.version ?? '').trim()
    /*
     * Resolved by *fetching* rather than by peeking. `evaluate` may await where inference may
     * not, so an unpinned node runs on the first press rather than failing because the metadata
     * had not landed — which is what a peek here would do, and it would look like the datastack
     * name being wrong. Both halves read one memo, so the materialization the dropdown shows and
     * the one this uses cannot disagree.
     */
    const version = pinned ? Number(pinned) : (await materializationsFor(datastack))[0]
    if (version === undefined || !Number.isInteger(version)) {
      throw new Error(
        `${datastack} reports no usable materializations. Check the datastack name, or that ` +
          `your token can see it.`,
      )
    }
    const datasetId = datasetIdFor(datastack, version)
    registerCustomCaveSpec(ctx.params)
    // Not checked against the listing, unlike the named families: a private datastack the
    // account can query need not appear in the public one, and refusing on that would make the
    // escape hatch useless for the case it exists for.
    const value = {
      kind: 'dataset',
      sourceId: 'cave',
      datasetId,
      label: `${datastack} ${version}`,
      ...annotationsFrom(ctx.input('annotations'), ctx.inputKey('annotations')),
    } satisfies DatasetValue
    watchRootDrift(value)
    return { dataset: value }
  },
})


/**
 * Ask, in the background, whether the wired annotations' root ids were still current when this
 * materialization was frozen.
 *
 * A CAVE root id is retired by any proofreading edit that touches its segment, so an annotation
 * base drifts out of step with a *pinned* materialization on its own. Nothing fails when it does:
 * the labels stop matching, those rows join to nothing, and the dataset reads as under-annotated.
 *
 * **Fired and forgotten, deliberately.** It costs a few seconds against a shared service for a
 * large base, and none of it is needed to build the value — so `evaluate` starts it and returns.
 * The answer arrives on `subscribeRootCheck`, which re-runs inference, and `validate` reads it.
 * Started once per dataset per session and cached per (segmentation, timestamp) beyond that; see
 * `data/cave/rootIds.ts`, where the answer being permanently true is what makes it cheap.
 *
 * Only CAVE, and only with annotations wired: a neuPrint id is a property on a node and does not
 * move, and a datastack's own table is materialised with the version by construction.
 */
function watchRootDrift(value: DatasetValue): void {
  if (value.sourceId !== 'cave') return
  const ids = value.annotations?.table.data[ID_COLUMN_NAME]
  if (!ids) return
  startRootCheck(value.datasetId, ids.map((cell) => idText(cell) ?? '').filter(Boolean))
}

/**
 * What that check found, as an edit-time warning — or nothing, which is the ordinary state.
 *
 * A *warning*: an id that has moved on is a fact about somebody's base rather than a mistake in
 * this graph, and the run it describes has already produced a perfectly good dataset. Refusing
 * would be refusing over data the node did not fetch.
 *
 * Keyed on the dataset id, which is all `validate` can see — so two dataset nodes on one
 * datastack and materialization with *different* annotation chains would show each other's
 * count. Uncommon, and the message says what was checked rather than whose it was.
 */
function rootDriftIssues(datasetId: string | undefined): string[] {
  const check = datasetId ? peekRootCheck(datasetId) : undefined
  if (!check || check.stale === 0) return []
  const some = check.examples.join(', ')
  const part = check.checked < check.total ? ` of the first ${check.checked.toLocaleString()}` : ''
  /*
   * Names the node that repairs it. A warning that states a problem and leaves somebody to work
   * out the remedy is half a warning — and the remedy here is not obvious, since it turns on a
   * supervoxel column most people have never had a reason to look at.
   */
  return [
    `${check.stale.toLocaleString()}${part} annotation ids are not current at this ` +
      `materialization (e.g. ${some}) — those rows will not match a neuron. Use "Update root ` +
      `IDs" to bring them forward from their supervoxel ids, or pin a materialization from ` +
      `after the base was updated.`,
  ]
}

/**
 * The dataset id this node stands for, or undefined while it cannot say.
 *
 * Empty means **latest**, the same as every family dataset node — and resolved through the same
 * peek the dropdown is built from, so the label somebody picked and the id that runs cannot
 * disagree. Unresolvable until the metadata lands, which is invariant 2's ordinary state: the
 * node publishes a Dataset type with no id for a moment and `reportSourceLearned` re-infers.
 */
function customCaveDatasetId(params: Record<string, unknown>): string | undefined {
  const datastack = String(params.datastack ?? '').trim()
  if (!datastack) return undefined
  const pinned = String(params.version ?? '').trim()
  const version = pinned ? Number(pinned) : peekMaterializations(datastack)?.[0]
  // Through `datasetIdFor`, which `splitDatasetId` is the reader for — a third spelling of the
  // `datastack:materialization` grammar is a third place it can drift.
  return version !== undefined && Number.isInteger(version)
    ? datasetIdFor(datastack, version)
    : undefined
}

function registerCustomCaveSpec(params: Record<string, unknown>): void {
  const datastack = String(params.datastack ?? '').trim()
  if (!datastack) return
  const table = String(params.neuronTable ?? '').trim()
  const view = String(params.connectionView ?? '').trim()
  registerDatastackSpec({
    datastack,
    label: datastack,
    description: 'A CAVE datastack named by hand.',
    // Absent where none was named, which is a real configuration: the chain is then the neuron
    // list. Registering regardless is what makes the datastack usable for the id-driven nodes,
    // which need a spec but never touch this table.
    ...(table
      ? {
          neurons: {
            table,
            idColumn: String(params.idColumn ?? 'pt_root_id').trim() || 'pt_root_id',
          },
        }
      : {}),
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
