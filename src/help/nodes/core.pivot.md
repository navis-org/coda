## The wide table's schema is discovered, not predicted

The `Table` output's columns are the distinct values found in the `Columns` field. Nothing short of reading the data can name them, so `inferOutputs` cannot know them in advance:

- Before the node runs for the first time, downstream column pickers show empty lists.
- After a page reload, until it is re-run, they go empty again — the same situation Raw Cypher is in.

```coda-graph
caption: The standard route: pivot to matrix, matrix to heatmap.
core.pivot as p
out.heatmap as hm
p:matrix -> hm
```

> [!WARNING] A pivoted matrix cannot say whether its numbers are similarity or distance
> When one reaches [Hierarchical Clustering](#cluster.linkage), the `Distance` setting's `auto`
> mode has to guess, and it guesses wrong for a distance matrix. Set `Distance` explicitly.

```coda-params
caption: The aggregation choice determines what the matrix cell values mean.
core.pivot: agg
```
