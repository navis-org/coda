## From a table file to a table

This is the one place a [Link Table](#core.linkTable) file becomes an ordinary table — one every
Filter, Join and chart accepts. Whatever it keeps is in memory from here on, so it keeps only what
you ask for:

- **`Columns`** to keep, in this order. None chosen keeps every column.
- **`Match column`** and **`IDs`**: keep only rows whose value there is one of the ids, typed into
  the card or taken from a wired table's `ID column` — both, where both are given.
- **`Row cap`**: stop after this many rows. The card says when it stopped early.

With a match column and no ids, nothing is read. With no match column, the first rows up to the
cap are read — a million by default, from the start of the file, not a sample of it.

```coda-params
core.readRows: matchColumn, ids
```

## How long a lookup takes

The read happens in the background, and Cancel stops it at once. A lookup in a large file is fast
when whole blocks can be skipped — a Parquet file sorted by the match column, or a Feather file with
that column under `Index columns` on its Link Table — and reads the whole file when the ids are
spread through every block. The card says when nothing could be skipped in a file of four or more
blocks.

A read that would hold more than a browser tab survives is refused before it runs out of memory,
naming the three controls above that shrink it.
