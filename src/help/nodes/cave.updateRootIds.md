> [!WARNING] CAVE-only
> This node requires a CAVE dataset.

A CAVE "root ID" changes whenever a neuron is edited, so an annotation table edited on its own schedule drifts out of sync with a pinned materialization. Nothing fails when it does: the rows quietly stop matching any neuron.

This node repairs that using supervoxel IDs. A supervoxel is the atom of the segmentation — proofreading regroups supervoxels, it does not split them — so a supervoxel ID is a stable anchor where a root ID is not. Given one, the chunkedgraph can say which segment a supervoxel belonged to at any instant.

### How it works

The node checks which root IDs are stale at the target materialization, then looks up only those rows. An annotation table that has not been edited costs one staleness check and zero further lookups; both answers are cached permanently, since what a root or supervoxel was at a past instant never changes.

For each stale row whose supervoxel is known, the node retrieves the current root ID and rewrites it. Rows already current, and rows without a supervoxel ID, are left alone.

### Wiring: the Dataset input is a reference port

The Dataset input names the datastack to query — it carries an identity, not a table value. That is what lets this node sit between an annotation source and the dataset it fixes without forming a wiring cycle: wired as `Annotation → Update → Dataset`, a reference port avoids two edges in opposite directions between the same pair of nodes.

```coda-params
cave.updateRootIds: idColumn, supervoxelColumn, version
```
