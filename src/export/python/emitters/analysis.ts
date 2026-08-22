/**
 * The remaining data nodes: Build Network, the two importers, and Paths.
 */

// An emitter may reach `src/ui`, which is what keeps the palette in one place rather than
// transcribed into two exporters — the same licence `out.scatter`'s emitter takes.
import { MAX_SERIES } from '../../../ui/colors'
import { clusterColor } from '../../../ui/encoding'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'
import { pySelection, selectionIds } from './common'

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
    const nodeKey = ctx.column('nodeKey') ?? 'neuronId'
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
    lines.push(`${out} = ${out}.rename(columns={${pyStr(idColumn)}: 'neuronId'})`)
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
      "neuprint's `fetch_paths` returns every route within the hop budget. Coda additionally " +
        'ranks them by their weakest link and keeps the strongest — that ranking is not ' +
        'reproduced here, so this is the unranked set.',
    ),
    `${out} = fetch_paths(`,
    `    ${sources}['neuronId'].tolist(),`,
    `    ${targets}['neuronId'].tolist(),`,
    `    min_weight=${minWeight},`,
    `    max_path_length=${maxHops},`,
    `    client=${c},`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// NBLAST
// ---------------------------------------------------------------------------

/**
 * The units sentence both NBLAST emitters carry, and the dotprops block all three call sites
 * build. Written once here rather than three times below — `common.ts` is the home for the
 * cross-file version of this, but these two emitters are the only readers.
 */
const MICRON_NOTE =
  'NBLAST is calibrated in micrometres — navis: "Neurons should be in microns as NBLAST is ' +
  'optimized for that". This converts through the units navis carries on the neuron rather ' +
  'than assuming a factor.'

function dotpropsLines(from: string, name: string, k: number, resample: number): string[] {
  return [
    `${name} = navis.make_dotprops(`,
    `    ${from}.convert_units('um'),`,
    `    k=${k},`,
    ...(resample > 0 ? [`    resample=${resample},`] : []),
    `)`,
  ]
}

/**
 * The one node whose Python is the *same implementation*, not a translation of it.
 *
 * Coda runs navis-fastcore in the browser and navis reaches for the very same wheel when it is
 * installed, so a notebook of this cell is not an approximation of what the canvas did — it is
 * what the canvas did, on a machine with cores. Two things still differ and both are said out
 * loud rather than papered over: units, and how the symmetric case is spelled.
 */
registerEmitter('neuron.nblast', (ctx) => {
  const query = ctx.wired('query')
  const target = ctx.input('target')
  ctx.require('navis')

  const out = ctx.output('scores')
  const dots = `${ctx.name}_dp`
  const k = Number(ctx.params.k ?? 5)
  const resample = Number(ctx.params.resample ?? 1)
  const symmetry = String(ctx.params.symmetry ?? 'mean')
  const normalized = ctx.params.normalize !== false
  const useAlpha = ctx.params.useAlpha === true

  const lines: string[] = [
    /*
     * `convert_units` rather than a division by 1000: navis carries the unit on the neuron, so
     * this is right for a dataset whose voxels are not 8 nm and it *raises* rather than
     * silently scaling where the unit is unknown. Coda has to use the factor, because its own
     * skeletons are nanometres by construction.
     */
    ...ctx.note(MICRON_NOTE),
    ...dotpropsLines(query, dots, k, resample),
  ]

  const targetDots = target ? `${ctx.name}_target_dp` : undefined
  if (target && targetDots) lines.push(...dotpropsLines(target, targetDots, k, resample))

  const common = [
    `    normalized=${normalized ? 'True' : 'False'},`,
    ...(useAlpha ? [`    use_alpha=True,`] : []),
  ]

  if (!target && symmetry === 'none') {
    // navis's own docstring: "A more efficient way than running nblast(query=x, target=x)".
    lines.push(`${out} = navis.nblast_allbyall(`, `    ${dots},`, ...common, `)`)
  } else {
    if (!target) {
      lines.push(
        ...ctx.note(
          `nblast_allbyall has no symmetry option, so the symmetric case goes through ` +
            `nblast(x, x, scores='${symmetry}'). Same scores, a little more work.`,
        ),
      )
    }
    lines.push(
      `${out} = navis.nblast(`,
      `    ${dots},`,
      `    ${targetDots ?? dots},`,
      `    scores=${pyStr(symmetry === 'none' ? 'forward' : symmetry)},`,
      ...common,
      `)`,
    )
  }

  const label = ctx.column('labelColumn')
  if (label) {
    lines.push(
      ...ctx.note(
        `Coda labels the rows by "${label}"; this frame is indexed by neuron id, which is what ` +
          `every other navis call takes.`,
      ),
    )
  }
  return lines
})

/**
 * navis has this one outright — `nblast_knn(..., format='long')` returns the same tidy frame
 * this node emits, which makes the translation a rename rather than a reshape.
 *
 * The rename is not cosmetic. navis calls the columns `query` and `target`; Coda calls them
 * `queryId` and `targetId` because `isIdentifierColumn` reads a name's last word to decide
 * whether a number is an identifier or a quantity, and a column called `query` prints body
 * 527536 as "527,536". Emitting navis's names would leave every downstream cell addressing
 * columns that are not there.
 */
registerEmitter('neuron.nblastKnn', (ctx) => {
  const query = ctx.wired('query')
  const target = ctx.input('target')
  ctx.require('navis')

  const out = ctx.output('matches')
  const dots = `${ctx.name}_dp`
  const tangentK = Number(ctx.params.tangentK ?? 5)
  const resample = Number(ctx.params.resample ?? 1)
  const symmetry = String(ctx.params.symmetry ?? 'mean')

  const lines: string[] = [...ctx.note(MICRON_NOTE), ...dotpropsLines(query, dots, tangentK, resample)]

  const targetDots = target ? `${ctx.name}_target_dp` : undefined
  if (target && targetDots) lines.push(...dotpropsLines(target, targetDots, tangentK, resample))

  lines.push(
    `${out} = navis.nblast_knn(`,
    `    ${dots},`,
    ...(targetDots ? [`    target=${targetDots},`] : []),
    `    k=${Number(ctx.params.k ?? 5)},`,
    `    scores=${pyStr(symmetry === 'none' ? 'forward' : symmetry)},`,
    `    n_candidates=${Number(ctx.params.nCandidates ?? 200)},`,
    `    format='long',`,
    `    normalized=${ctx.params.normalize !== false ? 'True' : 'False'},`,
    ...(ctx.params.useAlpha === true ? [`    use_alpha=True,`] : []),
    `)`,
    // Coda's column names, so anything wired after this node addresses the same frame.
    `${out} = ${out}.rename(columns={'query': 'queryId', 'target': 'targetId'})`,
  )

  const label = ctx.column('labelColumn')
  if (label) {
    lines.push(
      ...ctx.note(
        `Coda also carries "${label}" for each side as queryLabel / targetLabel. Join them ` +
          `back on from the neuron table if you need them here.`,
      ),
    )
  }
  return lines
})

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/**
 * **A Coda tree carries its labels and a SciPy `Z` does not**, which is the one shape decision
 * in this trio. `Z` is `(n - 1) x 4` of numbers and nothing in it says which observation index
 * 3 was; the matrix's row labels are what a dendrogram and a cluster table both need.
 *
 * So the tree output binds the `Z` — a real linkage matrix, so `fcluster`, `cut_tree`,
 * `dendrogram` and `cophenet` all take it directly, which is what a reader wants — and its
 * labels and leaf order ride alongside under derived names. The walk gives every emitter its
 * input's *variable name*, so a node downstream reconstructs the companions from that with no
 * channel between emitters and nothing to keep in step.
 */
function companions(variable: string): { labels: string; order: string; clusters: string } {
  return {
    labels: `${variable}_labels`,
    order: `${variable}_order`,
    // The third arrived with the Dendrogram's `cluster`/`color` columns: a cut is a fact about
    // the tree in Coda, where SciPy keeps it in whatever variable `cut_tree` was assigned to.
    // Bound to `None` by Linkage and to the cut by Cut Tree, so a Dendrogram can read it either
    // way without knowing which is upstream.
    clusters: `${variable}_clusters`,
  }
}

registerEmitter('cluster.linkage', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('numpy')
  ctx.require('scipyCluster', 'leaves_list', 'linkage')
  ctx.require('scipyDistance', 'squareform')

  const tree = ctx.output('tree')
  const ordered = ctx.output('ordered')
  const { labels, order, clusters } = companions(tree)
  const method = String(ctx.params.method ?? 'ward')
  const symmetry = String(ctx.params.symmetry ?? 'mean')
  const distance = String(ctx.params.distance ?? 'auto')

  const combined =
    symmetry === 'mean'
      ? '(_m + _m.T) / 2'
      : symmetry === 'min'
        ? 'np.minimum(_m, _m.T)'
        : symmetry === 'max'
          ? 'np.maximum(_m, _m.T)'
          : '_m'

  const lines: string[] = [
    ...ctx.note(
      'Coda runs navis-fastcore, whose linkage matrix is SciPy’s: checked against ' +
        'scipy.cluster.hierarchy.linkage on NBLAST-shaped matrices, merge order identical and ' +
        'heights agreeing to 1e-15. The fused pass fastcore uses saves memory, not accuracy.',
    ),
    `_m = np.asarray(${src}, dtype=float)`,
  ]

  if (symmetry === 'none') {
    lines.push(
      ...ctx.note(
        'Symmetry is off, so only the upper triangle is read — `squareform` ignores the ' +
          'lower half exactly as fastcore does. On a matrix that is not already symmetric ' +
          'that discards data rather than combining it.',
      ),
    )
  }

  // `checks=False` because the diagonal is never read either here or in fastcore, and a
  // self-score of 1 makes a diagonal of 0 distance that `squareform`'s checks would want
  // anyway. Turning them on would refuse a matrix that clusters perfectly well.
  lines.push(
    `_d = ${distance === 'none' ? combined : `1.0 - (${combined})`}`,
    `${tree} = linkage(squareform(_d, checks=False), method=${pyStr(method)})`,
    `${labels} = list(getattr(${src}, 'index', range(len(_m))))`,
    `${order} = leaves_list(${tree})`,
    // Nothing has cut it yet, and `None` says so where an empty list would read as "cut into
    // nothing" — the same absent-is-not-empty distinction the tree value itself draws.
    `${clusters} = None`,
    // The block-diagonal picture, which is what the second port is for.
    `${ordered} = ${src}.iloc[${order}, ${order}]`,
  )

  if (distance === 'auto') {
    lines.push(
      ...ctx.note(
        'Scores are similarities, so the distance is 1 − score. A matrix that carries ' +
          'distances already would be clustered as it stands.',
      ),
    )
  }
  return lines
})

/**
 * `cut_tree`, not `fcluster(..., 'maxclust')`, and the difference is not cosmetic.
 *
 * Both cut a tree into k groups and they disagree on ties: `maxclust` finds the lowest height
 * leaving *at most* k clusters, so on six observations in three tied pairs it answers three
 * clusters for k = 2, 4 and 5 alike. `cut_tree` undoes the last k - 1 merges and returns
 * exactly k, which is what Coda's node does — verified as the same partition on all 300
 * comparisons across the five methods offered.
 */
registerEmitter('cluster.cut', (ctx) => {
  const src = ctx.wired('in')
  const { labels, order } = companions(src)
  ctx.require('pandas')
  ctx.require('numpy')

  const clustersOut = ctx.output('clusters')
  const tree = ctx.output('tree')
  const out = companions(tree)
  const byHeight = String(ctx.params.mode ?? 'count') === 'height'

  ctx.require('scipyCluster', byHeight ? 'fcluster' : 'cut_tree')
  const cut = byHeight
    ? `fcluster(${src}, t=${Number(ctx.params.height ?? 0.5)}, criterion='distance')`
    : `cut_tree(${src}, n_clusters=${Number(ctx.params.count ?? 4)}).ravel()`

  return [
    `_raw = np.asarray(${cut})`,
    ...ctx.note(
      'Coda numbers clusters left to right as the dendrogram draws them, so the column reads ' +
        'against the picture. SciPy numbers them by its own bookkeeping — the grouping is ' +
        'identical either way; this renumbers so the two agree.',
    ),
    `_renumber = {c: i + 1 for i, c in enumerate(dict.fromkeys(_raw[${order}]))}`,
    `_cluster = [_renumber[c] for c in _raw]`,
    `_position = {int(obs): i for i, obs in enumerate(${order})}`,
    `${clustersOut} = pd.DataFrame({`,
    `    'label': ${labels},`,
    `    'cluster': _cluster,`,
    `    'order': [_position[i] for i in range(len(${labels}))],`,
    `})`,
    `${clustersOut}['size'] = ${clustersOut}.groupby('cluster')['label'].transform('size')`,
    ``,
    // The tree passes through, companions and all, so a Dendrogram wired after this one still
    // finds its labels.
    `${tree} = ${src}`,
    `${out.labels} = ${labels}`,
    `${out.order} = ${order}`,
    `${out.clusters} = _cluster`,
  ]
})

/**
 * SciPy's `orientation` is named for where the **root** goes, not the leaves — checked against
 * the docstring rather than guessed. Coda's "leaves on the right" is therefore `'left'`, and
 * getting it backwards produces a mirrored picture that looks perfectly reasonable.
 */
registerEmitter('out.dendrogram', (ctx) => {
  const src = ctx.wired('in')
  const { labels, order, clusters } = companions(src)
  ctx.require('pandas')
  ctx.require('matplotlib')
  ctx.require('scipyCluster', 'dendrogram')

  const out = ctx.output('out')
  const selected = ctx.output('selected')
  const outNames = companions(out)
  const down = String(ctx.params.orientation ?? 'right') === 'down'
  // Leaf *positions*, not names: a label column can call two leaves the same thing, so the
  // canvas holds the observation index. See `out.dendrogram`.
  const selection = selectionIds(ctx)

  const lines = [
    `${out} = ${src}`,
    `${outNames.labels} = ${labels}`,
    `${outNames.order} = ${order}`,
    `${outNames.clusters} = ${clusters}`,
    ``,
    `plt.figure(figsize=(10, 6))`,
    `dendrogram(`,
    `    ${out},`,
    `    labels=${outNames.labels},`,
    // 'left' puts the root at the left and the leaves to its right.
    `    orientation=${pyStr(down ? 'top' : 'left')},`,
    ...(ctx.params.showLabels === false ? [`    no_labels=True,`] : []),
    `)`,
    `plt.tight_layout()`,
    `plt.show()`,
    ``,
  ]

  /*
   * The palette is read off the real one rather than restated — an emitter may reach `src/ui`,
   * which is half of why the registry is separate from the node definitions. Coda's dark ramp,
   * because `evaluate` pins it: see `EMITTED_MODE` in the node.
   *
   * Worth knowing that this does **not** make the drawing above match: `scipy.dendrogram` has a
   * colour scheme of its own and takes `link_color_func` to override it. What matches is the
   * column, which is what anything downstream reads.
   */
  const palette = Array.from({ length: MAX_SERIES }, (_, i) => clusterColor(i + 1, 'dark'))
  const uncut = clusterColor(0, 'dark')

  if (selection.length > 0) {
    lines.push(
      `_picked = ${pySelection(selection)}`,
      `_position = {int(obs): i for i, obs in enumerate(${outNames.order})}`,
      `_palette = ${pyList(palette)}`,
      `_cluster_of = lambda i: 0 if ${outNames.clusters} is None else int(${outNames.clusters}[i])`,
      // Cycling past the eighth, as the tree draws it — see `clusterColor`.
      `_colour_of = lambda c: ${pyStr(uncut)} if c <= 0 else _palette[(c - 1) % ${MAX_SERIES}]`,
      `${selected} = pd.DataFrame({`,
      `    'label': [${outNames.labels}[i] for i in _picked],`,
      `    'order': [_position[i] for i in _picked],`,
      `    'cluster': [_cluster_of(i) for i in _picked],`,
      `    'color': [_colour_of(_cluster_of(i)) for i in _picked],`,
      `}).sort_values('order')`,
    )
  } else {
    lines.push(
      ...ctx.note('No branch is selected on the canvas, so Selected is empty.'),
      `${selected} = pd.DataFrame({'label': [], 'order': [], 'cluster': [], 'color': []})`,
    )
  }
  return lines
})

/**
 * `Selected to Neurons` / `Clusters to Neurons` — one emitter, two registrations, exactly as
 * the node is one operation under two names.
 *
 * **`merge` compares by value and Coda compares as text**, which is the whole care in this
 * cell. An NBLAST labelled by neuron id produces the *string* `"722817260"` against an `int64`
 * column, so a plain `left_on='neuronId', right_on='label'` merges nothing at all — zero rows,
 * no error, on the single most common wiring. Both sides are cast to `str` into a scratch key
 * for that reason, which reproduces `joinTables`' `String(cell)` rule exactly.
 *
 * The `drop_duplicates` is the second half of the same fidelity: Coda takes the first row for a
 * repeated label where `merge` would emit the cross product, turning a duplicate into extra
 * neurons nobody selected.
 */
function labelsToNeuronsEmitter(ctx: EmitContext): string[] {
  const labels = ctx.wired('labels')
  const neurons = ctx.input('neurons')
  ctx.require('pandas')

  const out = ctx.output('neurons')
  const labelColumn = ctx.column('labelColumn') ?? 'label'
  const suffix = String(ctx.params.suffix ?? '_c')

  if (!neurons) {
    ctx.require('numpy')
    return [
      ...ctx.note(
        'No neuron table is wired on the canvas, so the labels are read as neuron ids — which ' +
          'is what they are unless NBLAST was told to label by something else. Rows that are ' +
          'not usable ids are dropped, as they are in Coda.',
      ),
      `${out} = ${labels}.copy()`,
      `${out}['neuronId'] = pd.to_numeric(${out}[${pyStr(labelColumn)}], errors='coerce')`,
      `${out} = ${out}[${out}['neuronId'].notna()].drop(columns=[${pyStr(labelColumn)}])`,
      `${out}['neuronId'] = ${out}['neuronId'].astype('int64')`,
      // neuronId first, as the node emits it — a column order nothing depends on but everything
      // downstream is read by a person.
      `${out} = ${out}[['neuronId'] + [c for c in ${out}.columns if c != 'neuronId']]`,
    ]
  }

  const matchColumn = ctx.column('matchColumn') ?? 'neuronId'
  return [
    ...ctx.note(
      'Coda matches labels as text, so both sides go through a string key: an NBLAST labelled ' +
        'by neuron id gives "722817260" against an int64 column, and merging those directly ' +
        'returns nothing at all.',
    ),
    `_left = ${neurons}.assign(_key=${neurons}[${pyStr(matchColumn)}].astype(str))`,
    `_right = ${labels}.assign(_key=${labels}[${pyStr(labelColumn)}].astype(str))`,
    // First match wins, as it does in Coda; merge would otherwise emit the cross product.
    `_right = _right.drop_duplicates('_key').drop(columns=[${pyStr(labelColumn)}])`,
    `${out} = _left.merge(_right, on='_key', how='inner', suffixes=('', ${pyStr(suffix)}))`,
    `${out} = ${out}.drop(columns=['_key'])`,
  ]
}

registerEmitter('cluster.selectedToNeurons', labelsToNeuronsEmitter)
registerEmitter('cluster.clustersToNeurons', labelsToNeuronsEmitter)
