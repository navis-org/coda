Compares every observation with every other over its features, as the square matrix a [Linkage](#cluster.linkage) or a [Heatmap](#out.heatmap) takes.

Although any feature works, this node was written for connectivity. Because
connectivity is typically sparse, it reads the long form (i.e. a sparse matrix) directly rather than pivoting first - that's what makes it scale. Wide format is supported too but not recommended for large datasets.

```coda-graph
caption: Connectivity similarity is the case it was written for.
neuron.partnerVectors as pv
core.similarity as sim
out.heatmap as hm
pv -> sim
sim -> hm
```

## Layout decides which pickers you get

```coda-params
core.similarity: layout, metric, output
```

**Long** is a table of triplets — observation, feature, value. It is what [Partner Vectors](#neuron.partnerVectors) and Group By produce, and **the only form that scales**: neuron connectivity is typically very sparse (<<1%).

**Wide** is one row per observation with a column per feature — what an uploaded feature vector looks like. Pick `Id column` and `Feature columns`.

> [!NOTE] Leaving `Value` empty asks a different question
> The vector is 1 wherever a pair is listed at all, however many rows list it — whether two observations touch the same features, rather than how hard.

## Metrics

| Metric               | Keeps                                                                |
| -------------------- | -------------------------------------------------------------------- |
| `Cosine`             | measures direction of the feature vector, not its magnitude; the usual choice |
| `Jaccard (presence)` | boolean: weights ignored entirely, and a zero counts as absent |
| `Jaccard (weighted)` | presence and weight                                                  |
| `Pearson`            | the weights, as a correlation                                        |
| `Euclidean`          | the magnitude too, so it separates by how much as well as by what    |

`Cells are` determines the output: similarities or distances (1 − similarity). The output matrix know what it is — so [Linkage](#cluster.linkage) downstream needs nothing set either way. A heatmap is usually easier to read as similarities.

> [!WARNING] The matrix is N²
> It is square in the number of observations, so this works at low thousands: "compare these three hundred neurons across two brains", not "co-cluster two connectomes".
