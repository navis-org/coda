/**
 * The viewers, in ggplot2 / igraph / nat.
 *
 * Every one of these is a **tap** in Coda — it passes its input through and draws beside it —
 * so each emitter binds the pass-through and then draws. The styling params reach the plot
 * where ggplot has somewhere to put them and are stated in a comment where it does not: a knob
 * silently ignored is worse than a knob visibly not translated.
 */

import { readColorSpec, readShapeSpec, readSizeSpec } from '../../../nodes/lib/encodingParams'
import { usesRegex } from '../../../nodes/lib/tableFilter'
import { copyIdsSettings } from '../../../nodes/lib/copyIds'
import type { MatrixAxis } from '../../../nodes/lib/matrixShape'
import { rCol as col, rStr, rVector } from '../r'
import { hclustMethod } from './analysis'
import { registerEmitter } from '../registry'
import type { Emitter } from '../types'
import { neuronIds } from './common'
import { REGEX_FLAVOUR_NOTE, filterPredicates } from './tableFilters'
import { roisPrimaryOnly } from '../../../nodes/lib/roiViewParams'
import type {
  HeatmapFilterStep,
  HeatmapLabelPlan,
  HeatmapOrderPlan,
  HeatmapSelectionStep,
} from '../../plans/heatmap'
import { heatmapExportPlan } from '../../plans/heatmap'
import type { PickedLabels } from '../../plans/viewers'
import {
  NEUROGLANCER_REFUSAL,
  barChartPlan,
  distributionPlan,
  histogramPlan,
  piePlan,
  scatterPlan,
  tableViewerPlan,
  viewer3dPlan,
} from '../../plans/viewers'

registerEmitter('out.table', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const filtered = ctx.output('filtered')
  const { terms, ignored } = tableViewerPlan(ctx)
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
    lines.push(...ctx.note(REGEX_FLAVOUR_NOTE))
  }

  // A clause the canvas was ignoring is one this document must ignore too — and say so, or the
  // two quietly report different row counts for the same graph.
  for (const note of ignored) lines.push(...ctx.note(note))

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
  const plan = barChartPlan(ctx)

  const lines = [`${out} <- ${src}`]
  if (plan.note !== undefined) return [...lines, ...ctx.note(plan.note)]
  const { category, value, series } = plan

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
  // Every decision below is `heatmapExportPlan`'s; this emitter spells it in base R and ggplot2.
  const plan = heatmapExportPlan(ctx)
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  // A method fastcore takes and `hclust` cannot reproduce — Linkage's refusal, one node over.
  // Otherwise the order lines are handed `hclust`'s own name for it.
  let order = plan.order
  if (order?.by === 'cluster') {
    const hclust = hclustMethod(order.method)
    if (hclust.refusal !== undefined) return ctx.todo(hclust.refusal)
    order = { ...order, method: hclust.method }
  }
  ctx.library('ggplot2')
  ctx.library('tidyr')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const { palette, diverging, substitute, limits, manual, log, showValues } = plan.colour

  const lines = [
    `${out} <- as.matrix(${src})`,
    ...heatmapLabelLines(ctx, out, plan.labels, plan.tracked),
    ...heatmapFilterLines(ctx, out, plan.filter, plan.tracked),
    ...heatmapOrderLines(ctx, out, order, plan.tracked),
    ...heatmapSelectionLines(ctx, out, plan.selection, plan.tracked),
  ]

  /*
   * The fill scale, named for the palette rather than substituted: viridisLite spells the
   * seven continuous ramps exactly as matplotlib does, and the ColorBrewer sets are what
   * `scale_fill_distiller` reads — `direction = 1` keeps their published orientation, red at
   * the negative end of RdBu. Coda's own two have no name here, so the nearest published one
   * stands in, and for the diverging pair that is RdBu the other way round.
   */
  // The ends wherever they are not the data's — `colorDomain`'s on a diverging scale — as in Python.
  const scaled = diverging || manual || log
  const ends = scaled ? `, limits = ${log ? 'c(0, log10(1 + hi_ - lo_))' : 'c(lo_, hi_)'}` : ''
  const fill = diverging
    ? substitute
      ? `scale_fill_distiller(palette = "RdBu", direction = -1${ends})`
      : `scale_fill_distiller(palette = ${rStr(palette)}, direction = 1${ends})`
    : substitute
      ? `scale_fill_distiller(palette = "Blues", direction = 1${ends})`
      : `scale_fill_viridis_c(option = ${rStr(palette)}${ends})`
  if (substitute) {
    lines.push(
      ...ctx.note(
        `Coda draws this in its own ${diverging ? 'blue–red' : 'blue'} ramp, which has no ` +
          `name here; ${diverging ? 'RdBu reversed' : 'Blues'} is the nearest published one.`,
      ),
    )
  }
  lines.push(...ctx.note(plan.colour.limitsNote))
  if (diverging) {
    // Symmetric about zero, which is what Coda's diverging scale does and ggplot's does not.
    lines.push(
      `hi_ <- ${limits.max ?? `max(abs(${out}), na.rm = TRUE)`}`,
      ...(limits.max === undefined ? [`if (!is.finite(hi_) || hi_ == 0) hi_ <- 1`] : []),
      `lo_ <- -hi_`,
    )
  } else if (scaled) {
    lines.push(
      `hi_ <- ${limits.max ?? `max(${out}, na.rm = TRUE)`}`,
      `lo_ <- ${limits.min ?? `min(0, ${out}, na.rm = TRUE)`}`,
    )
  }
  if (log) {
    lines.push(
      ...ctx.note(
        'The colour runs on a log scale and the values do not: the fill is ' +
          'log10(1 + value - low) and the label, where one is drawn, is the value itself. A ' +
          'cell past either end is clipped to it, as on the card — note that this leaves the ' +
          'legend labelled in the transformed units.',
      ),
    )
  }

  // A matrix has to be melted before ggplot can draw it; `pheatmap` would take it directly but
  // is another dependency for one node. The factor levels are the matrix's own order, top row
  // first — without them ggplot sorts both axes alphabetically and the Order tab is undone.
  lines.push(
    ``,
    `${out} |>`,
    `  as.data.frame() |>`,
    `  tibble::rownames_to_column("row") |>`,
    `  pivot_longer(-row, names_to = "column", values_to = "value") |>`,
    `  mutate(`,
    `    row = factor(row, levels = rev(rownames(${out}))),`,
    `    column = factor(column, levels = colnames(${out}))${scaled ? ',' : ''}`,
    ...(scaled
      ? [
          // A column of its own rather than `oob = scales::squish` on the scale: clamping to
          // the ends is what Coda does, and this keeps `value` itself for the label.
          `    fill_ = pmin(pmax(value, lo_), hi_)${log ? ',' : ''}`,
          ...(log ? [`    fill_ = log10(1 + fill_ - lo_)`] : []),
        ]
      : []),
    `  ) |>`,
    `  ggplot(aes(column, row, fill = ${scaled ? 'fill_' : 'value'})) +`,
    `  geom_tile() +`,
    `  ${fill} +`,
    ...(showValues ? [`  geom_text(aes(label = signif(value, 3)), size = 3) +`] : []),
    `  theme_minimal() +`,
    `  theme(axis.text.x = element_text(angle = 45, hjust = 1))`,
  )
  return lines
})

/**
 * The Labels tab, as base R: `dimnames` rewritten through `coda_relabel`.
 *
 * **Assigned into `${out}` itself**, which is where this parts company with `out.dendrogram`'s
 * emitter: there the renamed labels go onto a *copy* of the tree that only `plot()` sees,
 * because the canvas names leaves presentationally. Here the canvas writes the names into the
 * matrix and the Filter and Order tabs read them, so anything less would leave the two lines
 * below matching labels the card no longer has.
 *
 * Emitted **before** the filter lines, the node's own order.
 *
 * `coda_relabel` rather than a bare `match()`: it carries first-of-a-repeated-key and
 * `coda_match_keys`, which is what makes an 18-digit id compare as text rather than as a double
 * that has already lost its last digits. Blanks are dropped first, the one rule the helper does
 * not carry — `""` is not `NA`, and an untyped body would take a blank axis label.
 */
function heatmapLabelLines(
  ctx: Parameters<Emitter>[0],
  out: string,
  labels: HeatmapLabelPlan | undefined,
  tracked: ReadonlySet<MatrixAxis>,
): string[] {
  if (!labels) return []
  const { annotations, match, label } = labels
  ctx.library('dplyr')
  ctx.helper('coda_relabel')

  const lines = [
    `named_ <- ${annotations} |>`,
    `  filter(!is.na(${col(label)}) & ${col(label)} != "")`,
  ]
  for (const axis of labels.axes) {
    const names = axis === 'rows' ? 'rownames' : 'colnames'
    // The arrival names, captured before they are overwritten — `Selected Rows` carries them in
    // `label`, and after the assignment there is nothing left to recover them from. Only where a
    // selection actually reads them (`tracked`).
    if (tracked.has(axis)) lines.push(`${sourceName(axis)} <- ${names}(${out})`)
    // A one-column frame in and a column out: a matrix's dimnames are a character vector, not a
    // column of the thing being rewritten — the shape `out.dendrogram` uses for its leaves.
    lines.push(
      `${names}(${out}) <- coda_relabel(`,
      `  data.frame(label = ${names}(${out})),`,
      `  "label",`,
      `  named_,`,
      `  ${rStr(match)},`,
      `  ${rStr(label)},`,
      `  unmatched = "keep"`,
      `)$label`,
    )
  }
  return lines
}

/**
 * The Filter tab, as base R: one logical vector per filtered axis, then one subscript.
 *
 * Emitted **before** the order lines, which is the node's own rule — an order is computed
 * against what the filter left. A literal goes through `tolower` on both sides rather than
 * `ignore.case`, because `grepl`'s `fixed = TRUE` ignores that argument.
 */
function heatmapFilterLines(
  ctx: Parameters<Emitter>[0],
  out: string,
  steps: HeatmapFilterStep[],
  tracked: ReadonlySet<MatrixAxis>,
): string[] {
  const lines: string[] = []
  const masks: Partial<Record<MatrixAxis, string>> = {}

  for (const step of steps) {
    // A pattern the canvas could not compile: the axis stays whole, and the note says so here.
    if (step.note !== undefined) {
      lines.push(...ctx.note(step.note))
      continue
    }
    const { axis } = step
    const name = axis === 'rows' ? 'keepRows_' : 'keepCols_'
    const labels = `${axis === 'rows' ? 'rownames' : 'colnames'}(${out})`
    const test = step.regex
      ? `grepl(${rStr(step.pattern)}, ${labels}, ignore.case = TRUE)`
      : `grepl(${rStr(step.pattern.toLowerCase())}, tolower(${labels}), fixed = TRUE)`
    lines.push(`${name} <- ${step.negate ? `!${test}` : test}`)
    // The arrival names go through the *same* mask, which is the only way the two stay aligned.
    if (tracked.has(axis)) lines.push(`${sourceName(axis)} <- ${sourceName(axis)}[${name}]`)
    masks[axis] = name
  }

  if (masks.rows || masks.columns) {
    lines.push(`${out} <- ${out}[${masks.rows ?? ''}, ${masks.columns ?? ''}, drop = FALSE]`)
  }
  return lines
}

/**
 * The Order tab, as base R over the matrix: **positions** per sorted axis, the follower derived
 * from the leader, then one subscript. `hclust`'s `$order` is `leaves_list` — checked for the
 * Linkage node — and `R_METHODS` is the same spelling of the methods.
 *
 * **Positions, and that is a bug fix rather than a style.** This subscripted by *name*, which is
 * correct only while axis labels are unique — and the Labels tab makes repeats routine, since
 * naming rows by cell type is what it is for. Measured on a 3x3 with two rows called `LC4`:
 * `m[c("DN", "LC4", "LC4"), ]` matches the first `LC4` twice and **silently drops the second
 * row**, keeping the row count right so nothing looks wrong. pandas had the same bug and failed
 * the other way, duplicating rows instead. Every arm here is positional now, which made three
 * of them shorter — `order()` and `hclust()$order` were answering in positions already and were
 * being converted to labels.
 */
function heatmapOrderLines(
  ctx: Parameters<Emitter>[0],
  out: string,
  order: HeatmapOrderPlan | undefined,
  tracked: ReadonlySet<MatrixAxis>,
): string[] {
  if (!order) return []
  const lines: string[] = []

  for (const [i, step] of order.steps.entries()) {
    // A `value` sort with no key: the note stands where the sort would have been.
    if (step.note !== undefined) {
      lines.push(...ctx.note(step.note))
      continue
    }
    const { axis } = step
    const labels = axis === 'rows' ? `rownames(${out})` : `colnames(${out})`
    let expr: string
    switch (step.by) {
      case 'total':
        // `method = "radix"` for the tie rule: Coda's sort is stable, so equal totals keep
        // their arrival order rather than whichever order a quicksort happens to leave.
        expr = `order(${axis === 'rows' ? 'rowSums' : 'colSums'}(${out}, na.rm = TRUE), decreasing = TRUE, method = "radix")`
        break
      case 'label':
        ctx.helper('coda_natural_order')
        expr = `coda_natural_order(${labels})`
        break
      case 'value': {
        // The *first* line of that name, which is `axisVector`'s `indexOf`.
        const other = axis === 'rows' ? `colnames(${out})` : `rownames(${out})`
        const sorted = `order(${
          axis === 'rows' ? `${out}[, key_]` : `${out}[key_, ]`
        }, decreasing = TRUE, na.last = TRUE, method = "radix")`
        const found = [
          `key_ <- which(${other} == ${rStr(order.key)})[1]`,
          `${orderName(axis)} <- ${order.reverse ? `rev(${sorted})` : sorted}`,
        ]
        // Whether a line carries the key is a fact about the data, so it is asked at run time:
        // the card warns and leaves this axis — and the one following it — as they arrived.
        const follower = order.follower?.leader === axis ? order.follower.axis : undefined
        if (follower) found.push(followerLine(ctx, out, follower, axis))
        lines.push(
          `if (${rStr(order.key)} %in% ${other}) {`,
          ...found.map((line) => `  ${line}`),
          `} else {`,
          `  message(${rStr(step.keyMissing)})`,
          `  ${orderName(axis)} <- ${identity(out, axis)}`,
          ...(follower ? [`  ${orderName(follower)} <- ${identity(out, follower)}`] : []),
          `}`,
        )
        continue
      }
      case 'cluster': {
        // Once, before the first axis: a later one always has lines above it in the section.
        if (i === 0) {
          lines.push(
            ...ctx.note(
              'The clustering is seaborn’s clustermap: each row a vector across the columns, ' +
                'clustered by the distance between vectors. Coda reads an empty cell as 0 for ' +
                'this, and puts a constant vector — no correlation, no cosine — at distance 1 ' +
                'from everything rather than letting `cor`’s NA stop `hclust`.',
            ),
            `x_ <- ${out}`,
            `x_[!is.finite(x_)] <- 0`,
          )
        }
        const vectors = axis === 'rows' ? 'x_' : 't(x_)'
        const { method } = order
        if (order.metric === 'euclidean') {
          expr = `hclust(dist(${vectors}), method = ${rStr(method)})$order`
          break
        }
        // A constant vector has no correlation and a zero vector no cosine: `cor` answers NA
        // and `hclust` refuses the lot. Coda puts such a vector at distance 1 from everything —
        // unlike everything, at the end of the tree — so the NA is written as 1 here too.
        lines.push(
          `d_ <- 1 - ${
            order.metric === 'correlation'
              ? `cor(t(${vectors}))`
              : `tcrossprod(${vectors} / sqrt(rowSums(${vectors}^2)))`
          }`,
          `d_[!is.finite(d_)] <- 1`,
          `diag(d_) <- 0`,
        )
        expr = `hclust(as.dist(d_), method = ${rStr(method)})$order`
        break
      }
    }
    lines.push(`${orderName(axis)} <- ${order.reverse ? `rev(${expr})` : expr}`)
  }

  // A `value` sort's follower was written inside its run-time check, above.
  if (order.follower && order.by !== 'value') {
    lines.push(followerLine(ctx, out, order.follower.axis, order.follower.leader))
  }

  // The arrival names take the same positions, both axes, after the follower is derived.
  for (const axis of order.ordered.filter((a) => tracked.has(a))) {
    lines.push(`${sourceName(axis)} <- ${sourceName(axis)}[${orderName(axis)}]`)
  }

  if (order.ordered.length > 0) {
    const rows = order.ordered.includes('rows') ? orderName('rows') : ''
    const columns = order.ordered.includes('columns') ? orderName('columns') : ''
    lines.push(`${out} <- ${out}[${rows}, ${columns}, drop = FALSE]`)
  }
  return lines
}

/** The variable holding an axis's permutation. */
function orderName(axis: MatrixAxis): string {
  return axis === 'rows' ? 'rows_' : 'cols_'
}

/** An axis's labels on the matrix. */
function axisLabels(out: string, axis: MatrixAxis): string {
  return axis === 'rows' ? `rownames(${out})` : `colnames(${out})`
}

/** The permutation that leaves an axis as it arrived. */
function identity(out: string, axis: MatrixAxis): string {
  return `seq_len(${axis === 'rows' ? 'nrow' : 'ncol'}(${out}))`
}

/**
 * The follower's permutation: the leader's labels in the leader's *new* order, matched onto the
 * follower — the first unclaimed line of a repeated name winning. `intersect`/`setdiff` cannot
 * say that: both de-duplicate, so a follower with two lines of one name came back with one.
 */
function followerLine(
  ctx: Parameters<Emitter>[0],
  out: string,
  axis: MatrixAxis,
  leader: MatrixAxis,
): string {
  ctx.helper('coda_follow_order')
  return (
    `${orderName(axis)} <- ` +
    `coda_follow_order(${axisLabels(out, leader)}[${orderName(leader)}], ${axisLabels(out, axis)})`
  )
}

/** Where an axis's arrival names live while the pipeline reshapes them. */
function sourceName(axis: MatrixAxis): string {
  return axis === 'rows' ? 'rowSrc_' : 'colSrc_'
}

/**
 * `Selected Rows` and `Selected Columns`.
 *
 * **Both bound whatever the selection is**, the notebook emitter's rule and for its reason: an
 * emitter cannot ask who is downstream, and a chunk further on naming an unbound variable is an
 * error rather than an empty table. The positions and whether the arrival names are handed over
 * are the plan's; what is R's own is how an empty list of positions is spelled.
 */
function heatmapSelectionLines(
  ctx: Parameters<Emitter>[0],
  out: string,
  selection: HeatmapSelectionStep[],
  tracked: ReadonlySet<MatrixAxis>,
): string[] {
  ctx.helper('coda_matrix_selection')
  const lines: string[] = ['']
  for (const { axis, positions } of selection) {
    const names = axis === 'rows' ? 'rownames' : 'colnames'
    const arrival = tracked.has(axis) ? `, ${sourceName(axis)}` : ''
    // **`integer(0)` and never `rVector`'s empty**, which is `character(0)`: these are
    // positions, and the helper shifts them to R's 1-based subscripts and hands one back in
    // `index` — a character vector there types that column as something other than an integer,
    // which is a column a join downstream reads differently.
    const vector = positions.length === 0 ? 'integer(0)' : rVector(positions)
    lines.push(
      `${ctx.output(axis)} <- coda_matrix_selection(` +
        `${names}(${out}), ${vector}${arrival})`,
    )
  }
  return lines
}

registerEmitter('out.scatter', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const plan = scatterPlan(ctx)

  const lines = [`${out} <- ${src}`]
  if (plan.selected.note === undefined) {
    const { column, ids } = plan.selected
    lines.push(`${selected} <- ${out} |> filter(${col(column)} %in% ${rVector(ids)})`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} <- ${out} |> slice(0)`)
  }
  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { x, y } = plan.drawn

  // Read through the spec readers rather than by naming param ids — see the note in the
  // Python emitter: two of these three had drifted off the node's actual param names and were
  // silently emitting nothing.
  const colorSpec = readColorSpec('point', ctx.params, ctx.column)
  const hue = colorSpec.mode === 'constant' ? undefined : colorSpec.column
  const size = readSizeSpec('point', ctx.params, ctx.column, { min: 3, max: 12 }).column
  const shapeSpec = readShapeSpec('point', ctx.params, ctx.column)
  const shape = shapeSpec.mode === 'categorical' ? shapeSpec.column : undefined
  const aes = [
    `x = ${col(x)}`,
    `y = ${col(y)}`,
    ...(hue ? [`colour = ${col(hue)}`] : []),
    ...(size ? [`size = ${col(size)}`] : []),
    ...(shape ? [`shape = ${col(shape)}`] : []),
  ]
  const opacity = Number(ctx.params.opacity)

  lines.push(``, `ggplot(${out}, aes(${aes.join(', ')})) +`)
  lines.push(
    `  geom_point(${Number.isFinite(opacity) && opacity < 1 ? `alpha = ${opacity}` : ''}) +`,
  )
  if (ctx.params.xLog === true) lines.push(`  scale_x_log10() +`)
  if (ctx.params.yLog === true) lines.push(`  scale_y_log10() +`)
  if (String(ctx.params.trend) !== 'none') {
    // `lm` in the transformed space, which is the reading a log axis is put on to get.
    lines.push(`  geom_smooth(method = "lm", se = FALSE) +`)
  }
  if (String(ctx.params.aspect) === 'equal') lines.push(`  coord_equal() +`)
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
 *
 * `missing` adds the null arm: `markLabel` names a null `"—"`, and `as.character(NA) %in% …` is
 * `FALSE`, so without it a selected "—" slice would come back empty.
 */
function labelFilter(frame: string, selected: PickedLabels): string {
  const c = col(selected.column)
  const isin = `as.character(${c}) %in% ${rVector(selected.labels)}`
  return `${frame} |> filter(${selected.missing ? `${isin} | is.na(${c})` : isin})`
}

registerEmitter('out.histogram', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('ggplot2')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const plan = histogramPlan(ctx)

  const lines = [`${out} <- ${src}`]

  if (plan.selected.note === undefined) {
    const { column, ranges } = plan.selected
    const clauses = ranges.map(
      (range) =>
        `(${col(column)} >= ${range.lo} & ${col(column)} ${range.closed ? '<=' : '<'} ${range.hi})`,
    )
    lines.push(`${selected} <- ${out} |> filter(`, `  ${clauses.join(' |\n  ')}`, `)`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} <- ${out} |> slice(0)`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { value, series } = plan.drawn

  const normalize = String(ctx.params.normalize)
  const cumulative = ctx.params.cumulative === true && normalize !== 'density'
  const fixed = String(ctx.params.binMode) === 'fixed'
  const bins = Math.max(2, Math.round(Number(ctx.params.bins)))

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
  const plan = piePlan(ctx)

  const lines = [`${out} <- ${src}`]

  if (plan.selected.note === undefined) {
    lines.push(`${selected} <- ${labelFilter(out, plan.selected)}`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} <- ${out} |> slice(0)`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { value } = plan.drawn
  const category = plan.category!

  const maxSlices = Math.max(2, Math.round(Number(ctx.params.maxSlices)))
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
    ctx.params.sortSlices !== false ? `  arrange(desc(value))` : `  arrange(${col(category)})`,
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
  const plan = distributionPlan(ctx)

  const lines = [`${out} <- ${src}`]

  if (plan.selected.note === undefined) {
    lines.push(`${selected} <- ${labelFilter(out, plan.selected)}`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} <- ${out} |> slice(0)`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { value } = plan.drawn
  const { group } = plan

  const grouped = !!group && group !== value
  const style = String(ctx.params.style)
  const whiskers = String(ctx.params.whiskers)
  const maxGroups = Math.max(1, Math.round(Number(ctx.params.maxGroups)))
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
    const outliers =
      ctx.params.points === 'none' ? ', outlier.shape = NA' : ', outlier.size = 0.8'
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
      lines.push(
        `  geom_boxplot(alpha = 0.35, coef = ${coefFor(whiskers)}, outlier.shape = NA) +`,
      )
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
  const minLinkWeight = Number(ctx.params.minLinkWeight)
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
  const plan = viewer3dPlan(ctx)
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  const { geometry: wired, volumes, selected: selection } = plan

  ctx.library('nat')
  ctx.library('dplyr')
  const selected = ctx.output('selected')

  const lines = wired.length > 0 ? [`plot3d(${wired.join(', ')})`] : []
  if (volumes) {
    /*
     * Shells go in through rgl rather than through `plot3d`, because what that socket carries
     * is a list of `mesh3d` and `plot3d` has no method for one. The alpha is the card's own
     * default: a neuropil is drawn so that something else can be seen inside it.
     */
    lines.push(`for (.mesh in ${volumes}) rgl::shade3d(.mesh, alpha = 0.12, col = "grey70")`)
  }
  lines.push('')
  if (selection.note === undefined) {
    lines.push(`${selected} <- tibble(neuronId = ${rVector(selection.ids)})`)
  } else {
    lines.push(
      ...ctx.note(selection.note),
      // `character(0)`, not `numeric(0)`: the node's fallback schema is `str`, and an empty
      // double column is what makes a later `bind_rows` against a real one error outright.
      `${selected} <- tibble(neuronId = character(0))`,
    )
  }
  return lines
})

/**
 * The clipboard's R half. See the Python emitter for why this is a note rather than a TODO:
 * the node is a tap, so withholding its binding would unbind every chunk below it, and the ids
 * themselves translate exactly — it is only the *destination* that a document does not have.
 */
registerEmitter('out.copyIds', (ctx) => {
  const src = ctx.wired('neurons')
  const out = ctx.output('neurons')
  // The card's own reader — see the Python emitter for why this is not resolved per surface.
  const { separator, dedupe, quoted } = copyIdsSettings(ctx.params)

  // `as.character` before anything else, and it is load-bearing rather than tidy: R's numeric is
  // a double, so an 18-digit CAVE root id printed from one is a different id (invariant 8).
  // neuprintr hands back a `bodyid` that is already numeric, which is exactly the case this
  // catches — the digits are wrong before `paste` ever sees them, but only once.
  // R's own word for it, and Python's is `_list` — a `list` in R is the other data structure,
  // so one shared suffix would have to be wrong in one of the two languages.
  const ids = `${ctx.name}_vec`
  const lines = [`${out} <- ${src}`, `${ids} <- as.character(${neuronIds(out)})`]
  // `unique` keeps first occurrence, which is the card's rule — a Sort upstream is a decision.
  if (dedupe) lines.push(`${ids} <- unique(${ids})`)
  if (quoted) lines.push(`${ids} <- paste0('"', ${ids}, '"')`)
  lines.push(
    ...ctx.note(
      'In Coda this button puts the ids on the clipboard. A document has none, so they are ' +
        'printed here — copy them from the output, or use the vector directly.',
    ),
    `writeLines(paste(${ids}, collapse = ${rStr(separator)}))`,
  )
  return lines
})

registerEmitter('out.download', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const filename = String(ctx.params.filename) || 'export'
  const format = String(ctx.params.format)

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

// Refused whatever it is set to — `NEUROGLANCER_REFUSAL` says why.
registerEmitter('out.neuroglancer', (ctx) => ctx.todo(NEUROGLANCER_REFUSAL))

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
  const status = String(ctx.params.status)
  const topTypes = Number(ctx.params.topTypes)

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
  const primaryOnly = roisPrimaryOnly(ctx.params)

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
