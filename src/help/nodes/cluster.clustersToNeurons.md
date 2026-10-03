[Cut Tree](#cluster.cut) assigns cluster numbers to leaf *names*, not neurons. Clusters to Neurons maps those cluster numbers back onto the neurons, so that every neuron carries its `cluster` (plus `order` and `size`). You can then e.g.:

- colour segments by cluster in [Neuroglancer](#out.neuroglancer)
- isolate one group with a Filter
- count members per cluster with a [Group By](#core.groupBy)

Wire it to Cut Tree's `Clusters` output, not to a [Dendrogram](#out.dendrogram)'s `Selected`: only `Clusters` covers every neuron.

This node does the same lookup as [Selected to Neurons](#cluster.selectedToNeurons). It matches against the neuron table you wire into `Neurons` rather than querying the dataset; see that node's help for details and for how `Match on` and `Suffix` work.

```coda-params
cluster.clustersToNeurons: labelColumn, matchColumn
```

If a label stands for several neurons (as a cell type does), every one of those neurons gets that cluster number.

> [!NOTE] No `cluster` column
> If the input table has no `cluster` column, the node warns you but still runs. This usually
> means a Dendrogram's `Selected` was wired in instead of Cut Tree's `Clusters`. The matching
> still works, there is just nothing to colour by.
