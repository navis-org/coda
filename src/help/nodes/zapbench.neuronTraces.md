Calcium-imaging traces for the neurons in a fish2 table, as a matrix: one row per neuron, one column per timestep. Neurons are matched to the recording by fish2's `zapbenchId` property. For the other direction, from the recording to neurons, start with [ZapBench Traces](#zapbench.traces).

```coda-graph
caption: Traces for a selection of fish2 neurons.
dataset.neuprint as ds "fish2"
neuron.findNeurons as find
zapbench.neuronTraces as zt
out.heatmap as hm
ds -> find:dataset
find -> zt
zt -> hm
```

## What it reads

Everything comes from the public ZapBench release, `gs://zapbench-release/volumes/20240930`, as HTTPS range requests. No token is needed.

| Array | Contents |
| --- | --- |
| `traces` | zarr v3, uncompressed `float32`, 7,879 timesteps × 71,721 cells, df/f |
| `traces_rastermap_sorted/s0` + `sorting.json` (491 kB) | the same values transposed and reordered by activity; read instead when cheaper |
| `stimulus_evoked_response` | with `Values: Stimulus-evoked response`; same shape, no sorted copy |

The array is stored in 512 × 512 chunks, and the bucket serves one byte range per request. So a read is priced in chunks, not neurons: in `traces`, any neuron costs its whole 512-cell block, about 16 MiB over the whole recording. The sorted copy is cheaper for a few scattered neurons, `traces` for many neurons over a short window. Each run reads whichever costs less.

- `Condition` is the only setting that makes a read smaller. Subsampling time would not, since one chunk already spans 512 timesteps.
- Past 64 MB, the card warns and reads anyway.
- Traces are cached in memory per cell for the session. Adding a neuron to the selection fetches only what is new.

## Settings

```coda-params
zapbench.neuronTraces: idColumn, labelColumn, condition, unmatched, product
```

A `zapbenchId` is the 1-based label in the ZapBench segmentation, so cell `n` is array column `n − 1`. Values outside 1–71,721 are refused; the usual cause is a picker left on a column of neuron ids.

62,178 of the 71,721 cells are matched to a fish2 neuron. No other dataset has a `zapbenchId` column.

Rows are named by `Label by`. Columns are named by absolute timestep, so a condition's columns keep their position in the recording.

## Colour neurons by activity

```coda-graph
caption: One number per neuron, attached to its skeleton. Rows are labelled by neuron id, so `label` is the key.
neuron.findNeurons as find
zapbench.neuronTraces as zt
core.reduceMatrix as red
neuron.skeletons as skel
neuron.attachAttributes as attach { matchOn: label }
out.viewer3d as v3d
find -> zt
find -> skel:neurons
zt -> red
skel -> attach:in
red -> attach:table
attach -> v3d:skeletons
```

Reduce Matrix's default statistic is the row `mean`. Colour the 3D View by that column.

## Data and credit

[ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html) is the Zebrafish Activity Prediction Benchmark: a whole-brain light-sheet calcium recording of one larval zebrafish, with about 70,000 segmented cells.

- The recording was made by Alex Bo-Yuan Chen in the Ahrens lab at HHMI Janelia.
- Segmentation annotations are by the CellMap Project Team.
- Alignment, segmentation and trace extraction are by Google Research.

Released under CC-BY 4.0. Cite Lueckmann, Immer et al., [ICLR 2025](https://openreview.net/pdf?id=oCHsDpyawq). Code and tutorials are at [google-research/zapbench](https://github.com/google-research/zapbench). fish2 is the EM connectome of the same fish.
