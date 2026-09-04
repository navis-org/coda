import { registerNode } from '../../core/registry'
import { connectivityRequest } from '../lib/datasetParam'
import { connectivityFor, synapseTotalsFor } from '../../data/queries'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { idColumn } from '../lib/tableOps'
import { unmatchedIds } from '../lib/idList'
import {
  datasetRequest,
  publishedNeurons,
  requireDataset,
  schemasForDataset,
  roiOptions,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
import type { TraversalDirection } from '../lib/connectivityOps'
import {
  connectivityOutputSchema,
  endpointNeurons,
  endpointSchema,
  neuronRowsFor,
  normalizeConnectivity,
  normalizeSide,
  normalizeTargets,
  readBasis,
  readNormalizeBy,
  regionOptions,
  totalsLookup,
  traverseConnectivity,
  usesRegions,
} from '../lib/connectivityOps'

/** Above this the fan-out is worth saying out loud. A warning, never a refusal. */
const NOISY_HOPS = 3

function readDirection(raw: unknown): TraversalDirection {
  return raw === 'inputs' || raw === 'both' ? raw : 'outputs'
}

/**
 * Synaptic partners of a set of neurons, one or more hops out.
 *
 * Takes the whole neuron collection and issues one batched request per hop and direction —
 * the collection-level semantics Coda uses everywhere. A per-neuron variant would be a
 * ForEach around this node, not a different node.
 *
 * The output is an **edge list**, not a partner list: `preId → postId`, always oriented the
 * way the synapse points, with `hop` and `direction` saying how the traversal got there. See
 * `lib/connectivityOps.ts` for why the source's query-relative shape is reoriented here
 * rather than at the seam.
 */
export const connectivityNode = registerNode({
  type: 'neuron.connectivity',
  /*
   * `Connectivity`, not `Connectivity`. What it emits is an edge list — a table of
   * `preId → postId` rows — and "Graph" invited the reading that this node is where a network
   * comes from, which is `net.build` two nodes downstream. It also puts the name in the same
   * shape as `Skeletons`, `Meshes` and `Synapses`: what you get, not what you might do with it.
   * The node **type** is untouched, because that is what a saved graph carries.
   */
  label: 'Connectivity',
  category: 'query',
  description: 'Fetch synaptic partners for the incoming neurons, one or more hops out.',
  guide:
    'Synaptic partners, one or more hops out. Connections is an edge list: every row is preId → postId oriented the way the synapse points, so Build Network works with nothing to think about. Neuron Set is the same result as neurons — seeds plus every partner reached — which is what Adjacency takes. Partners decides whether a fragment counts as one.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  /*
   * **Two outputs describing one traversal**, which is `neuron.adjacency`'s arrangement and
   * `neuron.roiConnectivity`'s before it. `Connections` is the edge list and stays first, so a
   * link dragged off the node starts there and every graph saved before this port existed keeps
   * its wiring — `neuron.explore` appended `all` on the same rule.
   *
   * `Neuron Set` exists because an edge list is the wrong *type* for the node that most obviously
   * comes next. `Adjacency` wants two `Neurons` sets and `isSubtype` allows `neurons → table`
   * but not the reverse, so closing a partner set into its own induced subgraph meant Rename →
   * Stack → Dedupe → Input IDs — four nodes to say "the neurons I just found". It is derived
   * from the result rather than fetched again (the default, at least), so the two ports cannot
   * disagree about which neurons are in play.
   *
   * **Not called `Neurons`, though that is what it holds.** The input port is already `Neurons`,
   * and a node with one label on both sides reads as a pass-through everywhere else in the
   * registry — `out.profile` is literally one (`out: table`), and so is `Labels to Neurons`. The
   * id differs for the same reason, one step lower: `ctx.input('neurons')` beside
   * `ctx.output('neurons')` in one `evaluate` is a typo waiting to happen, and the notebook
   * exporter would bind it as `connectivity_neurons`.
   */
  outputs: [
    { id: 'connections', label: 'Connections', type: T.table() },
    { id: 'neuronSet', label: 'Neuron Set', type: T.neurons() },
  ],
  params: [
    {
      id: 'direction',
      kind: 'enum',
      label: 'Direction',
      default: 'outputs',
      options: [
        { value: 'outputs', label: 'downstream (outputs)' },
        { value: 'inputs', label: 'upstream (inputs)' },
        { value: 'both', label: 'both (in + out)' },
      ],
    },
    {
      id: 'hops',
      kind: 'int',
      label: 'Hops',
      help: 'How many synapses out to travel. 1 is direct partners. Every neuron reached by one hop is expanded by the next, so Min weight is what keeps this bounded.',
      default: 1,
      min: 1,
      step: 1,
    },
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min weight',
      help: 'Discard connections below this synapse count. Raise it to cut noise — and, past one hop, to keep the traversal from expanding every weak partner. Applied to the connection before any region split, so splitting never changes which partners are found.',
      default: 1,
      min: 1,
      step: 1,
    },
    /*
     * The four region and normalisation controls.
     *
     * **None of them carries `absentMeans`, and that is a claim rather than an oversight.** A
     * stored node written before these existed queried whole-neuron weights and emitted no
     * fraction, which is exactly what every default here says — so absence and the default
     * already agree, and writing the third state in would only add a key nothing reads
     * differently. See `ParamBase.absentMeans` for the case where they do not agree.
     */
    {
      id: 'splitByRoi',
      kind: 'boolean',
      label: 'Split by region',
      help: 'One row per connection per region, with a roi column naming it. A decomposition rather than extra rows: the parts sum back to the connection\u2019s weight, give or take the few synapses that sit in no primary region at all (none on male-CNS or MANC, under 1% on hemibrain and optic-lobe).',
      default: false,
    },
    {
      id: 'rois',
      kind: 'multiEnum',
      label: 'Regions',
      noun: 'region',
      /*
       * Empty is not "no regions" and it is not "every region" either — it is *no restriction*,
       * which is the state every graph written before this control was here is in. Said in
       * those words because "all regions" would read as a filter that happens to pass
       * everything, and the two differ: a restriction to every primary region drops the
       * synapses that fall outside all of them, where no restriction keeps the whole weight.
       */
      emptyLabel: 'the whole connection',
      help: 'Restrict every weight to these regions. A row\u2019s weight becomes the synapses inside them rather than the connection\u2019s total, and a connection with none is dropped.',
      default: [],
      options: (ctx) =>
        sourceSupports(ctx.inputs.dataset, 'connectivityRois')
          ? roiOptions(ctx.inputs.dataset, {
              primaryOnly: regionOptions(ctx.params).primaryOnly,
            })
          : [],
    },
    {
      id: 'primaryRoisOnly',
      kind: 'boolean',
      label: 'Primary regions only',
      /*
       * The vocabulary, not a post-filter. It decides which names the picker offers and what an
       * empty picker means, and it deliberately does **not** narrow a selection somebody has
       * already made — the column picker's rule, which keeps a chosen value rather than
       * substituting. A region picked while this was off and left in place when it went back on
       * is still honoured, and the warning below is what says so.
       */
      help: 'Regions nest \u2014 a synapse in LAL(L) is also counted in LX(L) and in CentralBrain. On, only the set that tiles the volume is offered, so a split adds nothing that is not there. Off, the whole published list is available and rows can sum to several times what the connection has.',
      default: true,
      visibleIf: usesRegions,
    },
    {
      id: 'normalize',
      kind: 'boolean',
      label: 'Normalize',
      help: 'Add weightNorm, the connection as a fraction of one neuron\u2019s total synapses, and weightTotal, the denominator it was divided by.',
      default: false,
    },
    {
      id: 'normalizeBy',
      kind: 'enum',
      label: 'Normalize by',
      help: 'Which end of the connection the denominator belongs to. These are different questions, not two views of one number.',
      default: 'postsynaptic',
      options: [
        { value: 'postsynaptic', label: 'the target\u2019s total input' },
        { value: 'presynaptic', label: 'the source\u2019s total output' },
      ],
      visibleIf: (params) => params.normalize === true,
    },
    {
      id: 'normalizeBasis',
      kind: 'enum',
      label: 'Denominator',
      /*
       * The transparency control, and the reason `weightTotal` rides in the table beside the
       * fraction. On male-cns body 10005 these two answer 23,423 and 9,324 for the same
       * neuron's outgoing synapses — the difference is the 14,091 that land on fragments the
       * segmentation never promoted to a neuron.
       */
      help: 'All synapses counts everything the neuron makes, including synapses onto fragments nobody reconstructed \u2014 it matches the total the dataset publishes for that neuron. Reconstructed partners only counts synapses onto partners the dataset calls neurons, which is the denominator to use when comparing edge weights across connectomes proofread to different depths.',
      default: 'all',
      options: [
        { value: 'all', label: 'all synapses' },
        { value: 'connected', label: 'reconstructed partners only' },
      ],
      visibleIf: (params) => params.normalize === true,
    },
    /*
     * Whether a body the dataset does not call a neuron counts as a partner.
     *
     * **A connectivity query matches its far end as a bare node**, which is deliberate and is
     * why this is a control rather than a fix: a partner may be a fragment the segmentation
     * never promoted to a neuron, and excluding those under-reports the total synapse weight —
     * which is exactly what `Normalize`'s `connected` basis exists to measure. What was wrong was
     * that it had no *other* setting. Measured on `male-cns:v1.0`, five `LC4` neurons downstream
     * at weight 1:
     *
     *   bare far end   4,252 partners   4,889 edges   11,898 synapses
     *   :Neuron          496 partners   1,043 edges    6,533 synapses
     *   superclass       492 partners   1,032 edges    6,503 synapses
     *
     * So the old behaviour answered a question almost nobody asked: 88% of the partners were
     * fragments, and the `Neuron Set` port could find a row for none of them.
     *
     * **A checkbox rather than a two-option enum**, because the two settings are not peers: one
     * is what nearly everybody wants and the other is an addition to it. What "proofread" means
     * is deliberately *not* restated here — it is whatever the Dataset card's own population says,
     * which is the point of asking `findNeurons` rather than compiling a predicate of our own.
     *
     * **`absentMeans: true`, and here the third state really is a third state.** A stored node
     * written before this control existed queried every partner — that is not the default, so
     * absence has to be written in on load or every saved workflow silently returns different
     * numbers after an update. Contrast the region params above, whose absence and default agree.
     *
     * **No warning when it is off**, deliberately. A badge on every Connectivity run is a badge
     * nobody reads by the third one, and the unticked box is already on the card. The asymmetry
     * runs the other way: ticking it is what leaves the `Neuron Set` port with empty columns, and
     * that is warned about where it happens.
     */
    {
      id: 'includeFragments',
      kind: 'boolean',
      label: 'Include fragments',
      help: 'Off, only proofread neurons come back \u2014 what counts as proofread is set on the Dataset node. On, everything the query finds does, small neuron fragments included. Those fragments are most of what a connectivity query returns: on male-CNS they are 88% of the partners and 45% of the synapse weight, and none of them has a row in the neuron table for the Neuron Set port to fill.',
      default: false,
      absentMeans: true,
    },
    /*
     * What the `Neuron Set` port carries.
     *
     * **No `absentMeans`, and that is a claim.** A stored node written before this port existed
     * emitted no neuron table and issued no lookup for one, which is exactly what `derived` does
     * — absence and the default already agree, so writing the third state in would only add a key
     * nothing reads differently. The four region params above carry the same note for the same
     * reason; see `ParamBase.absentMeans` for the case where they do not agree.
     *
     * Not `presentational`: it changes what `evaluate` returns, so it belongs in the provenance
     * key (invariant 4). Flipping it re-runs the node, which is the point — `full` is a query.
     *
     * No `visibleIf` either, though it is tempting: a param is hidden on a *param* condition, and
     * whether the port is wired is a fact about the graph that `visibleIf(params)` cannot see.
     * Hiding it on anything else would drop it out of the provenance key while it was still
     * deciding the output.
     */
    {
      id: 'neuronRows',
      kind: 'enum',
      label: 'Neuron Set',
      help: 'Minimal reads the IDs and types straight off the edges and costs nothing. Full meta data looks every neuron up in the dataset for the columns the edge list has no room for \u2014 status, size, instance \u2014 which is a second query over every neuron this result touched, and it runs whether or not the port is wired.',
      default: 'derived',
      options: [
        { value: 'derived', label: 'minimal (IDs + types)' },
        { value: 'full', label: 'full meta data' },
      ],
    },
  ],

  inferOutputs: (ctx) => {
    const schemas = schemasFromType(ctx.inputs.dataset)
    return {
      connections: T.table(
        connectivityOutputSchema(schemas.connectivity, {
          splitByRoi: ctx.params.splitByRoi === true,
          normalize: ctx.params.normalize === true,
        }),
      ),
      /*
       * Both branches are what `evaluate` actually returns — invariant 3 by construction, and
       * `Input IDs` makes the same split for the same reason. The schema changing with a control
       * is the visible cost of the control existing, and it is the honest shape: advertising
       * `status` over a table derived from an edge list would break every picker that believed
       * it.
       */
      neuronSet: T.neurons(
        ctx.params.neuronRows === 'full'
          ? schemas.neurons
          : endpointSchema(schemas.connectivity),
      ),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const hops = Number(ctx.params.hops ?? 1)
    const minWeight = Number(ctx.params.minWeight ?? 1)
    /*
     * A warning rather than a cap, deliberately — the same call Find Neurons makes about
     * `limit: 0`. What is worth saying is that the two params multiply: the frontier grows by
     * the average partner count each hop, and Min weight is the only thing dividing it.
     */
    if (hops >= NOISY_HOPS && minWeight <= 1) {
      issues.push(
        `${hops} hops at Min weight ${minWeight} expands every partner of every partner — this can reach a large fraction of the dataset. Raise Min weight.`,
      )
    }
    if (hops >= NOISY_HOPS && ctx.params.direction === 'both') {
      issues.push(
        `Direction "both" expands upstream and downstream at every hop, so ${hops} hops covers the undirected neighbourhood.`,
      )
    }

    /*
     * The two capability refusals, each gated on the control being *used* rather than on the
     * node's type. Both read `sourceSupports`, which folds in the edge-set arm — a dataset
     * answering from an imported file has no regions and no comparable totals, whatever the
     * backend behind it could do. See `canSplitConnectivityByRoi` and `canTotalSynapses`.
     */
    const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
    if (usesRegions(ctx.params) && !sourceSupports(ctx.inputs.dataset, 'connectivityRois')) {
      issues.push(`${label} cannot break a connection down by region`)
    }
    if (ctx.params.normalize === true && !sourceSupports(ctx.inputs.dataset, 'synapseTotals')) {
      issues.push(
        `${label} does not publish the per-neuron synapse totals Normalize divides by`,
      )
    }

    /*
     * Not a refusal: a nesting region set is a real question — "how much of this connection is
     * in the optic lobe" — that simply cannot also be a decomposition. Said at edit time as well
     * as at run time because it changes what the numbers in front of somebody mean, and because
     * `ctx.warn` is only seen by whoever presses Run.
     */
    if (regionOptions(ctx.params).mayNest) {
      issues.push(
        'Regions nest, so a split over the whole published list counts a synapse once per region containing it — the rows will sum to more than the connection weight.',
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const neurons = ctx.input('neurons')
    if (!isTableValue(neurons)) throw new Error('Neurons input is not a table')

    const neuronIds = idColumn(neurons, 'neuronId')
    if (neuronIds.length === 0) throw new Error('No neuronIds in the incoming neuron table')

    const direction = readDirection(ctx.params.direction)
    const hops = Math.max(1, Math.floor(Number(ctx.params.hops ?? 1)))
    const minWeight = Number(ctx.params.minWeight ?? 1)
    const normalize = ctx.params.normalize === true
    const includeFragments = ctx.params.includeFragments === true
    const { rois: chosen, splitByRoi, primaryOnly } = regionOptions(ctx.params)

    /*
     * The region list that actually reaches the query, resolved once.
     *
     * An explicit selection is honoured verbatim — the picker's rule, which keeps what somebody
     * chose rather than substituting. Only an empty one has anything to decide, which is why
     * the whole resolution sits under one guard: either the primary set, or nothing at all and
     * the source enumerates `roiInfo`'s own keys.
     */
    let rois: string[] | undefined = chosen.length ? chosen : undefined
    if (splitByRoi && !chosen.length) {
      if (!primaryOnly) {
        ctx.warn(
          'Split by region is covering every region each connection mentions, and regions nest — a synapse in LAL(L) is counted again in LX(L) and in CentralBrain, so the rows sum to several times what the connection has. Turn on "Primary regions only" for a split that takes the connection apart rather than repeating it.',
        )
      } else {
        // `listDatasets` is cached and deduplicated, so this is a lookup rather than a fetch on
        // any run but the very first of a session.
        await source.listDatasets(ctx.signal)
        const primaryRois = source.peekDataset(dataset.datasetId)?.primaryRois
        if (primaryRois?.length) rois = [...primaryRois]
        else {
          /*
           * The toggle says restrict and there is nothing to restrict to. Warned rather than
           * refused — a split over every region is still a true statement about where the
           * synapses are, it just is not a decomposition — but said plainly, because the number
           * a reader would otherwise take from it is a total that is too large.
           */
          ctx.warn(
            `${source.label} has not published which of this dataset's regions tile the volume, so the split covers every region a connection mentions. Regions nest, so the rows can sum to more than the connection weight.`,
          )
        }
      }
    }

    // Resolved once and handed to both schema builders: the traversal's, and — if Normalize is
    // on — the wider one the fractions are appended to.
    const sourceSchema = schemasForDataset(source, dataset).connectivity

    ctx.progress(0.15, `${neuronIds.length} neurons`)
    const traversed = await traverseConnectivity({
      seeds: neuronIds,
      direction,
      hops,
      schema: connectivityOutputSchema(sourceSchema, { splitByRoi }),
      signal: ctx.signal,
      /*
       * The `Include fragments` filter, asked of the source rather than compiled into the
       * connectivity query — and that is the design rather than a shortcut. It is literally
       * `findNeurons`, so "published" means exactly what `Find Neurons` means on the same dataset
       * card, on every backend, with no `ConnectivityRequest` field for five sources to lower and
       * one of them to lower differently. The alternative is two definitions of one set that have
       * to be kept in step, and the `Neuron Set` port beside it is the thing that would silently
       * disagree. `publishedNeurons` is where the request projection is chosen; see it for why
       * that choice is the opposite of the row lookup's fifty lines below.
       *
       * The cost is a round trip per hop and a connectivity response that still carries every
       * fragment before they are dropped. The saving is the hop after: a frontier of 496 rather
       * than 4,252.
       */
      published: includeFragments ? undefined : publishedNeurons(source, dataset, ctx.signal),
      // A hop's cost is unknown until its frontier is known, so progress is per round rather
      // than per row: the fraction paces the hops and the note carries the frontier size.
      onHop: (hop, total, frontier) =>
        ctx.progress(
          0.15 + (0.7 * (hop - 1)) / total,
          total > 1 ? `hop ${hop}/${total} · ${frontier} neurons` : `${frontier} neurons`,
        ),
      fetch: (frontier, hopDirection) =>
        connectivityFor(source, {
          ...connectivityRequest(dataset),
          neuronIds: frontier,
          direction: hopDirection,
          minWeight,
          ...(rois ? { rois } : {}),
          ...(splitByRoi ? { splitByRoi } : {}),
          signal: ctx.signal,
        }),
    })

    /*
     * Normalisation is a second query, and it is asked about the ids in the *result* rather than
     * about the seeds — past one hop the neuron whose total is wanted is generally not one
     * anybody named. See `normalizeTargets`.
     *
     * A block rather than an early return, because the `Neurons` port is derived from whichever
     * table this settles on and there is exactly one place that decision should be made.
     */
    let connections = traversed
    if (normalize) {
      const by = readNormalizeBy(ctx.params.normalizeBy)
      const basis = readBasis(ctx.params.normalizeBasis)
      const targets = normalizeTargets(traversed, by)
      ctx.progress(0.88, `synapse totals for ${targets.length.toLocaleString()} neurons`)
      const totals = await synapseTotalsFor(source, {
        // The same projection the traversal spreads. `connectivityRequest` carries the edge set
        // as well as the id and the annotation chain, which is what lets `synapseTotalsFor`
        // refuse a dataset answering from a file — see its own note.
        ...connectivityRequest(dataset),
        neuronIds: targets,
        side: normalizeSide(by),
        basis,
        signal: ctx.signal,
      })

      const normalized = normalizeConnectivity(
        traversed,
        by,
        totalsLookup(totals),
        connectivityOutputSchema(sourceSchema, { splitByRoi, normalize: true }),
      )

      /*
       * Said out loud rather than left as blanks in a column. A null denominator is what a
       * fragment on the far end of an edge gets under the `connected` basis — it is not a neuron,
       * so nothing totalled it — and a chart reading `weightNorm` would simply drop those rows
       * with no indication that it had.
       */
      if (normalized.missingRows > 0) {
        ctx.warn(
          `${normalized.missingRows.toLocaleString()} of ${traversed.length.toLocaleString()} rows have no denominator (${normalized.missingNeurons.toLocaleString()} neurons the dataset publishes no ${by === 'postsynaptic' ? 'input' : 'output'} total for), so weightNorm is empty for them.`,
        )
      }

      connections = normalized.table
    }

    /*
     * The `Neuron Set` port.
     *
     * Derived first and unconditionally: it is a pass over two columns of a table already in
     * hand, it is what the `full` lookup is keyed by, and it is the count the warning below
     * compares against.
     */
    const derived = endpointNeurons(connections, endpointSchema(sourceSchema), neurons)
    if (ctx.params.neuronRows !== 'full') {
      ctx.progress(1)
      return { connections, neuronSet: derived }
    }

    ctx.progress(0.93, `neuron rows for ${derived.length.toLocaleString()} neurons`)
    /*
     * `datasetRequest`, not `neuronSetRequest` — the same call `Input IDs` makes, and for its
     * reason. These are neurons the traversal *found*; narrowing them by the dataset node's
     * population checkboxes would delete rows the edge list still counts and report the deletion
     * as neurons the dataset does not have. And not `connectivityRequest` either: a dataset
     * answering from an attached edge file has no neuron table behind it to look anything up in.
     */
    const endpointIds = idColumn(derived)
    const rows = await source.findNeurons({
      ...datasetRequest(dataset),
      neuronIds: endpointIds,
      signal: ctx.signal,
    })

    /*
     * **A left join, so the two ports stay the same set.** `findNeurons` answers only about
     * bodies the dataset calls a neuron, and with `Partners` set to every partner a great many
     * are not: on `male-cns:v1.0`, five LC4 neurons have 4,252 distinct downstream partners of
     * which 496 carry the `:Neuron` label. Returning the lookup's own rows would make this port
     * a different length from the edge list beside it — the one property it exists to have — so
     * every endpoint survives and an unmatched one keeps its id and the type the edge carried,
     * with the rest of the columns empty. See `neuronRowsFor`.
     */
    const missing = unmatchedIds(endpointIds, rows).length
    if (missing > 0) {
      ctx.warn(
        `${missing.toLocaleString()} of the ${derived.length.toLocaleString()} neurons in this ` +
          `result have no row in ${source.label}'s neuron table, so their columns are empty — a ` +
          `synaptic partner can be a fragment the dataset does not publish as a neuron, which ` +
          `the edge list still counts. Their IDs and types are kept. Untick "Include ` +
          `fragments" to leave them out of the result altogether.`,
      )
    }
    ctx.progress(1)
    return {
      connections,
      neuronSet: neuronRowsFor(derived, rows, schemasForDataset(source, dataset).neurons),
    }
  },
})
