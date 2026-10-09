## What Table from URL does

Table from URL downloads a CSV, TSV or semicolon-separated file from a web address and reads it as a table. Unlike [Upload Table](#core.uploadTable), the workflow only stores the address, so a colleague opening your workflow fetches the same file and gets the same table.

```coda-params
core.tableFromUrl: url
```

`ID column`, `Type column` and `Text columns` work as in Upload Table: the ID column is renamed to `neuronId` (which makes the output a neuron table), the type column to `type`.

The file has to be publicly reachable, and the server hosting it has to allow other websites to read it (via CORS headers). Public files on GitHub work (see below); files behind a login, or on your own disk, don't. The same size limits as for Upload Table apply: a warning above 50 MB and an error above 200 MB. For a file on disk, use Upload Table or [Link Table](#core.linkTable).

## GitHub links

You can paste a GitHub link to a file as it is, either the address of the file page (`github.com/org/repo/blob/main/table.tsv`) or the one behind its "Raw" button. Neither address can be read directly from the browser, so the node fetches the file from `raw.githubusercontent.com` instead. Your workflow keeps the link you pasted; an exported notebook or R Markdown document uses the `raw.githubusercontent.com` address, with a comment saying so.

## Fetching again

The table is fetched once and then cached. If the file at the URL changes, Coda can't tell: increase `Refresh` in the node's advanced settings to fetch it again.
