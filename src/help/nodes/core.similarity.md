## What Similarity Matrix does

Similarity Matrix compares every observation (typically a neuron) with every other one over a set of features, and returns the result as a square matrix. That matrix can go straight into a [Linkage](#cluster.linkage) for clustering or into a [Heatmap](#out.heatmap).

You can use any kind of feature, but the most common case is connectivity: two neurons are similar if they connect to the same partners. [Partner Vectors](#neuron.partnerVectors) produces exactly the input this node needs:

```coda-graph
caption: Compare neurons by their connectivity and draw the result.
neuron.partnerVectors as pv
core.similarity as sim
out.heatmap as hm
pv -> sim
sim -> hm
```

## Input layout

```coda-params
core.similarity: layout, metric, output
```

`Layout` tells the node how your features are arranged:

- "Long (one row per pair)" is a table with one row per observation and feature, e.g. `neuronId`, `feature`, `weight`. This is what [Partner Vectors](#neuron.partnerVectors) and [Group By](#core.groupBy) produce. Pick the `Observations`, `Features` and `Value` columns.
- "Wide (one column per feature)" is a table with one row per observation and one column per feature, which is what an uploaded table of feature vectors usually looks like. Pick the `Id column` and the `Feature columns`.

Use the long layout whenever you can. Connectivity is very sparse (most neurons don't connect to most others), and the long layout only stores the connections that actually exist. That is what lets this node handle large populations.

If you leave `Value` empty, every listed pair counts as 1, no matter how many rows list it. You then compare *whether* two neurons share partners, not how strongly they connect to them.

## Metrics

| Metric | Compares |
| --- | --- |
| "Cosine" | the direction of the feature vectors, ignoring their overall size: a strongly and a weakly connected neuron with the same partners come out alike. The default, and usually the right choice |
| "Jaccard (presence)" | only which features are present; weights are ignored and a zero counts as absent |
| "Jaccard (weighted)" | which features are present, and with what weight |
| "Pearson" | the weights, as a correlation |
| "Euclidean" | the weights including their overall size, so a strongly and a weakly connected neuron come out different even if they have the same partners |

`Cells are` decides whether the matrix contains similarities or distances (1 − similarity). [Linkage](#cluster.linkage) handles either without you having to set anything; for a heatmap, similarities are usually easier to read. "Euclidean" is a distance by nature, so the setting is hidden for it.

> [!WARNING] The matrix grows with the square of the number of neurons
> 300 neurons give you 90,000 cells, 3,000 neurons 9 million. In practice this node works up to a
> few thousand neurons, and the node warns you when a comparison gets expensive.

## Comparing neurons across two datasets

You can put neurons from two connectomes into the same matrix, so that e.g. a male CNS neuron and a FlyWire neuron can end up in the same cluster. The node itself doesn't treat this case any differently: it compares whatever rows it gets. Two things are up to you to get right:

```coda-graph
caption: Two datasets, each with qualified ids, stacked into one table and compared.
neuron.partnerVectors as pvA
neuron.partnerVectors as pvB
core.qualifyIds as qA { prefix: malecns }
core.qualifyIds as qB { prefix: flywire }
core.stack as stack
core.similarity as sim { layout: long, metric: cosine }
cluster.linkage as link
pvA -> qA
pvB -> qB
qA -> stack:in1
qB -> stack:in2
stack -> sim
sim -> link
```

**Ids have to be unique across both datasets.** Body ids are per dataset, so neuron 12345 can exist in both brains as two different cells. Stacked as they are, they would be treated as a single neuron with the combined connectivity of both. Put a Qualify Ids node on each branch before the [Stack Tables](#core.stack) to turn the ids into `malecns:12345` and `flywire:12345`.

**Features have to use the same names in both datasets.** If each branch names partners in its own dataset's terms, no feature appears in both, every cross-dataset similarity is 0, and the heatmap shows two clean blocks along the diagonal: each brain clusters perfectly on its own and nothing matches across. Wire the `Labels` output of [Match Cell Types](#compare.matchTypes) into each [Partner Vectors](#neuron.partnerVectors) so that both sides use the same feature names.

> [!TIP] Look at the matrix before clustering
> Put a [Heatmap](#out.heatmap) on the matrix first. Two dark blocks along the diagonal with
> nothing between them means the features don't match up. A real cross-dataset result has visible
> structure off the diagonal.

"Cosine" is a good choice here, too: a neuron from a more densely reconstructed dataset has more synapses overall, and cosine ignores that. It does not help with systematic differences in *which* partners were found. For that, set `Weights` to fractions on Partner Vectors.

Further downstream, [Cut Tree](#cluster.cut) can read each neuron's dataset back off its qualified id and, in its mixed mode, gives you the most fine-grained clusters that still contain neurons from both datasets.
