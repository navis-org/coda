/**
 * Connectivity, and the reorientation R needs in the opposite direction.
 *
 * `neuprint_connection_table()` answers **query-relative**: one row per (bodyid, partner) with
 * a `prepost` column saying which side the queried neuron is on. That is the shape Coda's
 * Profile wants and the wrong shape for an edge list — so this emitter reorients *into*
 * pre/post, where the Python one had to reorient out of it. The output columns are the same
 * either way, because everything downstream addresses them by name.
 */

import { rStr } from '../r'
import { registerEmitter, registerHelper } from '../registry'
import { neuronIds } from './common'
import type { EmitContext } from '../types'
import { populationFromType } from '../../../nodes/lib/populationParams'
import { regionOptions } from '../../../nodes/lib/connectivityOps'

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
  if (ctx.params.includeFragments === true) return []
  const population = populationFromType(ctx.inputType('dataset'))
  if (population.length === 0) return []
  return ctx.note(
    'Partners here are restricted to bodies neuPrint labels :Neuron, which is what ' +
      'neuprint_connection_table does with all_segments = FALSE. The Dataset node narrows the ' +
      'population further (' +
      population.join(', ') +
      '), which this call cannot express on a partner — so this chunk can return a few more ' +
      'partners than the canvas did.',
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
  ctx.library('neuprintr')
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

registerEmitter('neuron.connectivity', (ctx) => {
  const conn = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  ctx.library('neuprintr')
  ctx.library('dplyr')

  const out = ctx.output('connections')
  const ids = neuronIds(neurons)
  const direction = String(ctx.params.direction ?? 'outputs')
  const hops = Math.max(1, Number(ctx.params.hops ?? 1))
  const minWeight = Math.max(1, Number(ctx.params.minWeight ?? 1))

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
      'The region options are not translated. neuprint_connection_table() can break a connection down by region; the argument names were not verified against an installed neuprintr, and guessing them produces a cell that fails at your console.',
    )
  }
  if (ctx.params.normalize === true) {
    return ctx.todo(
      'Normalize is not translated. The all-synapses denominators are the upstream/downstream columns of neuprint_get_meta(); the reconstructed-partners-only denominator needs its own aggregate query, and the two differ by a factor of two and a half on male-CNS.',
    )
  }

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
      ...endpointLines(ctx, out, ids, conn),
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
    ...endpointLines(ctx, out, ids, conn),
  ]
})

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
  source: [
    'coda_endpoint_neurons <- function(connections, seed_ids = NULL) {',
    '  # The neurons an edge list is about: the seeds, then every partner, one row each.',
    '  #',
    '  # The seeds are included whether or not any edge survived min_weight -- both ends of',
    '  # the edge list only cover the seeds that turned out to be wired to something.',
    '  parts <- list()',
    '  if (!is.null(seed_ids)) {',
    '    parts[[length(parts) + 1]] <- tibble::tibble(',
    '      neuronId = seed_ids, type = NA_character_',
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
    '  # First appearance decides the order; the first non-empty type wins, which need not be',
    '  # the same row -- a neuron can arrive as an untyped seed and be typed by an edge later.',
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
  source: [
    'coda_edge_list <- function(ids, prepost, min_weight, all_segments, conn) {',
    "  # Coda's Connectivity output: preId -> postId, always oriented the way the synapse",
    '  # points, whichever way the traversal travelled.',
    '  #',
    '  # all_segments = FALSE keeps only bodies neuPrint labels :Neuron, which is this',
    "  # function's own default; TRUE matches :Segment instead -- every body, fragments",
    '  # included. Note that it applies to BOTH ends, so with FALSE a queried body that is',
    "  # not itself a published neuron returns nothing, where Coda's canvas always keeps the",
    '  # neurons you asked about.',
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
    '      preId = numeric(0), preType = character(0),',
    '      postId = numeric(0), postType = character(0),',
    '      weight = numeric(0), hop = integer(0), direction = character(0)',
    '    ))',
    '  }',
    '  # An edge inside the seed set comes back from each end, and Build Network sums the',
    '  # weight of every row joining a pair -- so a duplicate is a doubled synapse count in',
    '  # the picture rather than a cosmetic repeat.',
    '  dplyr::distinct(out, preId, postId, .keep_all = TRUE)',
    '}',
  ],
})

/**
 * The multi-hop traversal.
 *
 * The same three rules as the Python helper, and they matter for the same reason: each
 * produces a plausible wrong answer rather than an error.
 */
registerHelper({
  name: 'coda_traverse_connectivity',
  needs: ['coda_edge_list'],
  requires: ['neuprintr', 'dplyr'],
  source: [
    'coda_traverse_connectivity <- function(seed_ids, direction, hops, min_weight,',
    '                                       all_segments, conn) {',
    "  # Coda's Connectivity node past one hop: a breadth-first walk returning an edge list.",
    '  #',
    '  # Three rules worth keeping, each of which silently changes the answer if dropped:',
    '  #',
    '  #  * A neuron is expanded at most once. Connectomes are full of recurrent loops, so a',
    '  #    walk that re-expands a visited neuron does not terminate. The edge back into an',
    '  #    already-visited neuron is still reported; only the expansion is skipped.',
    '  #  * An edge re-found at a later hop keeps the hop it was first given, so the label',
    '  #    says something about the graph rather than about the walk order.',
    '  #  * direction = "both" expands both ways at every hop -- the undirected ball, not two',
    '  #    cones. That is what finds the neurons sharing input with a seed.',
    '  prepost <- switch(direction, inputs = "PRE", both = "BOTH", "POST")',
    '  frontier <- unique(as.numeric(seed_ids))',
    '  expanded <- numeric(0)',
    '  found <- NULL',
    '',
    '  for (hop in seq_len(hops)) {',
    '    todo <- setdiff(frontier, expanded)',
    '    if (length(todo) == 0) break',
    '    expanded <- union(expanded, todo)',
    '',
    '    step <- coda_edge_list(todo, prepost, min_weight, all_segments, conn)',
    '    if (nrow(step) == 0) break',
    '    step$hop <- hop',
    '',
    '    if (is.null(found)) {',
    '      found <- step',
    '    } else {',
    '      # Keep the hop and direction an edge was FIRST given.',
    '      fresh <- dplyr::anti_join(step, found, by = c("preId", "postId"))',
    '      found <- dplyr::bind_rows(found, fresh)',
    '      step <- fresh',
    '    }',
    '',
    '    reached <- ifelse(step$direction == "downstream", step$postId, step$preId)',
    '    frontier <- setdiff(unique(reached), expanded)',
    '  }',
    '',
    '  if (is.null(found)) {',
    '    return(coda_edge_list(numeric(0), prepost, min_weight, all_segments, conn))',
    '  }',
    '  found',
    '}',
  ],
})
