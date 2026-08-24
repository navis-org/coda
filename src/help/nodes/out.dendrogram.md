Draws a [Hierarchical Clustering](#cluster.linkage) tree. It lets you interactively select branches and pass the selection to downstream widget. Often used in conjunction with [Cut Tree](#cluster.cut) to colour branches by cluster.

```coda-graph
caption: Draw a dendrogram with colored clusters and visualize selections in Neuroglancer. Not shown: `Neurons` and `Dataset`.
cluster.linkage as link
cluster.cut as cut
out.dendrogram as dend
cluster.selectedToNeurons as sel
out.neuroglancer as ng
link -> cut
cut:tree -> dend
dend:selected -> sel
sel -> ng
```

```coda-params
caption: Control appearance
out.dendrogram: orientation, showLabels
```
