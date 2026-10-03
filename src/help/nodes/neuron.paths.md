## What Paths does

Paths finds the strongest routes from one set of neurons (`Sources`) to another (`Targets`). Where [Connectivity](#neuron.connectivity) tells you what a neuron is connected to, Paths tells you how one group of neurons reaches another:

```coda-graph
caption: Find the strongest routes between two neurons and draw them as a network.
neuron.inputIds as in1 {ids: "10001"}
neuron.inputIds as in2 {ids: "21312"}
neuron.paths as p
out.network as net
in1 -> p:sources
in2 -> p:targets
p -> net
```

```coda-params
neuron.paths: maxHops, minWeight, topN, collapseTypes
```

## How routes are ranked

A route is ranked by its weakest link, i.e. the smallest number of synapses on any single hop along the way. The weights are not added up. A long route through consistently strong connections therefore ranks above a short route that includes one weak connection.

The search runs from both ends at once and keeps the `N strongest` routes (25 by default; 0 keeps every route it finds). `Max hops` sets the longest route it looks for. Every extra hop multiplies the number of neurons to search, so `Min synapses` is what keeps larger searches manageable.

## Cell types vs. individual neurons

With `Collapse types` on (the default), the search runs on a graph of cell types: all LC4 neurons become a single LC4 node. This changes which routes can be found. For example, LC4 → PLP1 → DNp01 is found even if no single PLP1 neuron both receives input from an LC4 and connects to a DNp01.

`Min synapses` applies after the weights have been summed per cell type, so with `Collapse types` on it is a threshold on the total number of synapses between two cell types. With `Collapse types` off, it applies to individual neuron-to-neuron connections.

Each node in the `Network` output has a `neurons` column with the number of cells it stands for: 1 for an individual neuron, and for a cell type the number of distinct neurons of that type seen on the connections that were found. This works well as a size encoding in the [Network Viewer](#out.network).

> [!NOTE] `neurons` is a lower bound
> The count for a cell type is the largest number of distinct neurons seen on any one of its
> connections (counts from different connections can't be added up, because the same neurons
> appear on several). If a cell type reaches different partners through different members, the
> real number is larger. Read it as "at least this many".

## Normalizing weights

`Normalize` divides each connection by a total synapse count and adds two columns next to the raw `weight`: `weightNorm` (the fraction) and `weightTotal` (the total it was divided by). As in [Connectivity](#neuron.connectivity), `Normalize by` picks which end of the connection the total belongs to, and `Denominator` picks which synapses are counted.

With `Collapse types` on, the total is that of the whole cell type: for `LC4 → PLP1`, the weight is divided by the total input of all PLP1 neurons combined.

```coda-params
neuron.paths: normalize, normalizeBy, normalizeBasis, rankBy, minFraction
```

`Rank by` decides whether routes are ranked by their weakest link in synapses ("synapses (weakest link)") or as a fraction of the total ("fraction of the total"). The two can give quite different answers. On the bundled optic lobe data, searching from L1 to DNp02 in four hops:

- The routes through LPLC2 have 375 synapses at their weakest link, against 352 for the route through LC4, so ranked by synapses LPLC2 comes first.
- But LPLC2 gets only about 15% of its input from any one T4 subtype, whereas LC4 gets 61% of its input from Tm3. Ranked by fraction, the route through LC4 comes first by a factor of four.

Both numbers are reported for every route, whichever ranking you pick.

`Min fraction` is applied during the search, not to the final ranking: a connection below it is not followed, so whatever lies behind it never enters the network. Like `Min synapses`, this keeps the search smaller.

If the dataset does not publish a total for a connection, that connection is never dropped by `Min fraction`. A route containing it gets an empty `bottleneckNorm` and is ranked below all routes that could be scored.

> [!WARNING] Which datasets can normalize
> Normalizing needs per-neuron synapse totals. neuPrint publishes them; CAVE and CATMAID don't.
> A dataset with a local edge table (attached via `Edge data`) computes the totals from that file
> by summing each neuron's weights. An edge table can't tell neurons from fragments, so both
> `Denominator` options give the same number there.

## Outputs

- `Network`: the graph spanned by the routes that were found. Each node carries `role`, `hop`, `paths` and `neurons`.
- `Layout`: a fixed, layered left-to-right layout of that network. Wire it into the `Layout` input of a [Network Viewer](#out.network) to use it in place of the viewer's own layout. It has no settings.
- `Paths`: one row per route, ranked by its weakest link, with `rank`, `source`, `target`, `hops`, `bottleneck` and `path`. When normalizing it also has `bottleneckNorm`, but no denominator column: the weakest link in synapses and the weakest link as a fraction are often different hops. Look up each connection's own total in the `Network` output instead.
