/** Build Network, Paths, Explore, Profile, the clustering trio, and the similarity pair. */

// An emitter may reach `src/ui` — see the notebook emitter for why the palette lives there.
import { MAX_SERIES } from '../../../ui/colors'
import { clusterColor } from '../../../ui/encoding'
import { rCol as col, rStr, rVector } from '../r'
import type { LANDMARK_SIDES } from '../../../nodes/transform/landmarkTransform'
import { LANDMARK_AXES, landmarkParamId } from '../../../nodes/transform/landmarkTransform'
import { matchParamsFrom } from '../../../nodes/lib/matchOps'
import { effectiveOutput, isLongLayout } from '../../../nodes/lib/similarityOps'
import type { SimilarityMetric, SimilarityOutput } from '../../../nodes/lib/similarityOps'
import { portIdAt } from '../../../core/ports'
import { compareParamsFrom } from '../../../nodes/lib/edgeComparison'
import { repeatParamId } from '../../../nodes/lib/repeatParams'
import { resolveDatasetNames } from '../../../nodes/analysis/compareConnectivity'
import { registerEmitter, registerHelper } from '../registry'
import type { EmitContext } from '../types'
import { neuronIds, selectionIds } from './common'

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
    `  ${neuronIds(sources)},`,
    `  ${neuronIds(targets)},`,
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
      'Explore Dataset downloads the whole neuron table once and searches it locally. On male-CNS ' +
        'that is around 165,000 rows; expect this chunk to take a few seconds.',
    ),
    `${all} <- neuprint_fetch_custom(`,
    // Aliased, because neuprint_fetch_custom names its columns after the RETURN expressions
    // — without `AS` the column is literally called `n.bodyId`, which nothing downstream finds.
    // The alias is also the id-column seam: neuPrint's property is `bodyId`, Coda's is `neuronId`.
    `  "MATCH (n:Neuron) RETURN n.bodyId AS neuronId, n.type AS type, n.instance AS instance,`,
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
    lines.push(
      ``,
      ...ctx.note('The search box is empty, so Hits is the whole table.'),
      `${hits} <- ${all}`,
    )
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
    lines.push(`${selected} <- ${all} |> filter(neuronId %in% ${rVector(selection)})`)
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
    "  # Coda's Explore Dataset query language, matching only.",
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
    '        cols <- union(cols, intersect("neuronId", names(df)))',
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
    lines.push(`${current} <- ${out} |> filter(neuronId %in% ${rVector(selection)})`)
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
  const ids = selection.length > 0 ? rVector(selection) : neuronIds(out)
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
 * Everything the Neuron Profile card shows, as a list of data frames.
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
    "  # Keys mirror the card's tiles: upstream_types, downstream_types, top_upstream,",
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

// ---------------------------------------------------------------------------
// NBLAST
// ---------------------------------------------------------------------------

/**
 * `nat.nblast` is the original, and Coda's is a port of a port — so this is the one emitter
 * that translates *back* to the reference implementation.
 *
 * Two things do not carry across. Units: `neuprint_read_neurons` returns raw voxels, which is
 * 8 nm on the hemibrain and is a per-dataset fact nothing in the graph records, so the factor
 * is emitted with its assumption stated rather than hidden in a helper. And symmetry: R folds
 * normalisation and symmetry into one `normalisation` argument with three values, so `min` and
 * `max` have nowhere to go and say so.
 */
registerEmitter('neuron.nblast', (ctx) => {
  const query = ctx.wired('query')
  const target = ctx.input('target')
  ctx.library('nat')
  ctx.library('nat.nblast')

  const out = ctx.output('scores')
  const dots = `${ctx.name}_dps`
  const k = Number(ctx.params.k ?? 5)
  const resample = Number(ctx.params.resample ?? 1)
  const symmetry = String(ctx.params.symmetry ?? 'mean')
  const normalized = ctx.params.normalize !== false
  const useAlpha = ctx.params.useAlpha === true

  const dotprops = (from: string, name: string): string[] => [
    `${name} <- dotprops(`,
    `  ${from} * VOXEL_UM,`,
    `  k = ${k},`,
    ...(resample > 0 ? [`  resample = ${resample},`] : []),
    `)`,
  ]

  const lines: string[] = [
    ...ctx.note(
      'NBLAST is calibrated in micrometres and neuprintr returns raw voxels — 8 nm on the ' +
        'hemibrain. Check this factor against your dataset: nothing in the graph records it.',
    ),
    `VOXEL_UM <- 8 / 1000`,
    ``,
    ...dotprops(query, dots),
  ]

  const targetDots = target ? `${ctx.name}_target_dps` : undefined
  if (target && targetDots) lines.push(``, ...dotprops(target, targetDots))

  const alpha = useAlpha ? [`  UseAlpha = TRUE,`] : []

  if (target && targetDots) {
    if (symmetry !== 'none') {
      lines.push(
        ...ctx.note(
          `nat.nblast's nblast() scores query against target only. Coda's "${symmetry}" ` +
            `symmetry would need the reverse call as well — mind the orientation of the two ` +
            `matrices before combining them.`,
        ),
      )
    }
    lines.push(
      ``,
      `${out} <- nblast(`,
      `  query = ${dots},`,
      `  target = ${targetDots},`,
      `  normalised = ${normalized ? 'TRUE' : 'FALSE'},`,
      ...alpha,
      `)`,
    )
    return lines
  }

  // One `normalisation` argument carries what Coda splits over two params, and it has three
  // values rather than four.
  const normalisation = !normalized ? 'raw' : symmetry === 'none' ? 'normalised' : 'mean'
  if (symmetry === 'min' || symmetry === 'max') {
    lines.push(
      ...ctx.note(
        `nat.nblast offers raw, normalised and mean — there is no "${symmetry}". This uses ` +
          `the mean of both directions.`,
      ),
    )
  }
  lines.push(
    ``,
    `${out} <- nblast_allbyall(`,
    `  ${dots},`,
    `  normalisation = ${rStr(normalisation)},`,
    ...alpha,
    `)`,
  )
  return lines
})

/**
 * The one NBLAST capability the natverse does not have.
 *
 * `nat.nblast` scores pairs and `nblast_allbyall` builds the whole matrix; there is no
 * shortlisted k-nearest search, and the honest translation of one is the matrix followed by a
 * per-row top-k — which is the `n²` this node exists to avoid and would be a different
 * computation wearing the same name. So this says so and points at the node that does export.
 */
registerEmitter('neuron.nblastKnn', (ctx) =>
  ctx.todo(
    'nat.nblast has no shortlisted k-nearest search. The honest equivalent is ' +
      'nblast_allbyall() followed by a per-row top-k, which is the full n^2 matrix this node ' +
      'exists to avoid — a different computation under the same name. Use the NBLAST node, ' +
      'which exports as nblast_allbyall(), and take the top matches from its matrix.',
  ),
)

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * `hclust` is the cleanest correspondence in either exporter, and unusually it needs no
 * companion variables: an `hclust` object carries `$merge`, `$height`, `$order` *and*
 * `$labels`, which is the whole of a Coda linkage in one object. Python's `Z` carries only the
 * first two, which is why the notebook has to pass labels alongside.
 *
 * Every one of the five method names was checked against SciPy rather than mapped from memory,
 * on the same 12 x 12 matrix through both: `ward`→`ward.D2`, `average`, `complete`, `single`
 * and `weighted`→`mcquitty` all reproduce the merge heights, and `leaves_list` and `$order`
 * agree exactly. `ward.D` is the older variant of Ward's criterion and is **not** the match —
 * the two differ on the same data and neither errors.
 */
const R_METHODS: Record<string, string> = {
  ward: 'ward.D2',
  average: 'average',
  complete: 'complete',
  single: 'single',
  weighted: 'mcquitty',
}

registerEmitter('cluster.linkage', (ctx) => {
  const src = ctx.wired('in')
  const tree = ctx.output('tree')
  const ordered = ctx.output('ordered')
  const method = R_METHODS[String(ctx.params.method ?? 'ward')] ?? 'ward.D2'
  const symmetry = String(ctx.params.symmetry ?? 'mean')
  const distance = String(ctx.params.distance ?? 'auto')

  const combined =
    symmetry === 'mean'
      ? '(m_ + t(m_)) / 2'
      : symmetry === 'min'
        ? 'pmin(m_, t(m_))'
        : symmetry === 'max'
          ? 'pmax(m_, t(m_))'
          : 'm_'

  const lines: string[] = [
    ...ctx.note(
      `Coda runs navis-fastcore, whose linkage is SciPy's, and "${String(ctx.params.method ?? 'ward')}" ` +
        `is hclust's "${method}". Checked through both on one matrix: same merge heights, same ` +
        `leaf order. Note that "ward.D" is a different criterion and would not agree.`,
    ),
    `m_ <- as.matrix(${src})`,
    `d_ <- as.dist(${distance === 'none' ? combined : `1 - (${combined})`})`,
  ]

  if (symmetry === 'none') {
    lines.push(
      ...ctx.note(
        'Symmetry is off, and `as.dist` reads the **lower** triangle where Coda and the ' +
          'notebook export read the upper. On a matrix that is already symmetric that is the ' +
          'same answer; on one that is not, this is the transpose of what the canvas shows.',
      ),
    )
  }

  lines.push(
    ``,
    `${tree} <- hclust(d_, method = ${rStr(method)})`,
    // The block-diagonal picture, which is what the second port is for.
    `${ordered} <- ${src}[${tree}$order, ${tree}$order]`,
    // An `hclust` carries `$labels` and `$order` but has nowhere to put a cut, so the cluster
    // vector rides beside it. NULL rather than an empty vector: nothing has cut this yet, which
    // is not the same as cutting it into nothing.
    `${tree}_clusters <- NULL`,
  )
  return lines
})

registerEmitter('cluster.cut', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('dplyr')
  const clusters = ctx.output('clusters')
  const tree = ctx.output('tree')
  const byHeight = String(ctx.params.mode ?? 'count') === 'height'

  const cut = byHeight
    ? `cutree(${src}, h = ${Number(ctx.params.height ?? 0.5)})`
    : `cutree(${src}, k = ${Number(ctx.params.count ?? 4)})`

  return [
    ...(byHeight
      ? ctx.note(
          'Cutting at a height gives however many groups fall out below it, which may be one ' +
            'if the height is above the top of the tree.',
        )
      : []),
    `cl_ <- ${cut}`,
    ...ctx.note(
      'Coda numbers clusters left to right as the dendrogram draws them, so the column reads ' +
        'against the picture. `cutree` numbers by observation order; the grouping is the same ' +
        'either way, and this renumbers so the two agree.',
    ),
    `cl_ <- match(cl_, unique(cl_[${src}$order]))`,
    ``,
    `${clusters} <- tibble(`,
    `  label = ${src}$labels,`,
    `  cluster = cl_,`,
    // Zero-based, as the canvas column is, so the two can be compared row for row.
    `  order = match(seq_along(${src}$labels), ${src}$order) - 1L,`,
    `) |>`,
    `  group_by(cluster) |>`,
    `  mutate(size = n()) |>`,
    `  ungroup()`,
    ``,
    `${tree} <- ${src}`,
    `${tree}_clusters <- cl_`,
  ]
})

/**
 * `horiz` was measured rather than assumed, because a mirrored dendrogram is a perfectly
 * plausible picture. Reading `par("usr")` back after the call: `horiz = TRUE` runs the height
 * axis from 0.568 down to −0.022, i.e. the **root at the left and the leaves on the right**,
 * which is Coda's default orientation; `horiz = FALSE` runs the height up the y-axis, i.e. the
 * root at the top and the leaves at the bottom. Both map directly with no flip.
 */
registerEmitter('out.dendrogram', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const down = String(ctx.params.orientation ?? 'right') === 'down'
  // Leaf positions, not names — see the notebook emitter and `out.dendrogram`.
  const selection = selectionIds(ctx)

  const lines = [
    `${out} <- ${src}`,
    // All three companions, not two: the tree passes through, and so does the cut beside it.
    // Bound rather than read from `${src}` below, so a chunk further on sees one name.
    `${out}_clusters <- ${src}_clusters`,
    ``,
    // `as.dendrogram` rather than plotting the hclust directly: `plot.hclust` has no `horiz`,
    // so the orientation this node offers only exists on the dendrogram class.
    `plot(`,
    `  as.dendrogram(${out}),`,
    `  horiz = ${down ? 'FALSE' : 'TRUE'},`,
    ...(ctx.params.showLabels === false ? [`  leaflab = "none",`] : []),
    `)`,
    ``,
  ]

  /*
   * Coda's dark ramp, read off the real palette rather than transcribed — see the notebook
   * emitter. `plot()` above draws in black regardless; what matches the canvas is the column.
   */
  const palette = Array.from({ length: MAX_SERIES }, (_, i) => clusterColor(i + 1, 'dark'))
  const uncut = clusterColor(0, 'dark')

  if (selection.length > 0) {
    lines.push(
      // Coda counts observations from 0 and R indexes from 1, so the shift is explicit rather
      // than left to whoever reads this next.
      `picked_ <- c(${selection.map((i) => i + 1).join(', ')})`,
      `palette_ <- ${rVector(palette)}`,
      `cl_ <- if (is.null(${out}_clusters)) rep(0L, length(${out}$labels)) else ${out}_clusters`,
      `${selected} <- tibble(`,
      `  label = ${out}$labels[picked_],`,
      `  order = match(picked_, ${out}$order) - 1L,`,
      `  cluster = as.integer(cl_[picked_]),`,
      // Cycling past the eighth, as the tree draws it.
      `  color = ifelse(cluster <= 0, ${rStr(uncut)}, palette_[((cluster - 1) %% ${MAX_SERIES}) + 1]),`,
      `) |>`,
      `  arrange(order)`,
    )
  } else {
    lines.push(
      ...ctx.note('No branch is selected on the canvas, so Selected is empty.'),
      `${selected} <- tibble(`,
      `  label = character(), order = integer(), cluster = integer(), color = character(),`,
      `)`,
    )
  }
  return lines
})

/**
 * `Selected to Neurons` / `Clusters to Neurons`, with the same two fidelity concerns the
 * notebook emitter records: **matched as text**, because a tree labelled by neuron id carries
 * strings against a numeric column, and **first match wins**, because `inner_join` would
 * otherwise emit the cross product for a repeated label.
 *
 * `suffix = c("", "_c")` is dplyr's, and it is the right shape here: Coda leaves the neuron
 * columns alone and suffixes only what the labels table brought, which is what an empty first
 * element means.
 */
function labelsToNeuronsEmitter(ctx: EmitContext): string[] {
  const labels = ctx.wired('labels')
  const neurons = ctx.input('neurons')
  ctx.library('dplyr')

  const out = ctx.output('neurons')
  const labelColumn = ctx.column('labelColumn') ?? 'label'
  const suffix = String(ctx.params.suffix ?? '_c')

  if (!neurons) {
    return [
      ...ctx.note(
        'No neuron table is wired on the canvas, so the labels are read as neuron ids. They stay ' +
          '`numeric` rather than becoming `integer`: R integers are 32-bit and a neuron id can ' +
          'exceed that, where a double is exact to 2^53 — which is Coda\'s own representation.',
      ),
      `${out} <- ${labels} |>`,
      `  mutate(neuronId = suppressWarnings(as.numeric(${col(labelColumn)}))) |>`,
      `  filter(!is.na(neuronId)) |>`,
      `  select(neuronId, everything(), -${col(labelColumn)})`,
    ]
  }

  const matchColumn = ctx.column('matchColumn') ?? 'neuronId'
  return [
    ...ctx.note(
      'Coda matches labels as text, so both sides go through a character key — a tree labelled ' +
        'by neuron id carries "722817260" against a numeric column, and joining those directly ' +
        'matches nothing.',
    ),
    `${out} <- ${neurons} |>`,
    `  mutate(key_ = as.character(${col(matchColumn)})) |>`,
    `  inner_join(`,
    `    ${labels} |>`,
    `      mutate(key_ = as.character(${col(labelColumn)})) |>`,
    // First match wins, as in Coda.
    `      distinct(key_, .keep_all = TRUE) |>`,
    `      select(-${col(labelColumn)}),`,
    `    by = "key_",`,
    `    suffix = c("", ${rStr(suffix)}),`,
    `  ) |>`,
    `  select(-key_)`,
  ]
}

registerEmitter('cluster.selectedToNeurons', labelsToNeuronsEmitter)
registerEmitter('cluster.clustersToNeurons', labelsToNeuronsEmitter)

// ---------------------------------------------------------------------------
// Landmark transforms
// ---------------------------------------------------------------------------

/**
 * Landmark Transform, as `nat::tpsreg`.
 *
 * This one was nearly written off. nat's landmark surface *looks* like file I/O —
 * `read.landmarks`, `write.landmarks`, `cmtklandmarks()` handing a pair to CMTK's own binaries
 * — and the version installed on the machine this was checked against (1.8.25) has no spline
 * fitter at all. It does now: `tpsreg()` moved into nat from `elmr` in **1.9.0**, and current
 * nat is 1.11.0.
 *
 * So the natverse has a first-class equivalent after all, and a close one. `tpsreg(sample,
 * reference)` builds the object, `xformpoints.tpsreg` lets `xform()` and everything built on it
 * apply it, and `swap` runs it backwards. It even makes the same two decisions Coda's bridge
 * did independently: the solve is cached for the session keyed by the landmarks, and the
 * inverse is a re-fit rather than an inversion.
 *
 * **`sample` is the space you are coming from and `reference` the one you are going to**, which
 * is nat's convention and the *opposite* of the `refmat`/`tarmat` names in the `Morpho::tps3d`
 * underneath — nat's own documentation flags the clash. Getting it backwards produces a
 * transform that runs and moves neurons the wrong way.
 *
 * `Morpho` is a **Suggests** rather than an Import, so it is not pulled in by installing nat and
 * the note says so. That is the one thing a reader has to act on before this cell runs.
 */
registerEmitter('core.landmarkTransform', (ctx) => {
  const table = ctx.wired('in')
  const out = ctx.output('transform')

  // Through the node's own id builder, so a renamed param breaks the build rather than
  // quietly emitting the "unset columns" TODO.
  const columns = (side: (typeof LANDMARK_SIDES)[number]) =>
    LANDMARK_AXES.map((axis) => ctx.column(landmarkParamId(side, axis)) ?? '')

  const from = columns('source')
  const to = columns('target')
  if ([...from, ...to].some((name) => !name)) {
    return ctx.todo('Landmark Transform has unset coordinate columns — pick all six.')
  }

  ctx.library('nat')
  const matrix = (names: string[], units: unknown) => {
    const cols = `as.matrix(${table}[, c(${names.map(rStr).join(', ')})])`
    return units === 'um' ? `${cols} * 1000` : cols
  }

  return [
    ...ctx.note(
      'nat::tpsreg() needs nat >= 1.9.0 and the Morpho package, which is a Suggests rather ' +
        'than a hard dependency — install.packages("Morpho") if this fails. Coda fits the same ' +
        'spline with navis-fastcore; the two agree to well under a nanometre.',
    ),
    `${out} <- nat::tpsreg(`,
    `  ${matrix(from, ctx.params.sourceUnits)},`,
    `  ${matrix(to, ctx.params.targetUnits)}`,
    `)`,
  ]
})

/**
 * Transform Neurons, but only where a transform is wired.
 *
 * The registry branch is refused for the reason `neuron.mirror` is refused wholesale: it needs a
 * templatebrain object per space, and the natverse spreads those across a package each with the
 * hemibrain having none at all. A supplied `tpsreg` needs no template symbol whatsoever, so that
 * branch translates exactly — `xform()` dispatches through `xformpoints.tpsreg` and works on a
 * neuronlist as readily as on a matrix.
 *
 * Registered rather than left in `NO_EMITTER` because the two branches genuinely differ: one is
 * a gap in what R can name, the other is a cell that runs.
 */
registerEmitter('neuron.xform', (ctx) => {
  const supplied = ctx.input('transform')
  if (!supplied) {
    return ctx.todo(
      'Transform Neurons uses the registrations Coda ships, which are keyed by template space ' +
        'name. The natverse spreads its templatebrain objects across a package each — FAFB14 ' +
        'in nat.flybrains, FlyWire in fafbseg, MANC in malevnc, MaleCNS in malecns — and the ' +
        'hemibrain has none at all, so a faithful cell needs a space-to-package table nobody ' +
        'has written. Wire a Landmark Transform instead and this emits. See neuron.mirror.',
    )
  }
  ctx.library('nat')
  return [`${ctx.output('out')} <- xform(${ctx.wired('in')}, reg = ${supplied})`]
})

// ---------------------------------------------------------------------------
// syNBLAST, and the two cleaning nodes
// ---------------------------------------------------------------------------

/**
 * Three TODOs, and the reasons are three different shapes of gap.
 *
 * The natverse is a *port target* rather than a translation for these. `nat.nblast` scores
 * dotprops and has no synapse-based variant at all; `nat` has resampling and stitching but its
 * smoothing kernel is not the one Coda's card describes; and the mesh half — quadric
 * decimation, ray-cast openness, boundary capping — lives across `Rvcg` and `Morpho` in
 * functions whose arguments do not line up with fastcore's.
 *
 * Each of these could be emitted as *something*. What stops it is `docs/export.md`'s rule that
 * a cell must be what the canvas did: a smoothing call whose one argument means a node count
 * where Coda's meant a distance is a cell that runs, produces plausible neurons, and is not
 * the result on screen. A TODO naming the gap is the honest degradation, and it is what
 * `neuron.nblastKnn` already does one function above.
 *
 * All three point at the notebook, which *is* exact — `navis-fastcore` is a Python package and
 * the Python exporter calls the same wheel Coda runs.
 */

registerEmitter('neuron.synblast', (ctx) =>
  ctx.todo(
    'The natverse has no synapse-based NBLAST. nat.nblast scores dotprops — tangent vectors ' +
      'fitted to skeleton points — and syNBLAST compares connector positions with the dot ' +
      'product fixed at 1, which is a different score out of the same lookup matrix. Export ' +
      'this graph as a notebook instead: navis-fastcore is a Python package, so that cell ' +
      'calls the same implementation Coda ran.',
  ),
)

registerEmitter('neuron.cleanSkeletons', (ctx) =>
  ctx.todo(
    'nat has resample() and stitch_neurons(), which are close to two of the four steps here, ' +
      'but its smoothing takes a window in nodes where this node takes a Gaussian width in ' +
      'micrometres along the neurite — a cell that ran would produce plausible neurons that ' +
      'are not the ones on screen. Export as a notebook for the exact pipeline; it calls ' +
      'navis-fastcore, which is what Coda ran.',
  ),
)

registerEmitter('neuron.cleanMeshes', (ctx) =>
  ctx.todo(
    'Mesh decimation and smoothing exist in Rvcg (vcgQEdecim, vcgSmooth) but stripping ' +
      'invaginated internal membrane has no equivalent anywhere in R, and it is the step that ' +
      'changes what a surface area or a volume means. Export as a notebook, which calls the ' +
      'same navis-fastcore functions Coda ran.',
  ),
)

// ---------------------------------------------------------------------------
// NBLAST Matches
// ---------------------------------------------------------------------------

/**
 * The one of the four that translates cleanly, because it is arithmetic on a matrix rather
 * than a call into somebody's neuron library.
 *
 * Two of fastcore's rules have to survive the translation and both are easy to lose:
 * `percentage` is a band around **each row's own** best value rather than a quantile of the
 * matrix, and `skip_self` is the *diagonal* rather than a comparison of names. Written out
 * here in base R so both are visible rather than buried in a helper.
 */
registerEmitter('neuron.nblastMatches', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('matches')
  // The node's own decoder, for the reason the Python emitter uses it: three transcriptions of
  // "the card stores `axis` as text and means an axis number" is three places to get it wrong,
  // and only one of them has a test.
  const p = matchParamsFrom(ctx.params)
  const { mode, axis, direction, skipSelf, cutoff } = p
  const lower = direction === 'lower'

  const lines: string[] = [
    `m_ <- as.matrix(${src})`,
    // `axis = 1` is the transpose and nothing else, which is what keeps the rest of this cell
    // written once. fastcore strides the buffer instead; the answer is the same.
    ...(axis === 1 ? [`m_ <- t(m_)`] : []),
  ]

  if (skipSelf) {
    lines.push(
      // The diagonal, exactly as fastcore means it — not a match on names.
      `diag(m_) <- ${lower ? 'Inf' : '-Inf'}`,
    )
  }
  if (lower) {
    lines.push(
      ...ctx.note('This is a distance matrix, so the sign is flipped and lower scores rank first.'),
      `m_ <- -m_`,
    )
  }

  if (direction === 'auto') {
    lines.push(
      ...ctx.note(
        'Best means is on "from the matrix", which Coda answers by reading what the matrix ' +
          'says its cells are. A plain matrix has nowhere to carry that, so this assumes ' +
          'higher is better.',
      ),
    )
  }

  const scoreBack = lower ? '-' : ''

  if (mode === 'top') {
    lines.push(
      `n_ <- min(${p.n}, ncol(m_)${skipSelf ? ' - 1' : ''})`,
      `${out} <- do.call(rbind, lapply(seq_len(nrow(m_)), function(i) {`,
      `  ord <- order(m_[i, ], decreasing = TRUE)[seq_len(n_)]`,
      // A row that ran out of finite cells — everything masked, or NA in the matrix — yields
      // fewer rows rather than rows naming a match that is not there. fastcore pads with -1
      // and Coda drops the padding; this is the same outcome by not creating it.
      `  ord <- ord[is.finite(m_[i, ord])]`,
      `  if (!length(ord)) return(NULL)`,
      `  data.frame(`,
      `    query = rownames(m_)[i],`,
      `    target = colnames(m_)[ord],`,
      `    rank = seq_along(ord),`,
      `    score = ${scoreBack}m_[i, ord],`,
      `    stringsAsFactors = FALSE`,
      `  )`,
      `}))`,
    )
    return lines
  }

  // The cutoff, per row, as a vector — which is what makes the percentage band a band around
  // each row's own best rather than around the matrix's.
  lines.push(
    cutoff === 'percentage'
      ? `cut_ <- apply(m_, 1, function(r) max(r[is.finite(r)], -Inf)) * (1 - ${p.percentage})`
      : `cut_ <- rep(${lower ? -p.threshold : p.threshold}, nrow(m_))`,
  )

  if (cutoff === 'percentage') {
    lines.push(
      ...ctx.note(
        'The band is around each row’s own best score, not the matrix’s — 0.05 keeps ' +
          'everything within 5% of that neuron’s top match. Note this multiplies, so it ' +
          'behaves as intended only for positive scores, which normalised NBLAST gives.',
      ),
    )
  }

  if (mode === 'count') {
    lines.push(
      `${out} <- data.frame(`,
      `  query = rownames(m_),`,
      `  matches = vapply(seq_len(nrow(m_)), function(i) sum(m_[i, ] >= cut_[i], na.rm = TRUE), integer(1)),`,
      `  stringsAsFactors = FALSE`,
      `)`,
    )
    return lines
  }

  lines.push(
    `${out} <- do.call(rbind, lapply(seq_len(nrow(m_)), function(i) {`,
    `  hit <- which(is.finite(m_[i, ]) & m_[i, ] >= cut_[i])`,
    `  if (!length(hit)) return(NULL)`,
    `  hit <- hit[order(m_[i, hit], decreasing = TRUE)]`,
    `  data.frame(`,
    `    query = rownames(m_)[i],`,
    `    target = colnames(m_)[hit],`,
    `    rank = seq_along(hit),`,
    `    score = ${scoreBack}m_[i, hit],`,
    `    stringsAsFactors = FALSE`,
    `  )`,
    `}))`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// Partner Vectors and Similarity Matrix
// ---------------------------------------------------------------------------

/**
 * Both chunks are a call into a generated helper rather than inline dplyr — the notebook
 * exporter's reasoning, unchanged one language over: what matters here is a handful of rules a
 * reader would transcribe subtly differently, and repeating them in every document is a chance
 * per document to get one wrong.
 *
 * Params hidden by `visibleIf` are left out of the call rather than passed with their stored
 * value, since they are excluded from the provenance key and the run this mirrors never read
 * them.
 */
registerEmitter('neuron.partnerVectors', (ctx) => {
  const src = ctx.wired('in')
  const weight = ctx.column('weight')
  if (!weight) return ctx.todo('This Partner Vectors node has no weight column picked.')

  ctx.helper('coda_partner_vectors')
  const neurons = ctx.input('neurons')
  const partnerBy = String(ctx.params.partnerBy ?? 'type')

  return [
    `${ctx.output('out')} <- coda_partner_vectors(`,
    `  ${src},`,
    ...(neurons ? [`  neurons = ${neurons},`] : []),
    `  partner_by = ${rStr(partnerBy)},`,
    ...(partnerBy === 'type'
      ? [`  untyped = ${rStr(String(ctx.params.untyped ?? 'id'))},`]
      : []),
    `  weight = ${rStr(weight)},`,
    `  weighting = ${rStr(String(ctx.params.weighting ?? 'raw'))}`,
    `)`,
  ]
})

registerEmitter('core.similarity', (ctx) => {
  const src = ctx.wired('in')
  const metric = String(ctx.params.metric ?? 'cosine') as SimilarityMetric
  // Through `effectiveOutput`: Euclidean hides the Output param, so reading it raw would put an
  // argument in the document that the run it mirrors never used.
  const output = effectiveOutput(
    metric,
    String(ctx.params.output ?? 'similarity') as SimilarityOutput,
  )
  const out = ctx.output('matrix')
  const tail = [`  metric = ${rStr(metric)},`, `  output = ${rStr(output)}`, `)`]
  // Through the same predicate the node's `visibleIf` uses, rather than this emitter's own
  // literal — the pair were testing `layout === 'wide'` in three places with three spellings.
  const long = isLongLayout(ctx.params)

  const idColumn = long ? undefined : ctx.column('idColumn')
  const picked = long ? [] : ctx.columns('wideFeatures')
  const observations = long ? ctx.column('observations') : undefined
  const features = long ? ctx.column('features') : undefined
  // Guards before `ctx.helper`, matching Partner Vectors above: a misconfigured node that emits
  // a TODO should not still pull two hundred lines of helper — and, here, an `install.packages`
  // line for Matrix — into the document.
  if (!long && (!idColumn || picked.length === 0)) {
    return ctx.todo('This Similarity Matrix needs an Id column and at least one feature column.')
  }
  if (long && (!observations || !features)) {
    return ctx.todo('This Similarity Matrix needs an Observations and a Features column.')
  }
  // No `ctx.library('Matrix')`: the helper declares its own package through `requires`, which is
  // what makes it impossible to pull the helper in without it.
  ctx.helper('coda_similarity')

  if (!long) {
    return [
      `${out} <- coda_similarity_wide(`,
      `  ${src},`,
      `  id_column = ${rStr(idColumn!)},`,
      `  columns = ${rVector(picked)},`,
      ...tail,
    ]
  }
  const value = ctx.column('value')
  return [
    `${out} <- coda_similarity_long(`,
    `  ${src},`,
    `  observations = ${rStr(observations!)},`,
    `  features = ${rStr(features!)},`,
    ...(value ? [`  value = ${rStr(value)},`] : []),
    ...tail,
  ]
})

// ---------------------------------------------------------------------------
// Compare Connectivity
// ---------------------------------------------------------------------------

/**
 * Type-level edge comparison across datasets. `coda_compare_connectivity` carries every rule —
 * see the helper for which two base R gets right on its own and which two it does not.
 *
 * The dataset names come from `resolveDatasetNames`, the node's own function: they are the
 * output's column names and they are deduplicated, so an emitter re-deriving that rule would
 * name a column the canvas does not have.
 *
 * The helper returns a list, destructured here rather than inside it, so both output variables
 * read as the node's two ports.
 */
registerEmitter('compare.connectivity', (ctx) => {
  const spec = compareParamsFrom(ctx, resolveDatasetNames(ctx), repeatParamId)
  const specs: string[] = []
  for (const [i, columns] of spec.columns.entries()) {
    const index = i + 1
    if (!columns.pre || !columns.post) {
      return ctx.todo(`Dataset ${index} of this Compare Connectivity has no pre or post column.`)
    }
    const entry = [
      `name = ${rStr(spec.names[i]!)}`,
      `edges = ${ctx.wired(portIdAt('edges', index))}`,
      `labels = ${ctx.wired(portIdAt('labels', index))}`,
      `pre = ${rStr(columns.pre)}`,
      `post = ${rStr(columns.post)}`,
      // Absent rather than empty: the helper reads a missing element as "one per row", which is
      // what an unweighted edge list means.
      ...(columns.weight ? [`weight = ${rStr(columns.weight)}`] : []),
      `id_column = ${rStr(spec.idColumn)}`,
      `label_column = ${rStr(spec.labelColumn)}`,
    ]
    specs.push(`  list(${entry.join(', ')})${index < spec.columns.length ? ',' : ''}`)
  }

  ctx.helper('coda_compare_connectivity')
  // The house scratch-name idiom in this file, rather than a suffix on a user-visible output.
  const cmp_ = `cmp_${ctx.output('comparison')}`
  return [
    `${cmp_} <- coda_compare_connectivity(list(`,
    ...specs,
    `), min_weight = ${spec.minWeight})`,
    `${ctx.output('comparison')} <- ${cmp_}$comparison`,
    `${ctx.output('counts')} <- ${cmp_}$counts`,
  ]
})
