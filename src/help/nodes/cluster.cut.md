A linkage tree holds every possible grouping at once. This node picks one: ask for a target number of groups, or cut across at a distance threshold. It is separate from [Hierarchical Clustering](#cluster.linkage) because the two are genuinely different acts — the tree is computed once and can be expensive, but the cut is something you try repeatedly while looking at the [Dendrogram](#out.dendrogram).

**By count vs. by distance.** If you ask for six clusters, you get exactly six — the algorithm undoes the tallest merges until there are that many groups. If you cut at a distance, you get however many groups fall out below the threshold, which is the honest way round when the question is "how alike do two neurons have to be to count as the same thing?" With NBLAST scores, a distance of 0.5 is a score of 0.5, so smaller means stricter and more groups. You can see the tree's maximum distance in the validation message if you cut above the top.

**Two outputs for two jobs.** `Clusters` is the table — one row per neuron with its cluster number — so you can join it back onto a neuron table and colour every downstream view by cluster. `Tree` is the same tree with the cut recorded on it, so a [Dendrogram](#out.dendrogram) wired to it is coloured by group automatically, without a second input or column picker.

```coda-params
cluster.cut: mode, count, height
```
