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
import { SYNAPSE_UNITS } from '../../../data/synapseUnits'
import { minSynapseConfidence, synapseUnitFor } from '../../../nodes/lib/synapseParams'
import { parseTypedLabels } from '../../../nodes/lib/labelLookup'
import { pyLongIntList, pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { TableSchema } from '../../../core/types'
import type { FieldTerm } from '../../../data/terms'
import { resolveRows } from '../../../data/filterRows'
import { rowsFromParams } from '../../../nodes/lib/findNeuronsRows'
import { schemasFromType } from '../../../nodes/lib/datasetParam'
import { filterMasks } from './tableFilters'
import type { EmitContext } from '../types'

/** What "neuPrint" means unless a node says otherwise. */
const DEFAULT_DEPLOYMENT = 'https://neuprint.janelia.org'
import { neuprintProperty } from '../../../data/neuprint/schema'
import {
  caveLabels,
  codaNeurons,
  codaSynapses,
  isCaveDataset,
  neuronIds,
  pyMaskFrame,
  pyPopulationMask,
} from './common'
import { populationFromType } from '../../../nodes/lib/populationParams'
import { SKELETON_SOURCE_PARAM } from '../../../nodes/lib/skeletonParams'
import { SKELETON_ROUTES } from '../../../data/skeletonRoutes'
import { withoutStatedStatus } from '../../../data/neuronFilter'
import { TRACED_STATUS } from '../../../data/neuronFilter'

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
  /*
   * Only families a notebook can be built for. These lines build a `neuprint.Client`, and the
   * other two sources need something else entirely — a mock dataset has no server at all,
   * and a CAVE datastack needs caveclient and a materialization number.
   *
   * The test is `DatasetFamily.notebook` rather than `sourceId`, because what decides it is
   * whether an emitter has been written and not which backend the data came from.
   * `canExportNotebook` reads the same field, which is what stops the menu offering an
   * export whose every cell after the first is a TODO; both families are named in
   * coverage.test.ts's NO_EMITTER as well.
   */
  if (family.notebook?.python !== 'neuprint') continue
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

/** The pandas tail: one `&`-joined mask over `frame`, or nothing when there is nothing to say. */
function maskLines(
  frame: string,
  terms: readonly FieldTerm[],
  schema: TableSchema | undefined,
): string[] {
  return terms.length === 0 ? [] : pyMaskFrame(frame, filterMasks(frame, terms, schema), '&')
}

/**
 * Which of Coda's rows `NeuronCriteria` can carry, and which have to become a pandas mask.
 *
 * The partition is only ever valid because **rows are ANDed**. Each is independent, so any
 * subset can be pushed into the query and the remainder applied to the result and the answer is
 * the same. One OR group would break that, and is most of why there is not one.
 *
 * `regex` is the wrinkle: it is a property of the whole criteria rather than of a field, so a
 * `type is LC4` and a `type matches LC.*` cannot both be pushed down. Mixed, the patterns go
 * down and the literals become masks — which is the right way round, since the pattern is the
 * one that would otherwise fetch the whole dataset.
 */
const CRITERIA_FIELDS = new Set(['type', 'instance'])

function partitionForCriteria(terms: readonly FieldTerm[]): {
  criteria: Map<string, FieldTerm>
  statuses: string[]
  rest: FieldTerm[]
} {
  const rest: FieldTerm[] = []
  const criteria = new Map<string, FieldTerm>()
  const statuses: string[] = []

  // Patterns win the `regex=True` slot; see above.
  const patterned = terms.some(
    (t) => CRITERIA_FIELDS.has(t.field) && t.op === 'match' && !t.negate,
  )

  for (const term of terms) {
    if (term.field === 'status' && term.op === 'eq' && !term.negate && !term.ignoreCase) {
      statuses.push(term.value)
      continue
    }
    const pushable =
      CRITERIA_FIELDS.has(term.field) &&
      !term.negate &&
      !term.ignoreCase &&
      !criteria.has(term.field) &&
      (patterned ? term.op === 'match' : term.op === 'eq')
    if (pushable) criteria.set(term.field, term)
    else rest.push(term)
  }
  return { criteria, statuses, rest }
}

/**
 * Find Neurons, on either backend, and the two are genuinely different operations.
 *
 * neuPrint pushes what it can into a `NeuronCriteria` and the server answers; whatever
 * `NeuronCriteria` cannot say becomes a mask on the result — same rows, one larger response,
 * and said out loud rather than left for the reader to notice. A CAVE datastack has no such
 * query — its API has no regex worth using — so `CaveSource` downloads the index once and
 * filters it locally, and the notebook does the same thing over the same frame
 * (`CodaCaveDataset.labels`, shared with Explore, so a graph with both pays for one fetch).
 *
 * Both tails go through `filterMasks`, which is the compiler `out.table`'s header filters
 * already used — so Coda's semantics reach pandas written out rather than approximated: the null
 * rule (a missing value satisfies `!=` and nothing else), and case per term rather than pandas'
 * own default.
 */
registerEmitter(
  'neuron.findNeurons',
  (ctx) => {
    const c = ctx.wired('dataset')
    if (!c) return ctx.todo('No Dataset is wired to this Find Neurons.')

    // One resolution of the dataset's neuron schema, threaded to whichever branch runs — it was
    // being recomputed three times per node, once in a helper that then discarded it.
    const schema = schemasFromType(ctx.inputType('dataset')).neurons
    const { terms, problems } = resolveRows(schema, rowsFromParams(ctx.params))
    const notes = problems.flatMap((p) => ctx.note(p.message))
    if (isCaveDataset(ctx)) return [...notes, ...caveFindNeurons(ctx, c, terms, schema)]

    ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
    const out = ctx.output('neurons')
    const roi = String(ctx.params.roi ?? '')
    const limit = Number(ctx.params.limit ?? 0)

    const { criteria: pushed, statuses, rest } = partitionForCriteria(terms)

    const criteria: string[] = []
    for (const [field, term] of pushed) criteria.push(`${field}=${pyStr(term.value)}`)
    /*
     * The dataset's population, which takes one of two routes and never both.
     *
     * A lone `traced` is a `NeuronCriteria` keyword, and that is worth having: it narrows at the
     * server, so the cell downloads the traced subset rather than all 186,061 rows of hemibrain.
     * Anything else has to be a mask on the result — `NeuronCriteria` ANDs its arguments and has
     * no null test, so it can say neither "type is not empty" nor an OR. Pushing part of an OR
     * into the criteria and masking the rest would AND the two halves and quietly return fewer
     * neurons than the canvas.
     *
     * `statuses` — this node's own `status` rows — removes the `traced` disjunct, which is
     * `findNeuronsCypher`' precedence restated rather than re-derived. Two copies of a
     * precedence rule is how a notebook comes to select a set the canvas does not.
     */
    const population = withoutStatedStatus(
      populationFromType(ctx.inputType('dataset')),
      statuses.length > 0,
    )
    const pushable = population.length === 1 && population[0] === 'traced'
    if (statuses.length > 0) criteria.push(`status=${pyList(statuses)}`)
    else if (pushable) criteria.push(`status=${pyList([TRACED_STATUS])}`)
    if (roi) criteria.push(`rois=${pyList([roi])}`)
    // `regex='guess'` is NeuronCriteria's default and it guesses from the string's shape. A Coda
    // `matches` row is always a regex — anchored, since that is what Neo4j's `=~` does — so
    // saying so is what stops `LC4` and `LC.*` being matched by two different rules.
    if ([...pushed.values()].some((t) => t.op === 'match')) criteria.push('regex=True')
    criteria.push(`client=${c}`)

    const lines: string[] = [...notes]
    // The ternary is only about line wrapping, so the normalisation sits outside it.
    lines.push(
      ...(criteria.length <= 2
        ? [`${out}, _ = fetch_neurons(NeuronCriteria(${criteria.join(', ')}), client=${c})`]
        : [
            `${out}, _ = fetch_neurons(`,
            `    NeuronCriteria(`,
            ...criteria.map((c_) => `        ${c_},`),
            `    ),`,
            `    client=${c},`,
            `)`,
          ]),
      codaNeurons(ctx, out),
    )

    if (rest.length > 0) {
      lines.push(
        ...ctx.note(
          'NeuronCriteria has no field for the rest of this node’s filters, so Coda applies ' +
            'them to the result instead. Same rows, one larger response.',
        ),
        ...maskLines(out, rest, schema),
      )
    }
    if (!pushable && population.length > 0) {
      lines.push(
        ...ctx.note(
          'The Dataset node narrows this graph to a population NeuronCriteria cannot express — ' +
            'it ANDs its arguments and has no "is not empty" test, where these combine with OR. ' +
            'The same neurons therefore arrive as a filter on the result, which means a larger ' +
            'response than the canvas asks the server for.',
        ),
        ...pyPopulationMask(out, population, schema),
      )
    }
    if (limit > 0) lines.push(`${out} = ${out}.head(${limit})`)
    return lines
  },
  { backends: ['neuprint', 'cave'] },
)

/**
 * The same node against a CAVE datastack: the index, filtered locally.
 *
 * **A region filter answers empty** — CAVE publishes no regions at all, so the clause can match
 * nothing, and that is Coda's answer rather than an oversight. It is no longer reachable from the
 * card, whose region picker now reads `capabilities.roiFilter` rather than a region list, so this
 * is what a graph saved against another backend meets.
 *
 * Everything else is a mask, and every mask is `filterMasks`' — which is what makes this cell
 * agree with `CaveSource.findNeurons` rather than resemble it. A row naming a column the
 * datastack does not publish cannot get this far: the canvas refuses it and `findNeuronsTerms`
 * reports it as a note above.
 */
function caveFindNeurons(
  ctx: EmitContext,
  dataset: string,
  terms: FieldTerm[],
  schema: TableSchema | undefined,
): string[] {
  const out = ctx.output('neurons')
  const roi = String(ctx.params.roi ?? '')
  const limit = Number(ctx.params.limit ?? 0)

  const lines: string[] = [
    ...ctx.note(
      'A CAVE datastack has no server-side neuron query, so Coda reads its whole index once ' +
        'and filters it here — which is what this does. Explore Dataset shares the same frame.',
    ),
    `${out} = ${caveLabels(dataset)}`,
  ]

  if (roi) {
    return [
      ...lines,
      ...ctx.note(
        `This node filters on region "${roi}", and a CAVE datastack publishes no regions — so ` +
          'Coda answers it empty rather than ignoring it. Drop the region to get neurons back.',
      ),
      `${out} = ${out}.iloc[0:0]`,
    ]
  }

  lines.push(...maskLines(out, terms, schema))
  if (limit > 0) lines.push(`${out} = ${out}.head(${limit})`)
  return lines
}

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
    const column = ctx.column('column') ?? 'neuronId'
    lines.push(
      `_ids = sorted(set(`,
      ...pyLongIntList(parsed.ids).map((l) => `    ${l}`),
      `) | set(${wired}[${pyStr(column)}].dropna().astype(int)))`,
    )
  } else if (wired) {
    const column = ctx.column('column') ?? 'neuronId'
    lines.push(`_ids = ${wired}[${pyStr(column)}].dropna().astype(int).tolist()`)
  } else {
    lines.push(`_ids = `.concat(pyLongIntList(parsed.ids).join('\n')))
  }

  if (!c) {
    // Unwired, the node is a one-column table of the ids themselves — which is enough for
    // everything downstream that reaches its ids through `neuronId` and reads nothing else.
    ctx.require('pandas')
    return [
      ...lines,
      ...ctx.note(
        'No Dataset is wired, so this is the ids alone — exactly what the node emits.',
      ),
      `${out} = pd.DataFrame({'neuronId': _ids})`,
    ]
  }

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  return [
    ...lines,
    `${out}, _ = fetch_neurons(NeuronCriteria(bodyId=_ids, client=${c}), client=${c})`,
    codaNeurons(ctx, out),
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

  /*
   * NeuronCriteria's kwargs are the neuron's own *neuPrint* properties, so the field chosen on
   * the node has to cross the same vocabulary seam `labelClause` puts it through — the id column
   * is `neuronId` here and `bodyId` there, and `NeuronCriteria(neuronId=…)` is a TypeError.
   * `class_` is a separate and genuinely local concern: a Python reserved word, not a rename.
   */
  const property = neuprintProperty(field)
  const kw = property === 'class' ? 'class_' : property
  const schema = schemasFromType(ctx.inputType('dataset')).neurons
  const population = withoutStatedStatus(
    populationFromType(ctx.inputType('dataset')),
    Boolean(status),
  )
  const pushable = population.length === 1 && population[0] === 'traced'
  const criteria = [`${kw}=_labels`]
  // Same two routes as Find Neurons above, and the same precedence: this node's own `Status`
  // removes the `traced` disjunct rather than ANDing with it.
  if (status) criteria.push(`status=${pyStr(status)}`)
  else if (pushable) criteria.push(`status=${pyStr(TRACED_STATUS)}`)
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
    codaNeurons(ctx, out),
  )
  if (!pushable && population.length > 0) {
    lines.push(
      ...ctx.note(
        'The Dataset node narrows this graph to a population NeuronCriteria cannot express, so ' +
          'the same neurons arrive as a filter on the result instead.',
      ),
      ...pyPopulationMask(out, population, schema),
    )
  }
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
  const links = ctx.output('links')
  const byType = ctx.params.groupByType !== false
  // neuprint-python's own vocabulary, not Coda's: `connection_table_to_matrix` appends
  // `_pre`/`_post` to this itself, and the columns it is indexing are `fetch_adjacencies`'
  // output — which `merge_neuron_properties` has just written `bodyId_pre`/`bodyId_post` into.
  const group = byType ? 'type' : 'bodyId'

  return [
    `_neurons, _conn = fetch_adjacencies(`,
    `    NeuronCriteria(bodyId=${neuronIds(sources)}, client=${c}),`,
    `    NeuronCriteria(bodyId=${neuronIds(targets)}, client=${c}),`,
    `    client=${c},`,
    `)`,
    `_conn = merge_neuron_properties(_neurons, _conn, ['type'])`,
    `${out} = connection_table_to_matrix(_conn, ${pyStr(group)}, sort_by=${pyStr(group)})`,
    ``,
    /*
     * The long half, from `_conn` rather than by melting the matrix back down.
     *
     * They agree, and that is worth saying because the canvas does it the other way round:
     * `matrixToLinks` drops the zero cells, and `_conn` has no zero rows to drop — a connection
     * table only holds connections that exist. `fetch_adjacencies` answers one row per
     * (pre, post, ROI), so the sum is across regions, which is exactly what
     * `connection_table_to_matrix` collapses into a cell.
     */
    `${links} = (`,
    `    _conn`,
    `    .groupby([${pyStr(`${group}_pre`)}, ${pyStr(`${group}_post`)}], as_index=False)['weight']`,
    `    .sum()`,
    `    .rename(columns={${pyStr(`${group}_pre`)}: 'source', ${pyStr(`${group}_post`)}: 'target'})`,
    `)`,
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
    `    NeuronCriteria(bodyId=${neuronIds(neurons)}, client=${c}),`,
    `    client=${c},`,
    `)`,
    codaNeurons(ctx, out),
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
  const ids = limit > 0 ? `${neurons}['neuronId'].head(${limit}).tolist()` : neuronIds(neurons)

  return [
    /*
     * A note rather than a refusal, and the line is where `Detail` on the Meshes node draws it:
     * the cell below fetches real skeletons for the right neurons, and what differs is *which
     * copy*. `neu.fetch_skeletons` reads neuPrint's own SWC, which is what the node does with
     * Source on Automatic; the published layer is a precomputed directory whose URL is resolved
     * from the dataset's neuroglancer state at run time, and this exporter has no network.
     *
     * Two things genuinely differ, so both are said: the published copy carries no radii
     * (male-CNS declares no vertex attributes at all), and its coverage is whatever was exported
     * into it — `optic-lobe:v1.0.1` answered 5 of 20 sampled bodies. A notebook silently a few
     * neurons short is the failure this exporter minds most.
     */
    ...(ctx.params[SKELETON_SOURCE_PARAM] === SKELETON_ROUTES.published
      ? ctx.note(
          'The Skeletons node is set to the published precomputed layer rather than neuPrint’s ' +
            'own SWC. This cell fetches the SWC: the published copy is a bucket whose URL comes ' +
            'from the dataset’s neuroglancer state, and navis reads it with ' +
            '`navis.read_precomputed`. It carries no radii, and it covers only the bodies that ' +
            'were exported into it.',
        )
      : []),
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
  const ids = limit > 0 ? `${neurons}['neuronId'].head(${limit}).tolist()` : neuronIds(neurons)

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

/**
 * Neuropil shells, as `navis.Volume`s rather than as OBJ bytes.
 *
 * `out.rois`'s emitter reads the same endpoint through `Client.fetch_roi_mesh`, which hands
 * back bytes — right there, because that notebook has no navis in its dependency set and a
 * generated file that fails on an import nobody asked for is worse than one that hands over
 * the bytes. Here the opposite holds: this node exists to feed a 3D scene, so what it must
 * produce is something plottable, and `navis.interfaces.neuprint.fetch_roi` returns exactly
 * that. Read off navis by introspection rather than recalled.
 *
 * Two things survive from that sibling because both are properties of the endpoint rather
 * than of either card. Some regions have no mesh, and every one male-CNS refuses is an
 * `-unspecified` bucket that collects unassigned synapses and is not a shape — so the loop
 * catches rather than letting one 400 end the cell. And the meshes are decimated display
 * surfaces, which matters more here than there: a node that binds them to a name invites
 * measuring them.
 */
registerEmitter('neuron.roiMeshes', (ctx) => {
  const client = ctx.wired('dataset')
  const out = ctx.output('meshes')
  const chosen = (Array.isArray(ctx.params.rois) ? ctx.params.rois : []).map(String)
  const list =
    chosen.length > 0
      ? `[${chosen.map((roi) => JSON.stringify(roi)).join(', ')}]`
      : `${client}.primary_rois`

  ctx.require('navisNeuprint')
  return [
    ...ctx.note(
      'Region meshes are one request each, and neuPrint publishes them for visualization ' +
        'only — decimated display surfaces, so a volume measured off one is an approximation ' +
        'rather than a figure to quote.',
    ),
    ...(chosen.length > 0
      ? []
      : [
          `# The picker was left empty, which means the set that tiles the volume — the`,
          `# published list nests, so "every region" draws each shell inside another one.`,
        ]),
    `${out} = []`,
    `_skipped = []`,
    `for _roi in ${list}:`,
    `    try:`,
    `        ${out}.append(neu.fetch_roi(_roi, client=${client}))`,
    `    except Exception:`,
    `        # No mesh published for this one. On male-CNS every such region is an`,
    `        # "-unspecified" bucket, which collects unassigned synapses and is not a shape.`,
    `        _skipped.append(_roi)`,
    ``,
    `print(f"{len(${out})} region meshes · {len(_skipped)} without one")`,
  ]
})

registerEmitter('neuron.synapses', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this Synapses node.')

  ctx.require('neuprint', 'NeuronCriteria', 'SynapseCriteria', 'fetch_synapses')
  const out = ctx.output('points')
  const polarity = String(ctx.params.polarity ?? '')
  const minConfidence = minSynapseConfidence(ctx.params)
  const unit = synapseUnitFor(ctx.inputType('dataset'), ctx.params)

  /*
   * **`confidence` is passed only when the node sets it, and that is not the same as passing 0.**
   * `SynapseCriteria`'s default is `None`, which it resolves to the dataset's own
   * `Meta.postHighAccuracyThreshold` — 0.5 on male-CNS. Writing `confidence=0` would emit a
   * notebook that *disables* a floor the canvas leaves in place, since neuPrint has already
   * applied it at ingest and nothing in the cloud scores below it. So an unset control emits no
   * argument, which is the same query the canvas runs.
   */
  const synCriteria = [
    ...(polarity ? [`type=${pyStr(polarity)}`] : []),
    ...(minConfidence > 0 ? [`confidence=${minConfidence}`] : []),
    'primary_only=True',
    `client=${c}`,
  ]

  return [
    `${out} = fetch_synapses(`,
    `    NeuronCriteria(bodyId=${neuronIds(neurons)}, client=${c}),`,
    `    SynapseCriteria(${synCriteria.join(', ')}),`,
    `    client=${c},`,
    `)`,
    codaNeurons(ctx, out),
    // `coda_neurons` one column further on: neuprint-python's `type` means pre or post, and
    // Coda calls that `polarity`. Left unrenamed, a syNBLAST or a Filter downstream addresses
    // a column this frame does not have — or, worse, reads `type` and gets polarity.
    codaSynapses(ctx, out),
    ...ctx.note(
      'neuprint-python calls the pre/post column "type"; Coda calls it "polarity" and keeps ' +
        '"type" for the cell type, which this frame does not carry — join it from a neuron ' +
        'table if you need it.',
    ),
    /*
     * **`fetch_synapses` deduplicates and there is no argument to stop it.** Its query carries
     * `WITH DISTINCT n, s` (neuprint-python `queries/synapses.py`) for the reason Coda's does: a
     * presynaptic site sits in one SynapseSet per partner. So `sites` needs no emitted argument
     * and `links` cannot be emitted at all — it is a different query, and writing the cell as if
     * the two agreed is exactly the silent divergence this export exists not to have.
     */
    ...(unit === SYNAPSE_UNITS.links
      ? ctx.note(
          'The Synapses node is set to one row per connection. fetch_synapses always ' +
            'de-duplicates (WITH DISTINCT n, s), so this frame has one row per presynaptic ' +
            'site instead — fewer rows than the canvas, by however many partners each site ' +
            'drives. Postsynaptic rows are unaffected.',
        )
      : []),
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
