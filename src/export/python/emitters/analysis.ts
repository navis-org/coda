/**
 * The remaining data nodes: Build Network, the two importers, Paths, the clustering trio, and
 * the connectivity-similarity pair.
 */

// An emitter may reach `src/ui`, which is what keeps the palette in one place rather than
// transcribed into two exporters — the same licence `out.scatter`'s emitter takes.
import { MAX_SERIES } from '../../../ui/colors'
import { clusterColor } from '../../../ui/encoding'
import { pyList, pyStr } from '../py'
import type { LANDMARK_SIDES } from '../../../nodes/transform/landmarkTransform'
import { LANDMARK_AXES, landmarkParamId } from '../../../nodes/transform/landmarkTransform'
import { matchParamsFrom } from '../../../nodes/lib/matchOps'
import { meshCleanParamsFrom, skeletonCleanParamsFrom } from '../../../nodes/lib/cleanOps'
import { NM_PER_UM } from '../../../nodes/lib/nblastOps'
import { effectiveOutput, isLongLayout } from '../../../nodes/lib/similarityOps'
import type { SimilarityMetric, SimilarityOutput } from '../../../nodes/lib/similarityOps'
import { ID_COLUMN_NAME } from '../../../core/ids'
import { portIdAt } from '../../../core/ports'
import { compareParamsFrom } from '../../../nodes/lib/edgeComparison'
import { repeatParamId } from '../../../nodes/lib/repeatParams'
import { resolveDatasetNames } from '../../../nodes/analysis/compareConnectivity'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'
import { pySelection, selectionIds } from './common'
import { pyFilterMask } from './table'
import { findColumn, isNumericDType } from '../../../core/types'
import { COMMON_SPACE, nerveCordIn } from '../../../data/transforms/spaces'

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
// Filter Network
// ---------------------------------------------------------------------------

/**
 * A subgraph around a selection, in networkx.
 *
 * The seed half goes through `pyFilterMask`, the same function `Filter Table` emits with, so the
 * two nodes that share a name share an operator table here as well as on the canvas. It runs
 * against a frame built from the node attributes rather than against the graph, because that is
 * where the columns are and because pandas is where the mask expression is written to run.
 *
 * `ego_graph` and `node_connected_component` are networkx's own, so the walk is theirs rather
 * than a transcription of ours — the two agree on what a hop is. The one place Coda does
 * something networkx would not is the roll-ups: `degreeIn` and friends are recomputed on a Coda
 * subgraph so a size encoding describes the picture. A networkx graph carries no such columns —
 * `G.degree()` is asked on demand and is therefore right by construction — so there is nothing
 * to emit for it, which is a difference worth *not* writing code for.
 */
registerEmitter('net.filter', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const name = ctx.column('column')
  const seedFrame = ctx.input('seed')
  const seedColumn = ctx.column('seedColumn')
  const hasSeedTable = !!seedFrame && !!seedColumn
  if (!name && !hasSeedTable) return ctx.todo('Nothing selects any nodes on this Filter Network.')

  ctx.require('networkx')
  ctx.require('pandas')

  const lines: string[] = []
  const seeds: string[] = []

  if (name) {
    const op = String(ctx.params.op ?? 'contains')
    const raw = String(ctx.params.value ?? '')
    // `ctx.attributes`, not `ctx.schema`: `schemaOf` has no branch for a network, and this is
    // the accessor `InferContext` carries for exactly that — forwarded onto `EmitContext` rather
    // than reached around, or every network emitter after this writes it again.
    const dtype = findColumn(ctx.attributes('in', 'nodes'), name)?.dtype
    const built = pyFilterMask('_attrs', name, op, raw, isNumericDType(dtype ?? 'str'))
    if (built.mask === undefined) return ctx.todo(built.reason)
    lines.push(
      ...built.notes.flatMap((note) => ctx.note(note)),
      // `orient='index'`, so the frame's index is the node id — which is what the mask selects
      // and therefore what comes back out as the seed set.
      `_attrs = pd.DataFrame.from_dict(dict(${src}.nodes(data=True)), orient='index')`,
      `_seed = set(_attrs.index[${built.mask}])`,
    )
    seeds.push('_seed')
  }

  if (hasSeedTable) {
    lines.push(`_wired = set(${seedFrame}[${pyStr(seedColumn!)}].dropna().astype(str))`)
    seeds.push('_wired')
  }

  // Unioned, never one overriding the other — both are things somebody asked for.
  lines.push(`_keep = ${seeds.join(' | ')}`)

  const expand = String(ctx.params.expand ?? 'component')
  if (expand === 'component') {
    lines.push(
      // Undirected on purpose: a connected component that respected arrows would be a
      // *reachable set*, which is a different answer wearing the same name.
      `_undirected = ${src}.to_undirected(as_view=True)`,
      `for _n in list(_keep):`,
      `    _keep |= nx.node_connected_component(_undirected, _n)`,
    )
  } else if (expand === 'hops') {
    const hops = Math.max(1, Math.floor(Number(ctx.params.hops ?? 1)))
    const direction = String(ctx.params.direction ?? 'any')
    if (direction === 'upstream') {
      lines.push(`_walk = ${src}.reverse(copy=False) if ${src}.is_directed() else ${src}`)
    } else {
      lines.push(`_walk = ${src}`)
    }
    lines.push(
      `for _n in list(_keep):`,
      `    _keep |= set(`,
      `        nx.ego_graph(`,
      `            _walk, _n, radius=${hops}, undirected=${direction === 'any' ? 'True' : 'False'}`,
      `        ).nodes`,
      `    )`,
    )
  }

  // `.copy()` rather than the view `subgraph` returns: a view keeps the whole graph alive and
  // refuses mutation, and everything downstream here treats its input as an ordinary graph.
  lines.push(`${out} = ${src}.subgraph(_keep).copy()`)
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
  const mode = String(ctx.params.mode ?? 'count')
  /*
   * The mixed-dataset mode has no counterpart here. `cut_tree`/`cutree` both cut across the
   * tree at one level; this mode descends to the deepest clusters drawing from every dataset,
   * which is a walk over the merge matrix rather than a cut. Emitting a count cut instead —
   * which is what falling through to the branch below did — produces a notebook that *runs*,
   * returns four clusters, and is a different analysis from the canvas, with `4` being a
   * default the user never saw because the control is hidden in this mode.
   *
   * `docs/export.md`'s policy: two things are refused, every other gap emits a TODO. Writing
   * the walk in both languages is the fix if somebody wants it; a silent wrong answer is not.
   */
  if (mode === 'mixed') {
    return ctx.todo(
      'This Cut Tree groups by which datasets each cluster draws from, which has no ' +
        'single-call equivalent here.',
    )
  }
  const byHeight = mode === 'height'
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

// ---------------------------------------------------------------------------
// Mirror Neurons
// ---------------------------------------------------------------------------

/**
 * `navis.mirror_brain`, which is the function Coda's mirror is a re-implementation of.
 *
 * A faithful translation rather than an approximation of one: navis flips about
 * `bbox.min + bbox.max` along the template's mirror axis, and Coda's `flipAt` is generated from
 * that same bounding box by `scripts/gen-transforms.py`. The two cannot drift, because only one
 * of them is written down.
 *
 * **`warp` is passed explicitly either way**, never left to the default. navis' default is
 * `"auto"` — apply the correction wherever a registration exists — so an omitted argument would
 * emit a notebook that does more or less than the canvas did depending on the template, and
 * disagrees with it by several micrometres without saying so.
 *
 * The two sides use *different landmarks for the same correction*, which is worth knowing
 * before comparing outputs to the nanometre: Coda ships a copy of navis-flybrains' own mirror
 * sets, so a space flybrains has since re-fitted would differ until `gen-transforms.py` is
 * re-run. The affine halves cannot differ at all — `check-mirror.py` holds them to exact
 * agreement — so any discrepancy is the spline and is bounded by what the landmarks disagree
 * about.
 *
 * Coda's space ids **are** flybrains' template names, which is not luck: `spaces.ts` took them
 * from flybrains so this translation could be a variable rather than a lookup table.
 */
registerEmitter('neuron.mirror', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const space = String(ctx.params.space ?? '')

  /*
   * A space this cell cannot name. The canvas reads it off the geometry at run time, which is a
   * value; an exporter has only params and types. Rather than guess a template — and mirror
   * somebody's neurons about the wrong midline in a file they will run tomorrow — it says so.
   */
  if (!space) {
    return ctx.todo(
      'Mirror Neurons read the template space off the geometry, which this exporter cannot ' +
        'see. Set Space on the node, or pass template= here by hand.',
    )
  }

  ctx.require('navis')
  ctx.require('flybrains')
  /*
   * `warp=` takes a Transform as readily as a bool — that is navis' own signature — so a wired
   * Landmark Transform translates by *name* rather than by being approximated. The flip still
   * comes from the template, which is what the canvas does too.
   */
  const supplied = ctx.input('warp')
  const warp = supplied ?? (ctx.params.warp === false ? 'False' : 'True')
  return [`${out} = navis.mirror_brain(${src}, template="${space}", warp=${warp})`]
})

/**
 * Transform Neurons, as `navis.xform_brain`.
 *
 * The verb is the same and the *route* is not, which is the thing this cell has to be honest
 * about. Coda fits one thin-plate spline through landmarks generated offline against the full
 * navis stack; navis walks its bridging graph through whatever CMTK and H5 registrations are
 * installed. So the notebook is not a reproduction of the canvas — it is the **long route the
 * canvas took a shortcut through**, which is the better answer of the two and worth having.
 *
 * How much better: measured on 500 FlyWire shell vertices, the two agree to **0.9 µm median**.
 * That is the cost of the shortcut, and it is smaller than the difference between two animals.
 *
 * **A nerve cord bound for `JRC2018U` is refused rather than emitted**, and this is the one that
 * would otherwise be a silent wrong answer. That template is a brain with no nerve cord in it.
 * Coda registers a VNC to `JRCVNC2018U` and then *places* it beside the brain by a fixed affine;
 * navis has no such registration, so `xform_brain` routes a nerve cord through a brain
 * deformation field instead — 100% of sample points land outside it, it warns as much, and the
 * answer comes back 97 µm from Coda's. A cell that runs, warns and returns nonsense is worse
 * than a TODO.
 *
 * Scoped to that target, deliberately. A nerve cord bound for *another dataset's* space is a
 * route navis may well have directly and better — `MANC → JRCFIB2022M` is one — so refusing
 * every VNC transform would decline cells that are correct.
 *
 * **A dataset-to-dataset target routes differently on the two sides**, and the note says so
 * without overstating it. Coda goes out through the hub and back; navis finds its own route,
 * usually direct. That costs Coda a second fit and — measured, restricted to the region the
 * target actually covers — about the sum of the two one-hop errors, 1.3–1.9 µm, with no
 * compounding. Where the two really part company is a target that does not cover the neuron at
 * all, and there neither answer means much: navis' own deformation field warns on the same
 * region.
 */
registerEmitter('neuron.xform', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')

  /*
   * A supplied transform short-circuits the whole route question, here as on the canvas —
   * `navis.xform` applies a Transform directly where `xform_brain` looks one up by template.
   * This is the branch that needs no note at all: both sides are running the same spline over
   * the same landmarks, so there is nothing to be approximate about.
   */
  const supplied = ctx.input('transform')
  if (supplied) {
    ctx.require('navis')
    return [`${out} = navis.xform(${src}, transform=${supplied})`]
  }

  const space = String(ctx.params.space ?? '')

  /*
   * The same gap `neuron.mirror` has, and for the same reason: the canvas reads the source space
   * off the geometry, which is a *value*, and an exporter has only params and types. Guessing a
   * template here would transform somebody's neurons out of a space they were never in, in a
   * file they run tomorrow.
   */
  if (!space) {
    return ctx.todo(
      'Transform Neurons read the source space off the geometry, which this exporter cannot ' +
        'see. Set Space on the node, or pass source= here by hand.',
    )
  }

  const target = String(ctx.params.target ?? COMMON_SPACE.id)

  if (target === COMMON_SPACE.id && nerveCordIn(space).any) {
    return ctx.todo(
      `${space} contains a nerve cord, and ${COMMON_SPACE.id} is a brain template with none. ` +
        'Coda registers the VNC to JRCVNC2018U and places it beside the brain by a fixed ' +
        'affine; navis has no equivalent registration and would route it through a brain ' +
        'deformation field, which returns coordinates ~97 µm away with only a warning. ' +
        'Transform to JRCVNC2018U instead, or place it yourself with ' +
        'navis.transforms.AffineTransform.',
    )
  }

  ctx.require('navis')
  ctx.require('flybrains')
  const note =
    target === COMMON_SPACE.id
      ? 'navis walks its full bridging graph here, where Coda fitted one spline through ' +
        'landmarks sampled from that same graph. The two agree to about 0.9 µm; this is the ' +
        'more accurate of the pair. Note the result is in micrometres, which navis carries on ' +
        'the neuron — anything downstream needing nanometres should convert rather than assume.'
      : `Coda goes out through ${COMMON_SPACE.id} and back where navis routes directly, so ` +
        'expect one to two micrometres of disagreement — about the sum of the two one-hop ' +
        'errors, which is what composing splines costs. Where the target does not cover the ' +
        'neuron (the hemibrain is one hemisphere) neither answer means much; navis warns about ' +
        'that region itself.'
  return [
    ...ctx.note(note),
    `${out} = navis.xform_brain(${src}, source="${space}", target="${target}")`,
  ]
})

/**
 * Landmark Transform, as `navis.transforms.TPStransform`.
 *
 * The one place the translation is exact rather than merely faithful: Coda fits this spline
 * with navis-fastcore's `TpsTransform`, which agrees with `navis.transforms.TPStransform` to
 * ~1e-14 relative — the same relationship the clustering emitter has to `scipy`. So the
 * notebook is not approximating the canvas here, it is running the other implementation of the
 * identical fit.
 *
 * Units are multiplied in rather than declared, because navis carries a unit on a *neuron* and
 * this is a bare array. Emitted only where the factor is not 1, so the ordinary nanometre case
 * reads as plainly as it is.
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

  ctx.require('navis')
  const scaled = (names: string[], units: unknown) => {
    const values = `${table}[[${names.map(pyStr).join(', ')}]].values`
    return units === 'um' ? `${values} * 1000` : values
  }

  return [
    `${out} = navis.transforms.TPStransform(`,
    `    ${scaled(from, ctx.params.sourceUnits)},`,
    `    ${scaled(to, ctx.params.targetUnits)},`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// syNBLAST
// ---------------------------------------------------------------------------

/**
 * The second node whose Python is the *same implementation* rather than a translation.
 *
 * `navis.synblast` exists and is deliberately not what this emits. navis's version takes
 * neurons carrying a `connectors` table, and Coda's input is a bare point cloud — the frame
 * `fetch_synapses` returned, several nodes upstream, possibly filtered since. Rebuilding
 * `TreeNeuron`s from it in order to hand them to a wrapper around the very function below
 * would be a longer cell doing the same arithmetic with one more thing to go wrong.
 *
 * fastcore takes `(N, 4)` arrays — `[x, y, z, type]` — which is what the frame already is.
 */
registerEmitter('neuron.synblast', (ctx) => {
  const query = ctx.wired('query')
  const target = ctx.input('target')
  ctx.require('fastcore')
  ctx.require('numpy')

  const out = ctx.output('scores')
  const polarity = ctx.column('polarityColumn')
  const label = ctx.column('labelColumn')
  const symmetry = String(ctx.params.symmetry ?? 'mean')
  const groups = `${ctx.name}_groups`
  const build = `${ctx.name}_connectors`
  // Namespaced like every other name this file binds. Unprefixed, two syNBLAST nodes in one
  // notebook would each define `VOXEL_UM` at top level and the second would silently overwrite
  // whatever the reader had corrected in the first.
  const voxelUm = `${ctx.name}_voxel_um`

  const lines: string[] = [
    ...ctx.note(
      'syNBLAST is calibrated in micrometres like NBLAST, and neuprint-python returns synapse ' +
        'locations in raw voxels — 8 nm on the hemibrain. Check this factor against your ' +
        'dataset: nothing in the graph records it.',
    ),
    `${voxelUm} = 8 / 1000`,
    ``,
    /*
     * A closure rather than two copies of the group-by, because the target side needs exactly
     * the same treatment and the two coming apart is a matrix compared against itself in
     * different units. Emitted as a `def` so the notebook reads as one idea.
     */
    `def ${build}(frame):`,
    `    """One (N, 4) array of [x, y, z, type] per neuron, in first-appearance order."""`,
    `    out, labels = [], []`,
    `    for key, rows in frame.groupby('neuronId', sort=False):`,
    `        block = np.empty((len(rows), 4))`,
    `        block[:, :3] = rows[['x', 'y', 'z']].to_numpy() * ${voxelUm}`,
    polarity
      ? `        block[:, 3] = (rows[${pyStr(polarity)}] == 'post').astype(float)`
      : `        block[:, 3] = 0.0`,
    `        out.append(block)`,
    /*
     * Guarded rather than indexed, and this is the one line where the notebook cannot simply
     * mirror the canvas. Coda's label picker offers every column of *its* synapse schema, and
     * neuprint-python's frame carries fewer of them — `type` is the cell type in Coda and is
     * not in this frame at all (see the Synapses cell). Falling back to the neuron id is what
     * Coda itself does for an empty cell, so the shape of the answer is the same either way.
     */
    label
      ? `        labels.append(` +
        `str(rows[${pyStr(label)}].iloc[0]) if ${pyStr(label)} in rows.columns else str(key))`
      : `        labels.append(str(key))`,
    `    return out, labels`,
    ``,
    `${groups}, ${groups}_labels = ${build}(${query})`,
  ]

  if (target) lines.push(`${groups}_t, ${groups}_t_labels = ${build}(${target})`)

  if (label) {
    lines.push(
      ...ctx.note(
        `Coda labels the rows by "${label}". neuprint-python's synapse frame carries fewer ` +
          `columns than Coda's does — notably not the cell type — so this falls back to the ` +
          `neuron id where the column is absent. Join it on from a neuron table to match.`,
      ),
    )
  }

  if (!polarity) {
    lines.push(
      ...ctx.note(
        'No polarity column is set on this node, so every connector is one pool and an input ' +
          'is compared against an output. `by_type` is off to match.',
      ),
    )
  }

  lines.push(
    `${out} = fastcore.synblast(`,
    `    ${groups},`,
    ...(target ? [`    ${groups}_t,`] : [`    None,`]),
    `    by_type=${polarity ? 'True' : 'False'},`,
    `    normalize=${ctx.params.normalize !== false ? 'True' : 'False'},`,
    `    symmetry=${symmetry === 'none' ? 'None' : pyStr(symmetry)},`,
    `)`,
    // A bare ndarray out of fastcore; Coda's matrix carries its labels, and every viewer and
    // clustering cell downstream indexes by them.
    `${out} = pd.DataFrame(`,
    `    ${out},`,
    `    index=${groups}_labels,`,
    `    columns=${target ? `${groups}_t_labels` : `${groups}_labels`},`,
    `)`,
  )
  ctx.require('pandas')
  return lines
})

// ---------------------------------------------------------------------------
// NBLAST Matches
// ---------------------------------------------------------------------------

/**
 * The third same-implementation cell, and the one where it matters most.
 *
 * A top-N per row is four lines of pandas and everybody writes them slightly differently. The
 * two rules worth preserving exactly are fastcore's: `percentage` is a band around each
 * group's **own** best value rather than a quantile of the matrix, and `skip_self` is the
 * *diagonal* rather than a comparison of labels. A notebook that re-derived either would
 * disagree with the canvas on precisely the rows a reader would go and check.
 */
registerEmitter('neuron.nblastMatches', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('fastcore')
  ctx.require('numpy')
  ctx.require('pandas')

  const out = ctx.output('matches')
  /*
   * Through the node's own decoder rather than transcribed. `decodeRenames` and
   * `resolveFilters` set this precedent for the same reason: a param's *interpretation* — that
   * `axis` is the string `'0'` but means the number 0, that `skipSelf` is `!== false` — lives
   * in `nodes/lib` and the emitters import it, so a notebook cannot come to disagree with the
   * canvas about what a control did.
   */
  const p = matchParamsFrom(ctx.params)
  const { mode, axis, direction, skipSelf, cutoff } = p

  const m = `${ctx.name}_m`
  const groups = `${ctx.name}_groups`
  const targets = `${ctx.name}_targets`

  const lines: string[] = [
    `${m} = np.ascontiguousarray(${src}, dtype=float)`,
    // The labels of the scanned axis, and of the other one. Which is which is the whole of
    // what `axis` controls, so both are bound rather than indexed inline.
    axis === 0
      ? `${groups} = list(getattr(${src}, 'index', range(${m}.shape[0])))`
      : `${groups} = list(getattr(${src}, 'columns', range(${m}.shape[1])))`,
    axis === 0
      ? `${targets} = list(getattr(${src}, 'columns', range(${m}.shape[1])))`
      : `${targets} = list(getattr(${src}, 'index', range(${m}.shape[0])))`,
  ]

  /*
   * `distances` is Coda's "Best means", and `auto` reads `MatrixValue.measure` — which lives on
   * the *value* and not on the type, so it is decided at run time and an emitter cannot see it.
   * It is not guessable either: the same port carries an NBLAST similarity, a Pivot's counts
   * and a normalised distance matrix. So `auto` emits the majority answer and says so, which
   * is the convention every other unknowable here follows.
   */
  const distances = direction === 'lower'

  const common = [
    `    axis=${axis},`,
    `    distances=${distances ? 'True' : 'False'},`,
    `    skip_self=${skipSelf ? 'True' : 'False'},`,
  ]
  const cut =
    cutoff === 'percentage'
      ? `    percentage=${p.percentage},`
      : `    threshold=${p.threshold},`

  if (direction === 'auto') {
    lines.push(
      ...ctx.note(
        'Best means is on "from the matrix", which Coda answers by reading what the matrix ' +
          'says its cells are. A DataFrame has nowhere to carry that, so this assumes higher ' +
          'is better. Set distances=True below if this is a distance matrix.',
      ),
    )
  }

  if (mode === 'count') {
    lines.push(
      `_counts = fastcore.count_matches(`,
      `    ${m},`,
      cut,
      ...common,
      `)`,
      `${out} = pd.DataFrame({'query': ${groups}, 'matches': _counts})`,
    )
    return lines
  }

  if (mode === 'top') {
    lines.push(
      /*
       * `n` is clamped here exactly as `clampN` clamps it on the canvas, and that is not
       * belt-and-braces: fastcore *raises* when `n` exceeds the scanned axis, so a graph that
       * Coda ran fine — clamped, with a warning — used to export a notebook that failed on a
       * cell the reader did not write. The clamp needs the matrix's own width, which only the
       * notebook has, so it is emitted rather than resolved.
       */
      `_n = min(${p.n}, ${m}.shape[${axis === 0 ? 1 : 0}]${skipSelf ? ' - 1' : ''})`,
      `_idx, _values = fastcore.top_matches(`,
      `    ${m},`,
      `    n=_n,`,
      ...common,
      `)`,
      // fastcore pads a short group with -1 / NaN to keep the two arrays rectangular. Kept out
      // of the frame rather than carried into it, exactly as Coda drops it.
      `_rows, _n = _idx.shape`,
      `_group = np.repeat(np.arange(_rows), _n)`,
      `_rank = np.tile(np.arange(1, _n + 1), _rows)`,
      `_flat_idx, _flat_val = _idx.ravel(), _values.ravel()`,
      `_keep = _flat_idx >= 0`,
    )
  } else {
    lines.push(
      `_offsets, _flat_idx, _flat_val = fastcore.matches_above(`,
      `    ${m},`,
      cut,
      ...common,
      `)`,
      `_counts = np.diff(_offsets)`,
      `_group = np.repeat(np.arange(len(_counts)), _counts)`,
      `_rank = np.concatenate([np.arange(1, c + 1) for c in _counts]) if len(_flat_idx) else _flat_idx`,
      `_keep = np.ones(len(_flat_idx), dtype=bool)`,
    )
  }

  lines.push(
    `${out} = pd.DataFrame({`,
    `    'query': np.asarray(${groups}, dtype=object)[_group[_keep]],`,
    `    'target': np.asarray(${targets}, dtype=object)[_flat_idx[_keep]],`,
    `    'rank': _rank[_keep],`,
    `    'score': _flat_val[_keep],`,
    `})`,
  )
  return lines
})

// ---------------------------------------------------------------------------
// Clean Skeletons / Clean Meshes
// ---------------------------------------------------------------------------

/**
 * Both cleaning nodes emit **fastcore**, not navis, and that is a considered choice.
 *
 * navis wraps some of this and would read more idiomatically over a `NeuronList` — but only
 * some. `navis.smooth_skeleton` is a moving average over a *node count* where Coda's control
 * is a Gaussian whose kernel is a *distance*, so emitting it would name a function whose one
 * argument means something else; and navis wraps neither `drop_internals` nor the
 * boundary-capping trio at all. Half a pipeline in navis and half in fastcore is worse than
 * either, and fastcore is what the canvas actually ran.
 *
 * The cost is that both cells loop over the neurons rather than mapping over a `NeuronList`,
 * which is what a reader would have to write anyway to reach these functions.
 */

const CLEAN_UNITS_NOTE =
  'Coda holds coordinates in nanometres and these controls are micrometres, so the distances ' +
  'below are the card’s values times 1000. If your neurons are in other units — neuprintr and ' +
  'raw neuprint-python both return voxels — scale them to match.'

registerEmitter('neuron.cleanSkeletons', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('fastcore')
  ctx.require('numpy')
  ctx.require('pandas')
  ctx.require('navis')

  const out = ctx.output('out')
  // The node's own decoder and the node's own constant. `NM_PER_UM` is the one number
  // `docs/python-pyodide.md` calls "the whole of the fix" for the nm/µm trap, and a literal
  // 1000 here would be a second, unpinned spelling of it in the half of the codebase where a
  // wrong scale produces a plausible neuron rather than an error.
  const p = skeletonCleanParamsFrom(ctx.params)
  const { heal, method } = p
  const healMaxDist = p.healMaxDist * NM_PER_UM
  const smooth = p.smooth * NM_PER_UM
  const spacing = p.spacing * NM_PER_UM
  const factor = p.factor

  const body: string[] = [
    `    nodes = _neuron.nodes.reset_index(drop=True)`,
    // Row numbers as node ids, which is what Coda's `parents` array already is — and what
    // makes every fastcore call below index straight back into `coords` and `radii`.
    `    ids = np.arange(len(nodes))`,
    `    lookup = pd.Series(ids, index=nodes['node_id'])`,
    `    parents = np.where(`,
    `        nodes['parent_id'] >= 0, lookup.reindex(nodes['parent_id']).to_numpy(), -1`,
    `    ).astype(np.int64)`,
    `    coords = nodes[['x', 'y', 'z']].to_numpy(dtype=float)`,
    `    radii = nodes['radius'].to_numpy(dtype=float)`,
  ]

  if (heal) {
    body.push(
      `    parents = fastcore.heal_skeleton(`,
      `        ids, parents, coords, method='ALL',`,
      `        max_dist=${healMaxDist > 0 ? healMaxDist : 'None'},`,
      `    )`,
    )
  }
  if (smooth > 0) {
    body.push(
      `    coords = fastcore.smooth_skeleton_gaussian(ids, parents, coords, ${smooth})`,
    )
  }
  if (method === 'resample' && spacing > 0) {
    body.push(
      `    ids, parents, coords, source, alpha, _ = fastcore.resample_skeleton(`,
      `        ids, parents, coords, ${spacing}`,
      `    )`,
      // fastcore's own prescription for carrying a per-node column across a resample.
      `    radii = radii[source[:, 0]] * (1 - alpha) + radii[source[:, 1]] * alpha`,
    )
  } else if (method === 'downsample' && factor > 1) {
    body.push(
      `    keep, parents, _, _ = fastcore.downsample_skeleton(ids, parents, ${factor})`,
      `    coords, radii, ids = coords[keep], radii[keep], keep`,
    )
  }

  return [
    ...ctx.note(CLEAN_UNITS_NOTE),
    // A loop rather than `NeuronList.apply`, because every call below takes bare arrays. The
    // neuron *count* never changes, which is what keeps the list joinable to its metadata.
    `_cleaned = []`,
    `for _neuron in navis.NeuronList(${src}):`,
    ...body,
    /*
     * `ids` and `parents` are already a matching pair of *node ids* at this point, whichever
     * branch ran — resampling mints fresh ones and downsampling keeps a subset of the
     * originals, and both return parents in the same numbering as the ids beside them. navis
     * takes arbitrary node ids, so nothing is re-based here. Coda's own `parents` array holds
     * row *positions* instead, which is why `skeletons.py` re-indexes and this does not.
     */
    `    _out = pd.DataFrame({`,
    `        'node_id': ids,`,
    `        'parent_id': parents,`,
    `        'x': coords[:, 0], 'y': coords[:, 1], 'z': coords[:, 2],`,
    `        'radius': radii,`,
    `    })`,
    `    _cleaned.append(navis.Skeleton(_out, id=_neuron.id, units=_neuron.units))`,
    `${out} = navis.NeuronList(_cleaned)`,
  ]
})

registerEmitter('neuron.cleanMeshes', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('fastcore')
  ctx.require('numpy')
  ctx.require('navis')

  const out = ctx.output('out')
  const p = meshCleanParamsFrom(ctx.params)
  const { dropInternals, fillHoles, ratio, smooth } = p

  const body: string[] = [`    v, f = _neuron.vertices.astype(float), _neuron.faces.astype(np.uint32)`]

  if (dropInternals) {
    body.push(
      `    v, f, _keep, _passes = fastcore.drop_internals(`,
      `        v, f,`,
      `        threshold=${p.openness},`,
      `        n_rays=${p.rays},`,
      `        iterations=${p.passes},`,
      `    )`,
    )
  }
  if (fillHoles) {
    body.push(
      `    _he = fastcore.boundary_halfedges(f)`,
      `    if len(_he):`,
      `        _rings, _offsets = fastcore.trace_loops(_he)`,
      `        _caps = fastcore.triangulate_rings(_rings, _offsets, v)`,
      // The caps re-use the boundary vertices and mint none, so this is a face append.
      `        if len(_caps):`,
      `            f = np.vstack([f, _caps]).astype(np.uint32)`,
    )
  }
  if (ratio < 1) {
    body.push(`    v, f, _vmap = fastcore.simplify_mesh(f, v, ratio=${ratio})`)
  }
  if (smooth > 0) {
    body.push(
      `    v = fastcore.smooth_mesh(`,
      `        f, v,`,
      `        method=${pyStr(p.method)},`,
      `        iterations=${smooth},`,
      `        weights='cotangent',`,
      // Without this an open mesh's rim rolls inwards under any of these filters, and a neuron
      // cut off at the edge of a dataset is open by construction.
      `        preserve_border=True,`,
      `        volume_correction=${p.volumeCorrection ? 'True' : 'False'},`,
      `    )`,
    )
  }

  return [
    ...(dropInternals
      ? ctx.note(
          'Faces must be wound outward for Drop internal membrane: rays are fired into the ' +
            'hemisphere each normal points into, so an inward-wound mesh reads as entirely ' +
            'buried and comes back empty, and an inconsistently wound one loses healthy ' +
            'membrane without saying so.',
        )
      : []),
    `_cleaned = []`,
    `for _neuron in navis.NeuronList(${src}):`,
    ...body,
    `    _cleaned.append(navis.Mesh((v, f), id=_neuron.id, units=_neuron.units))`,
    `${out} = navis.NeuronList(_cleaned)`,
  ]
})

// ---------------------------------------------------------------------------
// Partner Vectors and Similarity Matrix
// ---------------------------------------------------------------------------

/**
 * Both cells are a call into a generated helper rather than inline pandas, which is the choice
 * `coda_join` and `coda_combine` already made and for the same reason: the rules that matter
 * here are the ones a reader would get subtly wrong — an unconditional direction prefix, an
 * untyped partner standing in for itself, a sparse matrix that is never densified — and a
 * dozen lines of chained pandas in every notebook is a dozen chances for one of them to be
 * transcribed differently.
 *
 * Params hidden by `visibleIf` are left out of the call rather than passed with their stored
 * value. They are excluded from the provenance key (invariant 4), so `evaluate` cannot have
 * read them, and a cell that names one would be putting an argument in the notebook that the
 * run it mirrors never used.
 */
registerEmitter('neuron.partnerVectors', (ctx) => {
  const src = ctx.wired('in')
  const weight = ctx.column('weight')
  if (!weight) return ctx.todo('This Partner Vectors node has no weight column picked.')

  ctx.helper('coda_partner_vectors')
  const neurons = ctx.input('neurons')
  const labels = ctx.input('labels')
  const partnerBy = String(ctx.params.partnerBy ?? 'type')

  /*
   * A wired mapping supersedes both grouping params, so they are left out of the call rather
   * than emitted beside it — a cell reading `partner_by='type', labels=…` invites the reading
   * that the two combine, which is the one thing they do not do.
   */
  const grouping = labels
    ? [
        `    labels=${labels},`,
        `    label_id=${pyStr(ctx.column('labelId') ?? ID_COLUMN_NAME)},`,
        `    label_name=${pyStr(ctx.column('labelName') ?? 'label')},`,
      ]
    : [
        `    partner_by=${pyStr(partnerBy)},`,
        ...(partnerBy === 'type'
          ? [`    untyped=${pyStr(String(ctx.params.untyped ?? 'id'))},`]
          : []),
      ]

  return [
    `${ctx.output('out')} = coda_partner_vectors(`,
    `    ${src},`,
    ...(neurons ? [`    neurons=${neurons},`] : []),
    ...grouping,
    `    weight=${pyStr(weight)},`,
    `    weighting=${pyStr(String(ctx.params.weighting ?? 'raw'))},`,
    `)`,
  ]
})

registerEmitter('core.similarity', (ctx) => {
  const src = ctx.wired('in')
  const metric = String(ctx.params.metric ?? 'cosine') as SimilarityMetric
  // Through `effectiveOutput`, not `params.output`: a metric with no similarity form hides that
  // param, so reading it raw would emit `output='similarity'` for a node whose run could only
  // produce distances.
  const output = effectiveOutput(
    metric,
    String(ctx.params.output ?? 'similarity') as SimilarityOutput,
  )
  const out = ctx.output('matrix')
  const tail = [`    metric=${pyStr(metric)},`, `    output=${pyStr(output)},`, `)`]
  // Through the same predicate the node's `visibleIf` uses, rather than this emitter's own
  // literal — the pair were testing `layout === 'wide'` in three places with three spellings.
  const long = isLongLayout(ctx.params)

  const idColumn = long ? undefined : ctx.column('idColumn')
  const picked = long ? [] : ctx.columns('wideFeatures')
  const observations = long ? ctx.column('observations') : undefined
  const features = long ? ctx.column('features') : undefined
  // Guards before `ctx.helper`, matching Partner Vectors above: a misconfigured node that emits
  // a TODO should not still pull two hundred lines of helper into the document.
  if (!long && (!idColumn || picked.length === 0)) {
    return ctx.todo('This Similarity Matrix needs an Id column and at least one feature column.')
  }
  if (long && (!observations || !features)) {
    return ctx.todo('This Similarity Matrix needs an Observations and a Features column.')
  }
  ctx.helper('coda_similarity')

  if (!long) {
    return [
      `${out} = coda_similarity_wide(`,
      `    ${src},`,
      `    id_column=${pyStr(idColumn!)},`,
      `    columns=${pyList(picked)},`,
      ...tail,
    ]
  }
  const value = ctx.column('value')
  return [
    `${out} = coda_similarity_long(`,
    `    ${src},`,
    `    observations=${pyStr(observations!)},`,
    `    features=${pyStr(features!)},`,
    ...(value ? [`    value=${pyStr(value)},`] : []),
    ...tail,
  ]
})

// ---------------------------------------------------------------------------
// Compare Connectivity
// ---------------------------------------------------------------------------

/**
 * Type-level edge comparison across datasets.
 *
 * The rules all live in `coda_compare_connectivity`, which is the same call this file's Relabel
 * emitter makes one operation over and for the same reason: four of them are silent-wrong-answer
 * rules, and inlining them per node would put four copies of each into a notebook with two
 * comparisons in it.
 *
 * The dataset *names* come from `resolveDatasetNames`, the node's own function, rather than
 * being re-read off the params here. They are the output's column names and they are
 * deduplicated (invariant 3): two datasets typed "A" become `weight_A` and `weight_A_2`, and an
 * emitter that re-derived that rule would name a column the canvas does not have.
 *
 * Blocked in practice today — the Labels sockets are normally fed by `compare.matchTypes`, which
 * has no emitter, and `emit.ts` reports a node wired to an unemitted one as blocked before it
 * reaches here. It is written anyway because the port takes any table: a hand-built mapping from
 * `Upload Table` reaches this path now, and the bundled-CSV idea in `docs/export.md` would open
 * the common one.
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
      `'name': ${pyStr(spec.names[i]!)}`,
      `'edges': ${ctx.wired(portIdAt('edges', index))}`,
      `'labels': ${ctx.wired(portIdAt('labels', index))}`,
      `'pre': ${pyStr(columns.pre)}`,
      `'post': ${pyStr(columns.post)}`,
      // Absent rather than empty: the helper reads a missing key as "count each row as one",
      // which is what an unweighted edge list means.
      ...(columns.weight ? [`'weight': ${pyStr(columns.weight)}`] : []),
      `'id_column': ${pyStr(spec.idColumn)}`,
      `'label_column': ${pyStr(spec.labelColumn)}`,
    ]
    specs.push(`    {${entry.join(', ')}},`)
  }

  ctx.require('pandas')
  ctx.helper('coda_compare_connectivity')
  return [
    `${ctx.output('comparison')}, ${ctx.output('counts')} = coda_compare_connectivity([`,
    ...specs,
    `], min_weight=${spec.minWeight})`,
  ]
})
