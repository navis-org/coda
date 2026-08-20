/**
 * The viewers, in ggplot2 / igraph / nat.
 *
 * Every one of these is a **tap** in Coda — it passes its input through and draws beside it —
 * so each emitter binds the pass-through and then draws. The styling params reach the plot
 * where ggplot has somewhere to put them and are stated in a comment where it does not: a knob
 * silently ignored is worse than a knob visibly not translated.
 */

import { decodeClauses, resolveFilters, usesRegex } from '../../../nodes/lib/tableFilter'
import { rStr, rVector } from '../r'
import { registerEmitter } from '../registry'
import { selectionIds } from './common'
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
    `x = \`${category}\``,
    `y = \`${value}\``,
    ...(series ? [`fill = \`${series}\``] : []),
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
    lines.push(`${selected} <- ${out} |> filter(\`${idColumn}\` %in% ${rVector(selection)})`)
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
    `x = \`${x}\``,
    `y = \`${y}\``,
    ...(hue ? [`colour = \`${hue}\``] : []),
    ...(size ? [`size = \`${size}\``] : []),
    ...(shape ? [`shape = \`${shape}\``] : []),
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
  if (wired.length === 0) return ctx.todo('No geometry is wired to this 3D Viewer.')

  ctx.library('nat')
  ctx.library('dplyr')
  const selected = ctx.output('selected')
  const selection = selectionIds(ctx)

  const lines = [`plot3d(${wired.join(', ')})`, '']
  if (selection.length > 0) {
    lines.push(`${selected} <- tibble(bodyId = ${rVector(selection)})`)
  } else {
    lines.push(
      ...ctx.note('Nothing is picked in the viewer, so Selected is empty.'),
      `${selected} <- tibble(bodyId = numeric(0))`,
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

registerEmitter('dataset.description', (ctx) => {
  return ctx.todo(
    "This card shows the dataset's published description and citation. Read it with " +
      'neuprint_get_meta() / neuprint_datasets() if you need it here.',
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
    `  "MATCH (n:Neuron) RETURN n.bodyId AS bodyId, n.type AS type,`,
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
