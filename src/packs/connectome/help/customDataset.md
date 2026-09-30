A dataset assembled from parts, for data no single backend holds: a sheet of cell types, a synapse table on your disk, meshes from a public bucket. Everything below it — Find Neurons, Explore, Connectivity, Skeletons, Synapses — treats the result as one dataset.

```coda-graph
caption: Cell types from a sheet, synapses from a local file, geometry from a public bucket.
core.tableFromUrl as types
core.linkTable as syn
dataset.ngsource as seg
connectome:customDataset as custom
neuron.explore as explore
types -> custom:neurons
syn:file -> custom:synapses
seg -> custom:meshes
seg -> custom:skeletons
custom -> explore
```

## The parts

Wire only the parts you have; each answers its own questions and nothing else.

| Socket | Takes | Answers |
| --- | --- | --- |
| **Neurons** | a table, one row per neuron | which neurons exist and what they are called: Find Neurons, Explore, labels on every result |
| **Edges** | a table or a [Link Table](#core.linkTable) file, one row per connection | Connectivity, Adjacency, Paths and the synapse totals behind normalised weights |
| **Synapses** | a table or a Link Table file, one row per synaptic connection | Synapses and Synapses Between — and connectivity too, counting rows per pair, when nothing is wired into Edges |
| **Meshes**, **Skeletons** | any dataset: a Neuroglancer Source, neuPrint, CAVE | geometry, fetched from that dataset under the ids you ask for |

With no Neurons table, the neurons are every id the edge list or synapse table mentions, with no labels.

To drop rows from a file part — synapses below a confidence score, say — put a
[Filter Table](#core.filterTable) between the Link Table and the socket. It is applied to the rows
each question fetches, so it costs no extra read.

> [!WARNING] The ids must mean the same neurons in every part
> Nothing here can check that the root ids in your synapse table are the ones the mesh bucket
> uses. A mesh fetch that comes back empty for every neuron usually means they are not — a
> different materialization, or a different column.

## Picking columns

Each socket's pickers appear once something is wired into it. They never substitute one column for another: a column the table does not have is asked for on the card, naming the one that looks right. `Voxel size` and `Carry columns` are in the inspector.

```coda-params
connectome:customDataset: idColumn, pre, post, weight, synPre, synPost, synPosition, voxelSize, synCarry
```

## What is read, and when

The node itself reads nothing, so it runs at once. The questions below it pay:

- **An edge list is read whole** by the first connectivity question, then held for the tab, so every hop after it is answered from memory. After a reload the next question reads it again.
- **A synapse table is never read whole.** Each Synapses question reads only the rows naming the neurons asked about. From a Link Table file it is as fast as the file's order allows; [Link Table](#core.linkTable) says how to make it fast.
- **Connectivity counted from a synapse table** is the exception: its `pre` and `post` columns are read whole, once. The card warns when that is more than ten million rows, or when the file does not say how many it holds — which a Feather file never does. Wiring an edge list into Edges spares it.

Query nodes below a Custom Dataset wait for it to run, since what it holds is only known then.

## What it cannot say

A synapse table carries no template space, so synapse points claim none. It carries no score Coda knows the scale of, so `Min confidence` on a synapse node is ignored, with a warning. It holds one position per synapse, so `Location` on Synapses Between moves no point.

Local files behave as [Link Table](#core.linkTable) and [Upload Table](#core.uploadTable) describe: a shared workflow names them, and a colleague chooses their own copy.
