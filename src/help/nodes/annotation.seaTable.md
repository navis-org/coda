SeaTable ([`cloud.seatable.io`](https://cloud.seatable.io)) is a hosted service for collaborative spreadsheets and databases, handling larger datasets than a spreadsheet will (10k+ rows). This node reads a "base" using an account token — set it in Connections ▸ SeaTable — and publishes it as neuron labels for a Dataset.

There is a separate node for the LMB's SeaTable deployment, [FlyTable](#annotation.flyTable).

### Not a live view

Downloading full tables is slow, so the node caches them in the browser. The cache status indicator at the bottom right of the card says how long ago the table was fetched; clicking it re-fetches.

### Chaining annotation sources

This node chains with [FlyTable](#annotation.flyTable), CAVE Table and Google Sheets: later sources win name collisions. Wire them in series — order on the canvas means something. The output is ordinary neuron table data, so Filter or Sort can edit the chain.

### Workspace ambiguity

`Workspace` is optional; the node works it out from the base name. Name it only when two different workspaces hold a base of the same name.

```coda-params
caption: Selecting base and table
annotation.seaTable: base, table
```
