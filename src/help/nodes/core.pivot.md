## The wide table's schema is discovered, not predicted

The `Table` output's columns are the distinct values found in the `Columns` parameter field. Nothing short of reading the actual data can name them, so `inferOutputs` cannot know them in advance. This means:

- Before the node runs for the first time, downstream column pickers show empty lists.
- After a page reload (until re-run), they go empty again — the same situation Raw Cypher is in, for the same reason.

This is by design: the schema is genuine and dynamic, observed from the actual data rather than guessed.

```coda-graph
caption: The standard route: pivot to matrix, matrix to heatmap.
core.pivot as p
out.heatmap as hm
p:matrix -> hm
```

> [!WARNING] A pivoted matrix cannot say whether its numbers are similarity or distance
> A Matrix has no built-in notion of whether its values are **similarity** (bigger = more alike) or **distance** (bigger = less alike). When a pivoted matrix reaches [Hierarchical Clustering](#cluster.linkage), the `Distance` setting's `auto` mode has to guess, and it will guess wrong for a distance matrix. Specify `Distance` explicitly rather than relying on auto.

```coda-params
caption: The aggregation choice determines what the matrix cell values mean.
core.pivot: agg
```
