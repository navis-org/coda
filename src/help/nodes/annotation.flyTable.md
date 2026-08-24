## FlyTable

FlyTable is the LMB's SeaTable deployment, used for FlyWire and Aedes cell typing — currently **internal only**. Reads a base using an account token (set in Connections ▸ FlyTable) and
publishes it as neuron labels for a Dataset.

### Not a live view

Because downloading the full tables can be slow, the node caches them in the browser. Look at the bottom right of the node for a cache status indicator: it tells you how long ago the table was fetched. Clicking it triggers a re-fetch.

### Chaining Annotation Sources

This node chains with [SeaTable](#annotation.seaTable), [CAVE table](#annotation.caveTable), and
Google Sheets: later sources win name collisions. Wire them in series; order on the canvas means
something.

### Workspace Ambiguity

The Workspace parameter is optional; it works out the workspace from the base name. Empty is
enough unless two different workspaces hold a base of the same name — then name it to
disambiguate.

```coda-params
caption: Selecting base and table
annotation.flyTable: base, table
```
