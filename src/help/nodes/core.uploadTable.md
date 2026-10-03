## What Upload Table does

Upload Table brings a table of your own into Coda: annotations, cell types, an embedding, a list of neurons. Press "Choose CSV…" to pick a CSV or TSV file, or "Paste" to paste rows straight into the card. The delimiter, the header and the column types are worked out from the file.

```coda-params
core.uploadTable: fileName
```

If your table lists neurons, set `ID column` to the column holding their ids. It is renamed to `neuronId`, which is what other nodes look for, and the output becomes a neuron table you can wire into e.g. [Connectivity](#neuron.connectivity). Likewise, `Type column` is renamed to `type`. Use `Text columns` for columns that look like numbers but are really labels, such as cluster ids.

## Where the data lives

The file is read once, when you choose it, and the rows are stored in this browser. You don't need the original file afterwards, and the table is still there after a reload. A few consequences:

- Files above 50 MB give you a warning, and files above 200 MB are refused: every row has to fit in memory.
- Only CSV and TSV are supported. For larger files, or Parquet and Feather, use [Link Table](#core.linkTable). It reads the file where it is (on disk or at a URL) and only loads the rows it needs.

> [!WARNING] Sharing a workflow does not share the table
> A `.coda.json` file or a share link only contains a reference to the table, not the rows. If a
> colleague opens your workflow, the card names the missing file and everything downstream stays
> blocked until they upload the same file themselves. Send the file along with the workflow, or
> put it online and use [Table from URL](#core.tableFromUrl) instead.
