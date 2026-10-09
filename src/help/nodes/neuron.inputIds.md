Input IDs turns a list of neuron ids you already have (from a paper, a spreadsheet, a colleague or Neuroglancer) into a neuron table that other nodes can work with:

```coda-graph
caption: Paste IDs (e.g. from Neuroglancer) and get their connectivity.
neuron.inputIds as in {ids: "10001, 21312"}
neuron.connectivity as con
out.table as tbl
in -> con
con -> tbl
```

Type or paste the ids into `IDs`. Spaces, commas and new lines all work as separators, and so do brackets and quotes, so you can paste a Python or JSON list as it is. Alternatively, wire in a table and pick its `ID column`; ids from both are combined.

```coda-params
neuron.inputIds: column
```

## With or without a dataset

The `Dataset` input is optional.

**Without a dataset**, the node simply outputs the ids as a one-column table (`neuronId`). That's enough for most purposes: [Connectivity](#neuron.connectivity), [Skeletons](#neuron.skeletons), [Meshes](#neuron.meshes), Synapses and [ROI Counts](#neuron.roiCounts) only need the `neuronId` column.

**With a dataset**, the node fetches the full neuron rows. That gives you two things a plain list of ids can't:

- the columns that downstream pickers and viewers usually want (`type`, `status`, `size`, …)
- a check for ids that don't exist in the dataset, which is the only way to catch a mistyped id

Unlike [Find Neurons](#neuron.findNeurons) and [IDs from Label](#neuron.idsFromLabel), this node does not filter by status, so no id you listed is dropped because of its status. If you want to drop untraced neurons, add a filter downstream.
