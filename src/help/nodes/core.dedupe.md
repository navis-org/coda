## What Deduplicate does

Deduplicate drops rows that repeat. Two rows count as repeats if they have the same values in the `Compare on` columns; leave the picker empty to compare whole rows, which removes exact duplicates. Rows that survive are kept whole and stay in their original order.

A common case is an annotation table where some neurons have more than one row: compare on the id column to get one row per neuron.

```coda-params
core.dedupe: columns, keep
```

## Which row is kept

`Keep` decides what happens to a set of repeated rows:

- "first" keeps the first row of each set.
- "last" keeps the last row of each set.
- "none (drop them all)" drops every row of a repeated set, so only rows that were unique to begin with survive. Use this when repeats are conflicting annotations and you would rather lose the neuron than pick one of them.

"first" and "last" go by the order of the rows in the input. If it matters which row wins, put a Sort node in front of this one.

Unlike [Group By](#core.groupBy), nothing is aggregated: every column keeps the values it had in the surviving row.
