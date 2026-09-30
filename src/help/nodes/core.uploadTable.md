Delimiter, header and column types are inferred from the file. Naming an ID column renames it to `neuronId`, so downstream nodes see it as neurons.

## Copied into this browser

The whole file is read and parsed when you choose it, and the rows are stored in this browser. On
every run they are loaded back into memory in full. That is what makes the table work anywhere in
the app, and it sets the limits:

- **Size**: a warning above 50 MB, and a refusal above 200 MB — every row is held in memory and in
  storage.
- **Formats**: CSV and TSV.
- **After a reload** the table is still there, in any browser, and the original file is no longer
  needed.

For anything larger, or already in Parquet or Feather, [Link Table](#core.linkTable) reads the file
where it is — on disk or at a URL — and only the rows a lookup needs.

> [!WARNING] Sharing a graph does not share the table
> The `.coda.json` carries only a content-addressed reference. For the workflow to run on a
> colleague's machine, they must have the same file and upload it here.

See also [Table from URL](#core.tableFromUrl) — the reproducible counterpart for remote data.

```coda-params
core.uploadTable: fileName
```
