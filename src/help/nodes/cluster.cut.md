## What Cut Tree does

A tree from [Linkage](#cluster.linkage) contains every possible grouping of your neurons at once, from one group per neuron at the bottom to a single group at the top. Cut Tree picks one of those groupings and tells you which cluster each neuron ends up in.

Computing the tree can take a while, but cutting it is fast. That's why the two are separate nodes: you can try different cuts while looking at the [Dendrogram](#out.dendrogram) without re-running the clustering.

```coda-params
cluster.cut: mode, count, height, maxShare
```

## Ways to cut

`Cut by` offers three modes:

- **"number of clusters"** gives you exactly as many groups as you set in `Clusters`. Under the hood, the tallest merges in the tree are undone until there are that many groups.
- **"distance"** cuts across the tree at a fixed height: everything joined at or below `Distance` stays together. You get however many groups that produces. This is often the more natural question ("how similar do two neurons need to be to count as the same type?"). With NBLAST scores, a distance of 0.5 corresponds to a score of 0.5, so smaller values are stricter and give you more groups. If you cut above the top of the tree, you get a single cluster and the node tells you the tree's maximum distance.
- **"groups drawing from every dataset"** is for co-clustering two (or more) connectomes on a single tree, where the question is which groups contain neurons from *all* datasets. A count cut can't answer that: it will happily return a group of forty neurons that all come from the same dataset. Instead, this mode descends to the smallest groups in which every dataset is present and no dataset makes up more than `Largest share` of the group. The default of 0.8 means no group may be more than four-fifths one brain.

In the third mode, neurons that have no counterpart in the other dataset end up in clusters of their own. The node reports how many; that number is a result, not something to tune away.

> [!WARNING] Qualify ids before stacking
> The third mode reads each neuron's dataset from its qualified id, e.g.
> `flywire:720575940623374218`. So put a `Qualify Ids` on each branch before the
> [Stack Tables](#core.stack) that combines them (see [Partner Vectors](#neuron.partnerVectors)
> for an example). Without it, every neuron appears to come from the same dataset and everything
> comes back as a singleton. The node warns you if that happens.

> [!NOTE] Comparison with cocoa
> This mode is not a port of cocoa's `extract_homogeneous_clusters`. The criterion described
> above is Coda's own.

## Outputs

- `Clusters` is a table with one row per neuron: `label`, `cluster`, `order` and `size`. Join it back onto a neuron table to colour other views by cluster.
- `Tree` is the same tree with the cut recorded on it. A [Dendrogram](#out.dendrogram) wired to this output colours its branches by cluster automatically.

## An example workflow

```coda-graph
caption: Cut an NBLAST clustering into groups, look at them in a dendrogram and in Neuroglancer.
neuron.nblast as nb
cluster.linkage as link
cluster.cut as cut { mode: count, count: 6 }
out.dendrogram as dend
cluster.clustersToNeurons as back
out.neuroglancer as ng
nb -> link
link:tree -> cut
cut:tree -> dend
cut:clusters -> back:labels
back -> ng:neurons
```

(Not shown here: the neuron table that [Clusters to Neurons](#cluster.clustersToNeurons) matches against, and the `Dataset` input of Neuroglancer.)

[NBLAST](#neuron.nblast) and Linkage only run once, whereas everything from Cut Tree onwards is quick to re-run. So a typical loop is: look at the [Dendrogram](#out.dendrogram) (coloured by cluster because it is wired to `Tree`), change `Clusters` or `Distance`, and look again.

The lower branch uses [Clusters to Neurons](#cluster.clustersToNeurons) to attach the cluster numbers to a neuron table, so that [Neuroglancer](#out.neuroglancer), a [3D View](#out.viewer3d), a [Network](#out.network) or a [Scatter](#out.scatter) can colour by cluster. Make sure to wire that branch from `Clusters` and not from the Dendrogram's `Selected` output: `Selected` only contains whatever you clicked, while `Clusters` covers every neuron.
