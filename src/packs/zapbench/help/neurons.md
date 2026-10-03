## What ZapBench to Neurons does

ZapBench to Neurons looks up the fish2 neurons that match a set of ZapBench cells, and returns them as a neuron table. You can feed that into [Skeletons](#neuron.skeletons), [Meshes](#neuron.meshes) or any other node that takes neurons.

```coda-graph
caption: Cells typed by id, drawn as meshes.
dataset.neuprint as ds "fish2"
zapbench:neurons as zn { ids: "1203, 4410, 5000-5100" }
neuron.meshes as mesh
out.viewer3d as v3d
ds -> zn:dataset
ds -> mesh:dataset
zn -> mesh:neurons
mesh -> v3d:meshes
```

To go from cells you picked on a [Heatmap](#out.heatmap), see the figure on [ZapBench Traces](#zapbench:traces).

## Specifying cells

You can wire a table into `Cells`, type ids into `Cell IDs`, or both. Each cell is looked up only once: typed ids come first, then the ones from the wired column.

```coda-params
zapbench:neurons: column, ids
```

- **From a Heatmap:** `Cell column` defaults to `label`, which is the column a Heatmap's `Selected Rows` carries. A label like `40211+40212` is read as each of the cells it lists, so a row selected at a reduced scale looks up every cell it averages.
- **From a table:** a `zapbenchId` column works too.
- **Ranges:** a range like `5000-5100` includes both ends.
- **Invalid ids:** ids outside 1–71,721 are refused. Numbers above a million are flagged, because they are most likely neuron ids rather than cell ids.

## How the lookup works

Nothing is read from the ZapBench bucket. Instead, the node asks neuPrint for the fish2 neurons whose `zapbenchId` is in your list, one query per 5,000 cells. For this you need a Dataset wired to fish2 and the same neuPrint token that every other neuPrint node uses. Other datasets are refused, because none of them has a `zapbenchId`.

The output has fish2's neuron columns, the same as [Find Neurons](#neuron.findNeurons) returns, with rows in the order of your cells.

> [!NOTE] Population filters are ignored
> Every matched neuron is returned, regardless of which checkboxes are ticked on the Dataset node.

62,178 of the 71,721 cells have a matching EM neuron. Cells without one are counted in a warning rather than treated as errors.

## Data and credit

Cell ids come from [ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html), the Zebrafish Activity Prediction Benchmark: a whole-brain light-sheet calcium recording of one larval zebrafish.

- The recording was made by Alex Bo-Yuan Chen in the Ahrens lab at HHMI Janelia.
- Segmentation annotations are by the CellMap Project Team.
- Alignment, segmentation and trace extraction are by Google Research.

Released under CC-BY 4.0. Cite Lueckmann, Immer et al., [ICLR 2025](https://openreview.net/pdf?id=oCHsDpyawq). The match to fish2, the EM connectome of the same fish, is the `zapbenchId` property published on neuPrint.
