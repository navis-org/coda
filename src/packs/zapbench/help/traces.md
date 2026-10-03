## What ZapBench Traces does

ZapBench Traces reads the ZapBench calcium recording starting from its cells, and returns the traces as a matrix (one row per cell, one column per timestep). You can either read every cell at a reduced scale, which gives you an overview to select cells from, or read cells you list at full resolution.

If you already know which neurons you want traces for, use [Neurons to ZapBench Traces](#zapbench:neuronTraces) instead.

The typical workflow goes from activity to anatomy: look at all cells on a [Heatmap](#out.heatmap), shift-drag over the rows you are interested in on the expanded Heatmap, and send `Selected Rows` to [ZapBench to Neurons](#zapbench:neurons) to get the matching fish2 neurons:

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

```coda-params
zapbench:traces: cells, ids, scale, condition, product
```

## Reading every cell

Everything comes from the public ZapBench release at `gs://zapbench-release/volumes/20240930`, via HTTPS range requests. You don't need a token.

With `Cells` set to "Every cell", the node reads `traces_rastermap_sorted`, which is the release's copy of `traces` ordered by activity, at the level chosen under `Scale`:

| Scale | Level | Matrix over the whole recording | Download |
| --- | --- | --- | --- |
| Quarter (default) | `s2` | 17,931 × 1,969, 269 MB | ~144 MB |
| Half | `s1` | 35,861 × 3,939, 1.1 GB | refused |
| Full | `s0` | 71,721 × 7,879, 4.2 GB | refused |

"Refused" means the matrix would exceed the browser tab's 512 MiB allocation limit; the card tells you so before you run it. Picking a shorter `Condition` brings Half or Full under that limit.

Before the traces themselves, the node makes two small reads:

- `sorting.json` (491 kB), which maps the activity order back to cell ids.
- A few values from neighbouring levels, to check that each level really is the mean of the one below it.

If either check fails, reduced scales are refused. At full scale, the node falls back to reading `traces` in cell-id order and shows a warning.

## Reading listed cells

With `Cells` set to "Cells I list", the node reads the ids in `Cell IDs` at full resolution, one row per cell, in the order you typed them. It uses the same reader as Neurons to ZapBench Traces, so the costs are the same as described there.

In both modes, the card warns you above 64 MB but reads anyway.

## Rows at a reduced scale

At a reduced scale, each value is an average. At Quarter, for example, it is the mean of a 4 × 4 block: four neighbouring cells (in activity order) by four timesteps.

- **Row labels:** a row's label lists the cells it averages, e.g. `40211+40212+40213+40214`. ZapBench to Neurons reads such a label as all four cells.
- **Column labels:** columns are named by the absolute timestep at which their bin starts.
- **Incomplete bins:** a trailing time bin that is incomplete is dropped. The last row may hold fewer than four cells.

> [!NOTE] Rows are in activity order
> Rows are sorted by activity, not by cell id. Neighbouring rows therefore have correlated
> activity, which is why averaging them is meaningful and why a band of rows on the Heatmap makes
> a coherent selection.

Setting `Values` to "Stimulus-evoked response" requires `Scale` to be "Full", because there is no downsampled copy of that array.

## Data and credit

[ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html) is the Zebrafish Activity Prediction Benchmark: a whole-brain light-sheet calcium recording of one larval zebrafish, with about 70,000 segmented cells.

- The recording was made by Alex Bo-Yuan Chen in the Ahrens lab at HHMI Janelia.
- Segmentation annotations are by the CellMap Project Team.
- Alignment, segmentation and trace extraction are by Google Research.

Released under CC-BY 4.0. Cite Lueckmann, Immer et al., [ICLR 2025](https://openreview.net/pdf?id=oCHsDpyawq). Code and tutorials are at [google-research/zapbench](https://github.com/google-research/zapbench).
