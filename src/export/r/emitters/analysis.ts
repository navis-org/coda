/** Build Network, Paths, Explore and Profile. */

import { rStr, rVector } from '../r'
import { registerEmitter, registerHelper } from '../registry'
import { bodyIds, selectionIds } from './common'

// ---------------------------------------------------------------------------
// Build Network
// ---------------------------------------------------------------------------

registerEmitter('net.build', (ctx) => {
  const edges = ctx.wired('edges')
  ctx.library('igraph')
  ctx.library('dplyr')
  const out = ctx.output('network')
  const source = ctx.column('source') ?? 'preId'
  const target = ctx.column('target') ?? 'postId'
  const weight = ctx.column('weight') ?? 'weight'
  const directed = ctx.params.directed !== false
  const nodes = ctx.input('nodes')
  const minWeight = Number(ctx.params.minWeight ?? 0)

  const lines = [
    // Parallel links merge and only `weight` is summed: a number in a connectivity table is as
    // often an identifier as a measure, and summing `preId` gives a large plausible integer.
    `links <- ${edges} |>`,
    `  group_by(\`${source}\`, \`${target}\`) |>`,
    `  summarise(weight = sum(\`${weight}\`), edges = n(), .groups = "drop")`,
  ]
  if (minWeight > 0) lines.push(`links <- links |> filter(weight >= ${minWeight})`)

  lines.push(
    ``,
    `${out} <- graph_from_data_frame(`,
    `  links,`,
    `  directed = ${directed ? 'TRUE' : 'FALSE'}${nodes ? `,` : ''}`,
    ...(nodes ? [`  vertices = ${nodes}`] : []),
    `)`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

registerEmitter('neuron.paths', (ctx) => {
  const conn = ctx.wired('dataset')
  const sources = ctx.wired('sources')
  const targets = ctx.wired('targets')
  const collapse = ctx.params.collapseTypes !== false
  const maxHops = Number(ctx.params.maxHops ?? 3)
  const minWeight = Number(ctx.params.minWeight ?? 1)

  if (collapse) {
    /*
     * Same refusal as the Python side, and for the same reason: Coda traverses the
     * type-collapsed graph, which finds routes no neuron-level search returns, and Cypher
     * cannot walk a derived graph without GDS.
     */
    return ctx.todo(
      'Paths with "Collapse types" on has no neuprintr equivalent. Coda runs the search on ' +
        'the type-collapsed graph — every neuron of a type expanded together and aggregated ' +
        'back to types at each hop — which finds routes no neuron-level search returns. ' +
        'Switch the node to neuron-level to export it, or write the traversal by hand.',
    )
  }

  ctx.library('neuprintr')
  // `neuprint_get_paths` takes a hop budget directly, which `fetch_shortest_paths` does not —
  // one of the few places R gives up less than Python here.
  return [
    ...ctx.note(
      'neuprintr returns every route within the hop budget. Coda additionally ranks them by ' +
        'their weakest link and keeps the strongest — that ranking is not reproduced, so this ' +
        'is the unranked set.',
    ),
    `${ctx.output('paths')} <- neuprint_get_paths(`,
    `  ${bodyIds(sources)},`,
    `  ${bodyIds(targets)},`,
    `  n = ${maxHops},`,
    `  weightT = ${minWeight},`,
    `  conn = ${conn}`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Explore
// ---------------------------------------------------------------------------

registerEmitter('neuron.explore', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  ctx.library('dplyr')
  const all = ctx.output('all')
  const hits = ctx.output('hits')
  const selected = ctx.output('selected')
  const query = String(ctx.params.query ?? '').trim()
  const limit = Number(ctx.params.limit ?? 0)
  const selection = selectionIds(ctx)

  const lines: string[] = [
    ...ctx.note(
      'Explore downloads the whole neuron table once and searches it locally. On male-CNS ' +
        'that is around 165,000 rows; expect this chunk to take a few seconds.',
    ),
    `${all} <- neuprint_fetch_custom(`,
    // Aliased, because neuprint_fetch_custom names its columns after the RETURN expressions
    // — without `AS` the column is literally called `n.bodyId`, which nothing downstream finds.
    `  "MATCH (n:Neuron) RETURN n.bodyId AS bodyId, n.type AS type, n.instance AS instance,`,
    `   n.status AS status, n.pre AS pre, n.post AS post",`,
    `  conn = ${conn}`,
    `)`,
  ]

  if (query) {
    ctx.helper('coda_search')
    lines.push(``, `${hits} <- coda_search(${all}, ${rStr(query)})`)
    if (limit > 0) {
      lines.push(
        ...ctx.note(
          `Coda caps this at ${limit} hits and keeps the ${limit} most *relevant*; the ` +
            'ranking is not ported, so this keeps the first matches in table order instead.',
        ),
        `${hits} <- ${hits} |> head(${limit})`,
      )
    }
  } else {
    lines.push(``, ...ctx.note('The search box is empty, so Hits is the whole table.'), `${hits} <- ${all}`)
  }

  lines.push(``)
  if (selection.length === 0) {
    lines.push(
      ...ctx.note('Nothing is ticked on the canvas, so Selected is empty.'),
      `${selected} <- ${all} |> slice(0)`,
    )
  } else {
    // Resolved against the whole table rather than against hits, exactly as the node does:
    // refining a search must not drop a neuron somebody already chose.
    lines.push(`${selected} <- ${all} |> filter(bodyId %in% ${rVector(selection)})`)
  }
  return lines
})

/**
 * Coda's neuron search, matching only.
 *
 * Same two departures as the Python port, stated in the same place: hits come back in table
 * order rather than ranked, and a query matching nothing returns nothing where the node would
 * retry it as a subsequence.
 */
registerHelper({
  name: 'coda_search',
  requires: ['dplyr'],
  source: [
    'coda_search <- function(df, query) {',
    '  # Coda\'s Explore query language, matching only.',
    '  #',
    '  # Terms are AND-ed; a leading "!" or "-" negates one. A bare word is a substring of the',
    '  # row\'s searchable text; "field=value" compares one column, with > < >= <= != and ~',
    '  # (unanchored regex) as the other operators.',
    '  #',
    '  # Two things this does NOT reproduce, both of which change which rows you get: hits are',
    '  # in table order rather than ranked by relevance (which matters where the result is',
    '  # capped), and a query matching nothing returns nothing where Coda retries it as a',
    '  # subsequence.',
    '  ops <- c("==", "!=", ">=", "<=", "~", ">", "<", "=")',
    '  tokens <- scan(text = query, what = "", quiet = TRUE)',
    '  if (length(tokens) == 0) return(df)',
    '',
    '  haystack <- NULL',
    '  keep <- rep(TRUE, nrow(df))',
    '',
    '  for (raw in tokens) {',
    '    negate <- FALSE',
    '    if (nchar(raw) > 1 && substr(raw, 1, 1) %in% c("!", "-") &&',
    '        !any(startsWith(substring(raw, 2), ops))) {',
    '      # Only a leading ! or - with something after it negates.',
    '      split_at <- regexpr(paste(ops, collapse = "|"), raw)',
    '      if (split_at <= 1) { negate <- TRUE; raw <- substring(raw, 2) }',
    '    }',
    '',
    '    field <- NULL; op <- NULL; value <- NULL',
    '    for (candidate in ops) {',
    '      at <- regexpr(candidate, raw, fixed = TRUE)',
    '      if (at > 1) {',
    '        f <- substr(raw, 1, at - 1)',
    '        if (grepl("^[A-Za-z_][A-Za-z0-9_.]*$", f)) {',
    '          field <- f; op <- candidate',
    '          value <- substring(raw, at + nchar(candidate))',
    '          break',
    '        }',
    '      }',
    '    }',
    '',
    '    if (is.null(field)) {',
    '      if (is.null(haystack)) {',
    '        cols <- names(df)[vapply(df, function(x) is.character(x) || is.factor(x), TRUE)]',
    '        cols <- union(cols, intersect("bodyId", names(df)))',
    '        haystack <- tolower(do.call(paste, c(lapply(df[cols], function(x)',
    '          ifelse(is.na(x), "", as.character(x))), sep = " ")))',
    '      }',
    '      mask <- grepl(tolower(raw), haystack, fixed = TRUE)',
    '    } else {',
    '      if (nchar(value) == 0) next',
    '      col <- names(df)[tolower(names(df)) == tolower(field)]',
    '      if (length(col) == 0) { keep <- keep & FALSE; next }',
    '      x <- df[[col[1]]]',
    '      missing <- is.na(x)',
    '      if (op == "~") {',
    '        mask <- grepl(value, ifelse(missing, "", as.character(x))) & !missing',
    '      } else if (is.numeric(x)) {',
    '        right <- suppressWarnings(as.numeric(value))',
    '        cmp <- switch(op, "=" = , "==" = x == right, "!=" = x != right,',
    '                      ">" = x > right, "<" = x < right, ">=" = x >= right, "<=" = x <= right)',
    '        cmp[is.na(cmp)] <- FALSE',
    '        # A missing value satisfies != and nothing else.',
    '        mask <- if (op == "!=") cmp | missing else cmp & !missing',
    '      } else {',
    '        left <- tolower(ifelse(missing, "", as.character(x)))',
    '        right <- tolower(value)',
    '        cmp <- switch(op, "=" = , "==" = left == right, "!=" = left != right,',
    '                      ">" = left > right, "<" = left < right, ">=" = left >= right,',
    '                      "<=" = left <= right)',
    '        cmp[is.na(cmp)] <- FALSE',
    '        mask <- if (op == "!=") cmp | missing else cmp & !missing',
    '      }',
    '    }',
    '    keep <- keep & (if (negate) !mask else mask)',
    '  }',
    '',
    '  df[keep, , drop = FALSE]',
    '}',
  ],
})

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

registerEmitter('out.profile', (ctx) => {
  const src = ctx.wired('neurons')
  const conn = ctx.input('dataset')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const current = ctx.output('current')
  const selection = selectionIds(ctx)
  const minWeight = Math.max(1, Number(ctx.params.minWeight ?? 1))
  const topN = Number(ctx.params.topN ?? 10)

  const lines: string[] = [`${out} <- ${src}`]
  if (selection.length > 0) {
    lines.push(`${current} <- ${out} |> filter(bodyId %in% ${rVector(selection)})`)
  } else {
    lines.push(
      ...ctx.note('No neuron is pinned on the canvas, so Current is empty.'),
      `${current} <- ${out} |> slice(0)`,
    )
  }

  if (!conn) {
    return [
      ...lines,
      ...ctx.note(
        'No Dataset is wired, so the metrics cannot be fetched — this is the pass-through ' +
          'and the pinned row only.',
      ),
    ]
  }

  ctx.helper('coda_profile')
  const ids = selection.length > 0 ? rVector(selection) : bodyIds(out)
  lines.push(
    ``,
    `profile <- coda_profile(`,
    `  ${ids},`,
    `  min_weight = ${minWeight},`,
    `  top_n = ${topN},`,
    `  conn = ${conn}`,
    `)`,
    ``,
    `${ctx.name}_upstream_types <- profile$upstream_types`,
    `${ctx.name}_downstream_types <- profile$downstream_types`,
    `${ctx.name}_top_upstream <- profile$top_upstream`,
    `${ctx.name}_top_downstream <- profile$top_downstream`,
    `${ctx.name}_regions <- profile$regions`,
    ``,
    `${ctx.name}_upstream_types`,
  )
  return lines
})

/**
 * Everything the Profile card shows, as a list of data frames.
 *
 * Cheaper than the widget for the same reason as the Python helper: `neuprint_connection_table`
 * takes the whole id vector, so this costs three requests for a hundred neurons as readily as
 * for one, where the widget pays three per neuron *viewed*.
 */
registerHelper({
  name: 'coda_profile',
  requires: ['neuprintr', 'dplyr'],
  source: [
    'coda_profile <- function(ids, min_weight = 1, top_n = 10, conn) {',
    '  # Keys mirror the card\'s tiles: upstream_types, downstream_types, top_upstream,',
    '  # top_downstream, regions.',
    '  #',
    '  # Three rules that produce a plausible wrong number rather than an error:',
    '  #  * Untyped partners keep their own bucket. Merging them puts a fictitious type at',
    '  #    the top of the list on male-CNS.',
    '  #  * Synapses are summed AND distinct partners counted -- forty synapses onto one',
    '  #    neuron is not forty onto forty.',
    '  #  * roiInfo NESTS: a synapse in LO(R) is counted again in its parent OL(R), so the',
    '  #    regions are filtered to the primary set before summing or the totals double.',
    '  partners <- function(side) {',
    '    tbl <- neuprint_connection_table(',
    '      ids, prepost = side, threshold = min_weight, details = TRUE, conn = conn',
    '    )',
    '    if (is.null(tbl) || nrow(tbl) == 0) return(NULL)',
    '    tbl',
    '  }',
    '',
    '  roll_up <- function(tbl) {',
    '    if (is.null(tbl)) return(NULL)',
    '    tbl |>',
    '      group_by(bodyid) |>',
    '      mutate(total_syn = sum(weight), total_partners = n_distinct(partner)) |>',
    '      group_by(bodyid, type, total_syn, total_partners) |>',
    '      summarise(synapses = sum(weight), partners = n_distinct(partner),',
    '                .groups = "drop") |>',
    '      mutate(synapse_share = synapses / total_syn,',
    '             partner_share = partners / total_partners) |>',
    '      select(-total_syn, -total_partners) |>',
    '      arrange(bodyid, desc(synapses), type) |>',
    '      group_by(bodyid) |>',
    '      (\\(g) if (top_n > 0) slice_head(g, n = top_n) else g)() |>',
    '      ungroup()',
    '  }',
    '',
    '  top_of <- function(tbl) {',
    '    if (is.null(tbl)) return(NULL)',
    '    tbl |>',
    '      group_by(bodyid) |>',
    '      mutate(share = weight / sum(weight)) |>',
    '      arrange(bodyid, desc(weight), partner) |>',
    '      (\\(g) if (top_n > 0) slice_head(g, n = top_n) else g)() |>',
    '      ungroup()',
    '  }',
    '',
    '  up <- partners("PRE")',
    '  down <- partners("POST")',
    '',
    '  primary <- neuprint_ROIs(superLevel = FALSE, conn = conn)',
    '  roi <- neuprint_get_roiInfo(ids, conn = conn)',
    '',
    '  list(',
    '    upstream_types = roll_up(up),',
    '    downstream_types = roll_up(down),',
    '    top_upstream = top_of(up),',
    '    top_downstream = top_of(down),',
    '    regions = roi,',
    '    primary_rois = primary',
    '  )',
    '}',
  ],
})
