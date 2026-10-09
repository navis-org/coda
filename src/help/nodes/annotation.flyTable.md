## What FlyTable does

FlyTable is the LMB's own SeaTable deployment, which is where cell typing for e.g. FlyWire and *Aedes* is done. This node reads a table from a FlyTable base and turns it into neuron labels: wire its output into the `Annotations` input of a Dataset, and the table's columns show up as properties of the neurons. A `cell_type` column is renamed to `type`, which is the name Coda reads cell types from.

> [!NOTE] Internal only
> FlyTable is currently internal, so you need an account on it. Add your account token under
> Connections ▸ FlyTable. For a base of your own on the public SeaTable service, use
> [SeaTable](#annotation.seaTable) instead.

## Settings

Pick the base and the table inside it:

```coda-params
annotation.flyTable: base, table
```

- `ID column` is the column holding the neuron ids (`root_id` by default). SeaTable stores it as text, so even 18-digit root ids come through exactly.
- `Columns` is a comma-separated list of columns to keep. Leave it empty to keep all of them. The whole table is downloaded either way.
- `Workspace` is optional: the node works it out from the base name. You only need to set it if two workspaces contain a base of the same name, in which case the node tells you.

## Caching

Downloading a full table takes a while, so the node keeps a copy in the browser. The cache indicator at the bottom right of the card tells you how long ago the table was fetched; click it to fetch the table again. Edits made in FlyTable after that will not show up until you do.

## Chaining annotation sources

FlyTable has an `Annotations` input of its own, so you can chain it with [SeaTable](#annotation.seaTable), [CAVE table](#annotation.caveTable) and [Google Sheet](#annotation.googleSheet). Each node adds its columns to the ones arriving from upstream, matched on neuron id. If two sources have a column of the same name, the later one in the chain wins, so the order of the chain matters.

The output is an ordinary table of neurons, so a [Table](#out.table) shows you what you got, and you can put a Filter or Sort in the chain before it reaches the Dataset.
