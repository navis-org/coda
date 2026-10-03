Network Metrics computes standard graph statistics for a network: degree, clustering, k-core, connected components, density and so on. The card shows a few summary numbers plus two plots, a scatter and a histogram, to explore them.

```coda-graph
caption: Compute metrics for a network and pass it on to a viewer.
net.build as build
net.metrics as met
out.network as viewer
build -> met
met -> viewer
```

There are three outputs:

- `Network` is the input network with every per-node metric added to its nodes. A viewer downstream can therefore colour or size nodes by e.g. `clustering` or `component` without any extra wiring.
- `Node stats` has the same per-node numbers as a plain table.
- `Summary` is a single row of statistics for the network as a whole. Because it is always one row, you can stack several: for example, run this node inside a [For Each](#flow.forEach) over five datasets, [Collect](#flow.collect) the rows, and plot density across connectomes in a bar chart.

## The summary row

Most columns are self-explanatory. The ones worth explaining:

| Column | What it says |
| --- | --- |
| `density` | Links present out of all possible links. Density drops quickly as networks get bigger, so only compare networks of similar size. |
| `meanDegree`, `medianDegree` | Partners per node. A mean far above the median means a few hubs are pulling up the average. |
| `reciprocity` | The fraction of connections that also run the other way. Left out for undirected networks, where it would always be 1. |
| `components` | How many separate pieces the network falls into. `largestComponent` is the size of the biggest one. |
| `isolated` | Nodes without any links. Usually the leftovers of a filter. |
| `meanClustering` | For each node: what fraction of its partners are connected to each other? Then averaged across nodes. Every node counts once, so nodes with only two or three partners dominate this number. |
| `transitivity` | The same question asked of the whole network at once, so here the hubs dominate. If the two numbers are far apart, the network is likely made up of hubs plus small, tightly connected groups. |
| `assortativity` | Do well-connected nodes connect to other well-connected nodes? Above 0 means they do; below 0 means hubs tend to connect to poorly connected nodes. Empty if all nodes have the same number of partners. |
| `selfLoops` | Links from a node to itself. These are counted towards degree but nothing else. |
| `parallelLinks` | Extra links between a pair of nodes that are already connected. If this is above 0, `Merge parallel links` is switched off in [Build Network](#net.build) upstream. |
| `totalWeight`, `meanWeight`, … | Statistics on the link weights, i.e. synapse counts on a connectivity network. |

## Per-node columns

`degreeIn`, `degreeOut` and `degree` count partners; `weightIn`, `weightOut` and `strength` add up the link weights instead. In addition there are:

- `clustering`: the fraction of this node's partners that are connected to each other. Empty for nodes with fewer than two partners, for which the question doesn't apply.
- `coreness`: the node's k-core number. Imagine repeatedly removing every node with fewer than *k* partners; `coreness` is the largest *k* at which this node is still left. High values mean the node sits in a densely connected core, without you having to pick a threshold.
- `component` and `componentSize`: which piece of the network the node belongs to (numbered from largest to smallest) and how big that piece is.

> [!NOTE] What counts as a link
> The metrics don't all treat links the same way:
>
> - Clustering, transitivity, k-core, components and assortativity treat the network as
>   undirected, with repeated links and self-loops removed. A pair connected in both directions
>   counts as one pair of neighbours.
> - Density and reciprocity respect the direction of links (a reciprocal pair counts as two
>   connections) but also ignore repeated links and self-loops.
> - Degree, strength and the weight columns count every link as it comes in, including
>   self-loops.

> [!WARNING] Existing columns are overwritten
> Networks coming from [Build Network](#net.build) already have `degreeIn` and similar columns;
> these are replaced. The same goes for a `component` or `strength` column you joined on yourself.
> The node tells you when this happens.

## The plots

The plot settings are in the headings of the two plots (and also under the advanced settings):

```coda-params
net.metrics: histColumn, plotX, plotY, bins, histVertical, logScale
```

The scatter plots any two numeric node columns against each other, e.g. to check whether the hubs are also the highly clustered nodes. If you wire [Network Centrality](#net.centrality) in upstream, its columns (`betweenness`, `community`, …) show up in the same pickers.

The histogram shows the distribution of either a numeric node column, a link column, or the component sizes. Link and component entries are marked as such in the `Distribution` list, since e.g. `weight` can exist on both nodes and links. Set `Bins` to 0 to choose the number of bins automatically.

By default the histogram is drawn with horizontal bars, which keeps the bin labels (ranges like `11–17`) readable. Tick `Vertical bars` to draw columns instead, but expect the labels to get crowded beyond a dozen or so bins.

`Log counts` bins the values on a log10 scale and scales the bars logarithmically. This is useful because a connectome's degree distribution typically has a long tail: on a linear scale, all bars past the first couple are barely visible. Values of zero have no logarithm (for degree, those are the isolated nodes), so the plot tells you how many it left out.

None of these settings change the data. All three outputs contain the same numbers regardless of what the plots show.

## Centrality

Betweenness, closeness, PageRank and communities are computed by a separate node, [Network Centrality](#net.centrality). They are much slower to compute because they require walking the whole network from every node, so that node only runs when you hit **Run**.
