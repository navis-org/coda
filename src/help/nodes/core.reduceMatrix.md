## What Reduce Matrix does

Reduce Matrix summarises each row (or each column) of a matrix with the statistics you tick, and returns them as a table. Use it to get from a matrix to one number per neuron that you can sort, join, or colour by. For example, reducing a matrix of activity traces gives you each neuron's mean activity:

```coda-graph
caption: Mean activity per neuron.
zapbench:neuronTraces as zt
core.reduceMatrix as red
out.table as tbl
zt -> red
red -> tbl
```

```coda-params
core.reduceMatrix: axis, stats, prefix, excludeDiagonal
```

`Reduce` decides which way you go. "each row, across its columns" gives one output row per matrix row; "each column, down its rows" gives one output row per matrix column. Picking the wrong one gives you a perfectly plausible table of the wrong neurons, so check which axis your neurons are on.

## What comes out

- `label`: the matrix's row (or column) labels.
- One column per ticked statistic, in the order you ticked them. With `Prefix` set to e.g. `zap`, `mean` becomes `zap_mean`. That is useful if you later join two of these tables.

If you tick no statistics at all, you get just the labels.

## Missing values

Empty and non-finite cells are skipped. A row with no values left gives an empty cell for every statistic except `sum` and `n`, which are 0. `sd` is the sample standard deviation and is empty for rows with fewer than two values.

## Similarity matrices

In an all-by-all matrix (e.g. [NBLAST](#neuron.nblast) or a [Similarity Matrix](#core.similarity)), every neuron is also compared with itself, and that self-score pulls the mean up. Tick `Exclude diagonal` to leave it out. This only applies when the row and column labels are the same list; for any other matrix, the setting is ignored and the node shows a warning.
