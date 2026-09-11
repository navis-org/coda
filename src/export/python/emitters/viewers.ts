/**
 * The viewers.
 *
 * Every one of these is a **tap** in Coda — it passes its input through and draws beside it —
 * so each emitter does two things: bind the pass-through variable, and draw. The pass-through
 * is what keeps a viewer usable mid-chain, and dropping it would break every node wired after
 * one.
 *
 * The styling params reach the plot where matplotlib has somewhere to put them and are stated
 * in a comment where it does not. That asymmetry is deliberate: a knob silently ignored is
 * worse than a knob visibly not translated.
 */

import { readColorSpec, readShapeSpec, readSizeSpec } from '../../../nodes/lib/encodingParams'
import { usesRegex } from '../../../nodes/lib/tableFilter'
import { copyIdsSettings } from '../../../nodes/lib/copyIds'
import type { MatrixAxis } from '../../../nodes/lib/matrixShape'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { Emitter } from '../types'
import { codaNeurons, isCaveDataset, neuronIds, pySelection } from './common'
import { filterMasks } from './tableFilters'
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

// ---------------------------------------------------------------------------
// Table — the one viewer with nothing to draw
// ---------------------------------------------------------------------------

registerEmitter('out.table', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const filtered = ctx.output('filtered')
  const { terms, ignored } = tableViewerPlan(ctx)
  const masks = filterMasks(out, terms, ctx.schema('in'))

  const lines = [`${out} = ${src}`]

  /*
   * The second port is bound whether or not it filters anything, because the walk binds names
   * for the reader rather than for us: a node downstream of an *unfiltered* Filtered port is
   * perfectly ordinary, and leaving the name unassigned would emit working code referring to a
   * variable nothing ever creates.
   */
  if (masks.length === 0) {
    lines.push(`${filtered} = ${out}`)
  } else if (masks.length === 1) {
    ctx.require('pandas')
    lines.push(`${filtered} = ${out}[${masks[0]}]`)
  } else {
    ctx.require('pandas')
    // Inside the subscript brackets, so the continuation needs no backslashes and a reader can
    // comment one clause out without touching the others.
    lines.push(
      `${filtered} = ${out}[`,
      ...masks.map((mask, i) => `    ${i === 0 ? ' ' : '&'} ${mask}`),
      ']',
    )
  }

  if (usesRegex(terms)) {
    lines.push(
      ...ctx.note(
        'Coda matches these regexes with JavaScript semantics and pandas uses Python `re`. ' +
          'The two agree on ordinary patterns and differ on lookbehind and named groups.',
      ),
    )
  }

  // A clause the canvas was ignoring is a clause the notebook must ignore too — and say so,
  // or the two quietly report different row counts for the same graph.
  for (const note of ignored) lines.push(...ctx.note(note))

  // A bare name on the last line is how a notebook displays a frame, which is exactly what
  // this node is for.
  return [...lines, masks.length > 0 ? filtered : out]
})

// ---------------------------------------------------------------------------
// Describe Table — the other viewer with nothing to draw
// ---------------------------------------------------------------------------

/**
 * A tap plus a frame *about* the frame.
 *
 * The one place a reader might expect `df.describe()` and must not get it. That method skips
 * every non-numeric column unless asked otherwise, counts an empty string as a value, reports
 * a standard deviation this node does not and omits the non-zero count it does — so a notebook
 * using it would answer a different question under the same heading. `coda_describe` mirrors
 * `src/nodes/lib/describeOps.ts` line for line instead.
 */
registerEmitter('out.describe', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const summary = ctx.output('summary')

  ctx.require('pandas')
  ctx.helper('coda_describe')

  // A bare name on the last line is how a notebook displays a frame — and it is the summary
  // rather than the pass-through, because the summary is what this node is for.
  return [`${out} = ${src}`, `${summary} = coda_describe(${out})`, summary]
})

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

registerEmitter('out.barChart', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('matplotlib')
  const out = ctx.output('out')
  const plan = barChartPlan(ctx)

  const lines = [`${out} = ${src}`]
  // The node itself does not refuse over an unpicked column — it is a tap, and blocking
  // everything downstream because a drawing cannot be configured helps nobody.
  if (plan.note !== undefined) return [...lines, ...ctx.note(plan.note)]
  const { category, value, series } = plan

  if (series) {
    lines.push(
      `_plot = ${out}.pivot_table(`,
      `    index=${pyStr(category)}, columns=${pyStr(series)},`,
      `    values=${pyStr(value)}, aggfunc='sum', fill_value=0,`,
      `)`,
      `_plot.plot.bar(stacked=True, figsize=(10, 5))`,
    )
  } else {
    lines.push(
      `${out}.plot.bar(x=${pyStr(category)}, y=${pyStr(value)}, figsize=(10, 5), legend=False)`,
    )
  }
  lines.push(`plt.ylabel(${pyStr(value)})`, `plt.tight_layout()`, `plt.show()`)
  return lines
})

// ---------------------------------------------------------------------------
// Histogram, pie and box/violin — the three charts with a label-shaped selection
// ---------------------------------------------------------------------------

/**
 * A categorical selection, as a pandas mask.
 *
 * `.astype(str)` rather than a bare `isin`, and that is faithfulness rather than caution:
 * Coda's `markLabel` stringifies the cell before comparing, so a selection made on a numeric
 * category column holds `'5'` and not `5`. Without the cast the notebook would silently select
 * nothing on exactly the graphs where the canvas selects something.
 *
 * `missing` adds the null arm: `markLabel` names a null `'—'`, so a selection holding that
 * picks the rows with no value, which `astype(str)` turns into `'nan'` and `'None'` instead.
 */
function labelMask(frame: string, selected: PickedLabels): string {
  const c = `${frame}[${pyStr(selected.column)}]`
  const isin = `${c}.astype(str).isin(${pyList(selected.labels)})`
  return `${frame}[${selected.missing ? `${isin} | ${c}.isna()` : isin}]`
}

registerEmitter('out.histogram', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('seaborn')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const plan = histogramPlan(ctx)

  const lines = [`${out} = ${src}`]

  if (plan.selected.note === undefined) {
    const { column, ranges } = plan.selected
    const clauses = ranges.map(
      (range) =>
        `((${out}[${pyStr(column)}] >= ${range.lo}) & (${out}[${pyStr(column)}] ` +
        `${range.closed ? '<=' : '<'} ${range.hi}))`,
    )
    lines.push(
      `${selected} = ${out}[`,
      ...clauses.map((clause, i) => `    ${i === 0 ? ' ' : '|'} ${clause}`),
      `]`,
    )
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} = ${out}.iloc[0:0]`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { value, series } = plan.drawn

  const binMode = String(ctx.params.binMode)
  const normalize = String(ctx.params.normalize)
  const args = [
    `data=${out}`,
    `x=${pyStr(value)}`,
    ...(series && series !== value ? [`hue=${pyStr(series)}`, `multiple='stack'`] : []),
    binMode === 'fixed' ? `bins=${Math.round(Number(ctx.params.bins))}` : `bins='auto'`,
    ...(normalize === 'count' ? [] : [`stat=${pyStr(normalize)}`]),
    ...(ctx.params.cumulative === true && normalize !== 'density' ? ['cumulative=True'] : []),
    ...(ctx.params.logX === true ? ['log_scale=True'] : []),
  ]

  if (binMode === 'auto') {
    // Both are "the automatic rule" and they are not the same rule, which is the sort of
    // difference that shows up as a differently shaped picture and gets blamed on the data.
    lines.push(
      ...ctx.note(
        'Coda picks bins by Freedman–Diaconis capped at 80; seaborn’s `bins="auto"` takes the ' +
          'larger of Freedman–Diaconis and Sturges and has no cap, so the bar count can differ.',
      ),
    )
  }
  lines.push(``, `plt.figure(figsize=(8, 5))`, `sns.histplot(${args.join(', ')})`)
  lines.push(`plt.tight_layout()`, `plt.show()`)
  return lines
})

registerEmitter('out.pie', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('pandas')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const plan = piePlan(ctx)

  const lines = [`${out} = ${src}`]

  if (plan.selected.note === undefined) {
    lines.push(`${selected} = ${labelMask(out, plan.selected)}`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} = ${out}.iloc[0:0]`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { value } = plan.drawn
  const category = plan.category!

  const maxSlices = Math.max(2, Math.round(Number(ctx.params.maxSlices)))
  const sortBySize = ctx.params.sortSlices !== false
  const labelMode = String(ctx.params.sliceLabels)

  lines.push(
    ``,
    value
      ? `_totals = ${out}.groupby(${pyStr(category)})[${pyStr(value)}].sum()`
      : `_totals = ${out}[${pyStr(category)}].value_counts()`,
    sortBySize
      ? `_totals = _totals.sort_values(ascending=False)`
      : `_totals = _totals.sort_index()`,
    // `.copy()` because the residual is written back into the head, and a slice of a Series is
    // a view — the assignment would otherwise be a SettingWithCopyWarning and, on some pandas
    // versions, a no-op.
    `_top = _totals.head(${maxSlices}).copy()`,
    `if len(_totals) > ${maxSlices}:`,
    `    _top['Other'] = _totals.iloc[${maxSlices}:].sum()`,
    ``,
    `plt.figure(figsize=(6, 6))`,
    `plt.pie(`,
    `    _top, labels=_top.index,`,
    labelMode === 'percent'
      ? `    autopct='%1.0f%%',`
      : labelMode === 'value'
        ? `    autopct=lambda pct: f'{pct * _top.sum() / 100:.0f}',`
        : `    autopct=None,`,
    // The hole, which is the whole of the donut/pie switch.
    ctx.params.shape === 'pie'
      ? `    wedgeprops=dict(edgecolor='white'),`
      : `    wedgeprops=dict(width=0.42, edgecolor='white'),`,
    `)`,
    `plt.tight_layout()`,
    `plt.show()`,
  )
  return lines
})

registerEmitter('out.distribution', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('seaborn')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const plan = distributionPlan(ctx)

  const lines = [`${out} = ${src}`]

  if (plan.selected.note === undefined) {
    lines.push(`${selected} = ${labelMask(out, plan.selected)}`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} = ${out}.iloc[0:0]`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { value } = plan.drawn
  const { group } = plan

  const style = String(ctx.params.style)
  const whiskers = String(ctx.params.whiskers)
  const maxGroups = Math.max(1, Math.round(Number(ctx.params.maxGroups)))
  // Hoisted, as the R emitter beside it does: read twice, the two could drift into emitting
  // `order=_order` without the line that binds it.
  const grouped = !!group && group !== value

  lines.push(``, `plt.figure(figsize=(8, 6))`)
  if (grouped) {
    // The cap is part of the picture, not a detail of the widget: without the `order` the
    // notebook draws every group and the two documents disagree about what is on screen.
    lines.push(`_order = ${out}[${pyStr(group)}].value_counts().head(${maxGroups}).index`)
  }
  /*
   * The value axis is `x` laid out as rows and `y` as columns — seaborn reads the orientation
   * off which of the two is numeric, so swapping the pair is the whole translation. `order` is
   * unaffected: it names the categorical axis whichever one that is.
   */
  const columns = ctx.params.orientation === 'columns'
  const valueAxis = columns ? 'y' : 'x'
  const groupAxis = columns ? 'x' : 'y'
  const shared = [
    `data=${out}`,
    `${valueAxis}=${pyStr(value)}`,
    ...(grouped ? [`${groupAxis}=${pyStr(group!)}`, `order=_order`] : []),
  ]
  const fliers = ctx.params.points === 'none' ? ['showfliers=False'] : ['fliersize=2']

  if (style === 'box') {
    lines.push(`sns.boxplot(${[...shared, whisArg(whiskers), ...fliers].join(', ')})`)
  } else if (style === 'violin') {
    lines.push(`sns.violinplot(${[...shared, `inner='quartile'`].join(', ')})`)
  } else if (style === 'both') {
    lines.push(`sns.violinplot(${[...shared, `inner='box'`].join(', ')})`)
  } else {
    /*
     * A swarm on its own, or over a box drawn first so the marks sit on top of it.
     *
     * Coda thins a swarm past 300 marks per group; seaborn draws every point and warns when
     * they will not fit, so a large group comes out denser here than on the canvas. Said out
     * loud rather than reproduced — a stride that matched Coda's exactly would be a hand-rolled
     * sample in the middle of an otherwise idiomatic cell.
     */
    if (style === 'swarmBox') {
      lines.push(
        `sns.boxplot(${[...shared, whisArg(whiskers), 'showfliers=False', `boxprops=dict(alpha=0.35)`].join(', ')})`,
      )
    }
    lines.push(`sns.swarmplot(${[...shared, 'size=3'].join(', ')})`)
    lines.push(
      ...ctx.note(
        'Coda thins a swarm to 300 marks per group; seaborn plots every observation, so a ' +
          'large group is denser here than on the canvas.',
      ),
    )
  }
  if (ctx.params.logAxis === true) lines.push(`plt.${valueAxis}scale('log')`)
  lines.push(`plt.tight_layout()`, `plt.show()`)
  return lines
})

/** seaborn's `whis`, for each of the three rules the node offers. */
function whisArg(rule: string): string {
  if (rule === 'p5p95') return 'whis=(5, 95)'
  if (rule === 'minmax') return 'whis=(0, 100)'
  return 'whis=1.5'
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

registerEmitter('out.heatmap', (ctx) => {
  const src = ctx.wired('in')
  // Every decision below is `heatmapExportPlan`'s; this emitter spells it in pandas and seaborn.
  const plan = heatmapExportPlan(ctx)
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)

  ctx.require('seaborn')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const { palette, diverging, substitute, limits, manual, log, showValues } = plan.colour

  const lines = [
    `${out} = ${src}`,
    ...heatmapLabelLines(ctx, out, plan.labels, plan.tracked),
    ...heatmapFilterLines(ctx, out, plan.filter, plan.tracked),
    ...heatmapOrderLines(ctx, out, plan.order, plan.tracked),
    ...heatmapSelectionLines(ctx, out, plan.selection, plan.tracked),
  ]

  /*
   * Coda's own ramps have no matplotlib name, so the nearest published ones stand in: `Blues`
   * for the sequential blue and `RdBu_r` for the blue-negative pair. Every other name is the
   * palette itself — that is what the list was chosen for — and the ColorBrewer sets run as
   * published in both places, red at the negative end of `RdBu`.
   */
  const cmap = substitute ? (diverging ? 'RdBu_r' : 'Blues') : palette
  if (substitute) {
    lines.push(
      ...ctx.note(
        `Coda draws this in its own ${diverging ? 'blue–red' : 'blue'} ramp, which has no ` +
          `matplotlib name; ${cmap} is the nearest published one.`,
      ),
    )
  }
  lines.push(...ctx.note(plan.colour.limitsNote))

  // The ends wherever they are not the data's — `colorDomain`'s on a diverging scale — as in R.
  let drawn = out
  if (diverging) {
    ctx.require('numpy')
    lines.push(
      `_hi = ${limits.max ?? `float(np.nanmax(np.abs(${out}.values)))`}`,
      ...(limits.max === undefined
        ? [`if not np.isfinite(_hi) or _hi == 0:`, `    _hi = 1.0`]
        : []),
      `_lo = -_hi`,
    )
  } else if (manual || log) {
    ctx.require('numpy')
    lines.push(
      `_hi = ${limits.max ?? `float(np.nanmax(${out}.values))`}`,
      `_lo = ${limits.min ?? `min(0.0, float(np.nanmin(${out}.values)))`}`,
    )
  }
  if (log) {
    drawn = '_plot'
    lines.push(
      ...ctx.note(
        'The colour runs on a log scale and the values do not: Coda maps a cell through ' +
          'log10(1 + value - low) and prints the value itself, so the annotations below come ' +
          'from the untransformed frame. A cell past either end is clipped to it, as on the card.',
      ),
      `_plot = np.log10(1 + (${out}.clip(_lo, _hi) - _lo))`,
    )
  }

  const args = [
    `cmap=${pyStr(cmap)}`,
    // seaborn's `center` makes the range symmetric about it, which is what Coda's diverging
    // scale does; without it a matrix running -3..30 would put zero a tenth of the way along.
    ...(diverging && !log ? ['center=0'] : []),
    ...(log
      ? ['vmin=0', `vmax=float(np.log10(1 + _hi - _lo))`]
      : manual || diverging
        ? ['vmin=_lo', 'vmax=_hi']
        : []),
    // `annot` takes a frame of its own, which is what keeps the printed numbers the values
    // where the colour is a logarithm of them.
    ...(showValues ? [log ? `annot=${out}` : 'annot=True', "fmt='.3g'"] : []),
  ]
  lines.push(
    `plt.figure(figsize=(10, 8))`,
    `sns.heatmap(${drawn}, ${args.join(', ')})`,
    `plt.tight_layout()`,
    `plt.show()`,
  )
  return lines
})

/**
 * The Labels tab, as pandas: the axis rewritten through `coda_relabel` and assigned back.
 *
 * **Into `${out}` itself, and that is the whole difference from `out.dendrogram`'s emitter.**
 * There the relabel reaches `dendrogram(labels=…)` and nothing else, because the canvas names
 * leaves presentationally and a later chunk reading the renamed tree would hand
 * `Selected to Neurons` cell types to merge on. Here the canvas writes the names into the
 * matrix — the Filter and Order tabs match and sort on them — so the notebook has to as well,
 * or the filter two lines below runs against labels the card no longer has.
 *
 * Emitted **before** the filter lines for the same reason it runs first in `evaluate`.
 *
 * `coda_relabel` carries first-occurrence-wins and `coda_match_keys`, which is why it is called
 * rather than spelled out: written inline the key is `.astype(str)`, and an `i64` column with
 * one null is `float64` in pandas and prints `'101.0'` against a label of `'101'`. Blanks are
 * dropped here, the one rule the helper does not carry — `dropna` keeps the empty string, and
 * an untyped body would otherwise take a blank axis label where the canvas kept its id.
 */
function heatmapLabelLines(
  ctx: Parameters<Emitter>[0],
  out: string,
  labels: HeatmapLabelPlan | undefined,
  tracked: ReadonlySet<MatrixAxis>,
): string[] {
  if (!labels) return []
  const { annotations, match, label } = labels
  // `pd.DataFrame` below, which the heatmap emitter itself has no other reason to ask for.
  ctx.require('pandas')
  ctx.helper('coda_relabel')

  const lines = [
    `${ctx.name}_named = ${annotations}.loc[`,
    `    ${annotations}[${pyStr(label)}].notna()`,
    `    & (${annotations}[${pyStr(label)}].astype(str) != '')`,
    `]`,
  ]
  for (const axis of labels.axes) {
    const attribute = axis === 'rows' ? 'index' : 'columns'
    // The arrival names, captured before they are overwritten — `Selected Rows` carries them in
    // `label`, and after `set_axis` there is nothing left to recover them from. Only where a
    // selection actually reads them (`tracked`), since this is the one thing here that costs a
    // line for nothing when nobody has dragged a rectangle.
    if (tracked.has(axis)) {
      lines.push(`${sourceName(axis)} = list(${out}.${attribute}.astype(str))`)
    }
    /*
     * `set_axis` and a rebind, never `${out}.index = …`.
     *
     * The pass-through is bound by reference — `heatmap = similarity_matrix` is one frame under
     * two names — so assigning to `.index` renames the *upstream* variable as well, and a cell
     * further down reading it would find axes the canvas never gave it. Coda's `evaluate`
     * returns a new value and leaves the upstream node's cached matrix alone; this is that,
     * spelled the way the filter and order lines below already spell it.
     *
     * A one-column frame in and a column out, because an axis is an Index rather than a column
     * of the frame being rewritten — `out.dendrogram`'s shape, whose labels are a list.
     * `.astype(str)` because a pivot's index may be numeric where Coda's labels are always text.
     */
    lines.push(
      `${out} = ${out}.set_axis(`,
      `    coda_relabel(`,
      `        pd.DataFrame({'label': ${out}.${attribute}.astype(str)}),`,
      `        'label',`,
      `        ${ctx.name}_named,`,
      `        ${pyStr(match)},`,
      `        ${pyStr(label)},`,
      `        unmatched='keep',`,
      `    )['label'].tolist(),`,
      `    axis=${pyStr(attribute)},`,
      `)`,
    )
  }
  return lines
}

/** Where an axis's arrival names live while the pipeline reshapes them. */
function sourceName(axis: MatrixAxis): string {
  return axis === 'rows' ? '_rowsrc' : '_colsrc'
}

/**
 * `Selected Rows` and `Selected Columns`.
 *
 * **Both bound whatever the selection is**, including empty, because an emitter cannot ask who
 * is downstream and a cell further on naming an unbound variable is a `NameError` rather than
 * an empty table. `coda_matrix_selection` is the whole of the logic; whether it is handed the
 * tracked arrival names or reads the axis itself is the plan's `tracked`, and the positions come
 * ascending from the plan, so the cell reads in the card's own order.
 */
function heatmapSelectionLines(
  ctx: Parameters<Emitter>[0],
  out: string,
  selection: HeatmapSelectionStep[],
  tracked: ReadonlySet<MatrixAxis>,
): string[] {
  ctx.require('pandas')
  ctx.helper('coda_matrix_selection')
  const lines: string[] = ['']
  for (const { axis, positions } of selection) {
    const attribute = axis === 'rows' ? 'index' : 'columns'
    lines.push(
      `${ctx.output(axis)} = coda_matrix_selection(` +
        `${out}.${attribute}, ${pyList(positions)}${tracked.has(axis) ? `, ${sourceName(axis)}` : ''})`,
    )
  }
  return lines
}

/**
 * The Filter tab, as pandas: one boolean mask per filtered axis, then one `.loc`.
 *
 * Emitted **before** the order lines, which is the node's own rule — an order is computed
 * against what the filter left. `.astype(str)` because a pivot's index may be numeric where
 * Coda's labels are always text, and `.str.contains` on an Int64Index raises.
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
    const name = axis === 'rows' ? '_keep_rows' : '_keep_cols'
    const labels = `${out}.${axis === 'rows' ? 'index' : 'columns'}.astype(str)`
    const test = `${labels}.str.contains(${pyStr(step.pattern)}, case=False, regex=${
      step.regex ? 'True' : 'False'
    })`
    lines.push(`${name} = ${step.negate ? `~${test}` : test}`)
    // The arrival names go through the *same* mask, which is the only way the two stay aligned
    // — the node tracks them through the identical index lists for the identical reason.
    if (tracked.has(axis)) {
      lines.push(`${sourceName(axis)} = list(pd.Series(${sourceName(axis)})[${name}.values])`)
    }
    masks[axis] = name
  }

  if (masks.rows && masks.columns)
    lines.push(`${out} = ${out}.loc[${masks.rows}, ${masks.columns}]`)
  else if (masks.rows) lines.push(`${out} = ${out}.loc[${masks.rows}]`)
  else if (masks.columns) lines.push(`${out} = ${out}.loc[:, ${masks.columns}]`)
  return lines
}

/**
 * The Order tab, as pandas: **positions** per sorted axis, the follower derived from the
 * leader, then one `.iloc`. The order is applied to the frame the node *outputs*, which is the
 * node's own rule — a Table cell downstream of this one sees the sorted frame here too.
 *
 * **Positions, and that is a bug fix rather than a style.** This emitted label indexes into
 * `.loc`, which is correct only while axis labels are unique — and the Labels tab makes repeats
 * routine, since naming rows by cell type is what it is for. Measured on a 3x3 with two rows
 * called `LC4`: `df.loc[['DN', 'LC4', 'LC4']]` returns **five rows**, because `.loc` with a
 * duplicated label returns every match for each occurrence. The R emitter had the same bug and
 * failed the other way, silently dropping a row; neither looks wrong in the output.
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
    const labels = axis === 'rows' ? `${out}.index` : `${out}.columns`
    let expr: string
    switch (step.by) {
      case 'total':
        ctx.require('numpy')
        // Negated and stable, which is Coda's `orderByScores`: descending, ties in arrival
        // order, and anything non-finite last — `argsort` puts NaN at the end either way.
        expr = `list(np.argsort(-${out}.sum(axis=${axis === 'rows' ? 1 : 0}).values, kind='stable'))`
        break
      case 'label':
        ctx.helper('coda_natural_key')
        expr = `sorted(range(len(${labels})), key=lambda i: coda_natural_key(${labels}[i]))`
        break
      case 'value': {
        ctx.require('numpy')
        // The *first* line of that name, which is `axisVector`'s `indexOf` — a repeated key is
        // not an error and picking the last of them would be a different question.
        const other = axis === 'rows' ? `${out}.columns` : `${out}.index`
        const found = [
          `_key = list(${other}).index(${pyStr(order.key)})`,
          `${orderName(axis)} = list(np.argsort(-${out}.${axis === 'rows' ? 'iloc[:, _key]' : 'iloc[_key, :]'}.values, kind='stable'))${order.reverse ? '[::-1]' : ''}`,
        ]
        // Whether a line carries the key is a fact about the data, so it is asked at run time:
        // the card warns and leaves this axis — and the one following it — as they arrived.
        const follower = order.follower?.leader === axis ? order.follower.axis : undefined
        if (follower) found.push(followerLine(ctx, out, follower, axis))
        lines.push(
          `if ${pyStr(order.key)} in list(${other}):`,
          ...found.map((line) => `    ${line}`),
          `else:`,
          `    print(${pyStr(step.keyMissing)})`,
          `    ${orderName(axis)} = list(range(len(${labels})))`,
          ...(follower
            ? [`    ${orderName(follower)} = list(range(len(${axisLabels(out, follower)})))`]
            : []),
        )
        continue
      }
      case 'cluster': {
        ctx.require('numpy')
        ctx.require('scipyCluster', 'leaves_list', 'linkage')
        ctx.require('scipyDistance', 'pdist')
        // Once, before the first axis: a later one always has lines above it in the section.
        if (i === 0) {
          lines.push(
            ...ctx.note(
              'The clustering is seaborn’s clustermap: each row a vector across the columns, ' +
                'clustered by the distance between vectors. Coda reads an empty or infinite ' +
                'cell as 0 for this, hence the nan_to_num, and puts a constant vector — no ' +
                'correlation, no cosine — at distance 1 from everything rather than letting ' +
                'pdist’s NaN stop linkage.',
            ),
            // Every non-finite cell to 0, which is `coda_cluster_order`'s `nan_to_num` — `fillna`
            // alone would hand `pdist` an infinity and every distance from that vector with it.
            // One copy for both axes, R's `x_`: nothing between them touches the frame.
            `_x = np.nan_to_num(${out}.to_numpy(dtype=float, copy=True), nan=0.0, posinf=0.0, neginf=0.0, copy=False)`,
          )
        }
        const vectors = axis === 'rows' ? '_x' : '_x.T'
        let distances = `pdist(${vectors}, metric=${pyStr(order.metric)})`
        if (order.metric !== 'euclidean') {
          // A constant vector has no correlation and a zero vector no cosine: `pdist` answers
          // NaN and `linkage` refuses the lot. Coda puts such a vector at distance 1 from
          // everything — unlike everything, at the end of the tree — so the NaN is too.
          distances = `np.nan_to_num(${distances}, nan=1.0)`
        }
        // `leaves_list` already answers in positions, so this arm got *simpler* for the fix.
        expr = `list(leaves_list(linkage(${distances}, method=${pyStr(order.method)})))`
        break
      }
    }
    lines.push(`${orderName(axis)} = ${expr}${order.reverse ? '[::-1]' : ''}`)
  }

  // A `value` sort's follower was written inside its run-time check, above.
  if (order.follower && order.by !== 'value') {
    lines.push(followerLine(ctx, out, order.follower.axis, order.follower.leader))
  }

  // The arrival names take the same positions, both axes, after the follower is derived.
  for (const axis of order.ordered.filter((a) => tracked.has(a))) {
    lines.push(`${sourceName(axis)} = [${sourceName(axis)}[i] for i in ${orderName(axis)}]`)
  }

  // `.iloc`, never `.loc` — see the header. Two lists select the cross product, which is what
  // a reordered matrix is.
  const rows = order.ordered.includes('rows') ? orderName('rows') : undefined
  const columns = order.ordered.includes('columns') ? orderName('columns') : undefined
  if (rows && columns) lines.push(`${out} = ${out}.iloc[${rows}, ${columns}]`)
  else if (rows) lines.push(`${out} = ${out}.iloc[${rows}]`)
  else if (columns) lines.push(`${out} = ${out}.iloc[:, ${columns}]`)
  return lines
}

/** The variable holding an axis's permutation. */
function orderName(axis: MatrixAxis): string {
  return axis === 'rows' ? '_rows' : '_cols'
}

/** An axis's labels on the frame. */
function axisLabels(out: string, axis: MatrixAxis): string {
  return axis === 'rows' ? `${out}.index` : `${out}.columns`
}

/**
 * The follower's permutation: the leader's labels in the leader's *new* order, matched onto the
 * follower — the first unclaimed line of a repeated name winning, which is `followOrder` and is
 * the rule a list comprehension cannot state. See `coda_follow_order`.
 */
function followerLine(
  ctx: Parameters<Emitter>[0],
  out: string,
  axis: MatrixAxis,
  leader: MatrixAxis,
): string {
  ctx.helper('coda_follow_order')
  return (
    `${orderName(axis)} = coda_follow_order(` +
    `[${axisLabels(out, leader)}[i] for i in ${orderName(leader)}], list(${axisLabels(out, axis)}))`
  )
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

registerEmitter('out.scatter', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('seaborn')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const plan = scatterPlan(ctx)

  const lines = [`${out} = ${src}`]

  if (plan.selected.note === undefined) {
    const { column, ids } = plan.selected
    lines.push(`${selected} = ${out}[${out}[${pyStr(column)}].isin(${pySelection(ids)})]`)
  } else {
    lines.push(...ctx.note(plan.selected.note), `${selected} = ${out}.iloc[0:0]`)
  }

  if (plan.drawn.note !== undefined) return [...lines, ...ctx.note(plan.drawn.note)]
  const { x, y } = plan.drawn

  /*
   * Read through the spec readers rather than by naming param ids here.
   *
   * All three were spelled as literals — `colorColumn`, `sizeColumn`, `shapeBy` — and two of
   * them had not matched the node's actual params for some time: `colorParams({ prefix:
   * 'point' })` generates `pointColorBy`, so `hue=` had been silently absent from every
   * exported scatter, and the fixture setting `colorColumn: 'type'` is what made the golden
   * look right. A reader turns that class of drift into a type error.
   *
   * A channel only contributes an aesthetic when its mode actually uses a column: a constant
   * colour is not a `hue=`.
   */
  const colorSpec = readColorSpec('point', ctx.params, ctx.column)
  const hue = colorSpec.mode === 'constant' ? undefined : colorSpec.column
  const size = readSizeSpec('point', ctx.params, ctx.column, { min: 3, max: 12 }).column
  const shapeSpec = readShapeSpec('point', ctx.params, ctx.column)
  const shape = shapeSpec.mode === 'categorical' ? shapeSpec.column : undefined
  const args = [
    `data=${out}`,
    `x=${pyStr(x)}`,
    `y=${pyStr(y)}`,
    ...(hue ? [`hue=${pyStr(hue)}`] : []),
    ...(size ? [`size=${pyStr(size)}`] : []),
    ...(shape ? [`style=${pyStr(shape)}`] : []),
  ]
  const opacity = Number(ctx.params.opacity)
  if (Number.isFinite(opacity) && opacity < 1) args.push(`alpha=${opacity}`)

  lines.push(``, `plt.figure(figsize=(8, 6))`, `sns.scatterplot(${args.join(', ')})`)
  if (ctx.params.xLog === true) lines.push(`plt.xscale('log')`)
  if (ctx.params.yLog === true) lines.push(`plt.yscale('log')`)
  if (String(ctx.params.aspect) === 'equal') lines.push(`plt.gca().set_aspect('equal')`)
  if (String(ctx.params.trend) !== 'none') {
    // seaborn's regplot fits in the space it is drawn in, which is the same reading Coda's
    // trend gives: straight on screen, so a log-log fit is a power law.
    lines.push(`sns.regplot(data=${out}, x=${pyStr(x)}, y=${pyStr(y)}, scatter=False, ci=None)`)
  }
  lines.push(`plt.tight_layout()`, `plt.show()`)
  return lines
})

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

registerEmitter('out.network', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('networkx')
  const out = ctx.output('out')
  const lines: string[] = []

  // The three filters are not presentational on this node: they change what it *returns*, so
  // they have to be applied to the value and not merely to the drawing.
  const minLinkWeight = Number(ctx.params.minLinkWeight)
  const hideIsolated = ctx.params.hideIsolated === true

  lines.push(`${out} = ${src}.copy()`)
  if (minLinkWeight > 0) {
    lines.push(
      `${out}.remove_edges_from([`,
      `    (u, v) for u, v, w in ${out}.edges(data='weight')`,
      `    if (w or 0) < ${minLinkWeight}`,
      `])`,
    )
  }
  if (hideIsolated) {
    lines.push(`${out}.remove_nodes_from(list(nx.isolates(${out})))`)
  }

  /*
   * The layout is left commented out, and that is the point rather than an omission. sigma's
   * ForceAtlas2 has no drop-in twin: `spring_layout` is a different algorithm, and the
   * hierarchical layouts Coda offers need graphviz, which is a system package this notebook
   * has no business requiring. So the graph object is handed over ready to draw and the
   * choice of layout is left where it belongs.
   */
  lines.push(
    ``,
    ...ctx.note(
      'Coda draws this with ForceAtlas2 in the browser. networkx has no equivalent, so the ' +
        'graph is handed over and the layout is yours to pick — uncomment one.',
    ),
    `# pos = nx.spring_layout(${out}, weight='weight')`,
    `# pos = nx.kamada_kawai_layout(${out}, weight='weight')`,
    `# pos = nx.nx_agraph.graphviz_layout(${out}, prog='dot')  # needs pygraphviz`,
    `#`,
    `# nx.draw_networkx(`,
    `#     ${out}, pos,`,
    `#     node_size=40,`,
    `#     width=[d['weight'] / 20 for _, _, d in ${out}.edges(data=True)],`,
    `#     with_labels=True, font_size=7,`,
    `# )`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

registerEmitter('out.viewer3d', (ctx) => {
  const plan = viewer3dPlan(ctx)
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  const { geometry: wired, selected: selection } = plan
  /*
   * Volumes are spread rather than passed, because what arrives on that socket is a *list* of
   * shells where the other three are one object each. `[skeletons, volumes]` would hand
   * `plot3d` a nested list; `[skeletons, *volumes]` is flat either way, and still correct if
   * somebody wires an ordinary Meshes node there — a NeuronList unpacks too.
   */
  const volumes = plan.volumes

  ctx.require('navis')
  const selected = ctx.output('selected')

  ctx.require('pandas')
  const args = [...wired, ...(volumes ? [`*${volumes}`] : [])].join(', ')
  const lines = [`navis.plot3d([${args}])`, '']
  if (selection.note === undefined) {
    lines.push(`${selected} = pd.DataFrame({'neuronId': ${pySelection(selection.ids)}})`)
  } else {
    lines.push(
      ...ctx.note(selection.note),
      // Typed at the literal rather than cast after it: an empty `[]` is `float64`, where the
      // node's own fallback schema says `str`. Nothing to convert, so `coda_ids` would be a
      // line of ceremony over a frame with no rows.
      `${selected} = pd.DataFrame({'neuronId': pd.Series([], dtype='string')})`,
    )
  }
  return lines
})

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

registerEmitter('out.download', (ctx) => {
  const src = ctx.wired('in')

  const out = ctx.output('out')
  const filename = String(ctx.params.filename) || 'export'
  const format = String(ctx.params.format)

  const lines = [`${out} = ${src}`]
  switch (format) {
    case 'json':
      lines.push(`${out}.to_json(${pyStr(`${filename}.json`)}, orient='records', indent=2)`)
      break
    case 'svg':
    case 'png':
      // The picture belongs to the viewer feeding this node, which in a notebook has already
      // drawn itself. `savefig` is the equivalent, and only while a figure is current.
      ctx.require('matplotlib')
      lines.push(
        ...ctx.note(
          'In Coda this saves the chart drawn by the node upstream. Here the plot cell has ' +
            'already drawn it, so this saves whatever figure is current.',
        ),
        `plt.savefig(${pyStr(`${filename}.${format}`)}, bbox_inches='tight')`,
      )
      break
    default:
      lines.push(`${out}.to_csv(${pyStr(`${filename}.csv`)}, index=False)`)
  }
  return lines
})

// ---------------------------------------------------------------------------
// Copy IDs
// ---------------------------------------------------------------------------

/**
 * A **note**, not a TODO, and the distinction is the whole of the decision here.
 *
 * `ctx.todo` means "no code came out of this" *and* "this step is missing from the
 * translation". The first would be false — the node is a tap, and a notebook that dropped it
 * would leave every cell below a mid-chain Copy IDs unbound — and the second is not the right
 * reading either: the ids are what the node is about, and a notebook can produce them exactly.
 * What it cannot produce is a **clipboard**, which is a fact about the destination rather than a
 * gap in the translation, so the cell prints them and says so.
 *
 * The three settings are honoured rather than defaulted, because the emitted text is the one
 * thing a reader compares against the card: a notebook printing bare newline-separated ids
 * beside a card set to quoted-and-comma-separated reads as the exporter ignoring controls.
 */
registerEmitter('out.copyIds', (ctx) => {
  const src = ctx.wired('neurons')
  const out = ctx.output('neurons')
  // The card's own reader, so a separator this notebook joins with cannot be one the card
  // would not offer — and the fallback for a name nobody has any more is written once.
  const { separator, dedupe, quoted } = copyIdsSettings(ctx.params)

  // `str(i)` rather than a dtype cast: an 18-digit CAVE root id is exact in pandas' int64 and
  // in Python's int, and `astype` is the one step of the three that has an opinion about a
  // column that arrived as text (invariant 8).
  // `_list` rather than `_ids`: a node on its default title is already called `copy_ids`, and
  // `copy_ids_ids` is a name a reader reads twice.
  const ids = `${ctx.name}_list`
  const lines = [`${out} = ${src}`, `${ids} = [str(i) for i in ${neuronIds(out)}]`]
  // `dict.fromkeys` rather than `set`, because the card deduplicates in first-seen order — a
  // Sort upstream is a decision, and `set` discards it silently.
  if (dedupe) lines.push(`${ids} = list(dict.fromkeys(${ids}))`)
  const each = quoted ? `[f'"{i}"' for i in ${ids}]` : ids
  lines.push(
    ...ctx.note(
      'In Coda this button puts the ids on the clipboard. A notebook has none, so ' +
        'they are printed here — copy them from the output, or use the list directly.',
    ),
    `print(${pyStr(separator)}.join(${each}))`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// Neuroglancer  (Profile lives in its own file — it compiles real metrics)
// ---------------------------------------------------------------------------

// Refused whatever it is set to — `NEUROGLANCER_REFUSAL` says why.
registerEmitter('out.neuroglancer', (ctx) => ctx.todo(NEUROGLANCER_REFUSAL))

// ---------------------------------------------------------------------------
// Dataset description
// ---------------------------------------------------------------------------

/**
 * The dataset's own credit card, which emits a **note** rather than a TODO.
 *
 * `ctx.todo` means "no code came out of this", which is true here — and it also means "this step
 * is missing from the translation", which is not. The card is a credit line on the canvas: it has
 * no outputs, so it blocks nothing, and nobody expects it in a notebook. It is also on *every*
 * published dataset node by default (`core/companion.ts`), so counting it would put a warning on
 * essentially every graph anyone exports, which is how a warning stops being read.
 *
 * Nothing is lost by the distinction: `todo` withholds a node's output bindings, and this node
 * has none.
 */
registerEmitter(
  'dataset.description',
  (ctx) => {
    const cave = isCaveDataset(ctx)
    return ctx.note(
      "This card shows the dataset's published description and citation, which is prose " +
        'rather than a step. Read it with ' +
        (cave ? '`client.info.get_datastack_info()`' : '`fetch_meta(client=...)`') +
        ' if you need it here.',
    )
  },
  /*
   * Both backends, which is not a claim that this emits caveclient code — it emits no code at
   * all. It is a claim that the *card* is backend-independent, which it is: it is prose about a
   * dataset, and the guard exists to stop neuprint-python calls reaching a `CAVEclient`.
   *
   * Without it the guard fires first and this becomes a TODO on every CAVE graph — and since
   * the card is on every published dataset node by default, that is a warning on every CAVE
   * graph anybody exports, about the one node nobody expected in a notebook.
   */
  { backends: ['neuprint', 'cave'] },
)

// ---------------------------------------------------------------------------
// Dataset Summary
// ---------------------------------------------------------------------------

/**
 * The Dataset Summary is a dashboard, and dashboards do not translate — but almost everything
 * it *shows* is an ordinary roll-up, so this is one of the few viewers whose export is worth
 * more than a note.
 *
 * The one place it is deliberately different from the card: the notebook fetches the neuron
 * table with `fetch_neurons(NeuronCriteria(...))` rather than reproducing Coda's cached index.
 * `neuronIndex` is `findNeurons` with no filter at all, so the honest translation of "every
 * neuron the dataset publishes" is a criteria object with nothing narrowing it — which is
 * exactly what an empty `Status` means on the card, and what the emitted comment says.
 */
registerEmitter('out.datasetSummary', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = `${ctx.name}_neurons`
  const status = String(ctx.params.status)
  const topTypes = Number(ctx.params.topTypes)
  const chosen = (ctx.params.attributes as string[] | undefined) ?? []

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  ctx.require('pandas')

  const criteria = status
    ? `NeuronCriteria(status=${pyStr(status)}, client=${c})`
    : `NeuronCriteria(client=${c})`

  const lines = [
    ...(status
      ? []
      : ctx.note(
          'No status filter, matching the card: the dataset index Coda counts is every ' +
            ':Neuron the dataset publishes, not only the Traced ones.',
        )),
    `${neurons}, _ = fetch_neurons(${criteria}, client=${c})`,
    codaNeurons(ctx, neurons),
    ``,
    `# How many neurons carry each value of an attribute. dropna=False would count the`,
    `# missing ones as a category; the card reports them apart instead.`,
  ]

  const attributes = summaryChartList(chosen, ctx.params.chartsMode)
  lines.push(
    `for _col in ${pyList(attributes)}:`,
    `    if _col in ${neurons}.columns:`,
    `        print(${neurons}[_col].value_counts().head(${Math.max(1, topTypes)}))`,
  )

  if (topTypes > 0) {
    lines.push(
      ``,
      `${ctx.name}_top_types = ${neurons}['type'].value_counts().head(${topTypes})`,
    )
  }

  lines.push(
    ``,
    `# Region completeness: traced synapses against the total present. The published list`,
    `# nests, so it is filtered to the primary set before anything is totalled.`,
    `${ctx.name}_regions = ${c}.fetch_roi_completeness()`,
    `${ctx.name}_regions = ${ctx.name}_regions[`,
    `    ${ctx.name}_regions['roi'].isin(${c}.primary_rois)`,
    `].reset_index(drop=True)`,
    `${ctx.name}_regions['preCompleteness'] = (`,
    `    ${ctx.name}_regions['roipre'] / ${ctx.name}_regions['totalpre']`,
    `).where(${ctx.name}_regions['totalpre'] > 0)`,
  )

  return lines
})

/**
 * The ROIs card draws neuropil shells; neuprint-python serves the same ones.
 *
 * `Client.fetch_roi_mesh(roi)` returns the OBJ **bytes** for one region and takes no dataset
 * argument, which satisfies the one-client-per-dataset rule for free. Read off neuprint-python
 * 0.6.3 by introspection rather than recalled — the same discipline that turned up
 * `navis.interfaces.neuprint` not existing.
 *
 * Two things the generated cell has to say, both from the endpoint's own behaviour rather than
 * from taste:
 *
 *  - **Some regions have no mesh, and that is correct.** Every one male-CNS refuses is an
 *    `-unspecified` bucket — `CentralBrain-unspecified`, `VNC-unspecified` — which collects
 *    synapses not assigned to a named neuropil and is not a shape. So the loop catches rather
 *    than letting one 400 end the cell, and reports what it skipped.
 *  - **The meshes are not measurements.** neuprint-python's own docstring says they are
 *    "intended for visualization only… not suitable for quantitative analysis", so a volume
 *    computed off one is an approximation of a decimated display surface. Worth stating in the
 *    notebook, where the next obvious step is exactly that computation.
 *
 * No plotting is emitted. Drawing an OBJ needs trimesh or navis, and neither is in this
 * notebook's dependency set — a generated file that fails on an import nobody asked for is
 * worse than one that hands over the bytes and says what to do with them.
 */
registerEmitter('out.rois', (ctx) => {
  const client = ctx.wired('dataset')
  const meshes = `${ctx.name}_meshes`
  const primaryOnly = roisPrimaryOnly(ctx.params)
  const rois = primaryOnly ? `${client}.primary_rois` : `${client}.all_rois`

  return [
    ...ctx.note(
      'Region meshes are OBJ bytes, one request each. neuPrint publishes them for ' +
        'visualization only — they are decimated display surfaces, so a volume measured off ' +
        'one is an approximation rather than a figure to quote.',
    ),
    ...(primaryOnly
      ? [
          `# The published region list nests, so this walks the primary set that tiles the`,
          `# volume — the same default the card carries.`,
        ]
      : [`# Every published region, including the ones nested inside others.`]),
    `${meshes} = {}`,
    `_skipped = []`,
    `for _roi in ${rois}:`,
    `    try:`,
    `        ${meshes}[_roi] = ${client}.fetch_roi_mesh(_roi)`,
    `    except Exception:`,
    `        # No mesh published for this one. On male-CNS every such region is an`,
    `        # "-unspecified" bucket, which collects unassigned synapses and is not a shape.`,
    `        _skipped.append(_roi)`,
    ``,
    `print(f"{len(${meshes})} region meshes"`,
    `      f" · {sum(len(_m) for _m in ${meshes}.values()) / 1e6:.1f} MB of OBJ"`,
    `      f" · {len(_skipped)} without one")`,
    ``,
    `# Each value is the contents of an .obj file. To look at one:`,
    `#     open("ME(R).obj", "wb").write(${meshes}["ME(R)"])`,
    `# or pass the bytes to trimesh / navis, neither of which this notebook imports.`,
  ]
})

/**
 * The default chart list, transcribed from `summaryAttributes`.
 *
 * A copy rather than an import, and the duplication is the lesser evil: that function filters
 * against a *live* schema, which an emitter has no access to, and the generated cell guards
 * every name with an `in .columns` check — so the cost of the two drifting is a chart missing
 * from a notebook, not a traceback. Importing it would mean either shipping a schema into the
 * exporter or emitting nothing at all.
 */
const SUMMARY_ATTRIBUTE_FALLBACK = [
  'superclass',
  'class',
  'subclass',
  'flow',
  'somaSide',
  'consensusNt',
  'hemilineage',
  'nerve',
]

/**
 * Which fields the cell counts: the chosen list, the fallback, or both.
 *
 * The chosen list if there is one, else the same priority list `summaryAttributes` walks —
 * transcribed rather than imported, because an emitter may not depend on a dataset's live schema
 * and `.value_counts()` on a column pandas does not have raises. Guarded per column in the
 * emitted loop, so a dataset lacking one prints nothing rather than stopping the cell.
 *
 * `chartsMode` picks which of the two readings a chosen list gets, exactly as the card does, and
 * **absence is spelled the way `absentMeans` spells it**: a graph stored before the control
 * existed meant the whole list, and a notebook exported from it has to say what the card drew.
 * What cannot be reproduced here is the family deduplication, which needs the live schema — it
 * costs a duplicate `value_counts` in a notebook rather than a wrong number.
 */
function summaryChartList(chosen: readonly string[], mode: unknown): string[] {
  if (chosen.length === 0) return SUMMARY_ATTRIBUTE_FALLBACK
  if (mode !== 'add') return [...chosen]
  return [
    ...SUMMARY_ATTRIBUTE_FALLBACK,
    ...chosen.filter((name) => !SUMMARY_ATTRIBUTE_FALLBACK.includes(name)),
  ]
}
