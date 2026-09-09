## What a linkage is

Clustering here is **agglomerative**: every neuron starts as its own group, the two closest groups merge, and that repeats until one group is left. The output — a *linkage* — is the record of that process: every merge, in order, with the distance it happened at.

```coda-graph
caption: The tree records the merges; Cut Tree turns them into groups.
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

The `Ordered` output is the input matrix with its rows and columns permuted into the tree's leaf order. That is the one to send to a Heatmap: an unordered [NBLAST](#neuron.nblast) matrix is visual noise, and the same numbers in leaf order show their clusters as blocks down the diagonal.

## Scores are not distances, and you do not have to worry about that

Clustering needs a distance — 0 for identical — and NBLAST produces a similarity, where 1 is identical. The conversion happens automatically, because a matrix carries what it measures.

```coda-params
caption: `Distance` is the setting that decides, and it is right by default.
cluster.linkage: distance
```

> [!WARNING] A matrix that says nothing about itself is assumed to be similarities
> A Pivot cannot know what its own numbers mean, so a pivoted matrix falls through to the
> similarity branch. If you pivoted something that is genuinely a distance, say so with `Distance`
> rather than letting `auto` invert it — the clustering succeeds either way, and the tree it draws
> is inside out.

## Choosing a method

`Method` is how the distance between two *groups* is measured once they hold more than one neuron, and it changes the shape of the tree more than any other setting.

| Method     | Behaviour                                                        |
| ---------- | ---------------------------------------------------------------- |
| `ward`     | keeps groups compact; what the NBLAST paper uses, and the default |
| `average`  | the other common choice; less eager to split off outliers         |
| `complete` | conservative — a group is only as close as its furthest member    |
| `single`   | chains: two clusters join through one intermediate neuron         |

`single` will merge two obviously distinct groups because one neuron sits between them, and the result reads as a single cluster.

## The matrix must be square, and symmetric

Linkage fails on a non-square matrix — a query-vs-target NBLAST, say. It also requires A→B to equal B→A, and **enforces that** through `Symmetry`; the default takes the mean of both directions.

```coda-params
caption: `Symmetry` decides how a matrix is made symmetric
cluster.linkage: symmetry
```
