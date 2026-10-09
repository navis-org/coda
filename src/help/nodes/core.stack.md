## What Stack Tables does

Stack Tables combines tables by appending their rows, one table after the other. Typical uses are combining the connectivity of two different sets of seed neurons, adding a hand-curated list of neurons to a query result, or putting the results of the same analysis on two datasets into one table.

```coda-params
core.stack: inputCount, sourceColumn, label1, label2
```

`Inputs` sets how many tables you want to combine (up to 8); each gets its own socket.

- Rows keep their order: all rows of `Input 1`, then all rows of `Input 2`, and so on.
- Duplicate rows are kept. Use [Deduplicate](#core.dedupe) downstream if you want to get rid of them.
- Every column of every input ends up in the output. If a column only exists in some of the inputs, it is left empty for rows from the others.

To add columns rather than rows, use [Join](#core.join).

## Tracking where rows came from

Enter a name under `Source column` to add a column that records which input each row came from. By default the values are `Input 1`, `Input 2`, etc.; you can give each input its own label in the advanced settings (e.g. `FlyWire` and `hemibrain`).

> [!NOTE] Older workflows
> In workflows saved before Stack Tables took more than two inputs, the first two labels default
> to `Top` and `Bottom` instead.

## Mismatched column types

If the same column has different types in two inputs, e.g. `neuronId` is a number in one table and text in the other, the node refuses to run and tells you which column and which inputs are affected. Fix the type upstream so that both agree. The one exception is whole numbers vs. decimal numbers, which are merged without complaint.
