```coda-graph
caption: The card reads the network; the two tables leave by their own ports.
net.build as build
net.metrics as met
out.network as viewer
build -> met
met -> viewer
```

Three outputs, one pass over the links. `Network` is the input carrying on with every per-node metric written onto its nodes, so a viewer downstream can colour or size by `clustering` or `component` with no extra wiring. `Node stats` is the same numbers as a plain table. `Summary` is one wide row about the graph as a whole, which makes it stackable: run this inside a [For Each](#flow.forEach) over five datasets, [Collect](#flow.collect) the rows, and a bar chart of density across connectomes is a column picker.

## The summary row

One row, one column per number. The ones worth explaining:

| Column | What it says |
| --- | --- |
| `density` | Links present out of links possible. It falls fast as a network grows, so it only compares graphs of similar size. |
| `meanDegree`, `medianDegree` | Partners per node. A mean far above the median means a few hubs are carrying the average. |
| `reciprocity` | Share of connections that also run the other way. Always 1 without arrows, so it is left out on an undirected network. |
| `components` | How many separate pieces the network is in. `largestComponent` is the size of the biggest. |
| `isolated` | Nodes with no links at all. Usually the leftovers of a filter. |
| `meanClustering` | Averaged over nodes: of my partners, what share are connected to each other? Every node counts once, so nodes with two or three partners dominate it. |
| `transitivity` | The same question asked of the whole graph at once, so the hubs dominate instead. When the two are far apart, the network is hubs plus small tight groups. |
| `assortativity` | Do well-connected nodes attach to other well-connected nodes? Above 0 means like joins like, below 0 means hubs join leaves. Empty when every node has the same number of partners. |
| `selfLoops` | Links from a node to itself. Counted in degree and nowhere else. |
| `parallelLinks` | Extra rows connecting a pair that was already connected. Above 0 means `Merge parallel links` is off upstream in [Build Network](#net.build). |
| `totalWeight`, `meanWeight`, … | The link weights — synapse counts, on a connectivity network. |

## The per-node columns

`degreeIn`, `degreeOut` and `degree` count partners; `weightIn`, `weightOut` and `strength` add up the weights instead. The other three:

- **`clustering`** — of this node's partners, the share that are connected to each other. Empty for a node with fewer than two partners, which is a question that does not apply rather than a zero.
- **`coreness`** — the k-core number. Repeatedly throw away every node with fewer than *k* partners; `coreness` is the largest *k* this node survives. A high value means it sits in a densely wired core, with no threshold to pick.
- **`component`, `componentSize`** — which piece the node is in, numbered largest first, and how big that piece is.

> [!NOTE] The three groups count different things
> **Clustering, transitivity, k-core, components and assortativity** run on the undirected graph with repeats and self-loops removed: a pair connected both ways is one neighbour relationship, and no node is its own neighbour. **Density and reciprocity** keep the arrows — a reciprocal pair is two of the possible connections — but still ignore repeats and self-loops. **Degree, strength and the weight columns** count every link exactly as it arrives, self-loops included.

> [!WARNING] These names are written over, not beside
> A network arriving here usually already carries `degreeIn` and friends from [Build Network](#net.build), and those are replaced. A `component` or `strength` column you joined on yourself is replaced too, and the node says so. Two columns with one name would give a picker downstream two answers, and the stale one wins as often as not.

## The two plots, and their controls

The controls sit on the plots, in the tile headings.

The **scatter** takes any two numeric node columns, so it answers "are the hubs the clustered ones?" without a second node. Wire [Network Centrality](#net.centrality) in upstream and `betweenness` and `community` join the same two pickers.

The **histogram** bins any one of three things: a numeric node column, a link column, or the component sizes. Link and component entries are prefixed in the list, because `weight` is a word both a node and a link can carry. Its bin field takes **0 for automatic**.

`Vertical bars` draws it as columns instead of rows. Rows are the default because a bin's label is a range like `11–17`, and rotated under a column those stay readable to about a dozen bins and no further.

```coda-params
net.metrics: histColumn, plotX, plotY, bins, histVertical, logScale
```

`Log counts` bins in log10 as well as scaling the bars, and says how many rows sat at zero — a degree of 0 has no logarithm, and those are the isolated nodes. A connectome's degree distribution has a long tail, so on a straight scale every bar past the second is an invisible sliver.

None of these changes the data. All three outputs hold the same numbers whatever the card is set to.

## What is not here

Betweenness, closeness, PageRank and communities are [Network Centrality](#net.centrality), a separate node: they need the whole graph walked from every node, which is far too slow to redo on every edit. Wire it in upstream and its columns show up in these pickers.
