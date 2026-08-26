/**
 * The dataset and query nodes, in neuprintr.
 *
 * The function list here was read off the package reference rather than recalled. Three things
 * differ from the Python side in ways worth knowing before comparing them:
 *
 *  - **`neuprint_connection_table()` is query-relative** — one row per (bodyid, partner) with a
 *    `prepost` column — which is the shape Coda's Profile wants and the *opposite* of
 *    `fetch_adjacencies`. The Connectivity node therefore has to reorient it here, where the
 *    Python emitter had to reorient in the other direction.
 *  - **`neuprint_get_paths()` exists**, so the Paths node loses less than it does in Python.
 *  - **There is no neuron-mesh fetch at all.** `neuprint_ROI_mesh()` is ROI shells.
 */

import {
  DATASET_FAMILIES,
  datasetFamily,
  resolveDatasetId,
} from '../../../nodes/lib/datasetFamilies'
import { parseIdList } from '../../../nodes/lib/idList'
import { parseTypedLabels } from '../../../nodes/lib/labelLookup'
import { rLongVector, rStr, rVector } from '../r'
import { registerEmitter } from '../registry'
import type { FieldTerm } from '../../../data/terms'
import { anchoredPattern, escapeRegex } from '../../../data/terms'
import { resolveRows } from '../../../data/filterRows'
import { rowsFromParams } from '../../../nodes/lib/findNeuronsRows'
import { schemasFromType } from '../../../nodes/lib/datasetParam'
import { filterPredicates } from './tableFilters'
import type { EmitContext } from '../types'
import { neuprintProperty } from '../../../data/neuprint/schema'
import { neuronIds } from './common'

/** What "neuPrint" means unless a node says otherwise. */
const DEFAULT_DEPLOYMENT = 'https://neuprint.janelia.org'

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/**
 * A `neuprint_connection()` binding.
 *
 * One per dataset node, passed to every call as `conn=`. neuprintr keeps a package-level
 * default connection that every call would find, which reads more tidily and is wrong the
 * moment a graph carries two datasets — the second connection silently becomes the default and
 * every earlier query starts answering from the other connectome.
 *
 * The token comes from an environment variable, never from the document. `neuprintr` reads
 * `neuprint_token` by convention, which is what `Sys.getenv` is asked for.
 */
function connectionLines(
  ctx: EmitContext,
  out: string,
  server: string,
  datasetId: string,
): string[] {
  ctx.library('neuprintr')
  return [
    `${out} <- neuprint_connection(`,
    `  server = ${rStr(server)},`,
    `  dataset = ${rStr(datasetId)},`,
    `  token = Sys.getenv("neuprint_token")`,
    `)`,
  ]
}

function emitDataset(ctx: EmitContext, familyKey: string): string[] {
  const family = datasetFamily(familyKey)
  if (!family) return ctx.todo(`Unknown dataset family "${familyKey}".`)

  const out = ctx.output('dataset')
  const version = ctx.params.version
  const resolved = resolveDatasetId(family, version)
  const lines: string[] = []

  let datasetId = resolved
  if (!datasetId) {
    datasetId = family.family
    lines.push(
      ...ctx.note(
        'This node tracks the latest release and the exporter could not resolve which that ' +
          'is, so only the family is named. Set `dataset` to the exact release you mean ' +
          'before sharing the document.',
      ),
    )
  } else if (!version) {
    lines.push(
      ...ctx.note(
        'The node is set to "Latest"; this pins the version it resolved to at export, so the ' +
          'document keeps answering the same question after the next release.',
      ),
    )
  }

  const server = String(ctx.params.server ?? '') || DEFAULT_DEPLOYMENT
  lines.push(...connectionLines(ctx, out, server, datasetId))
  return lines
}

for (const family of DATASET_FAMILIES) {
  /*
   * Only families a notebook can be built for. These lines build a `neuprint_login`, and the
   * other two sources need something else entirely — a mock dataset has no server at all,
   * and a CAVE datastack needs caveclient and a materialization number.
   *
   * The test is `DatasetFamily.notebook` rather than `sourceId`, because what decides it is
   * whether an emitter has been written and not which backend the data came from.
   * `canExportNotebook` reads the same field, which is what stops the menu offering an
   * export whose every cell after the first is a TODO; both families are named in
   * coverage.test.ts's NO_EMITTER as well.
   */
  if (family.notebook?.r !== 'neuprint') continue
  registerEmitter(`dataset.${family.key}`, (ctx) => emitDataset(ctx, family.key))
}

registerEmitter('dataset.neuprint', (ctx) => {
  const datasetId = String(ctx.params.dataset ?? '')
  if (!datasetId) return ctx.todo('This neuPrint node names no dataset.')
  const server = String(ctx.params.server ?? DEFAULT_DEPLOYMENT)
  return connectionLines(ctx, ctx.output('dataset'), server, datasetId)
})

registerEmitter('neuron.dataset', (ctx) => {
  const datasetId = String(ctx.params.dataset ?? '')
  if (!datasetId) return ctx.todo('This Dataset node names no dataset.')
  return connectionLines(ctx, ctx.output('dataset'), DEFAULT_DEPLOYMENT, datasetId)
})

// ---------------------------------------------------------------------------
// Find Neurons
// ---------------------------------------------------------------------------

/**
 * The pattern `neuprint_search` should be handed for one term, or undefined when it cannot be
 * one.
 *
 * `neuprint_search` takes a **regex** against one field, so an `is` row has to be spelled as the
 * anchored literal it means rather than passed through — `LC4` handed over bare would also match
 * `LC4b`, which is a different set with nothing to say so. `anchoredPattern` and `escapeRegex`
 * are the same two the local matcher and the Cypher compiler use, so all three agree by
 * construction.
 *
 * A negated or case-insensitive term is not searchable and becomes a `dplyr` predicate instead;
 * so does everything that is not a plain text comparison.
 */
function searchPattern(term: FieldTerm): string | undefined {
  if (term.negate || term.ignoreCase) return undefined
  if (term.op === 'match') return term.value
  if (term.op === 'eq') return anchoredPattern(escapeRegex(term.value))
  return undefined
}

registerEmitter('neuron.findNeurons', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const out = ctx.output('neurons')

  const schema = schemasFromType(ctx.inputType('dataset')).neurons
  // `resolveRows` lowers unchecked when the schema has not arrived, so this reads the same in
  // both emitters rather than each carrying its own unknown-is-not-missing branch.
  const resolved = resolveRows(schema, rowsFromParams(ctx.params))
  const roi = String(ctx.params.roi ?? '')
  const limit = Number(ctx.params.limit ?? 0)

  const lines: string[] = resolved.problems.flatMap((p) => ctx.note(p.message))

  /*
   * `neuprint_search` takes one field and one pattern, where Coda's node narrows on several rows
   * at once. So the search runs on whichever row can be one — type first, then instance — and
   * every other row becomes a filter on the returned metadata. The same rows, one larger
   * response, and stated so that nobody reads the absence of a `status=` argument as the status
   * having been ignored.
   */
  const searchable = resolved.terms.findIndex(
    (t) => (t.field === 'type' || t.field === 'instance') && searchPattern(t) !== undefined,
  )
  if (searchable === -1) {
    return ctx.todo(
      'This Find Neurons has no type or instance filter that neuprint_search can express. It ' +
        'needs one — an unbounded query against a shared production Neo4j is not something to ' +
        'generate.',
    )
  }

  const search = resolved.terms[searchable]!
  const rest = resolved.terms.filter((_, i) => i !== searchable)

  ctx.helper('coda_neurons')
  lines.push(
    `${out} <- neuprint_search(`,
    `  ${rStr(searchPattern(search)!)},`,
    `  field = ${rStr(search.field)},`,
    `  meta = TRUE,`,
    `  conn = ${conn}`,
    `) |> coda_neurons()`,
  )

  // An ROI restriction is a different question — `neuprint_bodies_in_ROI` answers it — so it
  // is reported rather than silently dropped from a search that cannot express it.
  if (roi) {
    lines.push(
      ...ctx.note(
        `Coda restricts this to neurons with synapses in ${roi}. neuprint_search cannot ` +
          'express that; neuprint_bodies_in_ROI() is how to intersect the result.',
      ),
    )
  }

  if (rest.length > 0) {
    ctx.library('dplyr')
    lines.push(
      ...ctx.note(
        "neuprint_search narrows on one field, so Coda's other filters are applied to the " +
          'result rather than in the query. Same rows, one larger response.',
      ),
      // `filter()` ANDs its arguments, which is what a list of rows means — and it is the same
      // compiler `out.table`'s header filters use, so the null rule and the per-term case
      // handling arrive written out rather than approximated.
      `${out} <- ${out} |> filter(${filterPredicates(rest, schema).join(', ')})`,
    )
  }
  if (limit > 0) {
    ctx.library('dplyr')
    lines.push(`${out} <- ${out} |> head(${limit})`)
  }
  return lines
})

// ---------------------------------------------------------------------------
// Input IDs / IDs from Label
// ---------------------------------------------------------------------------

/*
 * Ids are emitted as a **character** vector, not a numeric one, and that was measured rather
 * than assumed. R has no unsigned 64-bit integer and its default numeric is a double, so
 * `as.numeric("648518347529750614")` is `648518347529750528` — a different neuron, and wrong
 * in a different direction from JavaScript's own rounding of the same id. `c(1001, 1002)` is
 * fine for neuPrint's nine-to-eleven digit ids and silently destroys a CAVE root id, so the
 * one spelling that is correct everywhere is the quoted one. neuprintr's `neuprint_ids()`
 * takes character ids for exactly this reason — it is the natverse convention, and why
 * `bit64::integer64` exists in that stack at all.
 */
registerEmitter('neuron.inputIds', (ctx) => {
  const out = ctx.output('neurons')
  const parsed = parseIdList(String(ctx.params.ids ?? ''))
  const wired = ctx.input('ids')
  if (parsed.error && !wired)
    return ctx.todo(`The pasted id list is not valid: ${parsed.error}`)

  const column = ctx.column('column') ?? 'neuronId'
  const lines: string[] = []

  if (parsed.ids.length > 0 && wired) {
    const [first, ...rest] = rLongVector(parsed.ids)
    lines.push(
      `ids <- unique(c(`,
      `  ${first}`,
      ...rest.map((l) => `  ${l}`),
      `, ${wired}$${column}))`,
    )
  } else if (wired) {
    lines.push(`ids <- unique(${wired}$${column})`)
  } else {
    const [first, ...rest] = rLongVector(parsed.ids)
    lines.push(`ids <- ${first}`, ...rest)
  }

  const conn = ctx.input('dataset')
  if (!conn) {
    ctx.library('dplyr')
    return [
      ...lines,
      ...ctx.note(
        'No Dataset is wired, so this is the ids alone — exactly what the node emits.',
      ),
      `${out} <- tibble(neuronId = ids)`,
    ]
  }
  ctx.library('neuprintr')
  ctx.helper('coda_neurons')
  return [...lines, `${out} <- neuprint_get_meta(ids, conn = ${conn}) |> coda_neurons()`]
})

registerEmitter('neuron.idsFromLabel', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const out = ctx.output('neurons')

  const field = ctx.column('field') || 'type'
  const typed = parseTypedLabels(ctx.params.labels)
  const wired = ctx.input('labels')
  const wiredColumn = ctx.column('column')
  const regex = String(ctx.params.match ?? 'exact') === 'regex'

  const lines: string[] = []
  if (wired && wiredColumn) {
    lines.push(`labels <- unique(c(${rVector(typed)}, ${wired}$${wiredColumn}))`)
  } else {
    lines.push(`labels <- ${rVector(typed)}`)
  }

  /*
   * neuprint_search takes one pattern, so a set of labels becomes one alternation — and it has
   * to be anchored per entry. Coda matches each label on its own precisely because folding
   * them into a surrounding `^(?:…)$` splices their alternations together and matches a
   * superset; `paste0` with per-entry anchors keeps each one meaning what it means alone.
   */
  const pattern = regex
    ? 'paste0("^(?:", paste(labels, collapse = ")$|^(?:"), ")$")'
    : 'paste0("^", paste(gsub("([.\\\\\\\\^$|()\\\\[\\\\]{}*+?])", "\\\\\\\\\\\\\\\\\\\\1", labels), collapse = "$|^"), "$")'

  ctx.helper('coda_neurons')
  lines.push(
    `${out} <- neuprint_search(`,
    `  ${pattern},`,
    // neuPrint's own spelling, not Coda's — `neuprint_search(field = "neuronId")` matches
    // nothing at all, silently. Same seam `labelClause` applies to the built query.
    `  field = ${rStr(neuprintProperty(field))},`,
    `  meta = TRUE,`,
    `  conn = ${conn}`,
    `) |> coda_neurons()`,
  )

  const status = String(ctx.params.status ?? '')
  if (status) {
    ctx.library('dplyr')
    lines.push(`${out} <- ${out} |> filter(status == ${rStr(status)})`)
  }
  if (ctx.params.ignoreCase === true) {
    lines.push(
      ...ctx.note(
        'Coda matches these labels case-insensitively; this search is case-sensitive and may ' +
          'return fewer neurons.',
      ),
    )
  }
  return lines
})

// ---------------------------------------------------------------------------
// Adjacency / ROI
// ---------------------------------------------------------------------------

registerEmitter('neuron.adjacency', (ctx) => {
  const conn = ctx.wired('dataset')
  const sources = ctx.wired('sources')
  const targets = ctx.wired('targets')
  ctx.library('neuprintr')
  const out = ctx.output('matrix')

  const lines = [
    `${out} <- neuprint_get_adjacency_matrix(`,
    `  inputids = ${neuronIds(sources)},`,
    `  outputids = ${neuronIds(targets)},`,
    `  conn = ${conn}`,
    `)`,
  ]
  if (ctx.params.groupByType !== false) {
    lines.push(
      ...ctx.note(
        'Coda groups this matrix by cell type. neuprint_get_adjacency_matrix is per body, so ' +
          'the roll-up is done here rather than in the query.',
      ),
    )
  }
  return lines
})

registerEmitter('neuron.roiCounts', (ctx) => {
  const conn = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  ctx.library('neuprintr')
  ctx.helper('coda_neurons')
  return [
    ...ctx.note(
      'These counts nest: a synapse in LO(R) is counted again in its parent OL(R). Filter to ' +
        'neuprint_ROIs(superLevel = FALSE) before summing, or the totals roughly double.',
    ),
    `${ctx.output('counts')} <- neuprint_get_roiInfo(${neuronIds(neurons)}, conn = ${conn}) |>`,
    `  coda_neurons()`,
  ]
})

registerEmitter('neuron.roiConnectivity', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const matrix = ctx.output('matrix')
  const links = ctx.output('links')
  // The one node with a better fit in R than in Python: neuprintr publishes this directly.
  return [
    `${links} <- neuprint_ROI_connectivity(`,
    `  rois = neuprint_ROIs(conn = ${conn}),`,
    `  conn = ${conn}`,
    `)`,
    `${matrix} <- ${links}`,
  ]
})

registerEmitter('neuron.roiCompleteness', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  return [
    ...ctx.note(
      'neuprintr publishes no completeness helper, so this is the Cypher the node sends.',
    ),
    `${ctx.output('completeness')} <- neuprint_fetch_custom(`,
    `  "MATCH (n:Meta) RETURN n.roiInfo",`,
    `  conn = ${conn}`,
    `)`,
  ]
})

/**
 * Neuropil shells, fetched rather than described.
 *
 * `out.rois`'s R emitter leaves its `lapply` commented, because that card is a *widget* that
 * fetches for itself and the notebook is describing what it does. This is a node whose output
 * something downstream reads, so a commented fetch would leave the next chunk referring to a
 * name that was never bound. One request per region is the cost, and the note says so.
 */
registerEmitter('neuron.roiMeshes', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const chosen = (Array.isArray(ctx.params.rois) ? ctx.params.rois : []).map(String)
  const out = ctx.output('meshes')
  const names = `${out}_rois`

  return [
    ...ctx.note(
      'One request per region, and neuPrint publishes these for visualization only — ' +
        'decimated display surfaces, so a volume measured off one is an approximation rather ' +
        'than a figure to quote.',
    ),
    chosen.length > 0
      ? `${names} <- c(${chosen.map((roi) => JSON.stringify(roi)).join(', ')})`
      : // Empty means the set that tiles the volume; the published list nests, so "every
        // region" would draw each shell inside another one.
        `${names} <- neuprint_ROIs(superLevel = FALSE, conn = ${conn})`,
    `${out} <- lapply(${names}, neuprint_ROI_mesh, conn = ${conn})`,
    `names(${out}) <- ${names}`,
    `${names}`,
  ]
})

registerEmitter('neuron.rawCypher', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const query = String(ctx.params.query ?? '').trim()
  if (!query) return ctx.todo('This Raw Cypher node has no query.')
  return [
    `${ctx.output('result')} <- neuprint_fetch_custom(`,
    `  "${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\n  ')}",`,
    `  conn = ${conn}`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

registerEmitter('neuron.skeletons', (ctx) => {
  const conn = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  ctx.library('neuprintr')
  ctx.library('nat')
  const limit = Number(ctx.params.limit ?? 0)
  const ids = limit > 0 ? `head(${neuronIds(neurons)}, ${limit})` : neuronIds(neurons)
  // Returns a nat neuronlist, which is what every downstream nat call wants — the same
  // relationship navis has to the Python side, since navis is nat's port.
  return [`${ctx.output('skeletons')} <- neuprint_read_neurons(${ids}, conn = ${conn})`]
})

registerEmitter('neuron.meshes', (ctx) => {
  // The one capability neuprintr does not have. `neuprint_ROI_mesh` is ROI shells, not neurons.
  return ctx.todo(
    'neuprintr has no neuron-mesh fetch — neuprint_ROI_mesh() reads ROI shells only. Use the ' +
      'Skeletons node, which reads the same neurons as a nat neuronlist, or fetch meshes from ' +
      'the precomputed source directly.',
  )
})

registerEmitter('neuron.synapses', (ctx) => {
  const conn = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  ctx.library('neuprintr')
  const polarity = String(ctx.params.polarity ?? '')
  const args = [
    neuronIds(neurons),
    ...(polarity ? [`prepost = ${rStr(polarity.toUpperCase())}`] : []),
  ]
  /*
   * **This frame is in neuprintr's vocabulary, not Coda's**, and unlike every other R cell here
   * nothing normalises it: `neuprint_get_synapses` returns `bodyid` and `prepost` (0/1) where
   * Coda's point cloud carries `neuronId` and `polarity` ("pre"/"post"). The Python side gained
   * `coda_synapses` for exactly this; R has `coda_neurons` and the same seam, and the mapping
   * would be a factor rather than a rename, so it is a TODO with the gap named rather than a
   * silent inconsistency between the two exports of one graph.
   */
  return [
    ...ctx.note(
      'neuprintr returns bodyid and prepost (0/1) where Coda carries neuronId and polarity ' +
        '("pre"/"post"). Any cell below that names a synapse column will need one or the ' +
        'other spelling — the notebook export normalises these, this one does not yet.',
    ),
    `${ctx.output('points')} <- neuprint_get_synapses(${args.join(', ')}, conn = ${conn})`,
  ]
})
