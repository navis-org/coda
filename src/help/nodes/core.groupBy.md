## What comes out

The group columns, a row count called `n`, and **one aggregate per value column**, each named
`<agg>_<column>`. Summing `weight` gives `sum_weight`, not `weight` — the name says what was
done to it, so a table that has been through two Group By nodes still reads.

`n` rides along with every aggregation, including the ones that already count. It is nearly
always the number you need beside the answer: a mean of 3.5 from two rows and a mean of 3.5 from
two hundred are not the same claim.

```coda-params
caption: Group by is the key; Of columns is what gets aggregated.
core.groupBy: by, agg, value
```

## One aggregation, several value columns

`Of columns` takes as many columns as you like and applies the *same* aggregation to each, in one
pass — `sum_pre` beside `sum_post`, or `join_type` beside `join_side`. The columns are
independent: a null in one has no effect on any other, and each keeps its own unit.

What this node deliberately does **not** offer is a different aggregation per column. For
`sum` of one column beside `mean` of another, use two Group By nodes on the same input and
[Join](#core.join) them on the group columns — which is also the shape that makes it obvious the
two aggregates came from the same rows.

The picker only offers columns the aggregation can actually take: numeric ones for everything
except **join text**, which takes any column and produces text.

## The value list is ignored by `count`

**count rows** answers with `n` alone, so the `Of columns` picker disappears when it is chosen and
whatever it held is simply not read. Switching back brings the choice back with it; nothing has to
be emptied first.

## join text: distinct, in first-appearance order

**join text** folds a group's values into one cell, joined with `; `. Three rules, and each is a
decision rather than a default:

- **Distinct.** A repeat is dropped. This is what a community-annotation table folds into, where
  two people adding the same tag is the ordinary case, and the cell is meant to be *read*.
- **First appearance order**, so the result is stable rather than sorted into something nobody
  chose. Sort upstream if a particular order matters.
- **Absences are skipped**, and a group with nothing to join comes out empty rather than as the
  text `"null"`. Matching is exact: `DA1` and `da1` are different text somebody typed, and folding
  them would be an editorial decision this node cannot make.

The unit does not survive a join — nanometres joined with semicolons are no longer nanometres.

> [!NOTE] Nothing is picked for you
> Both pickers start empty and the node says so until they are set. That is deliberate for
> `Group by` and, since this node learned to take several value columns, true of `Of columns`
> too — a picker that holds a list has no "first compatible column" to fall back on. A graph
> saved by a build that predates the change opens with `Of columns` empty and a warning on the
> card; re-pick the column and the rest of the graph is untouched.

## Schema first, values later

The output schema is *computed* rather than copied from the input, and it is computed at edit
time. Change the aggregation from sum to mean and every column picker downstream updates to
`mean_weight` immediately — before anything re-runs, and whether or not this node has ever run.
That is what lets a chart or a Sort be configured against a table that does not exist yet.

```coda-graph
caption: The usual chain: fold the rows, then order and draw them.
core.groupBy as g
core.sort as s
out.barChart as bar
g -> s
s -> bar
```
