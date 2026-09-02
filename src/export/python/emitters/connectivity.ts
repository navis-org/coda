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
import { codaNeurons, neuronIds } from './common'
import { populationFromType } from '../../../nodes/lib/populationParams'
import type { EmitContext } from '../types'

/**
 * The far end of the connection, as a `NeuronCriteria`.
 *
 * **`None` is not "no restriction", and that is the finding.** `@neuroncriteria_args` turns a
 * `None` into `NeuronCriteria()`, whose `label` is `'Neuron'` when no `bodyId` is given, and
 * `fetch_adjacencies` interpolates it straight into `MATCH (n:{sources.label})-[e:ConnectsTo]->
 * (m:{targets.label})` — read off the installed neuprint-python 0.6.3 rather than assumed. So
 * this cell has always restricted the far end to published neurons, where the node until now
 * matched a bare node: on `male-cns:v1.0`, 496 partners against 4,252 for five LC4 seeds. The
 * `Include fragments` control is what makes the two agree, and `label='Segment'` is what the
 * ticked box needs — exactly the bare match, measured: `(m)` and `(m:Segment)` both answer 4,252 partners and
 * 11,898 synapses, because every `:Neuron` in neuPrint is also a `:Segment`.
 */
function farEnd(ctx: EmitContext, client: string): string {
  return ctx.params.includeFragments === true
    ? `NeuronCriteria(label='Segment', client=${client})`
    : 'None'
}

/**
 * What the notebook's restriction does *not* carry, when there is anything.
 *
 * `NeuronCriteria` takes values, so `traced` is expressible as `status='Traced'` and the other two
 * — a type column that is set, a superclass that is set — are not; the find emitters meet the same
 * wall and answer it with a mask on the result, which is not available here because
 * `fetch_adjacencies` returns `type` and `instance` for the partner and nothing else. Small and
 * said rather than large and silent: on male-CNS the label alone keeps 496 partners and the
 * label plus superclass keeps 492.
 */
function populationNote(ctx: EmitContext): string[] {
  if (ctx.params.includeFragments === true) return []
  const population = populationFromType(ctx.inputType('dataset'))
  if (population.length === 0) return []
  return ctx.note(
    'Partners here are restricted to bodies neuPrint labels :Neuron, which is what ' +
      'fetch_adjacencies does with an unconstrained far end. The Dataset node narrows the ' +
      'population further (' +
      population.join(', ') +
      '), and NeuronCriteria cannot express that on a partner — so this cell can return a few ' +
      'more partners than the canvas did.',
  )
}

/**
 * The `Neuron Set` port, appended to whichever branch produced the edge list.
 *
 * Emitted **unconditionally**, the way `neuron.adjacency` emits both of its outputs: an emitter
 * cannot see which of its ports the graph downstream actually reads, so a port left unassigned
 * is a `NameError` in somebody's notebook rather than a cell that is merely longer than it
 * needed to be.
 *
 * `full` is a second query, exactly as it is on the canvas — and it is `fetch_neurons` rather
 * than a `merge_neuron_properties` off the frames already in hand, because those carry `type`
 * and nothing else. The point of the control is the columns an edge list has no room for.
 */
function endpointLines(
  ctx: EmitContext,
  edges: string,
  seeds: string,
  client: string,
): string[] {
  ctx.require('pandas')
  ctx.helper('coda_endpoint_neurons')
  const out = ctx.output('neuronSet')
  if (ctx.params.neuronRows !== 'full') {
    return ['', `${out} = coda_endpoint_neurons(${edges}, ${seeds})`]
  }
  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  return [
    '',
    `_endpoints = coda_endpoint_neurons(${edges}, ${seeds})`,
    `${out}, _ = fetch_neurons(`,
    `    NeuronCriteria(bodyId=${neuronIds('_endpoints')}, client=${client}),`,
    `    client=${client},`,
    `)`,
    codaNeurons(ctx, out),
    /*
     * The same hole the node warns about, in the one place a notebook can carry it. A partner
     * can be a `Segment` below the dataset's neuron threshold — a real row in the edge list with
     * no row at all in the neuron table — so this frame is legitimately shorter than the
     * endpoint list it was built from.
     */
    `# NOTE: fetch_neurons has no row for a partner below the dataset's neuron threshold, so`,
    `# this frame can be shorter than _endpoints. The edge list still counts those synapses.`,
  ]
}

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
      ...populationNote(ctx),
      `${out} = coda_traverse_connectivity(`,
      `    ${ids},`,
      `    direction=${pyStr(direction)},`,
      `    hops=${hops},`,
      `    min_weight=${minWeight},`,
      `    all_segments=${ctx.params.includeFragments === true ? 'True' : 'False'},`,
      `    client=${c},`,
      `)`,
      ...endpointLines(ctx, out, ids, c),
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
  const far = farEnd(ctx, c)

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
      ...populationNote(ctx),
      `_down_neurons, _down = ${call(criteria, far).join('\n')}`,
      `_up_neurons, _up = ${call(far, criteria).join('\n')}`,
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
      ...endpointLines(ctx, out, ids, c),
    ]
  }

  const [sources, targets] = direction === 'inputs' ? [far, criteria] : [criteria, far]
  const label = direction === 'inputs' ? 'upstream' : 'downstream'

  return [
    ...note,
    ...populationNote(ctx),
    `_neurons, _conn = ${call(sources, targets).join('\n')}`,
    ...(regroupNeeded ? regroup('_conn') : []),
    `${out} = (`,
    `    merge_neuron_properties(_neurons, _conn, ['type'])`,
    `    .rename(columns={`,
    ...renameLines('        '),
    `    })`,
    `    .assign(hop=1, direction=${pyStr(label)})`,
    `)`,
    ...endpointLines(ctx, out, ids, c),
  ]
})

/**
 * The `Neuron Set` port's derivation, transcribed from `endpointNeurons` in
 * `nodes/lib/connectivityOps.ts`.
 *
 * Two rules in it are easy to drop and both produce a plausible wrong answer: the **seeds are
 * in the result** whether or not any edge survived `min_weight` — both ends of an edge list only
 * cover the seeds that turned out to be wired — and the row that decides a neuron's *order* is
 * not the row that decides its *type*, since a neuron can arrive as an untyped seed and be typed
 * by an edge several rows later.
 */
registerHelper({
  name: 'coda_endpoint_neurons',
  requires: [['pandas']],
  source: [
    'def coda_endpoint_neurons(connections, seed_ids=None):',
    '    """The neurons an edge list is about: the seeds, then every partner, one row each.',
    '',
    "    Coda's Connectivity node emits this beside the edge list so a partner set can go",
    '    straight back into an adjacency query without being reassembled from two columns.',
    '',
    '    The seeds are included whether or not any edge survived min_weight. Both ends of the',
    '    edge list only cover the seeds that turned out to be wired to something, and a seed',
    '    dropping out of the set in silence is what this exists to avoid.',
    '    """',
    '    frames = []',
    '    if seed_ids is not None:',
    "        frames.append(pd.DataFrame({'neuronId': list(seed_ids), 'type': None}))",
    "    for id_col, type_col in (('preId', 'preType'), ('postId', 'postType')):",
    '        frames.append(',
    '            connections[[id_col, type_col]].rename(',
    "                columns={id_col: 'neuronId', type_col: 'type'}",
    '            )',
    '        )',
    '',
    '    rows = pd.concat(frames, ignore_index=True)',
    "    rows['type'] = rows['type'].replace('', None)",
    '    # First appearance decides the order; the first non-empty type wins, which need not be',
    '    # the same row -- a neuron can arrive as an untyped seed and be typed by an edge later.',
    '    typed = (',
    "        rows.dropna(subset=['type'])",
    "        .drop_duplicates(subset='neuronId')",
    "        .set_index('neuronId')['type']",
    '    )',
    "    out = rows.drop_duplicates(subset='neuronId').reset_index(drop=True)",
    "    out['type'] = out['neuronId'].map(typed)",
    '    return out',
  ],
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
    'def coda_traverse_connectivity(seed_ids, direction, hops, min_weight, all_segments, client):',
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
    '',
    '    all_segments=False keeps only partners neuPrint labels :Neuron, which is what an',
    "    unconstrained NeuronCriteria already means and what bounds the next hop's frontier.",
    '    True matches :Segment instead -- every body, fragments included.',
    '    """',
    '    far = NeuronCriteria(label="Segment", client=client) if all_segments else None',
    '',
    '    def one_hop(ids, way):',
    '        criteria = NeuronCriteria(bodyId=list(ids), client=client)',
    '        if way == "downstream":',
    '            neurons, conn = fetch_adjacencies(',
    '                criteria, far, min_total_weight=min_weight,',
    '                omit_rois=True, client=client,',
    '            )',
    '        else:',
    '            neurons, conn = fetch_adjacencies(',
    '                far, criteria, min_total_weight=min_weight,',
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
