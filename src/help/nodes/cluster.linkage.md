## What Linkage does

Linkage runs agglomerative clustering: every neuron starts out as its own group, the two closest groups are merged, and this repeats until only one group is left. The output (the *linkage*) records each merge and the distance at which it happened.

The typical use is clustering neurons by their [NBLAST](#neuron.nblast) scores:

```coda-graph
caption: Cluster NBLAST scores, then look at the tree, the reordered matrix and the groups.
neuron.nblast as nb
cluster.linkage as link
out.dendrogram as dend
out.heatmap as hm
cluster.cut as cut
nb -> link
link:tree -> dend
link:ordered -> hm
link:tree -> cut
```

There are two outputs:

- `Tree` is the linkage itself. Feed it into a [Dendrogram](#out.dendrogram) to look at it, or into [Cut Tree](#cluster.cut) to turn it into groups.
- `Ordered` is the input matrix with rows and columns sorted into the order of the tree's leaves. Send this one to a [Heatmap](#out.heatmap): in leaf order, clusters show up as blocks along the diagonal.

## Input

Linkage needs a square matrix over a single population, e.g. an all-by-all NBLAST. A query-vs-target NBLAST is not square and will fail.

The matrix also has to be symmetric. NBLAST scores are not (A→B is never exactly B→A), so `Symmetry` combines the two directions first. The default uses the mean, which is also what we would recommend for NBLAST.

```coda-params
cluster.linkage: symmetry
```

## Similarities vs. distances

Clustering works on distances, where 0 means identical. NBLAST gives you similarities, where 1 means identical. You don't have to do anything about this: by default, `Distance` checks what the matrix contains and inverts similarities for you.

```coda-params
cluster.linkage: distance
```

> [!WARNING] Pivoted matrices are assumed to contain similarities
> A matrix coming out of a [Pivot](#core.pivot) does not know what its numbers mean, so `auto`
> treats them as similarities. If they are in fact distances, set `Distance` to "the values are
> already distances". Otherwise the clustering still runs but the tree comes out inside out.

## Choosing a method

`Method` determines how the distance between two groups is calculated once they contain more than one neuron. Of all the settings, this one has the biggest effect on the shape of the tree:

| Method     | Behaviour                                                              |
| ---------- | ---------------------------------------------------------------------- |
| `ward`     | keeps groups compact; used in the NBLAST paper and the default here     |
| `average`  | the other common choice; less eager to split off outliers               |
| `complete` | conservative: a group is only as close as its furthest member           |
| `single`   | tends to chain groups together through single intermediate neurons      |

If in doubt, stick with `ward`. Be careful with `single`: two clearly distinct groups will be merged as soon as a single neuron sits between them.
