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

import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import { selectionIds } from './common'

// ---------------------------------------------------------------------------
// Table — the one viewer with nothing to draw
// ---------------------------------------------------------------------------

registerEmitter('out.table', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  // A bare name on the last line is how a notebook displays a frame, which is exactly what
  // this node is for.
  return [`${out} = ${src}`, out]
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
    return [...lines, ...ctx.note('No category or value column is picked, so nothing is drawn.')]
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
    lines.push(
      `${selected} = ${out}[${out}[${pyStr(idColumn)}].isin(${pyList(selection)})]`,
    )
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

  lines.push(
    ``,
    `plt.figure(figsize=(8, 6))`,
    `sns.scatterplot(${args.join(', ')})`,
  )
  if (ctx.params.xLog === true) lines.push(`plt.xscale('log')`)
  if (ctx.params.yLog === true) lines.push(`plt.yscale('log')`)
  if (String(ctx.params.aspect ?? '') === 'equal') lines.push(`plt.gca().set_aspect('equal')`)
  if (String(ctx.params.trend ?? 'none') !== 'none') {
    // seaborn's regplot fits in the space it is drawn in, which is the same reading Coda's
    // trend gives: straight on screen, so a log-log fit is a power law.
    lines.push(
      `sns.regplot(data=${out}, x=${pyStr(x)}, y=${pyStr(y)}, scatter=False, ci=None)`,
    )
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
    lines.push(`${selected} = pd.DataFrame({'bodyId': ${pyList(selection)}})`)
  } else {
    lines.push(
      ...ctx.note('Nothing is picked in the viewer, so Selected is empty.'),
      `${selected} = pd.DataFrame({'bodyId': []})`,
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

registerEmitter('dataset.description', (ctx) => {
  // No outputs, and the card's whole content is somebody else's prose. A cell that fetched
  // and printed it would be a network call for a credit line.
  return ctx.todo(
    'This card shows the dataset\'s published description and citation. Read it with ' +
      '`fetch_meta(client=...)` if you need it here.',
  )
})
