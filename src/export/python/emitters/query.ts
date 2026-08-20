/**
 * The dataset and query nodes, in neuprint-python.
 *
 * Every signature here was read off neuprint-python 0.6.3 and navis 2.0 rather than recalled,
 * which is worth stating because two of them are not what an experienced user would guess:
 * `fetch_neurons` returns a **pair** (neurons, roi_counts), and there is no `fetch_mesh_neuron`
 * in neuprint at all — meshes come from `navis.interfaces.neuprint`, which is also where the
 * level-of-detail argument Coda's `Detail` param maps onto lives.
 */

import {
  DATASET_FAMILIES,
  datasetFamily,
  resolveDatasetId,
} from '../../../nodes/lib/datasetFamilies'
import { parseIdList } from '../../../nodes/lib/idList'
import { parseTypedLabels } from '../../../nodes/lib/labelLookup'
import { pyLongList, pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

/** What "neuPrint" means unless a node says otherwise. */
const DEFAULT_DEPLOYMENT = 'https://neuprint.janelia.org'
import { bodyIds } from './common'

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/**
 * A `Client(...)` binding.
 *
 * One per dataset node, and every fetch names it. neuprint-python has a global default client
 * that every call would find, which reads more tidily and is wrong the moment a graph carries
 * two datasets: the second `Client(...)` silently becomes the default and every earlier query
 * starts answering from the other connectome. Passing `client=` costs one kwarg and cannot do
 * that.
 */
function clientLines(
  ctx: EmitContext,
  out: string,
  server: string,
  datasetId: string,
): string[] {
  ctx.require('os')
  ctx.require('neuprint', 'Client')
  return [
    `${out} = Client(`,
    `    ${pyStr(server.replace(/^https?:\/\//, ''))},`,
    `    dataset=${pyStr(datasetId)},`,
    `    token=os.environ['NEUPRINT_APPLICATION_CREDENTIALS'],`,
    `)`,
  ]
}

/**
 * One `Client` per dataset node, and every fetch names it.
 *
 * neuprint-python has a global default client and every call would find it, which is tidier
 * to read and wrong the moment a graph carries two datasets — a second `Client(...)` silently
 * becomes the default and every earlier query starts answering from the other connectome.
 * Passing `client=` costs one kwarg and cannot do that.
 */
function emitDataset(ctx: EmitContext, familyKey: string): string[] {
  const family = datasetFamily(familyKey)
  if (!family) return ctx.todo(`Unknown dataset family "${familyKey}".`)

  const out = ctx.output('dataset')

  const version = ctx.params.version
  const resolved = resolveDatasetId(family, version)
  const lines: string[] = []

  let datasetId = resolved
  if (!datasetId) {
    // The listing is what turns "Latest" into a version, and it is a network call the
    // exporter has not made. Naming the family alone still connects; leaving it silent would
    // put an unpinned dataset into a file somebody shares, which is the provenance question
    // mark the version dropdown exists to close.
    datasetId = family.family
    lines.push(
      ...ctx.note(
        // Deliberately no example version. An earlier draft suggested `<family>:v1.2.3` for
        // every family, which is a version number nobody published and is simply wrong for
        // Mushroom Body, whose dataset id carries no version at all — a made-up specific is
        // worse guidance than none.
        `This node tracks the latest release and the exporter could not resolve which that ` +
          `is, so only the family is named. Set \`dataset\` to the exact release you mean ` +
          `before sharing the notebook.`,
      ),
    )
  } else if (!version) {
    lines.push(
      ...ctx.note(
        `The node is set to "Latest"; this pins the version it resolved to at export, so ` +
          `the notebook keeps answering the same question after the next release.`,
      ),
    )
  }

  const server = String(ctx.params.server ?? '') || DEFAULT_DEPLOYMENT
  lines.push(...clientLines(ctx, out, server, datasetId))
  return lines
}

for (const family of DATASET_FAMILIES) {
  if (family.synthetic) continue // Refused before the walk; see `syntheticDatasetNodes`.
  registerEmitter(`dataset.${family.key}`, (ctx) => emitDataset(ctx, family.key))
}

registerEmitter('dataset.neuprint', (ctx) => {
  // The custom node names its own deployment and dataset, so there is no family to consult.
  const datasetId = String(ctx.params.dataset ?? '')
  if (!datasetId) return ctx.todo('This neuPrint node names no dataset.')
  const server = String(ctx.params.server ?? DEFAULT_DEPLOYMENT)
  return clientLines(ctx, ctx.output('dataset'), server, datasetId)
})

// The superseded generic picker. Registered because a saved graph may still hold one.
registerEmitter('neuron.dataset', (ctx) => {
  const datasetId = String(ctx.params.dataset ?? '')
  if (!datasetId) return ctx.todo('This Dataset node names no dataset.')
  return clientLines(ctx, ctx.output('dataset'), DEFAULT_DEPLOYMENT, datasetId)
})

// ---------------------------------------------------------------------------
// Find Neurons
// ---------------------------------------------------------------------------

registerEmitter('neuron.findNeurons', (ctx) => {
  const c = ctx.wired('dataset')
  if (!c) return ctx.todo('No Dataset is wired to this Find Neurons.')

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  const out = ctx.output('neurons')

  const typePattern = String(ctx.params.typePattern ?? '')
  const instancePattern = String(ctx.params.instancePattern ?? '')
  const status = String(ctx.params.status ?? '')
  const roi = String(ctx.params.roi ?? '')
  const minSize = Number(ctx.params.minSize ?? 0)
  const limit = Number(ctx.params.limit ?? 0)

  const criteria: string[] = []
  if (typePattern) criteria.push(`type=${pyStr(typePattern)}`)
  if (instancePattern) criteria.push(`instance=${pyStr(instancePattern)}`)
  if (status) criteria.push(`status=${pyStr(status)}`)
  if (roi) criteria.push(`rois=${pyList([roi])}`)
  // `regex='guess'` is NeuronCriteria's default and it guesses from the string's shape. Coda's
  // fields are always regexes — anchored, since that is what Neo4j's `=~` does — so saying so
  // is what stops `LC4` and `LC.*` being matched by two different rules.
  if (typePattern || instancePattern) criteria.push('regex=True')
  criteria.push(`client=${c}`)

  const lines: string[] = []
  const call =
    criteria.length <= 2
      ? [`${out}, _ = fetch_neurons(NeuronCriteria(${criteria.join(', ')}), client=${c})`]
      : [
          `${out}, _ = fetch_neurons(`,
          `    NeuronCriteria(`,
          ...criteria.map((c_) => `        ${c_},`),
          `    ),`,
          `    client=${c},`,
          `)`,
        ]
  lines.push(...call)

  if (minSize > 0) {
    // NeuronCriteria has no size field, so Coda's server-side cut becomes a filter on the
    // result. Same rows, one larger response.
    lines.push(
      ...ctx.note(
        'Coda applies this size cut in the query; there is no NeuronCriteria field for it.',
      ),
      `${out} = ${out}[${out}['size'] >= ${minSize}]`,
    )
  }
  if (limit > 0) lines.push(`${out} = ${out}.head(${limit})`)
  return lines
})

// ---------------------------------------------------------------------------
// Input IDs
// ---------------------------------------------------------------------------

registerEmitter('neuron.inputIds', (ctx) => {
  const out = ctx.output('neurons')
  const parsed = parseIdList(String(ctx.params.ids ?? ''))
  const wired = ctx.input('ids')

  if (parsed.error && !wired)
    return ctx.todo(`The pasted id list is not valid: ${parsed.error}`)

  const c = ctx.wired('dataset')
  const lines: string[] = []
  const literal = parsed.ids.length > 0

  if (literal && wired) {
    ctx.require('pandas')
    const column = ctx.column('column') ?? 'bodyId'
    lines.push(
      `_ids = sorted(set(`,
      ...pyLongList(parsed.ids).map((l) => `    ${l}`),
      `) | set(${wired}[${pyStr(column)}].dropna().astype(int)))`,
    )
  } else if (wired) {
    const column = ctx.column('column') ?? 'bodyId'
    lines.push(`_ids = ${wired}[${pyStr(column)}].dropna().astype(int).tolist()`)
  } else {
    lines.push(`_ids = `.concat(pyLongList(parsed.ids).join('\n')))
  }

  if (!c) {
    // Unwired, the node is a one-column table of the ids themselves — which is enough for
    // everything downstream that reaches its ids through `bodyId` and reads nothing else.
    ctx.require('pandas')
    return [
      ...lines,
      ...ctx.note(
        'No Dataset is wired, so this is the ids alone — exactly what the node emits.',
      ),
      `${out} = pd.DataFrame({'bodyId': _ids})`,
    ]
  }

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  return [
    ...lines,
    `${out}, _ = fetch_neurons(NeuronCriteria(bodyId=_ids, client=${c}), client=${c})`,
  ]
})

// ---------------------------------------------------------------------------
// IDs from Label
// ---------------------------------------------------------------------------

registerEmitter('neuron.idsFromLabel', (ctx) => {
  const c = ctx.wired('dataset')
  if (!c) return ctx.todo('No Dataset is wired to this IDs from Label.')

  const field = ctx.column('field') || 'type'
  const typed = parseTypedLabels(ctx.params.labels)
  const wired = ctx.input('labels')
  const wiredColumn = ctx.column('column')
  const regex = String(ctx.params.match ?? 'exact') === 'regex'
  const status = String(ctx.params.status ?? '')

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  const out = ctx.output('neurons')
  const lines: string[] = []

  if (wired && wiredColumn) {
    lines.push(
      `_labels = ${typed.length > 0 ? pyList(typed) : '[]'} + ${wired}[${pyStr(wiredColumn)}].dropna().astype(str).tolist()`,
      `_labels = list(dict.fromkeys(_labels))`,
    )
  } else {
    lines.push(`_labels = ${pyList(typed)}`)
  }

  // NeuronCriteria's kwargs are the neuron's own properties, so the field chosen on the node
  // becomes the keyword. `class` is spelled `class_` in the Python API.
  const kw = field === 'class' ? 'class_' : field
  const criteria = [`${kw}=_labels`]
  if (status) criteria.push(`status=${pyStr(status)}`)
  if (regex) criteria.push('regex=True')
  criteria.push(`client=${c}`)

  if (ctx.params.ignoreCase === true) {
    lines.push(
      ...ctx.note(
        'Coda matches these labels case-insensitively; NeuronCriteria has no such flag, so ' +
          'this query is case-sensitive and may return fewer neurons.',
      ),
    )
  }

  lines.push(
    `${out}, _ = fetch_neurons(`,
    `    NeuronCriteria(${criteria.join(', ')}),`,
    `    client=${c},`,
    `)`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// Adjacency
// ---------------------------------------------------------------------------

registerEmitter('neuron.adjacency', (ctx) => {
  const c = ctx.wired('dataset')
  const sources = ctx.wired('sources')
  const targets = ctx.wired('targets')
  if (!sources || !targets) return ctx.todo('Adjacency needs both Sources and Targets wired.')

  ctx.require(
    'neuprint',
    'NeuronCriteria',
    'fetch_adjacencies',
    'merge_neuron_properties',
    'connection_table_to_matrix',
  )
  const out = ctx.output('matrix')
  const byType = ctx.params.groupByType !== false
  const group = byType ? 'type' : 'bodyId'

  return [
    `_neurons, _conn = fetch_adjacencies(`,
    `    NeuronCriteria(bodyId=${bodyIds(sources)}, client=${c}),`,
    `    NeuronCriteria(bodyId=${bodyIds(targets)}, client=${c}),`,
    `    client=${c},`,
    `)`,
    `_conn = merge_neuron_properties(_neurons, _conn, ['type'])`,
    `${out} = connection_table_to_matrix(_conn, ${pyStr(group)}, sort_by=${pyStr(group)})`,
  ]
})

// ---------------------------------------------------------------------------
// ROI Counts
// ---------------------------------------------------------------------------

registerEmitter('neuron.roiCounts', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this ROI Counts.')

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  const out = ctx.output('counts')

  return [
    // The second half of `fetch_neurons`' pair is the per-ROI breakdown, which is the whole
    // of what this node returns — one row per neuron per ROI.
    ...ctx.note(
      'These counts nest: a synapse in LO(R) is counted again in its parent OL(R). Filter ' +
        'to `fetch_primary_rois(client=...)` before summing, or the totals roughly double.',
    ),
    `_, ${out} = fetch_neurons(`,
    `    NeuronCriteria(bodyId=${bodyIds(neurons)}, client=${c}),`,
    `    client=${c},`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Raw Cypher
// ---------------------------------------------------------------------------

registerEmitter('neuron.rawCypher', (ctx) => {
  const c = ctx.wired('dataset')
  if (!c) return ctx.todo('No Dataset is wired to this Raw Cypher.')

  ctx.require('neuprint', 'fetch_custom')
  const out = ctx.output('result')
  const query = String(ctx.params.query ?? '').trim()
  if (!query) return ctx.todo('This Raw Cypher node has no query.')

  // Triple-quoted so the query keeps the shape it was written in on the canvas; a Cypher
  // query folded onto one line is unreadable and unmaintainable in the notebook.
  return [
    `${out} = fetch_custom(`,
    `    """`,
    ...query.split('\n').map((l) => `    ${l}`),
    `    """,`,
    `    client=${c},`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

registerEmitter('neuron.skeletons', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this Skeletons node.')

  // navis rather than neuprint's own `fetch_skeleton`: this returns a NeuronList of healed
  // TreeNeurons, which is the object every downstream navis call actually wants.
  ctx.require('navisNeuprint')
  const out = ctx.output('skeletons')
  const limit = Number(ctx.params.limit ?? 0)
  const ids = limit > 0 ? `${neurons}['bodyId'].head(${limit}).tolist()` : bodyIds(neurons)

  return [
    `${out} = neu.fetch_skeletons(`,
    `    ${ids},`,
    `    heal=True,`,
    `    client=${c},`,
    `)`,
  ]
})

registerEmitter('neuron.meshes', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this Meshes node.')

  ctx.require('navisNeuprint')
  const out = ctx.output('meshes')
  const limit = Number(ctx.params.limit ?? 0)
  const ids = limit > 0 ? `${neurons}['bodyId'].head(${limit}).tolist()` : bodyIds(neurons)

  return [
    // Coda's `Detail` is a triangle budget it spends across the batch, choosing the finest
    // level that fits; navis takes the level directly. `lod=1` is the usual middle ground.
    ...ctx.note(
      'Coda picks the level of detail from a triangle budget across the whole batch. navis ' +
        'takes a level, so this is a fixed one — raise `lod` for coarser, lower for finer.',
    ),
    `${out} = neu.fetch_mesh_neuron(`,
    `    ${ids},`,
    `    lod=1,`,
    `    client=${c},`,
    `)`,
  ]
})

registerEmitter('neuron.synapses', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this Synapses node.')

  ctx.require('neuprint', 'NeuronCriteria', 'SynapseCriteria', 'fetch_synapses')
  const out = ctx.output('points')
  const polarity = String(ctx.params.polarity ?? '')

  const synCriteria = [
    ...(polarity ? [`type=${pyStr(polarity)}`] : []),
    'primary_only=True',
    `client=${c}`,
  ]

  return [
    `${out} = fetch_synapses(`,
    `    NeuronCriteria(bodyId=${bodyIds(neurons)}, client=${c}),`,
    `    SynapseCriteria(${synCriteria.join(', ')}),`,
    `    client=${c},`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// ROI Completeness / ROI Connectivity
// ---------------------------------------------------------------------------

/*
 * Both cached summaries are `Client` **methods**, not module-level functions.
 *
 * Read off neuprint-python 0.6.3 by introspection: `neuprint.fetch_roi_completeness` does not
 * exist, while `Client.fetch_roi_completeness(format='pandas')` does — and neither takes a
 * dataset argument, because the client already carries one. Same class of trap as
 * `navis.interfaces.neuprint`: the obvious spelling is valid syntax, binds a name, and raises
 * at run time. It also happens to fit the "one Client per dataset node, and every fetch names
 * it" rule for free, since the call *is* on the client.
 */

registerEmitter('neuron.roiCompleteness', (ctx) => {
  const c = ctx.wired('dataset')
  const out = ctx.output('completeness')
  const primaryOnly = ctx.params.primaryOnly !== false

  return [
    // Renamed to Coda's column names, so anything downstream — a Filter, a Bar Chart — emits
    // the names its own params hold. The published ones are lowercase and unsuffixed.
    `${out} = ${c}.fetch_roi_completeness().rename(`,
    `    columns={`,
    `        'roipre': 'pre',`,
    `        'roipost': 'post',`,
    `        'totalpre': 'totalPre',`,
    `        'totalpost': 'totalPost',`,
    `    }`,
    `)`,
    // `.where` leaves NaN where the condition fails, which is the pandas spelling of Coda's
    // null. A plain division would give inf for a region with nothing in it.
    `${out}['preCompleteness'] = (${out}['pre'] / ${out}['totalPre']).where(${out}['totalPre'] > 0)`,
    `${out}['postCompleteness'] = (${out}['post'] / ${out}['totalPost']).where(${out}['totalPost'] > 0)`,
    `${out}['primary'] = ${out}['roi'].isin(${c}.primary_rois)`,
    ...(primaryOnly
      ? [
          ``,
          `# The published list nests: a synapse in AL-DA1(R) is counted again in AL(R), and`,
          `# hemibrain returns 229 rows of which 63 tile the volume. Totalling the full table`,
          `# double counts -- 21.0M presynaptic sites against a true 9.43M.`,
          `${out} = ${out}[${out}['primary']].reset_index(drop=True)`,
        ]
      : []),
  ]
})

registerEmitter('neuron.roiConnectivity', (ctx) => {
  const c = ctx.wired('dataset')
  const links = ctx.output('links')
  const matrix = ctx.output('matrix')
  const measure = String(ctx.params.measure ?? 'count') === 'weight' ? 'weight' : 'count'
  const rois = `_${matrix}_rois`

  return [
    // `fetch_roi_connectivity` already answers long — `from_roi, to_roi, count, weight` — so
    // this is a rename rather than a reshape. Unlike its sibling above it needs no primary
    // filter: the endpoint restricts itself to the primary set already, which was checked
    // rather than assumed (hemibrain's roi_names is exactly its 63 primary ROIs).
    `${links} = ${c}.fetch_roi_connectivity().rename(`,
    `    columns={'from_roi': 'source', 'to_roi': 'target'}`,
    `)`,
    ``,
    // Square over the union of both ends and sorted, matching the node: a region that only
    // ever receives would otherwise be missing from one axis and the diagonal would stop
    // meaning self-connection.
    `${rois} = sorted(set(${links}['source']) | set(${links}['target']))`,
    `${matrix} = (`,
    `    ${links}`,
    `    .pivot_table(index='source', columns='target', values=${pyStr(measure)}, fill_value=0)`,
    `    .reindex(index=${rois}, columns=${rois}, fill_value=0)`,
    `)`,
  ]
})
