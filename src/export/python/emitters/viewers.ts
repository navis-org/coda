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

import { datasetRef } from '../../../core/types'
import { decodeClauses, resolveFilters, usesRegex } from '../../../nodes/lib/tableFilter'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import { codaNeurons, pySelection, selectionIds } from './common'
import { filterMasks } from './tableFilters'

// ---------------------------------------------------------------------------
// Table — the one viewer with nothing to draw
// ---------------------------------------------------------------------------

registerEmitter('out.table', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const filtered = ctx.output('filtered')
  const { terms, problems } = resolveFilters(ctx.schema('in'), decodeClauses(ctx.params.filters))
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
    lines.push(`${filtered} = ${out}[`, ...masks.map((mask, i) => `    ${i === 0 ? ' ' : '&'} ${mask}`), ']')
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
  for (const problem of problems) lines.push(...ctx.note(`${problem} — not applied.`))

  // A bare name on the last line is how a notebook displays a frame, which is exactly what
  // this node is for.
  return [...lines, masks.length > 0 ? filtered : out]
})

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

registerEmitter('out.barChart', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('matplotlib')
  const out = ctx.output('out')
  const category = ctx.column('category')
  const value = ctx.column('value')
  const series = ctx.params.useSeries === true ? ctx.column('series') : undefined

  const lines = [`${out} = ${src}`]
  if (!category || !value) {
    // The node itself does not refuse over an unpicked column — it is a tap, and blocking
    // everything downstream because a drawing cannot be configured helps nobody.
    return [
      ...lines,
      ...ctx.note('No category or value column is picked, so nothing is drawn.'),
    ]
  }

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
// Heatmap
// ---------------------------------------------------------------------------

registerEmitter('out.heatmap', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('seaborn')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const showValues = ctx.params.showValues === true
  const scale = String(ctx.params.scale ?? '')

  const lines = [`${out} = ${src}`]
  if (scale === 'log') {
    ctx.require('numpy')
    lines.push(
      ...ctx.note('The node draws this on a log scale; the values themselves are unchanged.'),
      `_plot = np.log10(1 + ${out})`,
    )
  } else {
    lines.push(`_plot = ${out}`)
  }

  lines.push(
    `plt.figure(figsize=(10, 8))`,
    `sns.heatmap(_plot, cmap='rocket'${showValues ? ", annot=True, fmt='.3g'" : ''})`,
    `plt.tight_layout()`,
    `plt.show()`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

registerEmitter('out.scatter', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('seaborn')
  ctx.require('matplotlib')
  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const x = ctx.column('x')
  const y = ctx.column('y')

  const lines = [`${out} = ${src}`]

  const selection = selectionIds(ctx)
  const idColumn = ctx.column('idColumn')
  if (selection.length > 0 && idColumn) {
    lines.push(`${selected} = ${out}[${out}[${pyStr(idColumn)}].isin(${pySelection(selection)})]`)
  } else {
    lines.push(
      ...ctx.note('Nothing is lassoed on the canvas, so Selected is empty.'),
      `${selected} = ${out}.iloc[0:0]`,
    )
  }

  if (!x || !y) {
    return [...lines, ...ctx.note('No x or y column is picked, so nothing is drawn.')]
  }

  const hue = ctx.column('colorColumn')
  const size = ctx.column('sizeColumn')
  const shape = ctx.column('shapeBy')
  const args = [
    `data=${out}`,
    `x=${pyStr(x)}`,
    `y=${pyStr(y)}`,
    ...(hue ? [`hue=${pyStr(hue)}`] : []),
    ...(size ? [`size=${pyStr(size)}`] : []),
    ...(shape ? [`style=${pyStr(shape)}`] : []),
  ]
  const opacity = Number(ctx.params.opacity ?? 1)
  if (Number.isFinite(opacity) && opacity < 1) args.push(`alpha=${opacity}`)

  lines.push(``, `plt.figure(figsize=(8, 6))`, `sns.scatterplot(${args.join(', ')})`)
  if (ctx.params.xLog === true) lines.push(`plt.xscale('log')`)
  if (ctx.params.yLog === true) lines.push(`plt.yscale('log')`)
  if (String(ctx.params.aspect ?? '') === 'equal') lines.push(`plt.gca().set_aspect('equal')`)
  if (String(ctx.params.trend ?? 'none') !== 'none') {
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
  const minLinkWeight = Number(ctx.params.minLinkWeight ?? 0)
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
  // Three optional geometry sockets rather than one input, and the node is *not* a tap: its
  // only output is the neurons picked in the viewer. Assuming the pass-through shape every
  // other viewer has is what made this emit "nothing is wired" for a node plainly wired up.
  const wired = ['skeletons', 'meshes', 'points']
    .map((port) => ctx.input(port))
    .filter((v): v is string => !!v)
  if (wired.length === 0) return ctx.todo('No geometry is wired to this 3D Viewer.')

  ctx.require('navis')
  const selected = ctx.output('selected')
  const selection = selectionIds(ctx)

  ctx.require('pandas')
  const lines = [`navis.plot3d([${wired.join(', ')}])`, '']
  if (selection.length > 0) {
    lines.push(`${selected} = pd.DataFrame({'neuronId': ${pySelection(selection)}})`)
  } else {
    lines.push(
      ...ctx.note('Nothing is picked in the viewer, so Selected is empty.'),
      `${selected} = pd.DataFrame({'neuronId': []})`,
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
  const filename = String(ctx.params.filename ?? '') || 'export'
  const format = String(ctx.params.format ?? 'csv')

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
// Neuroglancer  (Profile lives in its own file — it compiles real metrics)
// ---------------------------------------------------------------------------

registerEmitter('out.neuroglancer', (ctx) => {
  // The output is a **URL**, not a table, so there is nothing to pass through: binding the
  // incoming neurons to it would hand a DataFrame to anything reading a link. Building the
  // URL needs the scene JSON the dataset publishes, which is a fetch this translation does
  // not make — so it emits nothing and says so, and downstream reports being blocked.
  return ctx.todo(
    'This node builds a neuroglancer URL by editing the scene its dataset publishes. That ' +
      'scene is a fetch this translation does not make, so no link is built here.',
  )
})

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
    const cave = datasetRef(ctx.inputType('dataset'))?.sourceId === 'cave'
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
  const status = String(ctx.params.status ?? '')
  const topTypes = Number(ctx.params.topTypes ?? 20)
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

  /*
   * The chosen list if there is one, else the same priority list `summaryAttributes` walks —
   * transcribed rather than imported, because an emitter may not depend on a dataset's live
   * schema and `.value_counts()` on a column pandas does not have raises. Guarded per column so
   * a dataset lacking one prints nothing rather than stopping the cell.
   */
  const attributes = chosen.length > 0 ? chosen : SUMMARY_ATTRIBUTE_FALLBACK
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
  const primaryOnly = ctx.params.primaryOnly !== false
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
