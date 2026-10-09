Build Network turns an edge table into a network of nodes and links that you can draw in the [Network Viewer](#out.network) or analyse with [Network Metrics](#net.metrics) and [Network Centrality](#net.centrality). Any table with two id columns will do; the usual input is a [Connectivity](#neuron.connectivity) edge list:

```coda-graph
caption: Turn a connectivity table into a network and draw it.
neuron.connectivity as conn
net.build as build
out.network as net
conn -> build:edges
build -> net
```

## Settings

```coda-params
net.build: source, target, weight, directed, aggregate
```

Pick the two id columns as `Source` and `Target`, and the column holding the connection strength (e.g. `weight` on a connectivity table) as `Weight`. If you leave `Weight` empty, each link is weighted by the number of rows that connect the pair.

The columns you pick are renamed on the way out: links carry `source`, `target`, `weight` and `edges` (the number of rows behind each link), and nodes carry `id`, `degreeIn`, `degreeOut`, `weightIn` and `weightOut`. Those are the names downstream column pickers will show you.

## Merging parallel links

With `Merge parallel links` ticked (the default), all rows connecting the same pair are collapsed into a single link and their weights are added up. On an undirected network, A→B and B→A count as the same pair.

`Keep columns` lets you carry other edge attributes onto the links, e.g. an ROI, a transmitter or a sign. Leave it empty to carry every column that isn't already used as source, target or weight.

> [!WARNING] Only the weight is summed
> When links are merged, every other column keeps its value only if all merged rows agree on it.
> If they don't (say, a connection spread over five ROIs), the cell is left empty. Numeric
> columns are not added up either, since a column like `preId` is a number but not a quantity. If
> you need a second summed column, use a [Group By](#core.groupBy) upstream.

## Node attributes

The optional `Node attrs` input takes a table with one row per node, e.g. with cell type, side or neurotransmitter. Set `Join on` (under the advanced settings) to the column in that table that holds the same ids as `Source` and `Target`. The attributes can then be used to colour nodes in the [Network Viewer](#out.network) or to filter the network.

> [!NOTE] Nodes come from the links
> `Node attrs` only adds columns. A row whose id doesn't appear in any link does not become a
> node. Likewise, raising `Min link weight` removes nodes as well as links: a node whose links all
> fall below the threshold disappears from the network.
