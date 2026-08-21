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
  if (family.synthetic) continue // Refused before the walk; see `canExportNotebook`.
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

registerEmitter('neuron.findNeurons', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const out = ctx.output('neurons')

  const typePattern = String(ctx.params.typePattern ?? '')
  const instancePattern = String(ctx.params.instancePattern ?? '')
  const status = String(ctx.params.status ?? '')
  const roi = String(ctx.params.roi ?? '')
  const minSize = Number(ctx.params.minSize ?? 0)
  const limit = Number(ctx.params.limit ?? 0)

  const lines: string[] = []

  /*
   * `neuprint_search` takes one field and one pattern, where Coda's node narrows on several at
   * once. So the search runs on whichever pattern is set and the rest become filters on the
   * returned metadata — the same rows, one larger response, and stated so nobody reads the
   * absence of a `status=` argument as the status having been ignored.
   */
  ctx.helper('coda_neurons')
  if (typePattern) {
    lines.push(
      `${out} <- neuprint_search(`,
      `  ${rStr(typePattern)},`,
      `  field = "type",`,
      `  meta = TRUE,`,
      `  conn = ${conn}`,
      `) |> coda_neurons()`,
    )
  } else if (instancePattern) {
    lines.push(
      `${out} <- neuprint_search(`,
      `  ${rStr(instancePattern)},`,
      `  field = "instance",`,
      `  meta = TRUE,`,
      `  conn = ${conn}`,
      `) |> coda_neurons()`,
    )
  } else {
    return ctx.todo(
      'This Find Neurons has no type or instance pattern. neuprint_search needs one — an ' +
        'unbounded query against a shared production Neo4j is not something to generate.',
    )
  }

  const filters: string[] = []
  if (instancePattern && typePattern) filters.push(`grepl(${rStr(instancePattern)}, instance)`)
  if (status) filters.push(`status == ${rStr(status)}`)
  // An ROI restriction is a different question — `neuprint_bodies_in_ROI` answers it — so it
  // is reported rather than silently dropped from a search that cannot express it.
  const roiNote = roi
    ? ctx.note(
        `Coda restricts this to neurons with synapses in ${roi}. neuprint_search cannot ` +
          'express that; neuprint_bodies_in_ROI() is how to intersect the result.',
      )
    : []
  if (minSize > 0) filters.push(`size >= ${minSize}`)

  lines.push(...roiNote)

  if (filters.length > 0) {
    ctx.library('dplyr')
    lines.push(
      ...ctx.note(
        "neuprint_search narrows on one field, so Coda's other criteria are applied to the " +
          'result rather than in the query. Same rows, one larger response.',
      ),
      `${out} <- ${out} |> filter(${filters.join(', ')})`,
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
  return [
    `${ctx.output('points')} <- neuprint_get_synapses(${args.join(', ')}, conn = ${conn})`,
  ]
})
