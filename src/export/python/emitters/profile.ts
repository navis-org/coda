/**
 * Profile: the metrics, without the widget.
 *
 * The card is a browser and a notebook is not, but almost everything it *shows* is an ordinary
 * roll-up over three fetches — and the notebook can do something the widget cannot. The widget
 * pages one neuron at a time and pays three requests per neuron viewed; `fetch_adjacencies`
 * takes the whole id list at once, so `coda_profile` costs three requests for a hundred neurons
 * as readily as for one. The emitted call passes the pinned neuron because that is what the
 * canvas was showing, and widening it is editing one argument.
 *
 * Ported from `nodes/lib/profileStats.ts`. Four of its rules are easy to lose and each produces
 * a plausible wrong number rather than an error, so each is called out where it is applied.
 */

import { pyList } from '../py'
import { registerEmitter, registerHelper } from '../registry'
import { neuronIds, selectionIds } from './common'

registerEmitter('out.profile', (ctx) => {
  const src = ctx.wired('neurons')

  const c = ctx.wired('dataset')
  const out = ctx.output('out')
  const current = ctx.output('current')
  const selection = selectionIds(ctx)
  const minWeight = Math.max(1, Number(ctx.params.minWeight ?? 1))
  const topN = Number(ctx.params.topN ?? 10)

  ctx.require('pandas')
  const lines: string[] = [`${out} = ${src}`]

  // The pinned row, which is the node's `Current` output whether or not the metrics run.
  if (selection.length > 0) {
    lines.push(`${current} = ${out}[${out}['neuronId'].isin(${pyList(selection)})]`)
  } else {
    lines.push(
      ...ctx.note('No neuron is pinned on the canvas, so Current is empty.'),
      `${current} = ${out}.iloc[0:0]`,
    )
  }

  if (!c) {
    return [
      ...lines,
      ...ctx.note(
        'No Dataset is wired, so the metrics cannot be fetched — this is the pass-through ' +
          'and the pinned row only.',
      ),
    ]
  }

  ctx.helper('coda_profile')
  const ids = selection.length > 0 ? pyList(selection) : neuronIds(out)

  lines.push(
    ``,
    // Named frames rather than one long table, so each lines up with a tile on the card.
    `_profile = coda_profile(`,
    `    ${ids},`,
    `    client=${c},`,
    `    min_weight=${minWeight},`,
    `    top_n=${topN},`,
    `)`,
    ``,
    `${ctx.name}_summary = _profile['summary']`,
    `${ctx.name}_upstream_types = _profile['upstream_types']`,
    `${ctx.name}_downstream_types = _profile['downstream_types']`,
    `${ctx.name}_top_upstream = _profile['top_upstream']`,
    `${ctx.name}_top_downstream = _profile['top_downstream']`,
    `${ctx.name}_regions = _profile['regions']`,
    `${ctx.name}_hemispheres = _profile['hemispheres']`,
    ``,
    `${ctx.name}_summary`,
  )
  return lines
})

registerHelper({
  name: 'coda_profile',
  // `neurons` and `roi_counts` come straight off `fetch_neurons`, so they arrive carrying
  // neuprint-python's `bodyId` while every roll-up below groups and merges on Coda's
  // `neuronId`. Without the rename each of those is a `KeyError` inside a generated helper.
  needs: ['coda_neurons'],
  requires: [
    ['pandas'],
    [
      'neuprint',
      'NeuronCriteria',
      'fetch_adjacencies',
      'fetch_neurons',
      'fetch_primary_rois',
      'merge_neuron_properties',
    ],
  ],
  source: [
    'import re',
    '',
    '_CODA_ROI_SIDE = re.compile(r"\\((L|R)\\)\\s*$")',
    '',
    '',
    'def _coda_roi_side(roi):',
    '    """Which side of the animal an ROI sits on.',
    '',
    '    One rule rather than a per-dataset table: every neuPrint dataset writes the side as a',
    '    trailing parenthesis, and a name without one -- "ANm", "CV" -- is genuinely',
    '    unlateralised rather than unlabelled. Reads the LAST parenthesis deliberately:',
    '    "HTct(UTct-T3)(L)" has two, and anchoring on the first reports every leg neuropil',
    '    as unsided.',
    '    """',
    '    match = _CODA_ROI_SIDE.search(roi or "")',
    '    return match.group(1) if match else "center"',
    '',
    '',
    'def _coda_partner_types(conn, top_n):',
    '    """Partners rolled up by type, with both shares.',
    '',
    '    Synapses summed *and* distinct partners counted in one pass, because the two answer',
    '    different questions -- forty synapses onto one neuron is not forty onto forty.',
    '    Untyped partners keep their own bucket rather than folding into a neighbour: on',
    "    male-CNS a large share of a neuron's partners are untyped, and merging them silently",
    '    puts a fictitious type at the top of the list.',
    '    """',
    '    if conn.empty:',
    '        return conn.assign(type=None, synapses=0, partners=0,',
    '                           synapse_share=0.0, partner_share=0.0).iloc[0:0]',
    '',
    '    out = []',
    '    for body, group in conn.groupby("neuronId", sort=False):',
    '        total_syn = group["weight"].sum()',
    '        total_partners = group["partnerId"].nunique()',
    '        rolled = (',
    '            group.groupby("partnerType", dropna=False)',
    '            .agg(synapses=("weight", "sum"), partners=("partnerId", "nunique"))',
    '            .reset_index()',
    '            .rename(columns={"partnerType": "type"})',
    '        )',
    '        rolled["neuronId"] = body',
    '        rolled["synapse_share"] = rolled["synapses"] / total_syn if total_syn else 0.0',
    '        rolled["partner_share"] = (',
    '            rolled["partners"] / total_partners if total_partners else 0.0',
    '        )',
    '        rolled = rolled.sort_values(',
    '            ["synapses", "type"], ascending=[False, True], na_position="last",',
    '        )',
    '        out.append(rolled.head(top_n) if top_n else rolled)',
    '',
    '    cols = ["neuronId", "type", "synapses", "partners", "synapse_share", "partner_share"]',
    '    return pd.concat(out, ignore_index=True)[cols]',
    '',
    '',
    'def _coda_top_partners(conn, top_n):',
    '    """Individual partner neurons, strongest first, with each one\'s share."""',
    '    if conn.empty:',
    '        return conn.assign(share=0.0).iloc[0:0]',
    '',
    '    out = []',
    '    for body, group in conn.groupby("neuronId", sort=False):',
    '        total = group["weight"].sum()',
    '        rows = group.copy()',
    '        rows["share"] = rows["weight"] / total if total else 0.0',
    '        rows = rows.sort_values(["weight", "partnerId"], ascending=[False, True])',
    '        out.append(rows.head(top_n) if top_n else rows)',
    '',
    '    cols = ["neuronId", "partnerId", "partnerType", "weight", "share"]',
    '    return pd.concat(out, ignore_index=True)[cols]',
    '',
    '',
    'def _coda_connectivity(neuron_ids, direction, min_weight, client):',
    '    """One direction of partners, in the query-relative shape the roll-ups expect.',
    '',
    '    neuronId is always the neuron being profiled and partnerId is whatever it is wired to,',
    "    whichever way the arrow points -- which is the *opposite* convention to Coda's",
    '    Connectivity node, and the right one here: "these are my upstream partners" is the',
    '    question a profile asks.',
    '    """',
    '    criteria = NeuronCriteria(bodyId=list(neuron_ids), client=client)',
    '    if direction == "downstream":',
    '        neurons, conn = fetch_adjacencies(',
    '            criteria, None, min_total_weight=min_weight,',
    '            omit_rois=True, client=client,',
    '        )',
    '        mine, theirs = "bodyId_pre", "bodyId_post"',
    '    else:',
    '        neurons, conn = fetch_adjacencies(',
    '            None, criteria, min_total_weight=min_weight,',
    '            omit_rois=True, client=client,',
    '        )',
    '        mine, theirs = "bodyId_post", "bodyId_pre"',
    '',
    '    if conn.empty:',
    '        return pd.DataFrame(',
    '            columns=["neuronId", "partnerId", "partnerType", "weight"]',
    '        )',
    '',
    '    conn = merge_neuron_properties(neurons, conn, ["type"])',
    '    partner_type = "type_post" if mine == "bodyId_pre" else "type_pre"',
    '    return conn.rename(columns={',
    '        mine: "neuronId", theirs: "partnerId", partner_type: "partnerType",',
    '    })[["neuronId", "partnerId", "partnerType", "weight"]]',
    '',
    '',
    'def coda_profile(neuron_ids, client, min_weight=1, top_n=10):',
    '    """Everything Coda\'s Profile card shows, as a dict of DataFrames.',
    '',
    '    Keys mirror the tiles: summary, upstream_types, downstream_types, top_upstream,',
    '    top_downstream, regions, hemispheres.',
    '',
    '    Three requests regardless of how many neurons are asked for, because every fetch here',
    '    takes the whole id list -- so this is cheap to widen from the pinned neuron to the',
    '    entire table, which is the one thing the Profile widget cannot do.',
    '',
    '    min_weight drops connections below a threshold; top_n caps each list (0 keeps all).',
    '    """',
    '    neuron_ids = [int(b) for b in neuron_ids]',
    '    if not neuron_ids:',
    '        empty = pd.DataFrame()',
    '        return {k: empty for k in ("summary", "upstream_types", "downstream_types",',
    '                                   "top_upstream", "top_downstream", "regions",',
    '                                   "hemispheres")}',
    '',
    '    neurons, roi_counts = fetch_neurons(',
    '        NeuronCriteria(bodyId=neuron_ids, client=client), client=client,',
    '    )',
    '    neurons, roi_counts = coda_neurons(neurons), coda_neurons(roi_counts)',
    '    up = _coda_connectivity(neuron_ids, "upstream", min_weight, client)',
    '    down = _coda_connectivity(neuron_ids, "downstream", min_weight, client)',
    '',
    '    # roiInfo NESTS: a synapse in LO(R) is counted again in its parent OL(R), so summing',
    "    # the raw breakdown reports roughly twice the neuron's synapses. Only the primary ROIs",
    '    # tile the volume, which is why they are fetched rather than assumed.',
    '    primary = set(fetch_primary_rois(client=client))',
    '    regions = roi_counts[roi_counts["roi"].isin(primary)].copy()',
    '    regions = (',
    '        regions.groupby(["neuronId", "roi"], as_index=False)[["pre", "post"]].sum()',
    '    )',
    '    regions["total"] = regions["pre"] + regions["post"]',
    '    regions = regions[regions["total"] > 0].sort_values(',
    '        ["neuronId", "total", "roi"], ascending=[True, False, True],',
    '    )',
    '',
    '    sides = regions.assign(side=regions["roi"].map(_coda_roi_side))',
    '    hemispheres = (',
    '        sides.pivot_table(index="neuronId", columns="side", values="total",',
    '                          aggfunc="sum", fill_value=0)',
    '        .rename(columns={"L": "left", "R": "right"})',
    '        .reset_index()',
    '    )',
    '    for column in ("left", "right", "center"):',
    '        if column not in hemispheres:',
    '            hemispheres[column] = 0',
    '    hemispheres["total"] = (',
    '        hemispheres["left"] + hemispheres["right"] + hemispheres["center"]',
    '    )',
    '',
    '    def totals(conn, prefix):',
    '        if conn.empty:',
    '            return pd.DataFrame(columns=["neuronId", f"{prefix}_synapses",',
    '                                         f"{prefix}_partners"])',
    '        return (',
    '            conn.groupby("neuronId", as_index=False)',
    '            .agg(**{f"{prefix}_synapses": ("weight", "sum"),',
    '                    f"{prefix}_partners": ("partnerId", "nunique")})',
    '        )',
    '',
    '    summary = neurons.merge(totals(up, "upstream"), on="neuronId", how="left")',
    '    summary = summary.merge(totals(down, "downstream"), on="neuronId", how="left")',
    '    summary = summary.merge(',
    '        hemispheres[["neuronId", "left", "right", "center"]], on="neuronId", how="left",',
    '    )',
    '',
    '    return {',
    '        "summary": summary,',
    '        "upstream_types": _coda_partner_types(up, top_n),',
    '        "downstream_types": _coda_partner_types(down, top_n),',
    '        "top_upstream": _coda_top_partners(up, top_n),',
    '        "top_downstream": _coda_top_partners(down, top_n),',
    '        "regions": regions,',
    '        "hemispheres": hemispheres,',
    '    }',
  ],
})
