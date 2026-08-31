A matrix drawn as a grid of coloured cells — the natural end of [Pivot](#core.pivot), [Similarity Matrix](#core.similarity), [NBLAST](#neuron.nblast) or Adjacency.

```coda-graph
caption: Feed Linkage's `Ordered`, not the raw matrix.
neuron.nblast as nb
cluster.linkage as link
out.heatmap as hm
nb -> link
link:ordered -> hm
```

**An unordered similarity matrix is visual noise.** The same numbers in leaf order show their clusters as blocks down the diagonal, which is what `Ordered` is for.

## Settings

```coda-params
out.heatmap: scale, showValues
```

Sequential for counts and fractions; diverging when zero is a meaningful middle, as it is after a log ratio. Everything else — the ramp, the range, the labels — is in the styling sidebar.

> [!NOTE] Put a [Normalize](#core.normalize) in front if one row dominates
> A heatmap of raw synapse counts is usually a picture of which cell type is numerous.

## More cells than pixels

The matrix is folded onto a grid of at most one cell per pixel, so drawing costs the card rather than the data — millions of cells are fine.

> [!WARNING] A folded block keeps its **strongest** cell, never the mean
> Averaging one strong connection across the hundred empty cells beside it would put it near the bottom of the ramp, and a connectivity matrix is mostly empty. The tooltip names the real row, column and value, and says `strongest of ~N cells` beside it.

Axis labels are thinned to a legible pitch when there are more of them than fit, and the caption counts what it dropped.
