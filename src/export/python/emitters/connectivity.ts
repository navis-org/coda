/**
 * Connectivity, and the reorientation that makes it an edge list.
 *
 * The one-hop case is written inline because it is the overwhelming majority and reads as
 * ordinary neuprint-python; past that it goes through a generated helper, because a BFS with
 * Coda's dedupe rules is not something to fold into a cell.
 *
 * What both paths have to preserve is the *shape*: `preId → postId`, always oriented the way
 * the synapse points, with `hop` and `direction` saying how the traversal got there. Every
 * downstream node addresses those names, so a translation that handed back neuprint's own
 * `bodyId_pre`/`bodyId_post` would break every column picker in the rest of the notebook.
 */

import { pyList, pyStr } from '../py'
import { regionOptions } from '../../../nodes/lib/connectivityOps'
import { registerEmitter, registerHelper } from '../registry'
import { neuronIds } from './common'

/**
 * neuprint's adjacency columns → Coda's edge-list names. Both paths share it.
 *
 * Indented by the caller rather than fixed, because these lines land inside a dict inside a
 * chained call: a constant indent is right in one of those places and wrong in the other, and
 * generated code that reads as carelessly formatted is generated code nobody trusts.
 */
function renameLines(indent: string): string[] {
  return [
    `${indent}'bodyId_pre': 'preId',`,
    `${indent}'type_pre': 'preType',`,
    `${indent}'bodyId_post': 'postId',`,
    `${indent}'type_post': 'postType',`,
  ]
}

registerEmitter('neuron.connectivity', (ctx) => {
  const c = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this Connectivity node.')

  const out = ctx.output('connections')
  const direction = String(ctx.params.direction ?? 'outputs')
  const hops = Math.max(1, Number(ctx.params.hops ?? 1))
  const minWeight = Math.max(1, Number(ctx.params.minWeight ?? 1))
  const ids = neuronIds(neurons)

  // The node's own decoder rather than a second reading of the same params — the route
  // `readUnpivotSpec` and `decodeRenames` already take. `primaryRoisOnly !== false` in
  // particular is a claim about what an *absent* key means on a stored document, and a copy of
  // it here is a copy nobody would edit alongside the node.
  const { rois, splitByRoi, primaryOnly, used: usesRois } = regionOptions(ctx.params)

  /*
   * Normalisation is refused rather than approximated, and the reason is the `connected` basis:
   * neuprint-python has no equivalent of it. `fetch_neurons` can supply the `all` denominators —
   * they are the `upstream`/`downstream` properties — but a denominator counting only synapses
   * onto partners neuPrint labels `:Neuron` needs its own aggregate query, and the two bases
   * differ by a factor of two and a half on male-CNS. Emitting the reachable half under a
   * control that names both would put a number in the notebook that is not the number on the
   * canvas, which is exactly the substitution the node itself refuses to make.
   */
  if (ctx.params.normalize === true) {
    return ctx.todo(
      'Normalize has no neuprint-python equivalent for the "reconstructed partners only" denominator, and emitting only the "all synapses" one would answer a different question from the canvas. The all-synapses denominators are the upstream/downstream columns of fetch_neurons; weightNorm is weight divided by those.',
    )
  }
  if (hops > 1 && usesRois) {
    // The traversal goes through a generated helper written against one row per pair. Splitting
    // inside it is a different dedupe key and a different frontier, and a helper that got that
    // subtly wrong would be worse than a cell saying so.
    return ctx.todo(
      'The region options are written against the one-hop fetch_adjacencies call; the multi-hop traversal helper works one row per pair. Set Hops to 1, or drop the region options.',
    )
  }

  ctx.require('neuprint', 'NeuronCriteria', 'fetch_adjacencies', 'merge_neuron_properties')

  if (hops > 1) {
    ctx.require('pandas')
    ctx.helper('coda_traverse_connectivity')
    return [
      `${out} = coda_traverse_connectivity(`,
      `    ${ids},`,
      `    direction=${pyStr(direction)},`,
      `    hops=${hops},`,
      `    min_weight=${minWeight},`,
      `    client=${c},`,
      `)`,
    ]
  }

  /*
   * `omit_rois=True` is load-bearing rather than a speed-up. Without it `fetch_adjacencies`
   * returns one row *per ROI per pair*, so a pair innervating four neuropils arrives as four
   * rows — and everything downstream that sums a weight double-counts. Coda's connectivity
   * fetch answers one row per pair, so this is what agrees with it.
   *
   * Which is also why the region options are the *same* argument turned off. `fetch_adjacencies`
   * already answers per-ROI, already restricts to the primary set by default, and already takes
   * an explicit `rois` list — so Coda's Split by region, Regions and Primary regions only map
   * onto three arguments of a call this cell was making anyway, rather than onto a helper.
   *
   * One difference is worth knowing and is written into the cell below: `min_total_weight` is
   * applied across **all** ROIs, where Coda applies Min weight to the restricted total. With a
   * `rois` list set the two can therefore disagree about a connection sitting either side of
   * the threshold.
   */
  /*
   * Built once: every one of these is fixed before `call` exists, and Python kwargs are
   * order-free, so there is nothing for the closure to decide per invocation.
   */
  const roiArgs: string[] = []
  if (rois.length) roiArgs.push(`    rois=${pyList(rois)},`)
  if (!usesRois) roiArgs.push(`    omit_rois=True,`)
  else if (!primaryOnly) roiArgs.push(`    include_nonprimary=True,`)

  const call = (sources: string, targets: string): string[] => [
    `fetch_adjacencies(`,
    `    ${sources},`,
    `    ${targets},`,
    `    min_total_weight=${minWeight},`,
    ...roiArgs,
    `    client=${c},`,
    `)`,
  ]

  /** Regions chosen, but the rows are wanted per pair — so the sum is ours. */
  const regroupNeeded = rois.length > 0 && !splitByRoi

  /**
   * Fold the per-ROI rows back to one row per pair, for Regions without Split by region.
   *
   * `fetch_adjacencies` has no mode that restricts to regions *and* totals across them, so the
   * restriction is its argument and the totalling is ours. Summing `weight` per pair is exactly
   * what Coda's unsplit region query does in Cypher, one `reduce` above the `UNWIND`.
   */
  const regroup = (frame: string): string[] => [
    `${frame} = (`,
    `    ${frame}`,
    `    .groupby(['bodyId_pre', 'bodyId_post'], as_index=False)['weight']`,
    `    .sum()`,
    `)`,
  ]

  const criteria = `NeuronCriteria(bodyId=${ids}, client=${c})`

  /*
   * The dedupe key, and the region is part of it exactly when a region is part of a row —
   * `traverseConnectivity`'s rule. Keyed on the pair alone over a split result, a `both`
   * traversal keeps whichever region of an internal edge arrived first and discards the rest of
   * the connection, which is a table that looks fine and is missing synapses.
   */
  const dedupe = splitByRoi
    ? `['bodyId_pre', 'bodyId_post', 'roi']`
    : `['bodyId_pre', 'bodyId_post']`

  const note = rois.length
    ? [
        `# NOTE: fetch_adjacencies applies min_total_weight across every ROI, where Coda's`,
        `# Min weight applies to the total *inside* the regions you named. A connection sitting`,
        `# either side of ${minWeight} can therefore differ between this cell and the canvas.`,
      ]
    : []

  if (direction === 'both') {
    ctx.require('pandas')
    return [
      ...note,
      `_down_neurons, _down = ${call(criteria, 'None').join('\n')}`,
      `_up_neurons, _up = ${call('None', criteria).join('\n')}`,
      ...(regroupNeeded ? [...regroup('_down'), ...regroup('_up')] : []),
      `_down = merge_neuron_properties(_down_neurons, _down, ['type']).assign(direction='downstream')`,
      `_up = merge_neuron_properties(_up_neurons, _up, ['type']).assign(direction='upstream')`,
      ``,
      // An edge inside the seed set comes back from each end, and Build Network sums the
      // weight of every row joining a pair — so a duplicate row is a doubled synapse count in
      // the picture rather than a cosmetic repeat.
      `${out} = (`,
      `    pd.concat([_down, _up], ignore_index=True)`,
      `    .drop_duplicates(subset=${dedupe})`,
      `    .rename(columns={`,
      ...renameLines('        '),
      `    })`,
      `    .assign(hop=1)`,
      `)`,
    ]
  }

  const [sources, targets] = direction === 'inputs' ? ['None', criteria] : [criteria, 'None']
  const label = direction === 'inputs' ? 'upstream' : 'downstream'

  return [
    ...note,
    `_neurons, _conn = ${call(sources, targets).join('\n')}`,
    ...(regroupNeeded ? regroup('_conn') : []),
    `${out} = (`,
    `    merge_neuron_properties(_neurons, _conn, ['type'])`,
    `    .rename(columns={`,
    ...renameLines('        '),
    `    })`,
    `    .assign(hop=1, direction=${pyStr(label)})`,
    `)`,
  ]
})

/**
 * The multi-hop traversal.
 *
 * A direct transcription of `nodes/lib/connectivityOps.ts`, and the three rules that are easy
 * to lose are called out in the docstring because each produces a plausible wrong answer
 * rather than an error: neurons are expanded at most once (connectomes are full of recurrent
 * loops, so re-expanding never terminates), an edge keeps the hop and direction it was *first*
 * given, and `both` expands both ways at every hop rather than running two separate cones.
 */
registerHelper({
  name: 'coda_traverse_connectivity',
  requires: [
    ['pandas'],
    ['neuprint', 'NeuronCriteria', 'fetch_adjacencies', 'merge_neuron_properties'],
  ],
  source: [
    'def coda_traverse_connectivity(seed_ids, direction, hops, min_weight, client):',
    '    """Coda\'s Connectivity node: a breadth-first walk returning an edge list.',
    '',
    '    Columns are preId/preType -> postId/postType, weight, hop, direction. Every row is',
    '    oriented the way the synapse points, whichever way the traversal travelled.',
    '',
    '    Three rules worth keeping, each of which silently changes the answer if dropped:',
    '',
    '    * A neuron is expanded at most once. Connectomes are full of recurrent loops, so a',
    '      walk that re-expands a visited neuron does not terminate. The edge back into an',
    '      already-visited neuron is still reported; only the expansion is skipped.',
    '    * An edge re-found at a later hop keeps the hop and direction it was first given,',
    '      so the label says something about the graph rather than about the walk order.',
    '    * direction="both" expands both ways at every hop -- the undirected ball, not two',
    '      cones. That is what finds the neurons sharing input with a seed.',
    '    """',
    '    def one_hop(ids, way):',
    '        criteria = NeuronCriteria(bodyId=list(ids), client=client)',
    '        if way == "downstream":',
    '            neurons, conn = fetch_adjacencies(',
    '                criteria, None, min_total_weight=min_weight,',
    '                omit_rois=True, client=client,',
    '            )',
    '        else:',
    '            neurons, conn = fetch_adjacencies(',
    '                None, criteria, min_total_weight=min_weight,',
    '                omit_rois=True, client=client,',
    '            )',
    '        if conn.empty:',
    '            return conn',
    '        return merge_neuron_properties(neurons, conn, ["type"]).assign(direction=way)',
    '',
    '    ways = ["downstream", "upstream"] if direction == "both" else (',
    '        ["upstream"] if direction == "inputs" else ["downstream"]',
    '    )',
    '',
    '    frontier = set(int(i) for i in seed_ids)',
    '    expanded = set()',
    '    rows = []',
    '    seen_edges = {}',
    '',
    '    for hop in range(1, int(hops) + 1):',
    '        if not frontier:',
    '            break',
    '        todo = frontier - expanded',
    '        if not todo:',
    '            break',
    '        expanded |= todo',
    '',
    '        found = [one_hop(todo, way) for way in ways]',
    '        found = [f for f in found if not f.empty]',
    '        if not found:',
    '            break',
    '        step = pd.concat(found, ignore_index=True)',
    '',
    '        next_frontier = set()',
    '        for row in step.itertuples(index=False):',
    '            key = (int(row.bodyId_pre), int(row.bodyId_post))',
    '            if key in seen_edges:',
    '                # Reached from the other end at this same hop: an edge internal to the',
    '                # frontier, which is the one case that earns the "both" label.',
    '                if seen_edges[key][0] == hop and seen_edges[key][1] != row.direction:',
    '                    seen_edges[key] = (hop, "both")',
    '                continue',
    '            seen_edges[key] = (hop, row.direction)',
    '            rows.append(row._asdict())',
    '            next_frontier.add(key[1] if row.direction == "downstream" else key[0])',
    '',
    '        frontier = next_frontier - expanded',
    '',
    '    if not rows:',
    '        return pd.DataFrame(',
    '            columns=["preId", "preType", "postId", "postType",',
    '                     "weight", "hop", "direction"]',
    '        )',
    '',
    '    out = pd.DataFrame(rows)',
    '    resolved = [seen_edges[(int(p), int(q))]',
    '                for p, q in zip(out["bodyId_pre"], out["bodyId_post"])]',
    '    out["hop"] = [r[0] for r in resolved]',
    '    out["direction"] = [r[1] for r in resolved]',
    '    return out.rename(columns={',
    '        "bodyId_pre": "preId",',
    '        "type_pre": "preType",',
    '        "bodyId_post": "postId",',
    '        "type_post": "postType",',
    '    })',
  ],
})
