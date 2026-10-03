## What Read Rows does

Read Rows takes a file from [Link Table](#core.linkTable) and turns (part of) it into an ordinary table that Filter, Join, the charts and every other table node accept. Whatever it reads is held in memory from here on, so you tell it exactly what to keep:

- `Columns`: the columns to keep, in this order. If you pick none, every column is kept.
- `Match column` and `IDs`: keep only rows whose value in the match column is one of the ids. You can type ids into the card, wire in a table and pick its `ID column`, or both.
- `Row cap`: stop after this many rows. The card tells you if it stopped early.

```coda-params
core.readRows: matchColumn, ids
```

A typical use is looking up the synapses or connections of a few neurons: wire their ids in from e.g. [Find Neurons](#neuron.findNeurons) and set `Match column` to the file's id column (`pre_pt_root_id`, `bodyId` and the like).

> [!NOTE] No ids, no rows
> If you pick a match column but give no ids, nothing is read. If you don't pick a match column,
> the node reads rows from the start of the file until it hits `Row cap` (a million by default).
> That is the beginning of the file, not a random sample of it.

## How long a lookup takes

Reading happens in the background, and Cancel stops it immediately. A lookup in a large file is fast if whole blocks can be skipped. That is the case for a Parquet file sorted by the match column, or for a Feather file whose Link Table lists that column under `Index columns`. If the ids are spread across every block, the whole file has to be read. For a file of four or more blocks, the card warns you when a lookup could not skip anything; see [Link Table](#core.linkTable) for how to sort a file.

If a read would need more memory than a browser tab can handle, the node stops before running out and tells you to choose fewer columns, match fewer ids or lower the row cap.
