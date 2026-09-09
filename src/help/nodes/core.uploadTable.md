Delimiter, header and column types are inferred from the file. Naming an ID column renames it to `neuronId`, so downstream nodes see it as neurons.

> [!WARNING] Sharing a graph does not share the table
> The `.coda.json` carries only a content-addressed reference. For the workflow to run on a
> colleague's machine, they must have the same file and upload it here.

See also [Table from URL](#core.tableFromUrl) — the reproducible counterpart for remote data.

```coda-params
core.uploadTable: fileName
```
