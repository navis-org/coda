The ZapBench recording, starting from its cells rather than from neurons. Read every cell at a reduced scale to get an overview to select from, or read listed cells at full resolution. For traces of known neurons, use [Neurons to ZapBench Traces](#zapbench:neuronTraces).

```coda-graph
caption: From activity to anatomy. Shift-drag rows on the expanded Heatmap; Selected Rows carries their cell ids.
zapbench:traces as zt
out.heatmap as hm
dataset.neuprint as ds "fish2"
zapbench:neurons as zn
neuron.skeletons as skel
out.viewer3d as v3d
zt -> hm
hm:rows -> zn:cells
ds -> zn:dataset
ds -> skel:dataset
zn -> skel:neurons
skel -> v3d:skeletons
```

## What it reads

Everything comes from the public ZapBench release, `gs://zapbench-release/volumes/20240930`, as HTTPS range requests. No token is needed.

`Cells: Every cell` reads `traces_rastermap_sorted`, the release's copy of `traces` ordered by activity, at the level `Scale` names:

| Scale | Level | Matrix over the whole recording | Download |
| --- | --- | --- | --- |
| Quarter (default) | `s2` | 17,931 × 1,969, 269 MB | ~144 MB |
| Half | `s1` | 35,861 × 3,939, 1.1 GB | refused |
| Full | `s0` | 71,721 × 7,879, 4.2 GB | refused |

"Refused" means the matrix would pass the tab's 512 MiB allocation limit, and the card says so before a Run. A shorter `Condition` brings Half or Full under the limit.

Two small reads come first:
- `sorting.json` (491 kB), which maps activity order back to cell ids.
- A few values from adjacent levels, checking that each level is still the mean of the one below.

If either check fails, a reduced scale is refused. Full scale falls back to `traces` in cell-id order, with a warning.

`Cells: Cells I list` reads the ids in `Cell IDs` at full resolution, one row per cell in the order typed. It uses the same reader as Neurons to ZapBench Traces, so costs are the same too.

Either way, past 64 MB the card warns and reads anyway.

## A row at reduced scale is a bin

At Quarter, each value is the mean of a 4 × 4 block: four neighbouring cells in activity order × four timesteps.

- **Row labels.** A row's label lists the cells it averages, `40211+40212+40213+40214`. [ZapBench to Neurons](#zapbench:neurons) reads such a label as all four cells.
- **Column labels.** Columns are named by the absolute timestep their bin starts at.
- **Partial bins.** A trailing partial time bin is dropped. The last row may hold fewer than four cells.

> [!NOTE] Rows are in activity order, not cell-id order
> Neighbouring rows have correlated activity, which is what makes averaging them meaningful and a band on the Heatmap a coherent selection.

`Values: Stimulus-evoked response` has no downsampled copy, so it needs `Scale: Full`.

## Settings

```coda-params
zapbench:traces: cells, ids, scale, condition, product
```

## Data and credit

[ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html) is the Zebrafish Activity Prediction Benchmark: a whole-brain light-sheet calcium recording of one larval zebrafish, with about 70,000 segmented cells.

- The recording was made by Alex Bo-Yuan Chen in the Ahrens lab at HHMI Janelia.
- Segmentation annotations are by the CellMap Project Team.
- Alignment, segmentation and trace extraction are by Google Research.

Released under CC-BY 4.0. Cite Lueckmann, Immer et al., [ICLR 2025](https://openreview.net/pdf?id=oCHsDpyawq). Code and tutorials are at [google-research/zapbench](https://github.com/google-research/zapbench).
