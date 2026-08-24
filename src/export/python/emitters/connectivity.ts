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

import { pyStr } from '../py'
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
  if (!neurons) return ctx.todo('No Neurons are wired to this Connectivity Graph node.')

  const out = ctx.output('connections')
  const direction = String(ctx.params.direction ?? 'outputs')
  const hops = Math.max(1, Number(ctx.params.hops ?? 1))
  const minWeight = Math.max(1, Number(ctx.params.minWeight ?? 1))
  const ids = neuronIds(neurons)

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
   */
  const call = (sources: string, targets: string): string[] => [
    `fetch_adjacencies(`,
    `    ${sources},`,
    `    ${targets},`,
    `    min_total_weight=${minWeight},`,
    `    omit_rois=True,`,
    `    client=${c},`,
    `)`,
  ]

  const criteria = `NeuronCriteria(bodyId=${ids}, client=${c})`

  if (direction === 'both') {
    ctx.require('pandas')
    return [
      `_down_neurons, _down = ${call(criteria, 'None').join('\n')}`,
      `_up_neurons, _up = ${call('None', criteria).join('\n')}`,
      `_down = merge_neuron_properties(_down_neurons, _down, ['type']).assign(direction='downstream')`,
      `_up = merge_neuron_properties(_up_neurons, _up, ['type']).assign(direction='upstream')`,
      ``,
      // An edge inside the seed set comes back from each end, and Build Network sums the
      // weight of every row joining a pair — so a duplicate row is a doubled synapse count in
      // the picture rather than a cosmetic repeat.
      `${out} = (`,
      `    pd.concat([_down, _up], ignore_index=True)`,
      `    .drop_duplicates(subset=['bodyId_pre', 'bodyId_post'])`,
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
    `_neurons, _conn = ${call(sources, targets).join('\n')}`,
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
    '    """Coda\'s Connectivity Graph node: a breadth-first walk returning an edge list.',
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
