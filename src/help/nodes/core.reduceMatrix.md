One table row per matrix row, or per column, carrying the statistics you tick. Use it to get from a matrix to a number you can sort, join, or colour a scene by.

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

- **Key column.** The key column is `label`, holding the matrix's row or column labels.
- **Missing values.** Non-finite cells are skipped. A line with none gives null, except `sum` (0) and `n` (0). `sd` is null below two values.
- **Diagonal.** `Exclude diagonal` applies only when the row and column labels are the same list; otherwise it is ignored with a warning.
