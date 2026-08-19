/**
 * The remaining data nodes: Build Network, the two importers, and Paths.
 */

import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

// ---------------------------------------------------------------------------
// Build Network
// ---------------------------------------------------------------------------

registerEmitter('net.build', (ctx) => {
  const edges = ctx.wired('edges')

  ctx.require('networkx')
  ctx.require('pandas')
  const out = ctx.output('network')
  const source = ctx.column('source') ?? 'preId'
  const target = ctx.column('target') ?? 'postId'
  const weight = ctx.column('weight') ?? 'weight'
  const directed = ctx.params.directed !== false
  const nodes = ctx.input('nodes')

  const lines: string[] = [
    // Parallel links merge, and only `weight` is summed. Coda is deliberate about that: a
    // number in a connectivity table is as often an identifier as a measure, and summing
    // `preId` produces a large plausible integer nobody can spot as nonsense.
    `_links = (`,
    `    ${edges}.groupby([${pyStr(source)}, ${pyStr(target)}], dropna=False)`,
    `    .agg(weight=(${pyStr(weight)}, 'sum'), edges=(${pyStr(weight)}, 'size'))`,
    `    .reset_index()`,
    `)`,
  ]

  const minWeight = Number(ctx.params.minWeight ?? 0)
  if (minWeight > 0) lines.push(`_links = _links[_links['weight'] >= ${minWeight}]`)

  lines.push(
    `${out} = nx.from_pandas_edgelist(`,
    `    _links,`,
    `    source=${pyStr(source)},`,
    `    target=${pyStr(target)},`,
    `    edge_attr=['weight', 'edges'],`,
    `    create_using=nx.DiGraph if ${directed ? 'True' : 'False'} else nx.Graph,`,
    `)`,
  )

  if (nodes) {
    const nodeKey = ctx.column('nodeKey') ?? 'bodyId'
    lines.push(
      ``,
      // The node join is one row per node, so every column rides along — unlike the link
      // merge above, where a value survives only if every merged row agrees on it.
      `nx.set_node_attributes(`,
      `    ${out},`,
      `    ${nodes}.set_index(${pyStr(nodeKey)}).to_dict('index'),`,
      `)`,
    )
  }

  return lines
})

// ---------------------------------------------------------------------------
// Upload Table
// ---------------------------------------------------------------------------

registerEmitter('core.uploadTable', (ctx) => {
  ctx.require('pandas')
  const out = ctx.output('out')
  const fileName = String(ctx.params.fileName ?? '')

  const lines: string[] = [
    /*
     * The rows are not in the graph and cannot be — they live in this browser's IndexedDB, and
     * a `.coda.json` sent to a colleague already arrives without them. So the notebook names
     * the file rather than carrying it, which is the same accepted cost with the same honest
     * statement of it. The filename is the one thing here anybody can act on.
     */
    ...ctx.note(
      fileName
        ? `Coda stores an uploaded table in the browser, not in the graph, so the rows are ` +
            `not in this notebook. Point this at your copy of "${fileName}".`
        : 'This Upload Table node has no file. Point the path below at your CSV.',
    ),
    `${out} = pd.read_csv(${pyStr(fileName || 'your-table.csv')})`,
  ]

  return [...lines, ...shapingLines(ctx, out)]
})

// ---------------------------------------------------------------------------
// Table from URL
// ---------------------------------------------------------------------------

registerEmitter('core.tableFromUrl', (ctx) => {
  ctx.require('pandas')
  const out = ctx.output('out')
  const url = String(ctx.params.url ?? '').trim()
  if (!url) return ctx.todo('This Table from URL node has no URL.')

  // The counterpart of the upload node, and the one property that separates them: a URL is
  // reproducible, so this node needs nothing carried alongside the notebook.
  return [`${out} = pd.read_csv(${pyStr(url)})`, ...shapingLines(ctx, out)]
})

/**
 * The two shaping controls both importers share.
 *
 * Applied after the read and both lossless, exactly as `uploadShapeTable` applies them — which
 * is what lets them cost no re-parse and never disagree with the rows already read.
 */
function shapingLines(ctx: EmitContext, out: string): string[] {
  const lines: string[] = []
  const idColumn = String(ctx.params.idColumn ?? '')
  const textColumns = ctx.columns('textColumns')

  if (idColumn) {
    // Nodes address columns by name, so a file whose author wrote `root_id` cannot meet
    // neuron data until it is renamed.
    lines.push(`${out} = ${out}.rename(columns={${pyStr(idColumn)}: 'bodyId'})`)
  }
  if (textColumns.length > 0) {
    // Widening only, and null stays null: `str(None)` is the four-letter word "None", which
    // would read as a value everywhere downstream.
    lines.push(
      `for _c in ${pyList(textColumns)}:`,
      `    ${out}[_c] = ${out}[_c].astype('string')`,
    )
  }
  return lines
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

registerEmitter('neuron.paths', (ctx) => {
  const c = ctx.wired('dataset')
  const sources = ctx.wired('sources')
  const targets = ctx.wired('targets')
  if (!sources || !targets) return ctx.todo('Paths needs both Sources and Targets wired.')

  const collapse = ctx.params.collapseTypes !== false
  const maxHops = Number(ctx.params.maxHops ?? 3)
  const minWeight = Number(ctx.params.minWeight ?? 1)

  if (collapse) {
    /*
     * The default mode has no equivalent, and it is worth being precise about why rather than
     * emitting something close. Coda traverses the **type-collapsed** graph: LC4 is one node,
     * a hop expands every LC4 neuron, and the result is aggregated back to types before
     * anything is pruned. That finds LC4 → PLP1 → DNp01 even when no single PLP1 neuron both
     * receives from an LC4 and projects to a DNp01 — and it is not recoverable by collapsing a
     * neuron-level result afterwards, because the neuron-level search never returns either
     * edge. Cypher cannot walk a derived graph without GDS, so neither `fetch_shortest_paths`
     * nor `fetch_paths` can express it.
     */
    return ctx.todo(
      'Paths with "Collapse types" on has no neuprint-python equivalent. Coda runs the ' +
        'search on the type-collapsed graph — every neuron of a type expanded together and ' +
        'aggregated back to types at each hop — which finds routes no neuron-level search ' +
        'returns, and which Cypher cannot express without GDS. Switch the node to ' +
        'neuron-level to export it, or write the traversal by hand.',
    )
  }

  ctx.require('neuprint', 'fetch_paths')
  const out = ctx.output('paths')

  return [
    ...ctx.note(
      'neuprint\'s `fetch_paths` returns every route within the hop budget. Coda additionally ' +
        'ranks them by their weakest link and keeps the strongest — that ranking is not ' +
        'reproduced here, so this is the unranked set.',
    ),
    `${out} = fetch_paths(`,
    `    ${sources}['bodyId'].tolist(),`,
    `    ${targets}['bodyId'].tolist(),`,
    `    min_weight=${minWeight},`,
    `    max_path_length=${maxHops},`,
    `    client=${c},`,
    `)`,
  ]
})
