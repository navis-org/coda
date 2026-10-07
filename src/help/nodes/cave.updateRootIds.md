## What Update root IDs does

In CAVE datasets, a neuron's root ID changes every time it is edited during proofreading. An annotation table that is maintained separately (e.g. a spreadsheet of cell types) therefore slowly drifts out of sync with the materialization your Dataset is pinned to. Nothing fails when that happens: the affected rows simply stop matching any neuron, and the dataset looks less annotated than it really is.

This node fixes that by bringing the root IDs in a table up to date with a given materialization, or with the live segmentation. Typically it sits between an annotation source and the Dataset it annotates:

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

Rows that are already up to date, and rows without a supervoxel ID, are left as they are. All other columns pass through untouched. If any out-of-date rows could not be updated, the card says how many, and why: no supervoxel ID, or a supervoxel ID that CAVE does not know.

If the table hasn't been edited since, this costs a single check and no further lookups. Both kinds of answer are cached for good, since what a root ID or supervoxel was at a past materialization never changes.

## Live root IDs

Set `Update to` to `live` to get the newest root IDs instead of those at a materialization. "Live" means the state of the segmentation at the moment the node last ran. The card shows how long ago that was, e.g. `cached 4m ago ⟳`; click it to run the node again and pick up any edits made since.

To match an annotation table whose root IDs are refreshed on a schedule, use `the last half hour` or `the last full hour` instead. These update to the state at the last :30 or :00 before the node ran, so the IDs line up with a table such as FlyTable's, which is refreshed every 30 minutes. Times are in UTC, which only matters in time zones offset by a half hour.

Live answers are not cached: every update asks CAVE again. Answers for the last half or full hour are remembered until the next boundary (for as long as the page stays open), so re-running after an upstream change costs nothing extra.

> [!WARNING] Live IDs and pinned datasets
> A Dataset pinned to a materialization only knows the root IDs at that materialization. Feeding it
> live (or half-hourly) IDs means neurons edited since then will no longer match. Use live IDs for things that look
> neurons up in the live segmentation, such as Neuroglancer, meshes and skeletons, or for exporting
> the table.

## Settings

```coda-params
cave.updateRootIds: idColumn, supervoxelColumn, updateTo, version
```

- `ID column` is the column of root IDs to update.
- `Supervoxel ID column` is the supervoxel each row was annotated at, `supervoxel_id` by default. Without this column the node can't update anything.
- `Update to` is `a materialization` (the default), `the last full hour`, `the last half hour` or `live`; see above.
- `Materialization` is the version to bring the IDs up to, when updating to a materialization. Leave it empty to use the one the wired Dataset is pinned to, which is almost always what you want.

The `Dataset` input only tells the node which datastack to ask; it does not read any data from it. That is why you can wire the same Dataset that receives the annotations into it without creating a loop.
