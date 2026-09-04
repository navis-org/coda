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

| Metric               | Keeps                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `Cosine`             | measures direction of the feature vector, not its magnitude; the usual choice |
| `Jaccard (presence)` | boolean: weights ignored entirely, and a zero counts as absent                |
| `Jaccard (weighted)` | presence and weight                                                           |
| `Pearson`            | the weights, as a correlation                                                 |
| `Euclidean`          | the magnitude too, so it separates by how much as well as by what             |

`Cells are` determines the output: similarities or distances (1 − similarity). The output matrix know what it is — so [Linkage](#cluster.linkage) downstream needs nothing set either way. A heatmap is usually easier to read as similarities.

> [!WARNING] The matrix is N²
> It is square in the number of observations, so this works at low thousands: "compare these three hundred neurons across two brains", not "co-cluster two connectomes".

## Two brains in one matrix

Neurons from two connectomes can go into the same matrix, and then a MaleCNS neuron and a FlyWire neuron can land in the same cluster. Nothing here is special-cased for it — the node compares whatever rows it is given — which is exactly why the two ways it goes wrong are the caller's to avoid.

```coda-graph
caption: The two branches meet at Stack Tables. What arrives here is one long table whose rows come from two brains.
neuron.partnerVectors as pvA
neuron.partnerVectors as pvB
core.qualifyIds as qA { prefix: malecns }
core.qualifyIds as qB { prefix: flywire }
core.stack as stack
core.similarity as sim { layout: long, metric: cosine }
cluster.linkage as link
pvA -> qA
pvB -> qB
qA -> stack:top
qB -> stack:bottom
stack -> sim
sim -> link
```

**`Observations` must be unique across the whole stack.** Body ids are per-dataset, so neuron 12345 exists in both brains and is two different cells. Stacked raw, they are one row here, holding the union of two neurons' connectivity. A `Qualify Ids` on each branch rewrites the id to `malecns:12345` / `flywire:12345` before the stack, which is what keeps them apart.

**`Features` must be a shared vocabulary**, or the answer is a plausible-looking lie. If the two branches name their partners in their own dataset's terms, no feature appears in both, every cross-brain cell is 0, and the result is a clean block-diagonal heatmap that clusters each brain perfectly on its own. That is not a finding about the brains; it is the matrix reporting that it was given two disjoint feature sets. Wire `Labels` from [Match Cell Types](#compare.matchTypes) into each [Partner Vectors](#neuron.partnerVectors) so both sides emit the same feature names.

> [!TIP] Sanity-check the picture, not just the numbers
> Put a [Heatmap](#out.heatmap) on the matrix before clustering. Two dark blocks on the diagonal with nothing between them is the failure above. A real cross-brain result has visible structure off the diagonal.

`Cosine` earns its default here: it ignores overall magnitude, so a neuron reconstructed in a denser dataset is not made dissimilar to its counterpart by sheer synapse count. It does not fix a systematic difference in _which_ partners were detected — for that, set `Weights` to fractions on Partner Vectors.

Downstream, [Cut Tree](#cluster.cut)'s mixed mode reads each neuron's brain back off its qualified id and returns the deepest clusters that still hold both.
