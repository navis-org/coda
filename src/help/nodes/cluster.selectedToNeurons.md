A [Dendrogram](#out.dendrogram) selection is a table of leaf *names*, not neurons. Selected to Neurons turns those names back into the neurons they stand for, so you can pass them on to e.g. [Neuroglancer](#out.neuroglancer), a [3D View](#out.viewer3d) or [Skeletons](#neuron.skeletons). Any other columns in the selection are carried along.

[Clusters to Neurons](#cluster.clustersToNeurons) does exactly the same thing for the output of [Cut Tree](#cluster.cut).

## Where the neurons come from

The node doesn't query the dataset. It looks the names up in whatever neuron table you wire into `Neurons`, typically the table that fed the Skeletons that fed your [NBLAST](#neuron.nblast). If you selected a branch containing three cell types, you therefore get back the neurons of those types that were actually clustered, not every neuron of those types in the connectome. For the latter, use [IDs from Label](#neuron.idsFromLabel).

## Matching by name

1. Wire the same neuron table you ran NBLAST on into `Neurons`.
2. Set `Match on` to the column that NBLAST used for its `Label by` setting (e.g. `type` if the tree is labelled by cell type). Values are compared as text, so both numbers and names work.

If NBLAST was left at its default (labelling by neuron id), you can leave `Neurons` unwired: the ids are then read straight from the labels.

`Suffix` (under the advanced settings) only matters if the neuron table already has a column with the same name as one carried over from the selection. In that case, the carried column gets the suffix (`_c` by default) instead of overwriting the original.

```coda-params
cluster.selectedToNeurons: labelColumn, matchColumn, suffix
```
