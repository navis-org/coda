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
import { regionOptions } from '../../../nodes/lib/connectivityOps'

registerEmitter('neuron.connectivity', (ctx) => {
  const conn = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  ctx.library('neuprintr')
  ctx.library('dplyr')

  const out = ctx.output('connections')
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
      `${out} <- coda_traverse_connectivity(`,
      `  ${neuronIds(neurons)},`,
      `  direction = ${rStr(direction)},`,
      `  hops = ${hops},`,
      `  min_weight = ${minWeight},`,
      `  conn = ${conn}`,
      `)`,
    ]
  }

  ctx.helper('coda_edge_list')
  const prepost = direction === 'inputs' ? 'PRE' : direction === 'both' ? 'BOTH' : 'POST'
  return [
    `${out} <- coda_edge_list(`,
    `  ${neuronIds(neurons)},`,
    `  prepost = ${rStr(prepost)},`,
    `  min_weight = ${minWeight},`,
    `  conn = ${conn}`,
    `)`,
  ]
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
    'coda_edge_list <- function(ids, prepost, min_weight, conn) {',
    "  # Coda's Connectivity output: preId -> postId, always oriented the way the synapse",
    '  # points, whichever way the traversal travelled.',
    '  one <- function(side) {',
    '    tbl <- neuprint_connection_table(',
    '      ids, prepost = side, threshold = min_weight, details = TRUE, conn = conn',
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
    'coda_traverse_connectivity <- function(seed_ids, direction, hops, min_weight, conn) {',
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
    '    step <- coda_edge_list(todo, prepost, min_weight, conn)',
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
    '    return(coda_edge_list(numeric(0), prepost, min_weight, conn))',
    '  }',
    '  found',
    '}',
  ],
})
