## What UMAP does

Embedding uses [UMAP](https://umap-learn.readthedocs.io) to lay out neurons in two dimensions such that similar neurons end up close to each other. Briefly, UMAP builds a graph connecting each neuron to its nearest neighbours and then looks for a 2D arrangement that preserves those neighbourhoods as well as possible.

This is complementary to [Linkage](#cluster.linkage): Linkage tells you what the groups are, an embedding shows you how the population is laid out. Wire the output into a [Scatter Plot](#out.scatter) to look at it:

```coda-graph
caption: Embed neurons by their NBLAST similarity and plot the result.
neuron.skeletons as skel
neuron.nblast as nb
core.embed as em
out.scatter as sc
skel -> nb
nb -> em:matrix
em -> sc
```

## Reading the plot

> [!WARNING] Distances between clusters are meaningless
> UMAP preserves which neurons are neighbours, but not how far apart two unrelated groups are. Two
> clusters at opposite ends of the plot are not necessarily more different than two clusters that
> touch. For the same reason, the axes (`umap1` and `umap2`) carry no units.

UMAP is also stochastic: a different `Seed` gives you a different (but equally valid) layout. Changing the seed and checking whether a cluster survives is a cheap way to make sure it is real.

```coda-params
core.embed: neighbors, minDist, seed
```

`Neighbours` controls how local the structure is. Small values preserve fine detail but tend to break the plot into islands; large values preserve the overall shape. Note that the count includes the neuron itself, so the default of 15 means 14 neighbours.

`Min distance` only affects how tightly points can be packed together. It does not change who is a neighbour of whom.

> [!TIP] Use equal axis scaling
> By default, a Scatter Plot stretches its axes to fill the card, which distorts an embedding. Set
> `Aspect` to *equal scale* in the Scatter Plot's `Axes` tab (under the advanced settings).

## Inputs

There are three ways to feed neurons into this node. Use exactly one of them; wiring more than one gives an error.

| Port | Takes | Notes |
| --- | --- | --- |
| `Matrix` | [NBLAST](#neuron.nblast), [Similarity Matrix](#core.similarity), a [Pivot](#core.pivot) | The most common route. `Distance` works like it does in [Linkage](#cluster.linkage). |
| `Features` | [Partner Vectors](#neuron.partnerVectors), an uploaded table | Computes the similarity matrix for you. |
| `Neighbours` | [NBLAST k-NN](#neuron.nblastKnn), any `(from, to, score)` table | Never builds a full matrix. |

The `Features` port saves you a [Similarity Matrix](#core.similarity) node but is not any faster: it still computes all pairwise similarities. For large populations, use the `Neighbours` port instead. [NBLAST k-NN](#neuron.nblastKnn) compares each neuron only against a shortlist of candidates rather than against all other neurons:

```coda-graph
caption: Embed from nearest neighbours, without an all-by-all matrix.
neuron.skeletons as skel
neuron.nblastKnn as knn
core.embed as em
out.scatter as sc
skel -> knn
knn -> em:neighbours
em -> sc
```

Neurons that appear only as neighbours (i.e. never in the `from` column) get no point of their own and are dropped. The node tells you how many. If that number is large, check whether your NBLAST k-NN has its `Target` port wired: in that case it compares two different populations, which doesn't give you a single neighbourhood graph to embed.

## Embedding a subset

Wire a table of neurons into `Only these` to embed just those neurons. For example, you can lasso a group of points in a [Scatter Plot](#out.scatter) and pass its `Selected` output back in to get an embedding of just that group:

```coda-graph
caption: Re-embed a lasso selection.
annotation:bigclust as bc
out.scatter as sc
core.embed as em
bc:embedding -> sc
bc:neighbours -> em:neighbours
sc:selected -> em:only
```

Neighbours outside the selection are ignored, so neurons at the edge of the selection end up with fewer neighbours than before (the node reports how many). On the `Features` route, the selection is applied before the similarity matrix is computed, which also makes large populations cheaper.

## Colouring the plot

The output has four columns: `label`, `umap1`, `umap2` and `annotation`. There are two ways to get something to colour by:

- Wire a neuron table into `Annotations` and set `Match on` and `Label by`. This fills the `annotation` column.
- Use [Cut Tree](#cluster.cut) and a [Join](#core.join). Both nodes call their key column `label`, so the join works without any configuration and you get the embedding coloured by cluster.

> [!NOTE] Changing the annotation re-runs the embedding
> The annotation ends up in the output table, so changing `Match on` or `Label by` re-runs the
> node. With the same `Seed` you will get exactly the same layout back, it just takes a moment.

## Exporting

Coda uses [umap-js](https://github.com/PAIR-code/umap-js), a JavaScript implementation of UMAP. The Python notebook export uses `umap-learn` and the R Markdown export uses `uwot`, with the same settings.

All three implement the same algorithm but won't produce exactly the same layout, in the same way that two different seeds won't. The exported code includes a note to that effect.
