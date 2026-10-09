## What comes out

Group By collapses all rows that share the same values in the `Group by` columns into a single row. For example, grouping a connectivity table by `postType` and summing `weight` gives you the total number of synapses onto each cell type.

```coda-params
core.groupBy: by, agg, value
```

Both column pickers start out empty, so you have to pick at least one group column and (unless you are counting rows) one value column.

The output contains:

- the group columns
- `n`: the number of rows in each group (always added, even when the aggregation itself is a count)
- one aggregate per value column, named `<agg>_<column>`

Summing `weight` therefore produces a column called `sum_weight`, not `weight`.

The column names update as soon as you change a setting: switch from sum to mean and every column picker downstream will offer `mean_weight` instead, without having to re-run.

## Aggregating several columns

You can pick as many columns as you like under `Of columns`. The same aggregation is applied to each of them, so you get e.g. `sum_pre` next to `sum_post`.

If you need different aggregations for different columns, use two Group By nodes on the same input and [Join](#core.join) the results on the group columns.

The picker only offers columns that the chosen aggregation can work with. That means numeric columns for everything except "join text", which takes any column.

"count rows" ignores `Of columns` entirely (the picker is hidden when you select it) and returns only `n`. Your column selection is remembered if you switch back.

## Missing values

Missing values are skipped. If a group has no values at all in a column, `mean`, `min`, `max` and "join text" give an empty cell for that group, whereas `sum` gives 0.

## Joining text

"join text" combines a group's values into a single cell, separated by `; `. A few things to keep in mind:

- Duplicate values are only kept once.
- Values are kept in the order they first appear, i.e. they are not sorted. Sort upstream if the order matters.
- Matching is exact: `DA1` and `da1` count as two different values.
- If the column had a unit (e.g. nanometres), the joined text no longer does.

> [!NOTE] Older workflows
> In workflows saved before `Of columns` accepted more than one column, the picker opens empty and
> the node shows a warning. Pick the column(s) again to fix it.

## A typical chain

```coda-graph
caption: Group, sort, then plot.
core.groupBy as g
core.sort as s
out.barChart as bar
g -> s
s -> bar
```
