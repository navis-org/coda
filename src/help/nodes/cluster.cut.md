A linkage tree holds every possible grouping at once. This node picks one: ask for a target number of groups, cut across at a distance threshold, or — when two connectomes were clustered together — cut wherever a group is lopsided.

It is separate from [Hierarchical Clustering](#cluster.linkage) because the tree is computed once and can be expensive, where the cut is something you try repeatedly while looking at the [Dendrogram](#out.dendrogram).

**By count vs. by distance.** Ask for six clusters and you get exactly six — the algorithm undoes the tallest merges until there are that many groups. Cut at a distance and you get however many groups fall out below the threshold, which is the honest way round for "how alike do two neurons have to be to count as the same thing?" With NBLAST scores a distance of 0.5 is a score of 0.5, so smaller means stricter and more groups. The tree's maximum distance is in the validation message if you cut above the top.

**Groups drawing from every dataset.** The third mode is for co-clustering: two brains' neurons on one tree, where the question is which groups contain neurons from *both*. A count cut cannot ask that — it will hand back a group of forty neurons all from one dataset. This mode descends to the *deepest* groups in which every dataset is present and none holds more than `Largest share`. Neurons with no counterpart fall out alone, and that count is a result rather than a setting to tune away.

> [!WARNING] The mixed mode reads each neuron's dataset from its qualified id
> `flywire:720575940623374218` — so put a **Qualify Ids** on each branch before the
> [Stack Tables](#core.stack) that combined them. Without it every neuron looks like one dataset,
> no group can draw from two, and everything comes back a singleton. The node says so.

This mode is *not* a port of cocoa's `extract_homogeneous_clusters` — the criterion above is Coda's own, written out so the two can be compared.

**Two outputs for two jobs.** `Clusters` is the table — one row per neuron with its cluster number — to join back onto a neuron table and colour every downstream view by cluster. `Tree` is the same tree with the cut recorded on it, so a [Dendrogram](#out.dendrogram) wired to it is coloured by group automatically.

## An example workflow

```coda-graph
caption: One cut, two jobs. Not shown: the neuron table `Clusters to Neurons` matches against, and Neuroglancer's `Dataset`.
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

Everything left of this node is `expensive` and runs once; everything right of it is cheap. So the loop you work in is: read the [Dendrogram](#out.dendrogram) — coloured by group, because it is wired to `Tree` — change `Clusters` or `Distance`, look again. The [NBLAST](#neuron.nblast) above never re-runs.

The lower branch is the other half: [Clusters to Neurons](#cluster.clustersToNeurons) joins the `Clusters` table back onto a neuron table, so every neuron carries its cluster number and [Neuroglancer](#out.neuroglancer) — or a [3D View](#out.viewer3d), a [Network](#out.network), a [Scatter](#out.scatter) — colours by it. Wire that branch from `Clusters`, not from a Dendrogram's `Selected`: `Selected` is whatever you clicked, and only `Clusters` covers every neuron.

```coda-params
cluster.cut: mode, count, height, maxShare
```
