/**
 * Annotation source nodes — where a CAVE dataset's labels come from.
 *
 * Three registrations over two providers, which is the `labelsToNeurons` call made again: `SeaTable`
 * and `FlyTable` are the *same* API at two hosts, so they share an implementation and differ in
 * the host they default to and the name somebody looks for. Discoverability is the case for two;
 * the cost is paid once rather than as two clients that drift.
 *
 * **They chain.** Each has its own optional Annotations input, so `CAVEtable → FlyTable →
 * Dataset` is one socket on the dataset and a visible sequence on the canvas. Each link adds its
 * columns to the ones before it, and a later source wins a name collision — which is what makes
 * the order on screen mean something. What the chain produces *replaces* the datastack's own
 * annotations rather than adding to them; see `data/annotations/types.ts`.
 *
 * **`expensive`, all of them.** A base is tens of megabytes and the params are text fields;
 * `cheap` would fire a download per keystroke. Invariant 6 in its plainest form.
 */

import type { EvalContext } from '../../core/node'
import { registerNode } from '../../core/registry'
import type { CodaType, TableSchema } from '../../core/types'
import { T } from '../../core/types'
import type { AnnotationsValue } from '../../core/values'
import type { AnnotationRef } from '../../data/annotations'
import {
  CAVE_TABLE_PROVIDER,
  SEATABLE_PROVIDER,
  annotationProvider,
  peekRefColumns,
  refKey,
} from '../../data/annotations'
import { SEATABLE_HOSTS } from '../../data/annotations/credentials'
import { joinAnnotations, joinedSchema } from '../lib/annotationOps'
import { ANNOTATIONS_INPUT, annotationSchemaFrom } from '../lib/annotationParams'
import { refreshParam } from '../../core/node'
import { datasetRef } from '../../core/types'

/**
 * The columns this node publishes: whatever arrived, plus its own.
 *
 * **Undefined if either half is unknown**, which is the rule `peekChainColumns` states and this
 * used to break: it published the upstream's columns alone while its own ref was still
 * resolving, so every picker downstream configured against half a schema and had it change when
 * discovery landed. `peekColumns` answers `undefined` until then *by contract*, so that was the
 * common case on a cold session rather than an edge.
 *
 * A later source wins a collision, which is what makes the order on the canvas mean something.
 */
function chainSchema(
  inputType: CodaType | undefined,
  own: AnnotationRef | undefined,
): TableSchema | undefined {
  const mine = own ? peekRefColumns(own) : undefined
  if (!mine) return undefined
  const upstream = annotationSchemaFrom(inputType)
  // An unwired socket is not an unknown one: nothing upstream is a complete answer. A wired one
  // whose columns have not landed is not — publishing half a chain is the partial schema every
  // picker downstream would then be configured against.
  if (inputType?.kind === 'annotations' && !upstream) return undefined
  // The same merge `joinAnnotations` performs on the values, so the claim and the result cannot
  // disagree about which side wins a collision or where the id column sits.
  return upstream ? joinedSchema(upstream, mine) : mine
}

/** One nonce for all three provider nodes: they refresh for the same reason. */
const ANNOTATION_REFRESH = refreshParam(
  'Forces a re-read even when nothing else changed. Annotation bases are edited daily and cache keys cannot see that.',
)

// ---------------------------------------------------------------------------
// CAVE table
// ---------------------------------------------------------------------------

export const caveTableNode = registerNode({
  type: 'annotation.caveTable',
  label: 'CAVE table',
  category: 'dataset',
  description: 'Neuron labels from an annotation table inside a CAVE datastack.',
  guide:
    'Reads a CAVE annotation table — nuclei, somas, a lab’s own cell typing — and hands it to a ' +
    'Dataset as its labels. Name the datastack holding the table; wire the Dataset input only to ' +
    'read a table out of a *different* datastack than the one being annotated, since a dataset ' +
    'wired both ways round is a cycle. The table has to carry a root id column directly; the datastack’s ' +
    'built-in typing, which is keyed through a reference table, is what a Dataset uses when ' +
    'nothing is wired. Set Pivot on for a table that is one row per (neuron, kind, value) rather ' +
    'than one row per neuron.',
  cost: 'expensive',
  /*
   * The Dataset input is **optional**, and that is what keeps the ordinary wiring possible at
   * all. It was required, which made the wiring this node's own guide describes — a datastack's
   * table handed back to that datastack as its labels — a *cycle*: `Dataset → CAVE table →
   * Dataset` is two edges between one pair in opposite directions, so `topoSort` returns both
   * nodes as `cyclic` and the pair goes dark with no result and no error naming the cause.
   *
   * So the datastack is a param, and the socket is the override: wired, it names a *different*
   * datastack to read the table from, which is the cross-datastack case and the only one the
   * wire was ever needed for. Found by writing this node's first test, which is the gap
   * invariant 5's corollary records about `out.barChart`.
   */
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false },
    ANNOTATIONS_INPUT,
  ],
  outputs: [{ id: 'annotations', label: 'Annotations', type: T.annotations() }],
  params: [
    {
      id: 'datastack',
      kind: 'string',
      label: 'Datastack',
      placeholder: 'flywire_fafb_public:783',
      help: 'Datastack and materialization holding the table, as `name:number`. Ignored when a Dataset is wired, which is how a table is read from a different datastack than the one being annotated.',
      default: '',
    },
    {
      id: 'table',
      kind: 'string',
      label: 'Table',
      placeholder: 'nuclei_v1',
      help: 'Annotation table in this datastack.',
      default: '',
    },
    {
      id: 'columns',
      kind: 'string',
      label: 'Columns',
      placeholder: 'cell_type, side',
      help: 'Comma-separated columns to keep. Empty keeps everything but the id.',
      default: '',
    },
    {
      id: 'idColumn',
      kind: 'string',
      label: 'ID column',
      default: 'pt_root_id',
      help: 'Column holding the root id.',
      advanced: true,
    },
    {
      id: 'pivotOn',
      kind: 'string',
      label: 'Pivot on',
      placeholder: 'classification_system',
      help: 'For a long table: the column naming the *kind* of annotation. Its distinct values become columns. Empty means the table is already one row per neuron.',
      default: '',
      advanced: true,
    },
    {
      id: 'valueColumn',
      kind: 'string',
      label: 'Value column',
      placeholder: 'cell_type',
      help: 'With Pivot on, the column holding the annotation itself.',
      default: '',
      advanced: true,
      visibleIf: (params) => Boolean(String(params.pivotOn ?? '')),
    },
    ANNOTATION_REFRESH,
  ],

  inferOutputs: (ctx) => ({
    annotations: T.annotations(
      chainSchema(
        ctx.inputs.annotations,
        caveRef(datasetRef(ctx.inputs.dataset)?.datasetId, ctx.params),
      ),
    ),
  }),

  validate: (ctx) => {
    if (!ctx.inputs.dataset && !String(ctx.params.datastack ?? '').trim()) {
      return ['Name a datastack, e.g. flywire_fafb_public:783 — or wire one to the Dataset input']
    }
    if (!String(ctx.params.table ?? '').trim()) return ['Name an annotation table']
    if (String(ctx.params.pivotOn ?? '') && !String(ctx.params.valueColumn ?? '')) {
      return ['With Pivot on set, name the column holding the value']
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = ctx.input('dataset')
    const ref = caveRef(
      dataset?.kind === 'dataset' ? dataset.datasetId : undefined,
      ctx.params,
    )
    if (!ref) throw new Error('Name a datastack and a table, or wire a Dataset')
    return { annotations: await resolve(ctx, ref) }
  },
})

/**
 * The ref this node stands for.
 *
 * Takes a `datasetId` rather than a context, because the two callers hold different things:
 * inference has a `CodaType` and `evaluate` has a `DatasetValue`. A shape covering both would be
 * a union nobody can read, and the one field either can supply is the id.
 *
 * A wired Dataset wins over the param, which is the precedence a socket always takes here — the
 * wire is the more specific statement, and it is the one somebody made on the canvas rather than
 * in a field they may have forgotten.
 */
function caveRef(
  datasetId: string | undefined,
  params: Record<string, unknown>,
): AnnotationRef | undefined {
  const table = String(params.table ?? '').trim()
  const dataset = datasetId ?? String(params.datastack ?? '').trim()
  if (!dataset || !table) return undefined
  return {
    provider: CAVE_TABLE_PROVIDER,
    config: {
      dataset,
      table,
      idColumn: String(params.idColumn ?? 'pt_root_id').trim() || 'pt_root_id',
      pivotOn: String(params.pivotOn ?? '').trim(),
      valueColumn: String(params.valueColumn ?? '').trim(),
      columns: String(params.columns ?? '').trim(),
    },
  }
}

// ---------------------------------------------------------------------------
// SeaTable, twice
// ---------------------------------------------------------------------------

function buildSeaTableNode(spec: { key: string; label: string; host: string; guide: string }) {
  return registerNode({
    type: `annotation.${spec.key}`,
    label: spec.label,
    category: 'dataset',
    description: `Neuron labels from a ${spec.label} base.`,
    guide: spec.guide,
    cost: 'expensive',
    inputs: [ANNOTATIONS_INPUT],
    outputs: [{ id: 'annotations', label: 'Annotations', type: T.annotations() }],
    params: [
      {
        id: 'base',
        kind: 'string',
        label: 'Base',
        placeholder: 'main',
        help: 'Which base to read. The account token decides which are visible.',
        default: '',
      },
      {
        id: 'table',
        kind: 'string',
        label: 'Table',
        placeholder: 'info',
        help: 'Table inside the base.',
        default: '',
      },
      {
        id: 'columns',
        kind: 'string',
        label: 'Columns',
        placeholder: 'cell_type, side',
        help: 'Comma-separated columns to keep. Empty keeps every column — which is what is downloaded either way, since the endpoint that can select columns is not readable from a browser.',
        default: '',
      },
      {
        id: 'idColumn',
        kind: 'string',
        label: 'ID column',
        default: 'root_id',
        help: 'Column holding the neuron id. Stored as text in SeaTable, so a wide id survives exactly.',
      },
      {
        id: 'workspace',
        kind: 'string',
        label: 'Workspace',
        placeholder: '5',
        help: 'Workspace the base sits in. A base is addressed by workspace and name, and the same name can appear in two.',
        default: '',
        advanced: true,
      },
      {
        id: 'host',
        kind: 'string',
        label: 'Server',
        default: spec.host,
        help: 'SeaTable deployment. FlyTable and cloud.seatable.io are the same software with unrelated accounts, so each needs its own token.',
        advanced: true,
      },
      ANNOTATION_REFRESH,
    ],

    inferOutputs: (ctx) => ({
      annotations: T.annotations(chainSchema(ctx.inputs.annotations, seaRef(ctx.params, spec.host))),
    }),

    validate: (ctx) => {
      if (!String(ctx.params.base ?? '').trim()) return ['Name a base']
      if (!String(ctx.params.table ?? '').trim()) return ['Name a table inside the base']
      if (!String(ctx.params.workspace ?? '').trim()) {
        return ['Name the workspace the base sits in — a base is addressed by workspace and name']
      }
      return []
    },

    evaluate: async (ctx) => {
      const ref = seaRef(ctx.params, spec.host)
      if (!ref) throw new Error('Name a workspace, a base and a table')
      return { annotations: await resolve(ctx, ref) }
    },
  })
}

function seaRef(
  params: Record<string, unknown>,
  fallbackHost: string,
): AnnotationRef | undefined {
  const base = String(params.base ?? '').trim()
  const table = String(params.table ?? '').trim()
  const workspace = String(params.workspace ?? '').trim()
  if (!base || !table || !workspace) return undefined
  return {
    provider: SEATABLE_PROVIDER,
    config: {
      host: String(params.host ?? '').trim() || fallbackHost,
      workspace,
      base,
      table,
      idColumn: String(params.idColumn ?? 'root_id').trim() || 'root_id',
      columns: String(params.columns ?? '').trim(),
    },
  }
}

export const flyTableNode = buildSeaTableNode({
  key: 'flyTable',
  label: 'FlyTable',
  host: SEATABLE_HOSTS.flytable,
  guide:
    'FlyTable is the LMB’s SeaTable deployment, and it is where FlyWire’s live cell typing ' +
    'actually lives — and the only place Aedes has any at all. Reading a base takes an account ' +
    'token (Connections ▸ FlyTable) and downloads the whole table: the endpoint that can select ' +
    'columns sends no CORS headers, so a browser has to take every column. It is cached, so the ' +
    'wait is once per base.',
})

export const seaTableNode = buildSeaTableNode({
  key: 'seaTable',
  label: 'SeaTable',
  host: SEATABLE_HOSTS.seatable,
  guide:
    'The same node as FlyTable pointed at cloud.seatable.io, which is the hosted service rather ' +
    'than the LMB’s deployment — two unrelated accounts, so each needs its own token. Use this ' +
    'for a base of your own; use FlyTable for the community annotations.',
})

// ---------------------------------------------------------------------------

/**
 * Fetch one ref and join it onto whatever arrived on the input.
 *
 * The join is an outer one on `neuronId`, so a neuron annotated by only one source in the chain
 * keeps its labels rather than being dropped — which is the common case the moment two bases
 * cover different populations.
 */
async function resolve(ctx: EvalContext, ref: AnnotationRef): Promise<AnnotationsValue> {
  const provider = annotationProvider(ref.provider)
  if (!provider) throw new Error(`No annotation provider "${ref.provider}"`)

  ctx.progress(0.05, provider.label)
  /*
   * `refresh` is a nonce — the node re-runs because the number changed, and the provider has to
   * be told to skip its cache or the control spends a join and returns the same table. It was
   * not passed at all, which made a param whose help says "forces a re-read" do nothing but
   * invalidate downstream.
   */
  const table = await provider.fetch(ref, {
    ...(Number(ctx.params.refresh ?? 0) > 0 ? { refresh: true } : {}),
    onProgress: ctx.progress,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  })

  const upstream = ctx.input('annotations')
  if (upstream?.kind !== 'annotations') {
    return { kind: 'annotations', sources: [refKey(ref)], table }
  }
  return {
    kind: 'annotations',
    sources: [...upstream.sources, refKey(ref)],
    table: joinAnnotations(upstream.table, table),
  }
}
