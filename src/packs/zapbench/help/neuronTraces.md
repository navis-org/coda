## What Neurons to ZapBench Traces does

This node fetches the calcium-imaging traces for the neurons in a fish2 table and returns them as a matrix: one row per neuron, one column per timestep. Neurons are matched to cells in the recording via fish2's `zapbenchId` property.

If you want to go the other way, from the recording to neurons, start with [ZapBench Traces](#zapbench:traces) instead.

```coda-graph
caption: Traces for a selection of fish2 neurons.
dataset.neuprint as ds "fish2"
neuron.findNeurons as find
zapbench:neuronTraces as zt
out.heatmap as hm
ds -> find:dataset
find -> zt
zt -> hm
```

## Matching neurons to cells

`ZapBench ID` is the column holding each neuron's ZapBench cell id; on fish2 that is `zapbenchId`. 62,178 of the 71,721 cells are matched to a fish2 neuron, so many neurons in your table won't have one. `Unmatched neurons` decides what happens to those:

- "Drop them" gives you a matrix of real measurements only.
- "Keep, with no values" preserves the input's row order and count, which is what you want if you join the result back onto something or use it as a colour channel. The empty rows can't be mistaken for measurements.
- "Keep, as zeros" is easier on code that can't handle gaps, but afterwards these rows look exactly like a neuron that was recorded and did nothing.

A `zapbenchId` is the 1-based label in the ZapBench segmentation, so cell `n` is column `n − 1` in the array. Values outside 1–71,721 are refused. If you see that error, the most likely cause is that `ZapBench ID` is set to a column of neuron ids. No dataset other than fish2 has a `zapbenchId` column.

Rows are named by `Label by`. This is what a [Heatmap](#out.heatmap) filter matches and what [Reduce Matrix](#core.reduceMatrix) names its rows by. Columns are named by absolute timestep, so the columns of a single condition keep their position in the recording.

```coda-params
zapbench:neuronTraces: idColumn, labelColumn, condition, unmatched, product
```

## What is read, and what it costs

Everything comes from the public ZapBench release at `gs://zapbench-release/volumes/20240930`, via HTTPS range requests. You don't need a token.

| Array | Contents |
| --- | --- |
| `traces` | zarr v3, uncompressed `float32`, 7,879 timesteps × 71,721 cells, df/f |
| `traces_rastermap_sorted/s0` + `sorting.json` (491 kB) | the same values, transposed and reordered by activity; read instead of `traces` when cheaper |
| `stimulus_evoked_response` | used with `Values` set to "Stimulus-evoked response"; same shape, no sorted copy |

The arrays are stored in chunks of 512 × 512, and the bucket serves one byte range per request. The cost of a read therefore depends on chunks, not on the number of neurons: in `traces`, any one neuron costs you its whole block of 512 cells, which is about 16 MiB over the full recording. The sorted copy is cheaper for a few scattered neurons, `traces` for many neurons over a short window. Each run reads from whichever is cheaper.

- `Condition` is the only setting that makes a read smaller. Subsampling in time would not help, because a single chunk already spans 512 timesteps.
- Above 64 MB, the card shows a warning but reads anyway.
- Traces are cached in memory per cell for the rest of the session, so adding a neuron to your selection only fetches what is new.

## Colouring neurons by activity

To colour neurons in 3D by their activity, reduce each trace to a single number and attach it to the skeletons:

```coda-graph
caption: One number per neuron, attached to its skeleton. Rows are labelled by neuron id, so `label` is the key.
neuron.findNeurons as find
zapbench:neuronTraces as zt
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

By default, Reduce Matrix computes the `mean` of each row. Colour the [3D View](#out.viewer3d) by that column.

## Data and credit

[ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html) is the Zebrafish Activity Prediction Benchmark: a whole-brain light-sheet calcium recording of one larval zebrafish, with about 70,000 segmented cells.

- The recording was made by Alex Bo-Yuan Chen in the Ahrens lab at HHMI Janelia.
- Segmentation annotations are by the CellMap Project Team.
- Alignment, segmentation and trace extraction are by Google Research.

Released under CC-BY 4.0. Cite Lueckmann, Immer et al., [ICLR 2025](https://openreview.net/pdf?id=oCHsDpyawq). Code and tutorials are at [google-research/zapbench](https://github.com/google-research/zapbench). fish2 is the EM connectome of the same fish.
