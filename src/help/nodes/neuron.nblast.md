## What NBLAST does

NBLAST ([Costa et al., 2016](https://doi.org/10.1016/j.cub.2016.05.027)) compares neurons by their morphology. Wire one set of skeletons into `Query` to compare all neurons against each other (all-by-all), or a second set into `Target` to compare one group against another. The output is a matrix of scores.

Briefly, NBLAST turns each neuron into *dotprops*: points with a tangent vector that describes the direction of the neurite at that point. It then asks how well the dotprops of one neuron line up with those of the other:

![A query neuron (red) against a target (black), and the point pairs the score is built from.](nblast-dotprops.png)

For one query neuron against one target neuron, that works like this:

1. For each point of the query, find the closest point on the target.
2. Score that pair of points based on the distance `dᵢ` between them and the absolute dot product of their tangent vectors `uᵢ · vᵢ`. The absolute value is used because it doesn't matter which way a tangent vector points along a neurite.
3. Add up the scores over all points of the query. This gives a single number for the pair.
4. Divide by the score of the query against itself, so that a perfect match is 1.

A few things follow from this:

- The neurons have to be in the same space. Neurons from different brains, or from different hemispheres of the same brain, have to be aligned first.
- Scoring A against B does not give the same result as scoring B against A: a small neuron can lie entirely inside a large one. See `Symmetry` below.
- The scoring is calibrated for neurons sampled at roughly 1 µm. See `Resample` below.

## A typical pipeline

```coda-graph
caption: NBLAST skeletons, cluster the scores and look at the results.
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

1. [Skeletons](#neuron.skeletons) fetches the neurons' morphologies. Its `Neurons` input takes whatever selected the neurons.
2. NBLAST resamples the skeletons, turns them into dotprops and scores them pairwise. With only `Query` wired you get a square (all-by-all) matrix; with `Target` wired, a rectangular (query-vs-target) one.
3. [Linkage](#cluster.linkage) clusters the matrix. The scores are converted to distances automatically.
4. A [Dendrogram](#out.dendrogram) shows the resulting tree.
5. A [Heatmap](#out.heatmap) shows Linkage's `Ordered` output, i.e. the matrix sorted so that clusters appear as blocks.

## Settings

```coda-params
neuron.nblast: resample, symmetry, normalize
```

`Symmetry` decides what to do when the two directions of a pair give different scores:

| Setting                     | Gives you            | Symmetric | Use when                                          |
| --------------------------- | -------------------- | --------- | ------------------------------------------------- |
| "mean of both directions"   | the average          | yes       | the default; almost always what you want          |
| "weaker direction"          | the lower score      | yes       | each neuron has to match the other                |
| "stronger direction"        | the higher score     | yes       | one neuron lying inside the other should count    |
| "query against target only" | one direction        | no        | a query-vs-target matrix you will read row by row |

`Resample` sets the spacing of the points in µm. 1 µm is the convention; setting it to 0 leaves each skeleton exactly as it was traced, which is only a good idea if you know that all neurons were traced the same way.

`Normalise` (under the advanced settings) divides each score by the query's score against itself. With normalisation on, a score of 0.6 means that a good part of the query neuron has a counterpart in the target, and a negative score means the two actively disagree. If you turn it off, the raw scores grow with the number of points, so large neurons score higher against everything and scores can't be compared between pairs.

## Things to keep in mind

> [!WARNING] Align neurons first
> Neurons from different brains, or from different hemispheres of one brain, have to be brought
> into the same space with [Transform Neurons](#neuron.xform) or [Mirror Neurons](#neuron.mirror)
> before NBLAST can compare them.

> [!NOTE] The first run downloads Python
> The scoring runs in Pyodide, an in-browser Python runtime of about 10 MB that is downloaded once
> per session. After that, NBLAST scores roughly 15,000 pairs per second.

For large populations, consider [NBLAST k-NN](#neuron.nblastKnn), which only scores each neuron against a shortlist of likely matches instead of against every other neuron.

*The dotprops figure is from [navis](https://navis-org.github.io/navis/), after Costa et al. (2016).*
