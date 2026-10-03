## What Update root IDs does

In CAVE datasets, a neuron's root ID changes every time it is edited during proofreading. An annotation table that is maintained separately (e.g. a spreadsheet of cell types) therefore slowly drifts out of sync with the materialization your Dataset is pinned to. Nothing fails when that happens: the affected rows simply stop matching any neuron, and the dataset looks less annotated than it really is.

This node fixes that by bringing the root IDs in a table up to date with a given materialization. Typically it sits between an annotation source and the Dataset it annotates:

```coda-graph
caption: Update an annotation table's root IDs before it reaches the Dataset.
core.tableFromUrl as sheet
cave.updateRootIds as update
dataset.flywire as ds
sheet -> update
ds -> update:dataset
update -> ds
```

> [!WARNING] CAVE only
> Root IDs only change in CAVE datasets. neuPrint body IDs and CATMAID skeleton IDs don't move, so
> there is nothing to update there.

## How it works

The fix relies on supervoxel IDs. Supervoxels are the smallest pieces of the segmentation, and proofreading only regroups them; it never splits them. A supervoxel ID therefore stays valid where a root ID does not, and CAVE can tell you which neuron a supervoxel belonged to at any given materialization.

1. The node first checks which of the table's root IDs are out of date at the target materialization.
2. For each outdated row, it looks up the current root ID of the row's supervoxel and writes that into `ID column`.

Rows that are already up to date, and rows without a supervoxel ID, are left as they are. All other columns pass through untouched.

If the table hasn't been edited since, this costs a single check and no further lookups. Both kinds of answer are cached for good, since what a root ID or supervoxel was at a past materialization never changes.

## Settings

```coda-params
cave.updateRootIds: idColumn, supervoxelColumn, version
```

- `ID column` is the column of root IDs to update.
- `Supervoxel ID column` is the supervoxel each row was annotated at, `supervoxel_id` by default. Without this column the node can't update anything.
- `Materialization` is the version to bring the IDs up to. Leave it empty to use the one the wired Dataset is pinned to, which is almost always what you want.

The `Dataset` input only tells the node which datastack to ask; it does not read any data from it. That is why you can wire the same Dataset that receives the annotations into it without creating a loop.
