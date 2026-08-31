```coda-graph
caption: Any table with two id columns will do; Connectivity is the usual one.
neuron.connectivity as conn
net.build as build
out.network as net
conn -> build:edges
build -> net
```

```coda-params
net.build: source, target, weight, directed, aggregate
```

Leave `Weight` empty to weight every link by **how many rows** connect the pair.

## Merging parallel links

`Merge parallel links` collapses every row connecting the same pair into one link.

> [!WARNING] Weights add. Nothing else does.
> Nothing in a column's type separates a measure from an identifier, and summing `preId` produced noise offered to the size pickers. **A value survives a merge only when every merged row agrees on it**, and is left empty otherwise.

`Keep columns` chooses which edge attributes ride along — an ROI, a transmitter, a sign. Empty carries every column the links do not already represent.

## Node attributes

The optional `Node attrs` input is an ordinary table of one row per node — cell type, side, neurotransmitter. `Join on` names the column in it holding the ids that `Source`/`Target` use. Can be used to e.g. color nodes in the [Network Viewer](#out.network) or to filter the network.

> [!WARNING] The node set comes from the surviving links
> `Node attrs` adds columns, never nodes — a row in it whose id appears in no edge is not in the network. And raising `Min link weight` drops nodes as well as links, since a node whose every link fell below it now appears nowhere.
