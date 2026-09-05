/**
 * Influence, as one generated helper.
 *
 * A tier-3 node: there is no neuprint-python call that answers this, and there is no faithful
 * one-liner. `ConnectomeInfluenceCalculator` is deliberately **not** the route — it solves the
 * whole connectome at once and needs petsc4py and slepc4py, so it is both a fourth dependency
 * and the problem this node exists to avoid. What a notebook should reproduce is the bounded
 * walk, which is `fetch_adjacencies` per hop with a small propagation over it.
 *
 * The one thing the cell does not reproduce is *how* a run with `Candidates` wired reached its
 * answer. The node meets in the middle there; this walks the full depth from the Neurons end and
 * filters. That is a cost difference and not an approximation — the two are the same number, by
 * the identity `z' W^k s = z_b' W^a s`, which `influenceOps.test.ts` and the mock-source test
 * both pin. Written into the cell as a NOTE rather than left for a reader to wonder about.
 */

import { pyStr } from '../py'
import { registerEmitter, registerHelper } from '../registry'
import type { EmitContext } from '../types'
import { neuronIds } from './common'
import { influenceParamsFrom, needsPublishedTotals } from '../../../nodes/lib/influenceOps'
import { populationFromType } from '../../../nodes/lib/populationParams'

/**
 * What the emitted published-neuron filter cannot carry.
 *
 * The node asks `publishedNeurons`, which goes through `neuronSetRequest` and therefore applies
 * the Dataset card's population narrowing. The helper's `keep()` is a `NeuronCriteria` with a
 * label, which takes values and cannot express "this column is set" — the same wall
 * `emitters/connectivity.ts` meets and answers the same way, and `populationFromType` is the
 * shared half. Small and said, rather than large and silent: the notebook can carry a few more
 * neurons through a hop than the canvas did.
 */
function populationNote(ctx: EmitContext, includeFragments: boolean): string[] {
  if (includeFragments) return []
  const population = populationFromType(ctx.inputType('dataset'))
  if (population.length === 0) return []
  return ctx.note(
    'The signal is passed on only by bodies neuPrint labels :Neuron. The Dataset node narrows ' +
      'the population further (' +
      population.join(', ') +
      '), and NeuronCriteria cannot express that — so this cell can carry a few more neurons ' +
      'through each hop than the canvas did.',
  )
}

registerEmitter('neuron.influence', (ctx) => {
  const client = ctx.wired('dataset')
  const neurons = ctx.wired('neurons')
  if (!neurons) return ctx.todo('No Neurons are wired to this Influence node.')

  const out = ctx.output('influence')
  /*
   * `influenceParamsFrom`, not a second reading of the same eight params. `regionOptions`' rule
   * and its recorded incident: written per caller, a node and an emitter drift on a default and
   * the notebook silently exports a different run from the one the canvas made — which is the
   * one failure nothing on the canvas can catch.
   */
  const settings = influenceParamsFrom(ctx.params)

  /*
   * The one combination the node itself refuses, refused here too rather than emitted as
   * something that runs — and through the node's own predicate, so the two cannot come apart.
   * Travelling downstream, W's divisor belongs to the *receiving* neuron and an outputs query
   * never returns it, so a cell that quietly normalised by the sending neuron's output total
   * would run cleanly and answer a different question.
   */
  if (needsPublishedTotals(settings)) {
    return ctx.todo(
      'Downstream influence divides each connection by the receiving neuron’s total input, which an outputs query never returns. Set Denominator to one of the published-totals options, or use Upstream.',
    )
  }

  const candidates = ctx.input('candidates')

  ctx.require('pandas')
  ctx.require('numpy')
  ctx.require(
    'neuprint',
    'NeuronCriteria',
    'fetch_adjacencies',
    'fetch_neurons',
    'merge_neuron_properties',
  )
  ctx.helper('coda_influence')

  const seeds = neuronIds(neurons)
  const lines = [
    ...populationNote(ctx, settings.includeFragments),
    `${out} = coda_influence(`,
    `    ${seeds},`,
    `    direction=${pyStr(settings.direction)},`,
    `    hops=${settings.maxHops},`,
    `    min_weight=${settings.minWeight},`,
    `    gain=${settings.gain},`,
    `    denominator=${pyStr(settings.denominator)},`,
    `    all_segments=${settings.includeFragments ? 'True' : 'False'},`,
    `    frontier_limit=${settings.frontierLimit},`,
    `    seed_mass=${settings.shareSeedMass ? `1.0 / max(1, len(${seeds}))` : '1.0'},`,
    `    per_query=${settings.perQuery ? 'True' : 'False'},`,
    `    client=${client},`,
    `)`,
  ]

  if (!candidates) return lines
  return [
    ...lines,
    '',
    `${out} = ${out}[${out}['neuronId'].isin(${neuronIds(candidates)})].reset_index(drop=True)`,
    ...ctx.note(
      'With Candidates wired the node walks from both ends and meets in the middle, which ' +
        'fetches far fewer neurons. This cell walks the full depth from the Neurons end and ' +
        'filters instead. The scores are identical — the split is a cost optimisation, not ' +
        'a different calculation — so only the running time differs.',
    ),
  ]
})

registerHelper({
  name: 'coda_influence',
  requires: [
    ['pandas'],
    ['numpy'],
    [
      'neuprint',
      'NeuronCriteria',
      'fetch_adjacencies',
      'fetch_neurons',
      'merge_neuron_properties',
    ],
  ],
  source: [
    'def coda_influence(seed_ids, direction, hops, min_weight, gain, denominator,',
    '                   all_segments, frontier_limit, seed_mass, client,',
    '                   per_query=False):',
    '    """Coda\'s Influence node: the bounded influence score of Bates et al. (2026).',
    '',
    '    The exact score solves r = (I - gW)^-1 s over the whole connectome, where W[post, pre]',
    "    is a connection as a fraction of the postsynaptic neuron's total input. That inverse is",
    '    the series s + gWs + g^2 W^2 s + ..., so walking k hops and adding the terms computes',
    '    the same quantity truncated at k. Every term is non-negative, so the result is a strict',
    '    lower bound: more hops can only raise a score.',
    '',
    '    Three rules that silently change the answer if dropped:',
    '',
    '    * This is NOT a breadth-first search. W^k s requires every neuron holding mass at hop k',
    '      to spread it, whether or not it also spread at hop k-1 -- that is what puts recurrent',
    '      loops into the score. A neuron is FETCHED once and cached, then propagated from on',
    '      every later hop.',
    '    * The divisor always belongs to the postsynaptic end, whichever way the walk travels.',
    '    * A partner dropped by all_segments=False still counts in the divisor. Its share of the',
    '      drive is lost, not shared out among the partners that remain.',
    '',
    '    denominator:',
    '      "traversal" -- sum of the input list this walk fetched, i.e. edges at or above',
    '          min_weight. What ConnectomeInfluenceCalculator computes from an edge list.',
    '          Only available travelling "inputs".',
    '      "all"       -- the neuron\'s published total input (fetch_neurons\' `upstream`).',
    '      "connected" -- input from bodies labelled :Neuron only, summed with a second',
    '          fetch_adjacencies. No min_weight is applied to it.',
    '',
    '    per_query=False returns neuronId, type, influence, influenceLog, hops, isSeed --',
    '    ranked, strongest first. per_query=True keeps the seeds in separate channels and',
    '    returns one row per (queryId, neuronId) pair instead, before the scores are summed',
    '    across the seeds; grouping that by neuronId and summing gives the same frame back.',
    "    influenceLog is the reference implementation's log compression,",
    '    sign(x)*(log(max(|x|, e^-24)) + 24), which is what its own figures plot.',
    '    """',
    '    far = NeuronCriteria(label="Segment", client=client) if all_segments else None',
    '    inward = direction == "inputs"',
    '    cache, cells, types, denoms, missing = {}, {}, {}, {}, set()',
    '',
    '    def fetch(ids):',
    '        criteria = NeuronCriteria(bodyId=list(ids), client=client)',
    '        if inward:',
    '            neurons, conn = fetch_adjacencies(',
    '                far, criteria, min_total_weight=min_weight, omit_rois=True, client=client,',
    '            )',
    '        else:',
    '            neurons, conn = fetch_adjacencies(',
    '                criteria, far, min_total_weight=min_weight, omit_rois=True, client=client,',
    '            )',
    '        # Every id asked about is cached, empty included, or a dead end is re-queried',
    '        # once per hop for the rest of the walk.',
    '        for i in ids:',
    '            cache.setdefault(int(i), ([], [], 0.0))',
    '        if conn.empty:',
    '            return',
    '        conn = merge_neuron_properties(neurons, conn, ["type"])',
    '        near, farcol = ("bodyId_post", "bodyId_pre") if inward else ("bodyId_pre", "bodyId_post")',
    '        neart, fart = ("type_post", "type_pre") if inward else ("type_pre", "type_post")',
    '        for row in conn.itertuples(index=False):',
    '            a, b = int(getattr(row, near)), int(getattr(row, farcol))',
    '            w = float(row.weight)',
    '            types.setdefault(a, getattr(row, neart, None))',
    '            types.setdefault(b, getattr(row, fart, None))',
    '            cells.setdefault(a, a)',
    '            cells.setdefault(b, b)',
    '            if w <= 0:',
    '                continue',
    '            p, ws, tot = cache[a]',
    '            p.append(b)',
    '            ws.append(w)',
    '            cache[a] = (p, ws, tot + w)',
    '',
    '    def published_totals(ids):',
    '        want = [int(i) for i in ids if int(i) not in denoms and int(i) not in missing]',
    '        if not want:',
    '            return',
    '        if denominator == "all":',
    '            # `upstream`, never `post`: they agree, but the outgoing twin of `post` is `pre`,',
    '            # the T-bar count, which is a different measure entirely.',
    '            frame, _ = fetch_neurons(NeuronCriteria(bodyId=want, client=client), client=client)',
    '            got = dict(zip(frame["bodyId"].astype(int), frame["upstream"].fillna(0)))',
    '        else:',
    '            _, conn = fetch_adjacencies(',
    '                None, NeuronCriteria(bodyId=want, client=client),',
    '                min_total_weight=1, omit_rois=True, client=client,',
    '            )',
    '            summed = conn.groupby("bodyId_post")["weight"].sum() if not conn.empty else {}',
    '            got = {int(k): float(v) for k, v in dict(summed).items()}',
    '        for i in want:',
    '            v = float(got.get(i, 0) or 0)',
    '            if v > 0:',
    '                denoms[i] = v',
    '            else:',
    '                missing.add(i)',
    '',
    '    kept = set(int(i) for i in seed_ids)',
    '    asked = set(kept)',
    '',
    '    def keep(ids):',
    '        if all_segments:',
    '            return set(int(i) for i in ids)',
    '        unknown = [int(i) for i in ids if int(i) not in asked]',
    '        if unknown:',
    '            frame, _ = fetch_neurons(',
    '                NeuronCriteria(bodyId=unknown, label="Neuron", client=client), client=client,',
    '            )',
    '            kept.update(int(i) for i in frame["bodyId"]) if not frame.empty else None',
    '            asked.update(unknown)',
    '        return set(i for i in (int(x) for x in ids) if i in kept)',
    '',
    '    # Mass is a vector throughout, of width 1 unless the seeds are kept apart. Uniform',
    '    # rather than branched: the propagation below is identical either way, and a scalar',
    '    # path beside a vector one is two implementations of one recurrence.',
    '    seeds = [int(i) for i in seed_ids]',
    '    width = len(seeds) if per_query else 1',
    '    current = {}',
    '    for q, i in enumerate(seeds):',
    '        v = np.zeros(width)',
    '        v[q if per_query else 0] = float(seed_mass)',
    '        current[i] = current.get(i, np.zeros(width)) + v',
    '    total = {i: v.copy() for i, v in current.items()}',
    '    first_hop = {i: 0 for i in current}',
    '',
    '    for hop in range(1, int(hops) + 1):',
    '        if not current:',
    '            break',
    '        todo = [i for i in current if i not in cache]',
    '        if todo:',
    '            fetch(todo)',
    '        if denominator != "traversal":',
    '            if inward:',
    '                published_totals(list(current))',
    '            else:',
    '                published_totals([b for i in current for b in cache[i][0]])',
    '',
    '        nxt = {}',
    '        for i, mass in current.items():',
    '            partners, weights, tot = cache.get(i, ([], [], 0.0))',
    '            if not partners:',
    '                continue',
    '            near = 0.0 if not inward else denoms.get(i, tot) if denominator != "traversal" else tot',
    '            if inward and near <= 0:',
    '                continue',
    '            for b, w in zip(partners, weights):',
    '                div = denoms.get(b, 0.0) if not inward else near',
    '                if div <= 0:',
    '                    continue',
    '                if b in nxt:',
    '                    nxt[b] += mass * w / div',
    '                else:',
    '                    nxt[b] = mass * w / div',
    '',
    '        survivors = keep(list(nxt))',
    '        nxt = {b: m for b, m in nxt.items() if b in survivors}',
    '        if frontier_limit and len(nxt) > frontier_limit:',
    '            # Ties broken by id so two runs of one query keep the same neurons.',
    '            ranked = sorted(',
    '                nxt.items(), key=lambda kv: (-float(kv[1].sum()), kv[0]),',
    '            )[:int(frontier_limit)]',
    '            nxt = dict(ranked)',
    '',
    '        scale = gain ** hop',
    '        for b, m in nxt.items():',
    '            if b in total:',
    '                total[b] = total[b] + m * scale',
    '            else:',
    '                total[b] = m * scale',
    '            first_hop.setdefault(b, hop)',
    '        current = nxt',
    '',
    '    seen = set(seeds)',
    '',
    '    def adjust(v):',
    '        return float(np.sign(v) * (np.log(max(abs(v), np.exp(-24.0))) + 24.0)) if v else 0.0',
    '',
    '    if per_query:',
    '        rows = [',
    '            {',
    '                "queryId": seeds[q],',
    '                "queryType": types.get(seeds[q]),',
    '                "neuronId": i,',
    '                "type": types.get(i),',
    '                "influence": float(v[q]),',
    '                "influenceLog": adjust(float(v[q])),',
    '                "hops": first_hop.get(i),',
    '                "isSeed": i in seen,',
    '            }',
    '            for i, v in total.items()',
    '            for q in range(width)',
    '            if v[q] > 0',
    '        ]',
    '        columns = ["queryId", "queryType", "neuronId", "type",',
    '                   "influence", "influenceLog", "hops", "isSeed"]',
    '        if not rows:',
    '            return pd.DataFrame(columns=columns)',
    '        return (',
    '            pd.DataFrame(rows)',
    '            .sort_values(["queryId", "influence"], ascending=[True, False])',
    '            .reset_index(drop=True)',
    '        )',
    '',
    '    rows = [',
    '        {',
    '            "neuronId": i,',
    '            "type": types.get(i),',
    '            "influence": float(v.sum()),',
    '            "influenceLog": adjust(float(v.sum())),',
    '            "hops": first_hop.get(i),',
    '            "isSeed": i in seen,',
    '        }',
    '        for i, v in total.items()',
    '        if v.sum() > 0',
    '    ]',
    '    if not rows:',
    '        return pd.DataFrame(',
    '            columns=["neuronId", "type", "influence", "influenceLog", "hops", "isSeed"]',
    '        )',
    '    return (',
    '        pd.DataFrame(rows)',
    '        .sort_values("influence", ascending=False)',
    '        .reset_index(drop=True)',
    '    )',
  ],
})
