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

import { pyList, pyStr, pyValue } from '../py'
import {
  readEdgeProperties,
  readTraversalDirection,
  regionOptions,
} from '../../../nodes/lib/connectivityOps'
import {
  CYPHER_PLACEHOLDERS,
  connectivityExportPlan,
  unexpressedPopulation,
} from '../../plans/connectivity'
import { CUSTOM_SOURCE_ID } from '../../../data/custom/layout'
import { registerEmitter, registerHelper } from '../registry'
import {
  codaIds,
  codaNeurons,
  cypherIdList,
  isCustomDataset,
  neuronIdInts,
  neuronIds,
} from './common'
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
 * `fetch_adjacencies` returns `type` and `instance` for the partner and nothing else. Which
 * population that leaves out is `unexpressedPopulation`'s.
 */
function populationNote(ctx: EmitContext): string[] {
  const population = unexpressedPopulation(ctx)
  if (population.length === 0) return []
  return ctx.note(
    'Partners here are limited to bodies that neuPrint labels :Neuron, which is what ' +
      'fetch_adjacencies does when the partner is left open. The Dataset node also restricts ' +
      'the population (' +
      population.join(', ') +
      '), which NeuronCriteria cannot express for a partner, so this cell can return a few ' +
      'more partners than Coda did.',
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
  const endpoints = ['', `_endpoints = coda_endpoint_neurons(${edges}, ${seeds})`]
  if (isCustomDataset(ctx)) {
    // The neuron table's rows for them: a partner it does not hold has none, as on the canvas.
    return [
      ...endpoints,
      `${out} = _endpoints[['neuronId']].merge(${client}.labels, on='neuronId')`,
    ]
  }
  ctx.require('neuprint', 'NeuronCriteria', 'fetch_neurons')
  return [
    ...endpoints,
    `${out}, _ = fetch_neurons(`,
    `    NeuronCriteria(bodyId=${neuronIdInts('_endpoints')}, client=${client}),`,
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

/**
 * One hop through the canvas's own Cypher, for a node asking for edge properties.
 *
 * `fetch_adjacencies` returns `weight` and a per-ROI breakdown and nothing else about a
 * connection — its RETURN is fixed — so a property like fish2's `weightAxonDendrite` has no
 * library route at all. `connectivityExportPlan` decides the legs, their query text and the
 * columns, shared with the R emitter; this only spells them in Python.
 *
 * A raw string, because `escapeString` writes `\'` into a region name like `a'L(R)` and a plain
 * triple-quoted string would eat the backslash.
 */
function cypherConnectivity(
  ctx: EmitContext,
  out: string,
  neurons: string,
  client: string,
  properties: readonly string[],
): string[] {
  ctx.require('pandas')
  ctx.require('neuprint', 'fetch_custom')
  const plan = connectivityExportPlan(ctx.params, properties)

  const lines = [...populationNote(ctx), `_ids = ${cypherIdList(neurons)}`]
  let fill = `.replace(${pyStr(CYPHER_PLACEHOLDERS.ids)}, _ids)`
  if (plan.primaryRois) {
    ctx.require('neuprint', 'fetch_primary_rois')
    // `str` of a list of names is a Cypher list literal: a name holding `'` comes out quoted `"`.
    lines.push(`_rois = str(list(fetch_primary_rois(client=${client})))`)
    fill += `.replace(${pyStr(CYPHER_PLACEHOLDERS.rois)}, _rois)`
  }
  const frames = plan.legs.map((leg) => (leg.label === 'downstream' ? '_down' : '_up'))
  plan.legs.forEach((leg, i) => {
    const frame = frames[i]!
    lines.push(
      `${frame} = fetch_custom(`,
      `    r"""`,
      ...leg.query.split('\n').map((l) => `    ${l}`),
      `    """${fill},`,
      `    client=${client},`,
      `)`,
      `${frame}.columns = ${pyList(plan.fetched)}`,
      `${frame} = ${frame}.rename(columns={${Object.entries(leg.renames)
        .map(([from, to]) => `${pyStr(from)}: ${pyStr(to)}`)
        .join(', ')}})`,
      `${frame} = ${frame}[${pyList(plan.ordered)}].assign(hop=1, direction=${pyStr(leg.label)})`,
    )
  })

  lines.push(
    '',
    frames.length > 1
      ? `${out} = pd.concat([${frames.join(', ')}], ignore_index=True).drop_duplicates(subset=${pyList(plan.dedupe)})`
      : `${out} = ${frames[0]}`,
    codaIds(ctx, out, 'preId', 'postId'),
    ...endpointLines(ctx, out, neuronIds(neurons), client),
  )
  return lines
}

/**
 * The same node over a Custom Dataset's edge list: `CodaCustomDataset.connectivity`, the canvas'
 * walk (`coda_walk`, shared with `coda_traverse_connectivity`), and `Include fragments` meaning what it
 * means there — a partner outside the Neurons table. A Custom Dataset has no regions and no edge
 * properties, so those controls are not on its card; `Normalize` is, and is refused here, its
 * denominators being totals over the whole edge list that this helper does not compute.
 */
function customConnectivity(
  ctx: EmitContext,
  c: string,
  ids: string,
  direction: string,
  hops: number,
  minWeight: number,
): string[] {
  if (ctx.params.normalize === true) {
    return ctx.todo(
      '`Normalize` divides by each neuron’s synapse total over the whole edge list, which ' +
        'this notebook does not compute. Sum weight per postId (or preId) over the edge list ' +
        'and divide by it, or untick `Normalize`.',
    )
  }
  const out = ctx.output('connections')
  return [
    `${out} = ${c}.connectivity(`,
    `    ${ids},`,
    `    direction=${pyStr(direction)},`,
    `    hops=${hops},`,
    `    min_weight=${minWeight},`,
    `    include_fragments=${pyValue(ctx.params.includeFragments === true)},`,
    `)`,
    ...endpointLines(ctx, out, ids, c),
  ]
}

registerEmitter(
  'neuron.connectivity',
  (ctx) => {
    const c = ctx.wired('dataset')
    const neurons = ctx.wired('neurons')

    const out = ctx.output('connections')
    const direction = readTraversalDirection(ctx.params.direction)
    const hops = Math.max(1, Number(ctx.params.hops))
    const minWeight = Math.max(1, Number(ctx.params.minWeight))
    const ids = neuronIds(neurons)

    if (isCustomDataset(ctx)) return customConnectivity(ctx, c, ids, direction, hops, minWeight)

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
        '`Normalize` cannot be exported: neuprint-python has no equivalent of the "reconstructed partners only" denominator. For the "all synapses" denominator, divide weight by the upstream/downstream columns of fetch_neurons to get weightNorm.',
      )
    }
    if (hops > 1 && usesRois) {
      // The traversal goes through a generated helper written against one row per pair. Splitting
      // inside it is a different dedupe key and a different frontier, and a helper that got that
      // subtly wrong would be worse than a cell saying so.
      return ctx.todo(
        'The region options can only be exported for one hop, because the multi-hop traversal helper returns one row per neuron pair. Set `Hops` to 1, or clear `Regions` and untick `Split by region`.',
      )
    }

    /*
     * Edge properties go through the canvas's own query — see `cypherConnectivity`. One hop only:
     * the multi-hop helper walks through `fetch_adjacencies`, which returns weight and nothing
     * else, and the region options are refused past one hop above for the same reason.
     */
    const properties = readEdgeProperties(ctx.params.edgeProperties)
    if (properties.length > 0) {
      if (hops > 1) {
        return ctx.todo(
          `\`Edge properties\` (${properties.join(', ')}) can only be exported for one hop, because the multi-hop traversal helper uses fetch_adjacencies, which returns only each connection's weight. Set \`Hops\` to 1, or clear \`Edge properties\`.`,
        )
      }
      return cypherConnectivity(ctx, out, neurons, c, properties)
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

    const criteria = `NeuronCriteria(bodyId=${neuronIdInts(neurons)}, client=${c})`

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
          `# NOTE: fetch_adjacencies applies min_total_weight to the total across every ROI, while`,
          `# Coda's \`Min weight\` applies to the total inside the regions you named. Connections`,
          `# close to ${minWeight} can therefore differ between this cell and Coda.`,
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
        // `preId`/`postId` are Coda columns, and a Coda id column is text — `bodyId_pre` arrives
        // from neuprint-python as `int64`, so the rename has to retype as well as rename.
        codaIds(ctx, out, 'preId', 'postId'),
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
      codaIds(ctx, out, 'preId', 'postId'),
      ...endpointLines(ctx, out, ids, c),
    ]
  },
  { backends: ['neuprint', CUSTOM_SOURCE_ID] },
)

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
  /*
   * It concatenates the seed ids with both ends of the edge list and then deduplicates. If the
   * two arrive under different types — text seeds against an `int64` `preId`, which is exactly
   * what `fetch_adjacencies` hands back — `pd.concat` gives an object column holding `10001`
   * and `'10001'`, and `drop_duplicates` reads them as two neurons. So both are cast, here,
   * rather than trusted to have been cast by whoever called it.
   */
  needs: ['coda_ids'],
  source: [
    'def coda_endpoint_neurons(connections, seed_ids=None):',
    '    """List the neurons in an edge list: the seeds, then every partner, one row each.',
    '',
    "    This is the Neuron Set output of Coda's Connectivity node. Seeds are always included,",
    '    even those left without edges after min_weight.',
    '    """',
    '    frames = []',
    '    if seed_ids is not None:',
    '        frames.append(',
    "            coda_ids(pd.DataFrame({'neuronId': list(seed_ids), 'type': None}), 'neuronId')",
    '        )',
    "    connections = coda_ids(connections.copy(), 'preId', 'postId')",
    "    for id_col, type_col in (('preId', 'preType'), ('postId', 'postType')):",
    '        frames.append(',
    '            connections[[id_col, type_col]].rename(',
    "                columns={id_col: 'neuronId', type_col: 'type'}",
    '            )',
    '        )',
    '',
    '    rows = pd.concat(frames, ignore_index=True)',
    "    rows['type'] = rows['type'].replace('', None)",
    '    # Order by first appearance, but take the first non-empty type, which may come from',
    '    # a later row (e.g. an untyped seed typed by an edge).',
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
 * The walk itself, whatever answers a hop — a direct transcription of `nodes/lib/connectivityOps.ts`.
 *
 * One helper for both backends: `coda_traverse_connectivity` hands it a `fetch_adjacencies` call and
 * `CodaCustomDataset.connectivity` a filter of its edge list, which is the only thing that differs
 * between them. The three rules that are easy to lose are called out in the docstring because each
 * produces a plausible wrong answer rather than an error: neurons are expanded at most once
 * (connectomes are full of recurrent loops, so re-expanding never terminates), an edge keeps the hop
 * and direction it was *first* given, and `both` expands both ways at every hop rather than running
 * two separate cones. Two copies of those rules had already begun to drift before they were one.
 */
registerHelper({
  name: 'coda_walk',
  requires: [['pandas']],
  source: [
    'def coda_walk(seed_ids, direction, hops, one_hop):',
    '    """Walk the connectome breadth-first from the seeds, as Coda\'s Connectivity node.',
    '',
    "    `one_hop(ids, way)` returns the edges leaving `ids` in direction `way` ('downstream' or",
    "    'upstream') with columns preId, preType, postId, postType and weight (ids as text).",
    '    The result has the same columns plus `hop` and `direction`, each row oriented from',
    '    presynaptic to postsynaptic.',
    '',
    '    Notes:',
    '',
    '    * Each neuron is expanded at most once, so recurrent loops do not repeat. Edges back',
    '      into visited neurons are still reported.',
    '    * An edge found again at a later hop keeps the hop and direction it was first found at.',
    '    * direction="both" expands both ways at every hop, so it also finds neurons that share',
    '      inputs with a seed.',
    '    """',
    "    columns = ['preId', 'preType', 'postId', 'postType', 'weight']",
    "    ways = {'both': ['downstream', 'upstream'], 'inputs': ['upstream']}.get(direction, ['downstream'])",
    '    frontier, expanded, seen = {str(i) for i in seed_ids}, set(), {}',
    '    for hop in range(1, int(hops) + 1):',
    '        todo = frontier - expanded',
    '        if not todo:',
    '            break',
    '        expanded |= todo',
    '        reached = set()',
    '        for way in ways:',
    '            for row in one_hop(todo, way).reindex(columns=columns).itertuples(index=False):',
    '                key = (row.preId, row.postId)',
    '                if key in seen:',
    '                    # Found from both ends at the same hop: label it "both".',
    '                    if seen[key][0] == hop and seen[key][1] != way:',
    "                        seen[key][1] = 'both'",
    '                    continue',
    '                seen[key] = [hop, way, row]',
    "                reached.add(row.postId if way == 'downstream' else row.preId)",
    '        frontier = reached - expanded',
    '    return pd.DataFrame([(*row, hop, way) for hop, way, row in seen.values()],',
    "                        columns=columns + ['hop', 'direction'])",
  ],
})

/** The multi-hop traversal against neuPrint: `coda_walk`, one hop a `fetch_adjacencies` call. */
registerHelper({
  name: 'coda_traverse_connectivity',
  requires: [
    ['pandas'],
    ['neuprint', 'NeuronCriteria', 'fetch_adjacencies', 'merge_neuron_properties'],
  ],
  needs: ['coda_ids', 'coda_walk'],
  source: [
    'def coda_traverse_connectivity(seed_ids, direction, hops, min_weight, all_segments, client):',
    '    """Run Coda\'s Connectivity node against neuPrint, one fetch_adjacencies call per hop.',
    '',
    '    With all_segments=False only partners labelled :Neuron are kept (and expanded at the',
    '    next hop). With all_segments=True every body counts, fragments included.',
    '    """',
    '    far = NeuronCriteria(label="Segment", client=client) if all_segments else None',
    '',
    '    def one_hop(ids, way):',
    '        criteria = NeuronCriteria(bodyId=[int(i) for i in ids], client=client)',
    '        sources, targets = (criteria, far) if way == "downstream" else (far, criteria)',
    '        neurons, conn = fetch_adjacencies(',
    '            sources, targets, min_total_weight=min_weight, omit_rois=True, client=client,',
    '        )',
    '        if not conn.empty:',
    '            conn = merge_neuron_properties(neurons, conn, ["type"])',
    '        conn = conn.rename(columns={',
    '            "bodyId_pre": "preId",',
    '            "type_pre": "preType",',
    '            "bodyId_post": "postId",',
    '            "type_post": "postType",',
    '        })',
    '        return coda_ids(conn, "preId", "postId")',
    '',
    '    return coda_walk(seed_ids, direction, hops, one_hop)',
  ],
})
