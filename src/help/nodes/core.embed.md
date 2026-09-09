Lays a neighbourhood graph out in two dimensions with UMAP, so a population you can only measure pairwise becomes a picture.

[Linkage](#cluster.linkage) answers what the *groups* are; this answers what the *neighbourhood* looks like. UMAP builds a fuzzy k-nearest-neighbour graph and then searches for the 2D arrangement whose own neighbourhood graph is most like it. Wire the result into a [Scatter Plot](#out.scatter).

```coda-graph
caption: The usual chain. NBLAST says how alike every pair is; this arranges them; the scatter draws it.
neuron.skeletons as skel
neuron.nblast as nb
core.embed as em
out.scatter as sc
skel -> nb
nb -> em:matrix
em -> sc
```

## What it preserves, and what it does not

> [!WARNING] Distance between clusters means nothing
> UMAP is faithful about *who is near whom* and says nothing about how far apart two groups that share no neighbours are. Two blobs at opposite ends of the card are not more different than two that touch — read membership, not geometry. The axes are unlabelled for the same reason: `umap1` and `umap2` are not measurements of anything.

It is also **stochastic**. A different `Seed` gives a different — equally valid — picture of the same neighbourhoods, so changing it and looking again is the cheapest check that a group you are reading off the plot is real.

```coda-params
caption: The three that decide the picture. Neighbours counts the neuron itself, so 15 means 14 neighbours.
core.embed: neighbors, minDist, seed
```

`Neighbours` is how local the structure is: small values keep fine detail and break the picture into islands, large ones preserve the overall shape. `Min distance` changes only how tightly points may pack — it moves the drawing, never the neighbourhoods.

> [!NOTE] Set the Scatter Plot's `Aspect` to *equal scale*
> A scatter's default is to fill its card, which stretches one axis against the other. On an
> embedding that is a claim about the data, since a UMAP's two axes carry the same units and
> nothing else. The control is in the Scatter's `Axes` tab, under the advanced settings.

## Three ways in, and only one of them is wired

The Matrix, Features and Neighbours ports are **alternatives**. Wiring more than one is refused rather than ranked.

| Port | Takes | Notes |
| --- | --- | --- |
| `Matrix` | [NBLAST](#neuron.nblast), [Similarity Matrix](#core.similarity), a [Pivot](#core.pivot) | The usual route. `Distance` reads the matrix the way Linkage does. |
| `Features` | [Partner Vectors](#neuron.partnerVectors), an uploaded table | Builds the similarity matrix itself, so no second card. |
| `Neighbours` | [NBLAST k-NN](#neuron.nblastKnn), any `(from, to, score)` table | The only route that never builds a matrix. |

> [!NOTE] The Features port is a convenience, not a speed-up
> It folds a [Similarity Matrix](#core.similarity) card in, and still builds that matrix — so it is square in the number of neurons exactly as doing it in two cards would be. The route that escapes the quadratic is `Neighbours`, because [NBLAST k-NN](#neuron.nblastKnn) scores each neuron against a shortlist rather than against everything.

```coda-graph
caption: The route that skips the all-by-all matrix.
neuron.skeletons as skel
neuron.nblastKnn as knn
core.embed as em
out.scatter as sc
skel -> knn
knn -> em:neighbours
em -> sc
```

A neighbour that never appears as a *from* has no point of its own and is dropped — the card says how many. A large count there usually means an NBLAST k-NN with `Target` wired, which compares two different populations and has no single neighbourhood to lay out.

## Colouring the plot

The output is `label`, `umap1`, `umap2` and `annotation`. Two ways to get something to colour by:

- Wire a neuron table into **Annotations** and set `Match on` and `Label by`. That fills the `annotation` column.
- Or wire [Cut Tree](#cluster.cut) and a [Join](#core.join). Both nodes call their key `label`, so the join needs nothing configured, and the result is the embedding coloured by cluster.

> [!NOTE] Relabelling re-runs the embedding
> Unlike a [Dendrogram](#out.dendrogram)'s leaf labels, these two pickers are *data*: the label leaves this node in a table, and a Scatter Plot's colour picker reads real columns. At a fixed `Seed` the identical arrangement comes back, so it costs time rather than moving the picture.

## Exporting it

Coda runs [umap-js](https://github.com/PAIR-code/umap-js), a JavaScript implementation, because the reference `umap-learn` needs numba and the in-browser Python runtime has none. The notebook export emits `umap-learn` and the R Markdown export emits `uwot`, with the same settings carried across by name.

All three are the same algorithm and none will draw quite the same arrangement as another — which is what two seeds of any one of them already do. The generated cell says so where it stands.
