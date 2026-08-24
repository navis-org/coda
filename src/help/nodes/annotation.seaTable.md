SeaTable ([`cloud.seatable.io`](https://cloud.seatable.io)) is a hosted service for collaborative spreadsheets and databases - a kind of Google sheets on steroids that can handle larger datasets (10k+ rows). This node reads a "base" (a table) using an account token (set in Connections ▸ SeaTable) and publishes it as neuron labels for a Dataset.

> [!NOTE]
> There is a separate node for the LMB's SeaTable deployment, [FlyTable](#annotation.flyTable). This is for internal use only.

### Not a live view

Because downloading the full tables can be slow, the node caches them in the browser. Look at the bottom right of the node for a cache status indicator: it tells you how long ago the table was fetched. Clicking it triggers a re-fetch.

### Chaining Annotation Sources

This node chains with [FlyTable](#annotation.flyTable), CAVE Table, and Google Sheets: later sources win name collisions. Wire them in series; order on the canvas means something. The output is ordinary neuron table data, so Filter or Sort can edit the chain.

### Workspace Ambiguity

The Workspace parameter is optional; it works out the workspace from the base name. Empty is enough unless two different workspaces hold a base of the same name — then name it to disambiguate.

```coda-params
caption: Selecting base and table
annotation.seaTable: base, table
```
