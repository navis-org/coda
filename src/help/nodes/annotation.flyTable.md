## FlyTable

FlyTable is the LMB's SeaTable deployment, used for FlyWire and Aedes cell typing — currently **internal only**. It reads a base using an account token, set in Connections ▸ FlyTable, and publishes it as neuron labels for a Dataset.

### Not a live view

Downloading full tables is slow, so the node caches them in the browser. The cache status indicator at the bottom right of the card says how long ago the table was fetched; clicking it re-fetches.

### Chaining annotation sources

This node chains with [SeaTable](#annotation.seaTable), [CAVE table](#annotation.caveTable) and Google Sheets: later sources win name collisions. Wire them in series — order on the canvas means something.

### Workspace ambiguity

`Workspace` is optional; the node works it out from the base name. Name it only when two different workspaces hold a base of the same name.

```coda-params
caption: Selecting base and table
annotation.flyTable: base, table
```
