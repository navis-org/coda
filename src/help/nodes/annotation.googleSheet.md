## What Google Sheet does

Google Sheet reads a tab of a Google Sheet and turns it into neuron labels: wire its output into the `Annotations` input of a Dataset, and the sheet's columns show up as properties of the neurons. A `cell_type` column is renamed to `type`, which is the name Coda reads cell types from.

The sheet has to be readable without logging in. In Google Sheets, click Share and set General access to "Anyone with the link" as Viewer. Then paste the link from your browser's address bar into `Sheet`.

```coda-params
annotation.googleSheet: sheet, idColumn, columns, gid
```

- `Sheet` takes the link as it appears in the address bar, or just the sheet's id. A "Publish to web" link uses a different id and does not work here.
- `ID column` is the column holding the neuron ids (`root_id` by default). It is read as text, so 18-digit root ids come through exactly.
- `Columns` is a comma-separated list of columns to keep. Leave it empty to keep all of them. The whole tab is downloaded either way. If you name a column the tab doesn't have, the card tells you.
- `Tab` picks which tab to read (see below).

## Picking a tab

By default the node reads the tab the pasted link points at, or the first tab if the link doesn't name one. To read another tab, set `Tab` to its gid: the number after `#gid=` in the address bar when that tab is open.

> [!WARNING] Use the gid, not the tab's name
> `Tab` only accepts the numeric gid. Google answers a request for a tab name it doesn't know with
> the sheet's first tab instead of an error, so going by name could quietly give you the wrong
> tab.

## Chaining annotation sources

Google Sheet has an `Annotations` input of its own, so you can chain it with [CAVE table](#annotation.caveTable), [FlyTable](#annotation.flyTable) and [SeaTable](#annotation.seaTable). Each node adds its columns to the ones arriving from upstream, matched on neuron id. If two sources have a column of the same name, the later one in the chain wins, so the order of the chain matters.

The output is an ordinary table of neurons, so you can put a Filter or Sort in the chain before it reaches the Dataset.
