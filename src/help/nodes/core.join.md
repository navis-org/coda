## What Join does

Join adds columns from one table to another by matching rows on a key column. For example, you can join a table of neurons with a table of neurotransmitter predictions on `neuronId` to get both in one table. Pick the key on each side with `Left key` and `Right key`; the output has all columns from both tables, with a single key column.

```coda-params
core.join: how, suffix
```

## Join types

`Type` decides which rows end up in the output:

| Type | Keeps |
| --- | --- |
| "left" (the default) | every row of the left table; right-hand columns are empty where there was no match |
| "inner" | only rows whose key appears in both tables |
| "outer" | every row of both tables, empty on whichever side had no match |
| "right" | every row of the right table; left-hand columns are empty where there was no match |

Rows keep the order of the left table ("right" keeps the order of the right table). With "outer", rows that only exist in the right table are appended at the end. Columns are always in left-then-right order, so you can switch between types without having to re-pick anything downstream.

## Duplicate keys

If a key appears more than once in the table being matched against (the right table, or the left table for "right"), only its first row is used. A join therefore never multiplies rows: joining 500 neurons gives you at most 500 rows (plus unmatched right rows for "outer"). If you need a particular row to be the one that is used, sort or [deduplicate](#core.dedupe) that table first.

## Column names

If the right table has a column with the same name as one in the left table, the right-hand copy gets the `Suffix` (`_r` by default) appended, so `type` becomes `type_r`. Nothing is dropped.

If the two key columns have different types (e.g. numbers on one side, text on the other), they are matched as text and the node shows a warning.

To join more than two tables, chain several Join nodes. To add rows rather than columns, use [Stack Tables](#core.stack).
