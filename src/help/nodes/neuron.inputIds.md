```coda-graph
caption: Paste IDs (e.g. from Neuroglancer) and get their connectivity
neuron.inputIds as in {ids: "10001, 21312"}
neuron.connectivity as con
out.table as tbl
in -> con
con -> tbl
```

### The Dataset input is optional

**Unwired**: the node emits the IDs as a one-column `Neurons` table.That is already enough for most of what a list of IDs is for: Connectivity Graph, Skeletons, Meshes, Synapses and ROI Counts all need only the `neuronId` column.

**Wired**: the node fetches the full neuron rows. This buys two things a single-column table cannot: the columns every picker and viewer wants (`type`, `status`, `size`), and the ability to say **which IDs the dataset has never heard of** — the only way to catch a mistyped ID.

```coda-params
neuron.inputIds: column
```
