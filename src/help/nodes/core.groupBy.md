## What comes out

The group columns, a row count called `n`, and **one aggregate per value column**, each named
`<agg>_<column>`. Summing `weight` gives `sum_weight`, not `weight`, so a table that has been
through two Group By nodes still reads.

`n` rides along with every aggregation, including the ones that already count.

```coda-params
caption: Group by is the key; Of columns is what gets aggregated.
core.groupBy: by, agg, value
```

## One aggregation, several value columns

`Of columns` takes as many columns as you like and applies the *same* aggregation to each, in one
pass — `sum_pre` beside `sum_post`. The columns are independent: a null in one has no effect on
any other, and each keeps its own unit.

For a different aggregation per column, use two Group By nodes on the same input and
[Join](#core.join) them on the group columns.

The picker only offers columns the aggregation can take: numeric for everything except **join
text**, which takes any column and produces text.

## The value list is ignored by `count`

**count rows** answers with `n` alone, so the `Of columns` picker disappears when it is chosen and
whatever it held is not read. Switching back brings the choice back with it.

## join text: distinct, in first-appearance order

**join text** folds a group's values into one cell, joined with `; `:

- **Distinct** — a repeat is dropped.
- **First appearance order**, not sorted. Sort upstream if a particular order matters.
- **Absences are skipped**; a group with nothing to join comes out empty rather than as the text
  `"null"`. Matching is exact: `DA1` and `da1` are different text.

The unit does not survive a join — nanometres joined with semicolons are no longer nanometres.

> [!NOTE] Both pickers start empty
> A picker that holds a list has no "first compatible column" to fall back on. A graph saved before
> `Of columns` took a list opens with it empty and a warning on the card.

## Schema first, values later

The output schema is *computed* rather than copied from the input, and computed at edit time.
Change the aggregation from sum to mean and every column picker downstream updates to
`mean_weight` immediately — before anything re-runs, and whether or not this node has ever run.

```coda-graph
caption: The usual chain: fold the rows, then order and draw them.
core.groupBy as g
core.sort as s
out.barChart as bar
g -> s
s -> bar
```
