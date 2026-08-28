/**
 * The viewers, in ggplot2 / igraph / nat.
 *
 * Every one of these is a **tap** in Coda — it passes its input through and draws beside it —
 * so each emitter binds the pass-through and then draws. The styling params reach the plot
 * where ggplot has somewhere to put them and are stated in a comment where it does not: a knob
 * silently ignored is worse than a knob visibly not translated.
 */

import { decodeClauses, resolveFilters, usesRegex } from '../../../nodes/lib/tableFilter'
import { rCol as col, rStr, rVector } from '../r'
import { registerEmitter } from '../registry'
import { decodeRanges } from '../../../nodes/lib/chartSelection'
import { selectionIds, selectionLabels } from './common'
import { filterPredicates } from './tableFilters'

registerEmitter('out.table', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const filtered = ctx.output('filtered')
  const { terms, problems } = resolveFilters(ctx.schema('in'), decodeClauses(ctx.params.filters))
  const predicates = filterPredicates(terms, ctx.schema('in'))

  const lines = [`${out} <- ${src}`]

  /*
   * Bound whether or not it filters anything: the walk binds names for the reader, and a node
   * downstream of an unfiltered Filtered port is perfectly ordinary. Leaving the name unbound
   * would emit working R referring to a variable nothing ever creates.
   */
  if (predicates.length === 0) {
    lines.push(`${filtered} <- ${out}`)
  } else if (predicates.length === 1) {
    ctx.library('dplyr')
    lines.push(`${filtered} <- dplyr::filter(${out}, ${predicates[0]})`)
  } else {
    ctx.library('dplyr')
    // Separate arguments rather than one `&` chain: `filter` ANDs them, and one clause per
    // line is what makes a four-clause filter readable and editable.
    lines.push(`${filtered} <- dplyr::filter(`)
    lines.push(`  ${out},`)
    predicates.forEach((predicate, i) =>
      lines.push(`  ${predicate}${i === predicates.length - 1 ? '' : ','}`),
    )
    lines.push(')')
  }

  if (usesRegex(terms)) {
    lines.push(
      ...ctx.note(
        'Coda matches these regexes with JavaScript semantics. `perl = TRUE` is the closest ' +
          'of R’s engines; the two differ on lookbehind and named groups.',
      ),
    )
  }

  // A clause the canvas was ignoring is one this document must ignore too — and say so, or the
  // two quietly report different row counts for the same graph.
  for (const problem of problems) lines.push(...ctx.note(`${problem} — not applied.`))

  // A bare name on the last line prints the frame, which under `df_print: paged` is a
  // scrollable table — the nearest thing R Markdown has to this node.
  return [...lines, predicates.length > 0 ? filtered : out]
})

/**
 * A tap plus a frame *about* the frame.
 *
 * `summary(df)` is what a reader might expect here and is not what this is: it returns
 * formatted text rather than data, and it has no distinct count and no non-zero count.
 * `coda_describe` mirrors `src/nodes/lib/describeOps.ts` instead — see the helper.
 */
registerEmitter('out.describe', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const summary = ctx.output('summary')

  ctx.helper('coda_describe')

  // A bare name on the last line prints the frame, and it is the summary rather than the
  // pass-through, because the summary is what this node is for.
  return [`${out} <- ${src}`, `${summary} <- coda_describe(${out})`, summary]
})

registerEmitter('out.barChart', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  const out = ctx.output('out')
  const category = ctx.column('category')
  const value = ctx.column('value')
  const series = ctx.params.useSeries === true ? ctx.column('series') : undefined

  const lines = [`${out} <- ${src}`]
  if (!category || !value) {
    return [
      ...lines,
      ...ctx.note('No category or value column is picked, so nothing is drawn.'),
    ]
  }

  const aes = [
    `x = ${col(category)}`,
    `y = ${col(value)}`,
    ...(series ? [`fill = ${col(series)}`] : []),
  ]
  lines.push(
    ``,
    `ggplot(${out}, aes(${aes.join(', ')})) +`,
    `  geom_col() +`,
    `  labs(y = ${rStr(value)}) +`,
    `  theme_minimal() +`,
    `  theme(axis.text.x = element_text(angle = 45, hjust = 1))`,
  )
  return lines
})

registerEmitter('out.heatmap', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('tidyr')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const scale = String(ctx.params.scale ?? '')

  const lines = [`${out} <- ${src}`]
  if (scale === 'log') {
    lines.push(
      ...ctx.note('The node draws this on a log scale; the values themselves are unchanged.'),
    )
  }
  // A matrix has to be melted before ggplot can draw it; `pheatmap` would take it directly but
  // is another dependency for one node.
  lines.push(
    ``,
    `${out} |>`,
    `  as.data.frame() |>`,
    `  tibble::rownames_to_column("row") |>`,
    `  pivot_longer(-row, names_to = "column", values_to = "value") |>`,
    `  ggplot(aes(column, row, fill = ${scale === 'log' ? 'log10(1 + value)' : 'value'})) +`,
    `  geom_tile() +`,
    `  scale_fill_viridis_c(option = "rocket") +`,
    `  theme_minimal() +`,
    `  theme(axis.text.x = element_text(angle = 45, hjust = 1))`,
  )
  return lines
})

registerEmitter('out.scatter', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const x = ctx.column('x')
  const y = ctx.column('y')
  const selection = selectionIds(ctx)
  const idColumn = ctx.column('idColumn')

  const lines = [`${out} <- ${src}`]
  if (selection.length > 0 && idColumn) {
    lines.push(`${selected} <- ${out} |> filter(${col(idColumn)} %in% ${rVector(selection)})`)
  } else {
    lines.push(
      ...ctx.note('Nothing is lassoed on the canvas, so Selected is empty.'),
      `${selected} <- ${out} |> slice(0)`,
    )
  }
  if (!x || !y) {
    return [...lines, ...ctx.note('No x or y column is picked, so nothing is drawn.')]
  }

  const hue = ctx.column('colorColumn')
  const size = ctx.column('sizeColumn')
  const shape = ctx.column('shapeBy')
  const aes = [
    `x = ${col(x)}`,
    `y = ${col(y)}`,
    ...(hue ? [`colour = ${col(hue)}`] : []),
    ...(size ? [`size = ${col(size)}`] : []),
    ...(shape ? [`shape = ${col(shape)}`] : []),
  ]
  const opacity = Number(ctx.params.opacity ?? 1)

  lines.push(``, `ggplot(${out}, aes(${aes.join(', ')})) +`)
  lines.push(
    `  geom_point(${Number.isFinite(opacity) && opacity < 1 ? `alpha = ${opacity}` : ''}) +`,
  )
  if (ctx.params.xLog === true) lines.push(`  scale_x_log10() +`)
  if (ctx.params.yLog === true) lines.push(`  scale_y_log10() +`)
  if (String(ctx.params.trend ?? 'none') !== 'none') {
    // `lm` in the transformed space, which is the reading a log axis is put on to get.
    lines.push(`  geom_smooth(method = "lm", se = FALSE) +`)
  }
  if (String(ctx.params.aspect ?? '') === 'equal') lines.push(`  coord_equal() +`)
  lines.push(`  theme_minimal()`)
  return lines
})

/**
 * A categorical selection, as a dplyr predicate.
 *
 * `as.character()` rather than a bare `%in%`, for the same reason the notebook casts: Coda's
 * `markLabel` stringifies the cell before comparing, so a selection made on a numeric category
 * column holds `"5"` and not `5`. Without the cast this document would select nothing on
 * exactly the graphs where the canvas selects something.
 */
function labelFilter(frame: string, column: string, labels: readonly string[]): string {
  return `${frame} |> filter(as.character(${col(column)}) %in% ${rVector(labels)})`
}

registerEmitter('out.histogram', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const value = ctx.column('value')
  const series = ctx.column('series')

  const lines = [`${out} <- ${src}`]

  // The same decode the node runs, so this document and the canvas cut the table at the same
  // numbers rather than at two readings of one stored selection.
  const ranges = decodeRanges(ctx.params.selection)
  if (ranges.length > 0 && value) {
    const clauses = ranges.map(
      (range) =>
        `(${col(value)} >= ${range.lo} & ${col(value)} ${range.closed ? '<=' : '<'} ${range.hi})`,
    )
    lines.push(`${selected} <- ${out} |> filter(`, `  ${clauses.join(' |\n  ')}`, `)`)
  } else {
    lines.push(
      ...ctx.note('No bars are selected on the canvas, so Selected is empty.'),
      `${selected} <- ${out} |> slice(0)`,
    )
  }

  if (!value) {
    return [...lines, ...ctx.note('No value column is picked, so nothing is drawn.')]
  }

  const normalize = String(ctx.params.normalize ?? 'count')
  const cumulative = ctx.params.cumulative === true && normalize !== 'density'
  const fixed = String(ctx.params.binMode ?? 'auto') === 'fixed'
  const bins = Math.max(2, Math.round(Number(ctx.params.bins ?? 30)))

  /*
   * ggplot's y is a mapping rather than a `stat=` argument, so every scaling here goes in the
   * aesthetic — and a cumulative histogram is `cumsum()` over the bin counts rather than a
   * flag. Stated as code rather than dropped with a note: it is the same picture, written the
   * way this language writes it.
   */
  const y = cumulative
    ? normalize === 'percent'
      ? 'cumsum(after_stat(count)) / sum(after_stat(count)) * 100'
      : 'cumsum(after_stat(count))'
    : normalize === 'percent'
      ? 'after_stat(count) / sum(after_stat(count)) * 100'
      : normalize === 'density'
        ? 'after_stat(density)'
        : undefined

  const aes = [
    `x = ${col(value)}`,
    ...(y ? [`y = ${y}`] : []),
    ...(series && series !== value ? [`fill = ${col(series)}`] : []),
  ]
  // Notes go before the chain rather than inside it. A comment between two `+`-continued
  // lines parses, but it reads as a step in the plot and it is not one.
  if (!fixed) {
    lines.push(
      ...ctx.note(
        'Coda picks the bin count by Freedman–Diaconis capped at 80; ggplot has no automatic ' +
          'rule and defaults to 30, which is what is written here.',
      ),
    )
  }
  lines.push(
    ``,
    `ggplot(${out}, aes(${aes.join(', ')})) +`,
    `  geom_histogram(bins = ${fixed ? bins : 30}, position = "stack") +`,
  )
  if (ctx.params.logX === true) lines.push(`  scale_x_log10() +`)
  lines.push(`  theme_minimal()`)
  return lines
})

registerEmitter('out.pie', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const category = ctx.column('category')
  const value = ctx.column('value')

  const lines = [`${out} <- ${src}`]

  const labels = selectionLabels(ctx)
  if (labels.length > 0 && category) {
    lines.push(`${selected} <- ${labelFilter(out, category, labels)}`)
  } else {
    lines.push(
      ...ctx.note('No slices are selected on the canvas, so Selected is empty.'),
      `${selected} <- ${out} |> slice(0)`,
    )
  }

  if (!category) {
    return [...lines, ...ctx.note('No category column is picked, so nothing is drawn.')]
  }

  const maxSlices = Math.max(2, Math.round(Number(ctx.params.maxSlices ?? 8)))
  const donut = ctx.params.shape !== 'pie'
  /*
   * Prefixed with the node's own name, and not with an underscore.
   * **A leading `_` is a syntax error in R** — since 4.2 it is the native pipe's placeholder —
   * so the `_plot` idiom the Python emitters use does not carry over. Naming them after the
   * node also keeps two charts in one document from overwriting each other's working tables.
   */
  const totals = `${ctx.name}_totals`
  const slices = `${ctx.name}_slices`

  lines.push(
    ``,
    // Tallied, then ranked by size, then folded — in that order, because which categories get
    // a slice is decided by size whatever the display order is. dplyr alone rather than
    // `forcats::fct_lump_n`, which says it in one call at the price of a package the setup
    // chunk would attach for this one node.
    `${totals} <- ${out} |>`,
    value
      ? `  count(${col(category)}, wt = ${col(value)}, name = "value") |>`
      : `  count(${col(category)}, name = "value") |>`,
    `  arrange(desc(value))`,
    `${slices} <- ${totals} |>`,
    `  mutate(${col(category)} = ifelse(row_number() <= ${maxSlices}, as.character(${col(category)}), "Other")) |>`,
    `  group_by(${col(category)}) |>`,
    `  summarise(value = sum(value), .groups = "drop") |>`,
    ctx.params.sortSlices !== false
      ? `  arrange(desc(value))`
      : `  arrange(${col(category)})`,
  )
  lines.push(
    ``,
    // The donut recipe: a stacked column in polar coordinates, with the x limit deciding
    // whether there is a hole. `theme_void` because a pie has no axes to draw.
    `ggplot(${slices}, aes(x = 2, y = value, fill = ${col(category)})) +`,
    `  geom_col(width = 1, colour = "white") +`,
    `  coord_polar(theta = "y") +`,
    donut ? `  xlim(0.5, 2.5) +` : `  xlim(0, 2.5) +`,
    `  theme_void()`,
  )
  return lines
})

registerEmitter('out.distribution', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const value = ctx.column('value')
  const group = ctx.column('group')

  const lines = [`${out} <- ${src}`]

  const labels = selectionLabels(ctx)
  if (labels.length > 0 && group) {
    lines.push(`${selected} <- ${labelFilter(out, group, labels)}`)
  } else {
    lines.push(
      ...ctx.note('No boxes are selected on the canvas, so Selected is empty.'),
      `${selected} <- ${out} |> slice(0)`,
    )
  }

  if (!value) {
    return [...lines, ...ctx.note('No value column is picked, so nothing is drawn.')]
  }

  const grouped = !!group && group !== value
  const style = String(ctx.params.style ?? 'box')
  const whiskers = String(ctx.params.whiskers ?? 'tukey')
  const maxGroups = Math.max(1, Math.round(Number(ctx.params.maxGroups ?? 24)))
  // Not `_keep`/`_plot`: a leading underscore is a syntax error in R. See the pie emitter.
  const keep = `${ctx.name}_keep`
  const plot = `${ctx.name}_data`

  if (grouped) {
    // The cap is part of the picture: without it this document draws every group and the two
    // disagree about what is on screen.
    lines.push(
      ``,
      `${keep} <- ${out} |> count(${col(group)}, sort = TRUE) |> head(${maxGroups}) |> pull(${col(group)})`,
      `${plot} <- ${out} |> filter(${col(group)} %in% ${keep})`,
    )
  } else {
    lines.push(``, `${plot} <- ${out}`)
  }

  if (whiskers === 'p5p95' && style !== 'violin') {
    // `coef` is a multiple of the IQR and cannot express a percentile pair, so this one knob
    // does not translate — said out loud, before the chain, rather than silently drawn as
    // Tukey.
    lines.push(
      ...ctx.note(
        'The 5th–95th percentile whisker has no `geom_boxplot` equivalent — `coef` is a ' +
          'multiple of the IQR — so this draws the full range instead.',
      ),
    )
  }

  // The value axis is `x` laid out as rows and `y` as columns; ggplot reads the orientation off
  // the mapping, so swapping the pair is the whole translation.
  const columns = ctx.params.orientation === 'columns'
  const valueAxis = columns ? 'y' : 'x'
  const groupAxis = columns ? 'x' : 'y'
  const aes = grouped
    ? `${valueAxis} = ${col(value)}, ${groupAxis} = ${col(group)}`
    : `${valueAxis} = ${col(value)}, ${groupAxis} = ""`
  lines.push(`ggplot(${plot}, aes(${aes})) +`)
  if (style === 'box') {
    const outliers = ctx.params.points === 'none' ? ', outlier.shape = NA' : ', outlier.size = 0.8'
    lines.push(`  geom_boxplot(coef = ${coefFor(whiskers)}${outliers}) +`)
  } else if (style === 'violin') {
    lines.push(`  geom_violin(draw_quantiles = c(0.25, 0.5, 0.75)) +`)
  } else if (style === 'both') {
    lines.push(
      `  geom_violin(alpha = 0.35) +`,
      `  geom_boxplot(width = 0.2, coef = ${coefFor(whiskers)}, outlier.shape = NA) +`,
    )
  } else {
    /*
     * `ggbeeswarm::geom_quasirandom` is the faithful mark and is another package for one style,
     * so this uses the jitter ggplot2 already has and says which it is. A quasirandom swarm and
     * a jitter answer the same question; only the second is reproducible from a seed.
     */
    if (style === 'swarmBox') {
      lines.push(`  geom_boxplot(alpha = 0.35, coef = ${coefFor(whiskers)}, outlier.shape = NA) +`)
    }
    lines.push(`  geom_jitter(width = 0.15, height = 0, size = 0.8, alpha = 0.7) +`)
  }
  if (ctx.params.logAxis === true) lines.push(`  scale_${valueAxis}_log10() +`)
  lines.push(`  theme_minimal()`)
  if (style === 'swarm' || style === 'swarmBox') {
    lines.push(
      ...ctx.note(
        'Coda packs a swarm so no two marks overlap and thins it to 300 per group. ' +
          '`geom_jitter` scatters them at random instead; `ggbeeswarm::geom_quasirandom` is ' +
          'the faithful mark if you want to add the dependency.',
      ),
    )
  }
  return lines
})

/** `geom_boxplot`'s `coef`, for the rules it can express. */
function coefFor(rule: string): string {
  // Tukey's 1.5 is the default; the full range is any multiple large enough to reach it, and
  // `Inf` is the idiomatic way to say so.
  return rule === 'tukey' ? '1.5' : 'Inf'
}

registerEmitter('out.network', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('igraph')
  const out = ctx.output('out')
  const minLinkWeight = Number(ctx.params.minLinkWeight ?? 0)
  const hideIsolated = ctx.params.hideIsolated === true

  const lines = [`${out} <- ${src}`]
  // Not presentational on this node: these change what it *returns*, so they apply to the
  // value and not merely to the drawing.
  if (minLinkWeight > 0) {
    lines.push(`${out} <- delete_edges(${out}, E(${out})[E(${out})$weight < ${minLinkWeight}])`)
  }
  if (hideIsolated)
    lines.push(`${out} <- delete_vertices(${out}, V(${out})[degree(${out}) == 0])`)

  lines.push(
    ``,
    ...ctx.note(
      'Coda draws this with ForceAtlas2 in the browser. igraph has no equivalent, so the ' +
        'graph is handed over and the layout is yours to pick — uncomment one.',
    ),
    `# plot(${out}, layout = layout_with_fr(${out}), vertex.size = 4, vertex.label = NA)`,
    `# plot(${out}, layout = layout_with_kk(${out}))`,
    `# plot(${out}, layout = layout_as_tree(${out}))`,
  )
  return lines
})

registerEmitter('out.viewer3d', (ctx) => {
  const wired = ['skeletons', 'meshes', 'points']
    .map((port) => ctx.input(port))
    .filter((v): v is string => !!v)
  const volumes = ctx.input('volumes')
  if (wired.length === 0 && !volumes) return ctx.todo('No geometry is wired to this 3D Viewer.')

  ctx.library('nat')
  ctx.library('dplyr')
  const selected = ctx.output('selected')
  const selection = selectionIds(ctx)

  const lines = wired.length > 0 ? [`plot3d(${wired.join(', ')})`] : []
  if (volumes) {
    /*
     * Shells go in through rgl rather than through `plot3d`, because what that socket carries
     * is a list of `mesh3d` and `plot3d` has no method for one. The alpha is the card's own
     * default: a neuropil is drawn so that something else can be seen inside it.
     */
    lines.push(
      `for (.mesh in ${volumes}) rgl::shade3d(.mesh, alpha = 0.12, col = "grey70")`,
    )
  }
  lines.push('')
  if (selection.length > 0) {
    lines.push(`${selected} <- tibble(neuronId = ${rVector(selection)})`)
  } else {
    lines.push(
      ...ctx.note('Nothing is picked in the viewer, so Selected is empty.'),
      `${selected} <- tibble(neuronId = numeric(0))`,
    )
  }
  return lines
})

registerEmitter('out.download', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const filename = String(ctx.params.filename ?? '') || 'export'
  const format = String(ctx.params.format ?? 'csv')

  const lines = [`${out} <- ${src}`]
  switch (format) {
    case 'json':
      lines.push(
        ...ctx.note('Needs the jsonlite package.'),
        `jsonlite::write_json(${out}, ${rStr(`${filename}.json`)}, pretty = TRUE)`,
      )
      break
    case 'svg':
    case 'png':
      ctx.library('ggplot2')
      lines.push(
        ...ctx.note(
          'In Coda this saves the chart drawn by the node upstream. Here the plot chunk has ' +
            'already drawn it, so this saves the last plot.',
        ),
        `ggsave(${rStr(`${filename}.${format}`)})`,
      )
      break
    default:
      ctx.library('readr')
      lines.push(`write_csv(${out}, ${rStr(`${filename}.csv`)})`)
  }
  return lines
})

registerEmitter('out.neuroglancer', (ctx) => {
  return ctx.todo(
    'This node builds a neuroglancer URL by editing the scene its dataset publishes. That ' +
      'scene is a fetch this translation does not make, so no link is built here.',
  )
})

// A note rather than a TODO — see the Python emitter, which records why at length: the card is
// prose with no outputs, and it is on every published dataset node by default.
registerEmitter('dataset.description', (ctx) => {
  return ctx.note(
    "This card shows the dataset's published description and citation, which is prose rather " +
      'than a step. Read it with neuprint_get_meta() / neuprint_datasets() if you need it here.',
  )
})

// ---------------------------------------------------------------------------
// Dataset Summary / ROIs
// ---------------------------------------------------------------------------

registerEmitter('out.datasetSummary', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  ctx.library('dplyr')
  const neurons = `${ctx.name}_neurons`
  const status = String(ctx.params.status ?? '')
  const topTypes = Number(ctx.params.topTypes ?? 20)

  return [
    ...ctx.note(
      'The card counts the whole dataset index. `neuprint_get_meta` on every body is the ' +
        'equivalent and is a large download — expect this chunk to take a while.',
    ),
    `${neurons} <- neuprint_fetch_custom(`,
    // Aliased: neuprint_fetch_custom names columns after the RETURN expressions.
    `  "MATCH (n:Neuron) RETURN n.bodyId AS neuronId, n.type AS type,`,
    `   n.status AS status, n.pre AS pre, n.post AS post",`,
    `  conn = ${conn}`,
    `)`,
    ``,
    ...(status ? [`${neurons} <- ${neurons} |> filter(status == ${rStr(status)})`, ``] : []),
    `${ctx.name}_top_types <- ${neurons} |>`,
    `  count(type, sort = TRUE) |>`,
    `  head(${topTypes})`,
    `${ctx.name}_top_types`,
  ]
})

registerEmitter('out.rois', (ctx) => {
  const conn = ctx.wired('dataset')
  ctx.library('neuprintr')
  const primaryOnly = ctx.params.primaryOnly !== false

  return [
    ...ctx.note(
      'Region meshes are display surfaces published for visualization — a volume measured ' +
        'off one is an approximation rather than a figure to quote.',
    ),
    `${ctx.name}_rois <- neuprint_ROIs(superLevel = ${primaryOnly ? 'FALSE' : 'NA'}, conn = ${conn})`,
    ``,
    `# One request each. nat::plot3d() draws them once read.`,
    `# ${ctx.name}_meshes <- lapply(${ctx.name}_rois, neuprint_ROI_mesh, conn = ${conn})`,
    `${ctx.name}_rois`,
  ]
})
