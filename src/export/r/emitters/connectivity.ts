/**
 * Connectivity, and the reorientation R needs in the opposite direction.
 *
 * `neuprint_connection_table()` answers **query-relative**: one row per (bodyid, partner) with
 * a `prepost` column saying which side the queried neuron is on. That is the shape Coda's
 * Profile wants and the wrong shape for an edge list — so this emitter reorients *into*
 * pre/post, where the Python one had to reorient out of it. The output columns are the same
 * either way, because everything downstream addresses them by name.
 */

import { CATMAID_TEXT } from '../../plans/query'
import { rStr, rVector } from '../r'
import { registerEmitter, registerHelper } from '../registry'
import { codaIds, cypherIdList, isCatmaidDataset, neuronIds } from './common'
import type { EmitContext } from '../types'
import {
  readEdgeProperties,
  readTraversalDirection,
  regionOptions,
} from '../../../nodes/lib/connectivityOps'
import {
  CYPHER_PLACEHOLDERS,
  connectivityExportPlan,
  unexpressedPopulation,
} from '../../plans/connectivity'

/**
 * neuprintr's own name for the `Include fragments` control.
 *
 * `neuprint_connection_table` builds `MATCH (a:`{node}`)-[c:ConnectsTo]->(b:`{node}`)` with
 * `node = ifelse(all_segments, "Segment", "Neuron")` — read off natverse/neuprintr's
 * `R/connectivity.R` rather than guessed, which is the standard the region options here are
 * refused by. So the default has always been the restricted set, and `TRUE` is the exact bare
 * match: on `male-cns:v1.0`, `(m)` and `(m:Segment)` both answer 4,252 partners and 11,898
 * synapses for five LC4 seeds, against 496 and 6,533 for `(m:Neuron)`.
 */
function allSegments(ctx: EmitContext): string {
  return ctx.params.includeFragments === true ? 'TRUE' : 'FALSE'
}

/** What the label restriction does not carry. See the notebook emitter's twin. */
function populationNote(ctx: EmitContext): string[] {
  const population = unexpressedPopulation(ctx)
  if (population.length === 0) return []
  return ctx.note(
    'Partners here are restricted to bodies neuPrint labels :Neuron, which is what ' +
      'neuprint_connection_table does with all_segments = FALSE. The Dataset node also narrows the ' +
      'population (' +
      population.join(', ') +
      '), which this call cannot apply to partners. This chunk can therefore return a few more ' +
      'partners than Coda did.',
  )
}

/**
 * The `Neuron Set` port, appended to whichever branch produced the edge list.
 *
 * Emitted **unconditionally**: an emitter cannot see which of its ports the graph downstream
 * reads, and a port left unassigned is an "object not found" at the reader's console rather
 * than a script that is merely longer than it needed to be.
 *
 * `full` is a second query here as it is on the canvas, and `neuprint_get_meta` is the call
 * `neuron.inputIds` already uses for it — the same route, so the two cells cannot disagree
 * about which columns a neuron row has.
 */
function endpointLines(ctx: EmitContext, edges: string, seeds: string, conn: string): string[] {
  ctx.helper('coda_endpoint_neurons')
  const out = ctx.output('neuronSet')
  if (ctx.params.neuronRows !== 'full') {
    return ['', `${out} <- coda_endpoint_neurons(${edges}, ${seeds})`]
  }
  if (isCatmaidDataset(ctx)) {
    // The neuron table's rows for them: a partner it does not hold has none, as on the canvas.
    return [
      '',
      `.endpoints <- coda_endpoint_neurons(${edges}, ${seeds})`,
      `${out} <- dplyr::inner_join(.endpoints["neuronId"], coda_catmaid_labels(${conn}), by = "neuronId")`,
    ]
  }
  ctx.helper('coda_neurons')
  return [
    '',
    `.endpoints <- coda_endpoint_neurons(${edges}, ${seeds})`,
    `${out} <- neuprint_get_meta(.endpoints$neuronId, conn = ${conn}) |> coda_neurons()`,
    // The same hole the node warns about: a partner can be a Segment below the dataset's
    // neuron threshold, which the edge list counts and the neuron table has no row for.
    `# NOTE: neuprint_get_meta has no row for a partner below the dataset's neuron threshold,`,
    `# so this table can be shorter than .endpoints. The edge list still counts those synapses.`,
  ]
}

/**
 * One hop through the canvas's own Cypher, for a node asking for edge properties.
 *
 * The notebook emitter's twin: `neuprint_connection_table` returns the weight and nothing else
 * about a connection, so a property has no library route. `connectivityExportPlan` decides the
 * legs, their query text and the columns; this only spells them in R. Unlike the library call,
 * the query text states its region options, so they are exported here where that route refuses
 * them. `neuprint_fetch_custom` names columns after the RETURN expressions (see Explore's chunk),
 * so they are set by position.
 */
function cypherConnectivity(
  ctx: EmitContext,
  out: string,
  neurons: string,
  conn: string,
  properties: readonly string[],
): string[] {
  const plan = connectivityExportPlan(ctx.params, properties)
  const lines = [
    ...populationNote(ctx),
    `.ids <- ${cypherIdList(neurons)}`,
    // `neuprint_ROIs(superLevel = FALSE)` is how this exporter spells the set that tiles the
    // volume everywhere else (`coda_profile`, ROI Meshes), so it is spelled that way here too.
    ...(plan.primaryRois
      ? [
          `.rois <- paste0("[", paste0('"', neuprint_ROIs(superLevel = FALSE, conn = ${conn}), '"', collapse = ","), "]")`,
        ]
      : []),
  ]
  const fill = (query: string) => {
    const ids = `sub(${rStr(CYPHER_PLACEHOLDERS.ids)}, .ids, ${rStr(query)}, fixed = TRUE)`
    return plan.primaryRois
      ? `sub(${rStr(CYPHER_PLACEHOLDERS.rois)}, .rois, ${ids}, fixed = TRUE)`
      : ids
  }
  const frames = plan.legs.map((leg) => (leg.label === 'downstream' ? '.down' : '.up'))
  plan.legs.forEach((leg, i) => {
    const frame = frames[i]!
    lines.push(
      `${frame} <- neuprint_fetch_custom(`,
      `  ${fill(leg.query)},`,
      `  conn = ${conn}`,
      `)`,
      `names(${frame}) <- ${rVector(plan.fetched)}`,
      `${frame} <- ${frame} |>`,
      `  rename(${Object.entries(leg.renames)
        .map(([from, to]) => `${to} = ${from}`)
        .join(', ')}) |>`,
      `  select(all_of(${rVector(plan.ordered)})) |>`,
      `  mutate(hop = 1L, direction = ${rStr(leg.label)})`,
    )
  })

  lines.push(
    '',
    frames.length > 1
      ? `${out} <- bind_rows(${frames.join(', ')}) |> distinct(${plan.dedupe.join(', ')}, .keep_all = TRUE)`
      : `${out} <- ${frames[0]}`,
    codaIds(ctx, out, 'preId', 'postId'),
    ...endpointLines(ctx, out, neurons, conn),
  )
  return lines
}

registerEmitter(
  'neuron.connectivity',
  (ctx) => {
    const conn = ctx.wired('dataset')
    const neurons = ctx.wired('neurons')
    ctx.library('dplyr')

    const out = ctx.output('connections')
    const ids = neuronIds(neurons)
    const direction = readTraversalDirection(ctx.params.direction)
    const hops = Math.max(1, Number(ctx.params.hops))
    const minWeight = Math.max(1, Number(ctx.params.minWeight))

    /*
     * CATMAID through `coda_walk`, the notebook's walk transcribed, one hop a
     * `catmaid_query_connected` call. CATMAID publishes no synapse totals, no per-region split and
     * no connection property but the count, so the canvas offers none of those controls on a
     * CATMAID dataset; a graph that still carries `Normalize` is refused as it is there.
     */
    if (isCatmaidDataset(ctx)) {
      if (ctx.params.normalize === true) {
        return ctx.todo(CATMAID_TEXT.normalize)
      }
      return [
        `${out} <- coda_catmaid_connectivity(`,
        `  ${conn},`,
        `  ${ids},`,
        `  direction = ${rStr(direction)},`,
        `  hops = ${hops},`,
        `  min_weight = ${minWeight},`,
        `  include_fragments = ${allSegments(ctx)}`,
        `)`,
        ...endpointLines(ctx, out, neurons, conn),
      ]
    }
    // One sentence for both routes, which refuse Normalize for the same reason.
    const normalizeTodo =
      '`Normalize` is not translated. To divide by all synapses, use the upstream/downstream columns of neuprint_get_meta(). To divide by reconstructed partners only, you need a separate aggregate query. The two denominators differ by a factor of two and a half on male-CNS.'

    /*
     * Edge properties go through the canvas's own query (`cypherConnectivity`), which states the
     * region options in its own text — so they are exported on this route where the library route
     * below refuses them. Normalize and multiple hops are still refused: neither has a translation
     * that was checked.
     */
    const properties = readEdgeProperties(ctx.params.edgeProperties)
    if (properties.length > 0) {
      if (ctx.params.normalize === true) return ctx.todo(normalizeTodo)
      if (hops > 1) {
        return ctx.todo(
          `Edge properties (${properties.join(', ')}) can only be exported for one hop. The multi-hop traversal helper uses neuprint_connection_table, which returns only the weight of each connection. Set \`Hops\` to 1, or clear \`Edge properties\`.`,
        )
      }
      return cypherConnectivity(ctx, out, neurons, conn, properties)
    }

    /*
     * The region and normalisation options are refused here where the Python emitter translates
     * the region half, and the asymmetry is about what could be *checked* rather than about what
     * neuprintr can do. `fetch_adjacencies`' signature, its defaults and its `"NotPrimary"`
     * bucket were read off the installed neuprint-python 0.6.3 by introspection; neuprintr was
     * not installed, and its argument names are exactly the kind of thing this codebase has been
     * bitten by recalling — `Client.fetch_roi_hierarchy` does not exist, to take the case already
     * written down in `roiHierarchy.ts`. A cell that names an argument neuprintr does not have
     * fails at the reader's console, which is worse than a cell that says what to write.
     */
    // The node's own decoder, shared with the notebook emitter. Written by hand here, this test
    // read `rois.length > 0` without filtering empty strings — so a stored `rois: ['']` refused
    // the export while the node and the notebook treated it as no regions at all.
    if (regionOptions(ctx.params).used) {
      return ctx.todo(
        'The region options are not translated (`Split by region`, `Regions`, `Primary regions only`). neuprint_connection_table() can break a connection down by region, but its argument names were not checked against an installed neuprintr. Add them by hand and check them against the neuprintr documentation.',
      )
    }
    if (ctx.params.normalize === true) return ctx.todo(normalizeTodo)

    if (hops > 1) {
      ctx.helper('coda_traverse_connectivity')
      return [
        ...populationNote(ctx),
        `${out} <- coda_traverse_connectivity(`,
        `  ${ids},`,
        `  direction = ${rStr(direction)},`,
        `  hops = ${hops},`,
        `  min_weight = ${minWeight},`,
        `  all_segments = ${allSegments(ctx)},`,
        `  conn = ${conn}`,
        `)`,
        ...endpointLines(ctx, out, neurons, conn),
      ]
    }

    ctx.helper('coda_edge_list')
    const prepost = direction === 'inputs' ? 'PRE' : direction === 'both' ? 'BOTH' : 'POST'
    return [
      ...populationNote(ctx),
      `${out} <- coda_edge_list(`,
      `  ${ids},`,
      `  prepost = ${rStr(prepost)},`,
      `  min_weight = ${minWeight},`,
      `  all_segments = ${allSegments(ctx)},`,
      `  conn = ${conn}`,
      `)`,
      ...endpointLines(ctx, out, neurons, conn),
    ]
  },
  { backends: ['neuprint', 'catmaid'] },
)

/**
 * The `Neuron Set` port's derivation, transcribed from `endpointNeurons` in
 * `nodes/lib/connectivityOps.ts`.
 *
 * The two rules that are easy to drop, both of which produce a plausible wrong answer: the
 * **seeds are in the result** whether or not any edge survived `min_weight` — both ends of an
 * edge list only cover the seeds that turned out to be wired — and the row deciding a neuron's
 * *order* is not the row deciding its *type*, since a neuron can arrive as an untyped seed and
 * be typed by an edge several rows later.
 */
registerHelper({
  name: 'coda_endpoint_neurons',
  requires: ['dplyr'],
  /*
   * It binds the seed ids to both ends of the edge list and then deduplicates. `bind_rows`
   * **errors** rather than coercing when the two are `<character>` and `<integer>` — measured
   * against dplyr 1.2 — so both are cast here rather than trusted to have been cast by
   * whoever called it. Its pandas twin has the same line for the opposite reason: there the
   * mismatch is silent and produces one neuron twice.
   */
  needs: ['coda_ids'],
  source: [
    'coda_endpoint_neurons <- function(connections, seeds = NULL) {',
    '  # One row per neuron in an edge list: the seeds first, then every partner.',
    '  #',
    '  # Seeds are included even if none of their edges passed min_weight. `seeds` is the seed',
    '  # table; its `type` column is used where it has one.',
    '  parts <- list()',
    '  connections <- coda_ids(connections, "preId", "postId")',
    '  if (!is.null(seeds)) {',
    '    types <- if ("type" %in% names(seeds)) as.character(seeds$type) else NA_character_',
    '    parts[[length(parts) + 1]] <- tibble::tibble(',
    '      neuronId = as.character(seeds$neuronId), type = types',
    '    )',
    '  }',
    '  parts[[length(parts) + 1]] <- tibble::tibble(',
    '    neuronId = connections$preId, type = connections$preType',
    '  )',
    '  parts[[length(parts) + 1]] <- tibble::tibble(',
    '    neuronId = connections$postId, type = connections$postType',
    '  )',
    '',
    '  rows <- dplyr::bind_rows(parts)',
    '  rows$type[!is.na(rows$type) & rows$type == ""] <- NA_character_',
    '  # Order is by first appearance; the type is the first non-empty one seen for that neuron.',
    '  typed <- dplyr::distinct(rows[!is.na(rows$type), ], neuronId, .keep_all = TRUE)',
    '  out <- dplyr::distinct(rows, neuronId, .keep_all = TRUE)',
    '  out$type <- typed$type[match(out$neuronId, typed$neuronId)]',
    '  out',
    '}',
  ],
})

/**
 * Query-relative to an edge list.
 *
 * `prepost = "PRE"` means *the partner is presynaptic to the queried neuron*, so the queried
 * neuron is the post end. Getting that backwards produces a network with every arrow reversed
 * and nothing anywhere to say so, which is why it is one helper rather than an expression
 * repeated per direction.
 */
registerHelper({
  name: 'coda_edge_list',
  requires: ['neuprintr', 'dplyr'],
  // Both id columns are Coda columns, and a Coda id column is text — see `coda_ids`.
  needs: ['coda_ids'],
  source: [
    'coda_edge_list <- function(ids, prepost, min_weight, all_segments, conn) {',
    "  # Fetch an edge list like Coda's Connectivity node: preId -> postId, in the",
    '  # direction of the synapse.',
    '  #',
    '  # all_segments = FALSE keeps only bodies labelled :Neuron; TRUE keeps every body,',
    '  # fragments included. This applies to both ends, so with FALSE a queried body that is',
    "  # not itself a :Neuron returns nothing (Coda's node always keeps the queried neurons).",
    '  one <- function(side) {',
    '    tbl <- neuprint_connection_table(',
    '      ids, prepost = side, threshold = min_weight, details = TRUE,',
    '      all_segments = all_segments, conn = conn',
    '    )',
    '    if (is.null(tbl) || nrow(tbl) == 0) return(NULL)',
    '    # prepost = "PRE" means the *partner* is presynaptic, so the queried body is post.',
    '    if (side == "PRE") {',
    '      tibble::tibble(',
    '        preId = tbl$partner, preType = tbl$type,',
    '        postId = tbl$bodyid, postType = tbl$type,',
    '        weight = tbl$weight, hop = 1L, direction = "upstream"',
    '      )',
    '    } else {',
    '      tibble::tibble(',
    '        preId = tbl$bodyid, preType = tbl$type,',
    '        postId = tbl$partner, postType = tbl$type,',
    '        weight = tbl$weight, hop = 1L, direction = "downstream"',
    '      )',
    '    }',
    '  }',
    '',
    '  sides <- if (prepost == "BOTH") c("POST", "PRE") else prepost',
    '  out <- dplyr::bind_rows(lapply(sides, one))',
    '  if (is.null(out) || nrow(out) == 0) {',
    '    return(tibble::tibble(',
    '      preId = character(0), preType = character(0),',
    '      postId = character(0), postType = character(0),',
    '      weight = numeric(0), hop = integer(0), direction = character(0)',
    '    ))',
    '  }',
    '  # An edge between two seeds is returned from both ends; drop the duplicate so its',
    '  # weight is not counted twice downstream.',
    '  out <- coda_ids(out, "preId", "postId")',
    '  dplyr::distinct(out, preId, postId, .keep_all = TRUE)',
    '}',
  ],
})

/**
 * The walk itself, whatever answers a hop — the notebook's `coda_walk`, transcribed with its
 * three rules: each neuron expanded once, an edge keeping the hop and direction it was first
 * found at, and `both` expanding both ways at every hop and labelling an edge found from both
 * ends at one hop `"both"`. One walk for neuPrint and CATMAID, as in the notebook; two had already
 * disagreed about that label.
 */
registerHelper({
  name: 'coda_walk',
  requires: ['dplyr'],
  source: [
    'coda_walk <- function(seed_ids, direction, hops, one_hop) {',
    "  # Walk the connectome breadth-first from the seeds, as Coda's Connectivity node.",
    '  #',
    '  # `one_hop(ids, way)` returns the edges leaving `ids` in direction `way` ("downstream" or',
    '  # "upstream") with columns preId, preType, postId, postType and weight (ids as text). The',
    '  # result has the same columns plus `hop` and `direction`, each row oriented from',
    '  # presynaptic to postsynaptic.',
    '  #',
    '  #  * Each neuron is expanded at most once, so recurrent loops do not repeat. Edges back',
    '  #    into visited neurons are still reported.',
    '  #  * An edge found again at a later hop keeps the hop and direction it was first found at.',
    '  #  * direction = "both" expands both ways at every hop, so it also finds neurons that share',
    '  #    inputs with a seed.',
    '  ways <- switch(direction, both = c("downstream", "upstream"), inputs = "upstream", "downstream")',
    '  frontier <- unique(as.character(seed_ids))',
    '  expanded <- character(0)',
    '  # One entry per edge found, in the order found: its key, hop and direction.',
    '  seen <- character(0)',
    '  seen_hop <- integer(0)',
    '  seen_way <- character(0)',
    '  parts <- list()',
    '  for (hop in seq_len(hops)) {',
    '    todo <- setdiff(frontier, expanded)',
    '    if (length(todo) == 0) break',
    '    expanded <- union(expanded, todo)',
    '    reached <- character(0)',
    '    for (way in ways) {',
    '      step <- one_hop(todo, way)',
    '      if (nrow(step) == 0) next',
    '      keys <- paste(step$preId, step$postId)',
    '      at <- match(keys, seen)',
    '      # Found from both ends at the same hop: label it "both".',
    '      again <- at[!is.na(at)]',
    '      seen_way[again[seen_hop[again] == hop & seen_way[again] != way]] <- "both"',
    '      fresh <- is.na(at) & !duplicated(keys)',
    '      step <- step[fresh, ]',
    '      seen <- c(seen, keys[fresh])',
    '      seen_hop <- c(seen_hop, rep(hop, nrow(step)))',
    '      seen_way <- c(seen_way, rep(way, nrow(step)))',
    '      parts[[length(parts) + 1]] <- step',
    '      reached <- c(reached, if (way == "downstream") step$postId else step$preId)',
    '    }',
    '    frontier <- setdiff(unique(reached), expanded)',
    '  }',
    '  if (length(parts) == 0) {',
    '    return(tibble::tibble(',
    '      preId = character(0), preType = character(0), postId = character(0),',
    '      postType = character(0), weight = integer(0), hop = integer(0), direction = character(0)',
    '    ))',
    '  }',
    '  out <- dplyr::bind_rows(parts)',
    '  out$hop <- seen_hop',
    '  out$direction <- seen_way',
    '  out',
    '}',
  ],
})

/** The multi-hop traversal against neuPrint: `coda_walk`, one hop a `coda_edge_list` call. */
registerHelper({
  name: 'coda_traverse_connectivity',
  needs: ['coda_walk', 'coda_edge_list'],
  requires: ['neuprintr', 'dplyr'],
  source: [
    'coda_traverse_connectivity <- function(seed_ids, direction, hops, min_weight,',
    '                                       all_segments, conn) {',
    '  # Walk the connectome breadth-first for `hops` steps and return the edge list, like',
    "  # Coda's Connectivity node with more than one hop: coda_walk, one hop a",
    '  # neuprint_connection_table() call per direction.',
    '  coda_walk(seed_ids, direction, hops, function(ids, way) {',
    '    coda_edge_list(ids, if (way == "downstream") "POST" else "PRE", min_weight, all_segments, conn)',
    '  })',
    '}',
  ],
})
