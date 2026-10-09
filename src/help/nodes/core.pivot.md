## What Pivot does

Pivot turns a long table into a matrix. You pick one column for the `Rows`, one for the `Columns` and an aggregation; every combination of row and column value becomes one cell. For example, pivoting a connectivity table with `Rows` set to `preType`, `Columns` set to `postType` and summing `weight` gives you a type-to-type connectivity matrix.

```coda-params
core.pivot: agg
```

`Aggregate` decides what goes into each cell: the "sum", "mean", "min" or "max" of the `Of column`, the number of rows ("count rows") or the number of distinct values ("count distinct"). Combinations that never occur in the table get 0.

Row and column labels are sorted alphabetically (numbers in numeric order). Empty values in the `Rows` or `Columns` field are collected under a single label `—`.

## Outputs

The node produces the same pivot in two shapes:

- `Matrix` is what a [Heatmap](#out.heatmap), [Normalize](#core.normalize) or [Linkage](#cluster.linkage) takes.
- `Table` is the same numbers as a wide table: one row per row label, one column per column label. Use it if you want to sort, filter, join or export the result.

```coda-graph
caption: Pivot to a matrix and draw it as a heatmap.
core.pivot as p
out.heatmap as hm
p:matrix -> hm
```

> [!NOTE] The wide table's columns are only known after a run
> The columns of the `Table` output are whatever values the `Columns` field contains, so Coda
> can't know them until the node has run. Until then, and again after you reload the page,
> column pickers downstream of `Table` are empty. Run the node to fill them.

## Size

Each distinct value in `Columns` becomes a column, so pick the field with fewer values for it (a side, a status, a region). The node warns you when a pivot is getting large and refuses outright beyond 100,000 columns. If that happens, group or filter the table first.

> [!WARNING] Clustering a pivoted matrix
> A pivoted matrix doesn't know whether its numbers are similarities or distances, so
> [Linkage](#cluster.linkage) treats them as similarities. If they are distances, set Linkage's
> `Distance` explicitly.
