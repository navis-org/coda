## What Custom Dataset does

Custom Dataset assembles a dataset from parts, for data that no single backend holds. For example: cell types from a spreadsheet, a synapse table on your disk and meshes from a public bucket. Nodes downstream of it ([Find Neurons](#neuron.findNeurons), [Explore](#neuron.explore), [Connectivity](#neuron.connectivity), [Skeletons](#neuron.skeletons), Synapses and so on) treat the result like any other dataset.

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

## Inputs

You only need to wire the parts you have. Each part answers its own kind of question and nothing else:

| Input                   | Takes                                                                          | Used for                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `Neurons`               | a table with one row per neuron                                                | which neurons exist and what they are called: Find Neurons, Explore, labels on every result |
| `Edges`                 | a table or a [Link Table](#core.linkTable) file with one row per connection     | Connectivity, Adjacency, [Paths](#neuron.paths), and the synapse totals behind normalised weights          |
| `Synapses`              | a table or a Link Table file with one row per synapse                          | Synapses and Synapses Between; also connectivity, if nothing is wired into `Edges`        |
| `Meshes`, `Skeletons`   | any dataset, e.g. a Neuroglancer Source, neuPrint or CAVE                       | geometry, fetched from that dataset for the ids you ask about                             |

Without a `Neurons` table, the neurons are simply all ids that appear in the edge list or synapse table, and they have no labels.

If `Edges` is empty, connectivity is counted from the synapse table: each row is one synapse, and the number of rows per pair of neurons becomes the weight.

To drop rows from a file, e.g. synapses below some confidence score, put a [Filter Table](#core.filterTable) between the Link Table and this node. The filter is applied to the rows each query fetches, so it costs no extra read.

> [!WARNING] Ids must mean the same neurons in every part
> The node has no way of checking that the root ids in your synapse table are the same ones the
> mesh bucket uses. If a mesh fetch comes back empty for every neuron, that is usually the reason:
> a different materialization, or the wrong id column.

## Picking columns

Each input's column pickers appear once something is wired into it. If the table does not have a column with the expected name (e.g. `pre` and `post` for an edge list), the node does not guess. Instead, the card asks you to pick one and suggests the column that looks right.

`Weight column` defaults to `weight`. If the edge list has no such column, each row counts as one connection. Clear the picker if that is what you want, e.g. for an edge list with one row per synapse.

`Voxel size` and `Carry columns` are in the inspector. `Voxel size` gives the nanometres per unit of the synapse position columns: leave it at `1, 1, 1` if they are already in nanometres, or use `4, 4, 40` for FlyWire's voxels. `Carry columns` puts extra columns of the synapse table (e.g. a neurotransmitter prediction) onto every synapse point, for colouring and filtering downstream.

```coda-params
connectome:customDataset: idColumn, pre, post, weight, synPre, synPost, synPosition, voxelSize, synCarry
```

In the `Neurons` table, the id column is renamed `neuronId` and read as text. Rows without a usable id are left out, and if an id appears more than once only the first row is kept; the card warns about both.

## What is read, and when

The node itself reads nothing, so it runs immediately. The reading happens when a node downstream asks a question:

- **Edge lists are read in full** by the first connectivity query and then kept in memory for as long as the tab is open, so every further hop is answered without reading again. After a reload, the next query reads the file again.
- **Synapse tables are never read in full.** Each Synapses query reads only the rows for the neurons it asks about. From a Link Table file this is as fast as the file's row order allows; see [Link Table](#core.linkTable) for how to make it fast.
- **Connectivity counted from a synapse table** is the exception: its pre and post columns are read in full, once. The card warns you when that means more than ten million rows, or when the file does not say how many rows it holds (Feather files never do). Wiring an edge list into `Edges` avoids this.

Query nodes downstream of a Custom Dataset wait for it to run, because what it contains is only known then.

## Limitations

- A synapse table carries no template space, so the synapse points don't claim one.
- Its scores have no scale Coda knows about, so `Min confidence` on a synapse node is ignored (with a warning).
- It holds one position per synapse, so `Location` on Synapses Between has no effect.

Local files behave as described for [Link Table](#core.linkTable) and [Upload Table](#core.uploadTable): a shared workflow only records their names, and a colleague opening it has to choose their own copy of each file.
