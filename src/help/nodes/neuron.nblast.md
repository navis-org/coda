## What NBLAST does

NBLAST decomposes each neuron into *dotprops* - points with a **tangent vector** — and asks how well one set of them aligns with the other.

![A query neuron (red) against a target (black), and the point pairs the score is built from.](nblast-dotprops.png)

Four steps, for one query against one target:

1. **Nearest neighbour.** For each point + tangent vector of the query, find the closest point +
   tangent vector on the target — a plain nearest-neighbour search by Euclidean distance.
2. **Score that pair.** A weighted product of the distance `dᵢ` between the two points and the
   *absolute* dot product of the two tangent vectors `uᵢ · vᵢ`. Absolute, because which way a
   tangent points along a neurite carries no meaning.
3. **Sum.** Add those over every point of the query. One number per query–target pair.
4. **Normalise.** Divide by the query's score against itself, so a perfect match is 1.

Three important things following from the above:

- Neurons have to be in the same space for NBLAST to work. Neurons from different brains (or different
  hemispheres of the same brain) have to be aligned first.
- Scoring A against B is **not** scoring B against A: a small neuron can lie entirely inside a
  large one → see `Symmetry` parameter.
- The scoring matrix is calibrated on neurons sampled at **~1 microns** → see `Resample` parameter.

See also [Costa et al. (2016)](https://doi.org/10.1016/j.cub.2016.05.027) for the original NBLAST paper.

## The typical pipeline

```coda-graph
caption: Scores are a matrix, so clustering and both viewers take them unchanged.
dataset.hemibrain as ds
neuron.skeletons as skel
neuron.nblast as nb
cluster.linkage as link
out.heatmap as hm
out.dendrogram as dend
ds -> skel:dataset
skel -> nb:query
nb -> link
link:ordered -> hm
link:tree -> dend
```

1. **Skeletons** fetches the morphologies. Its `Neurons` input is whatever chose the cells — `Find
   Neurons`, `Explore`, or a pasted list.
2. **NBLAST** takes the skeletons, resamples them, converts to dotprops, and scores them pairwise. The output is either a square matrix (all-by-all) or a rectangular one (query-vs-target) with the similarity scores.
3. **[Linkage](#cluster.linkage)** turns the matrix into a merge tree. Scores are converted to distances
   automatically, because the matrix knows it carries similarities.
4. **Dendrogram** draws the tree
5. **Heatmap** takes Linkage's `Ordered` output which is the matrix in leaf order which shows structure in the data

## The settings that change what a score means

```coda-params
neuron.nblast: resample, symmetry, normalize
```

`Symmetry` decides what to publish when the two directions of a pair disagree:

| Setting                     | Publishes            | Symmetric | Use when                                       |
| --------------------------- | -------------------- | --------- | ---------------------------------------------- |
| `mean of both directions`   | the average          | yes       | the default; almost always this                |
| `weaker direction`          | the worse of the two | yes       | each neuron must match the other               |
| `stronger direction`        | the better of the two| yes       | one contained in the other should count        |
| `query against target only` | one direction        | **no**    | a query-vs-target matrix you will read row-wise |

## Gotchas

> [!WARNING] Neurons have to be in the same space for NBLAST to work. Neurons from different brains (or different hemispheres of the same brain) have to be aligned first!

> [!WARNING] Turning `Normalise` off makes scores incomparable between pairs
> The raw sum grows with the number of points, so a large neuron scores higher against
> everything. Normalised, 0.6 means "much of this neuron has a counterpart in that one" and a
> negative score means the two actively disagree. Off is for people who want the raw sums.

> [!WARNING] Setting `Resample` to `0` leaves each skeleton exactly as traced, which is right only when you
> know the whole set was traced the same way.

> [!WARNING] The first run downloads a Python runtime
> The scoring runs in Pyodide — about ten megabytes, fetched once per session. Every run after
> that is immediate, at roughly fifteen thousand pairs a second.

*The dotprop figure is from [navis](https://navis-org.github.io/navis/), after Costa et al.
(2016).*
