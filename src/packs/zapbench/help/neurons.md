The fish2 neurons matched to a set of ZapBench cells, as a neuron table ready for [Skeletons](#neuron.skeletons), [Meshes](#neuron.meshes) or any node that takes neurons.

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

For cells picked on a Heatmap, see the figure on [ZapBench Traces](#zapbench:traces).

## Cells in

```coda-params
zapbench:neurons: column, ids
```

Cells come from the wired `Cells` table, from `Cell IDs`, or both. Each cell is looked up once: typed ids first, then the wired column.

- **From a Heatmap.** `Cell column` defaults to `label`, the column a Heatmap's `Selected Rows` carries. A label like `40211+40212` is read as each of its cells, so a bin selected at reduced scale looks up every cell it averages.
- **From a table.** A `zapbenchId` column works too.
- **Ranges.** A range like `5000-5100` includes both ends.
- **Out of range.** Ids outside 1–71,721 are refused, and numbers above a million are flagged as likely neuron ids.

## What it reads

Nothing comes from the ZapBench bucket. The node sends one neuPrint query per 5,000 cells, for the fish2 neurons whose `zapbenchId` is in the list. It needs a Dataset wired to fish2 and the neuPrint token every neuPrint node uses. Other datasets are refused, since none carries `zapbenchId`.

The output has fish2's neuron columns, as Find Neurons returns them, with rows in the order of the cells.

> [!NOTE] The dataset's population filters do not apply
> Every matched body is returned, whatever the Dataset node's checkboxes say.

62,178 of the 71,721 cells have an EM neuron. The rest are counted in a warning, not treated as errors.

## Data and credit

Cell ids come from [ZAPBench](https://zapbench-release.storage.googleapis.com/landing.html), the Zebrafish Activity Prediction Benchmark: a whole-brain light-sheet calcium recording of one larval zebrafish.

- The recording was made by Alex Bo-Yuan Chen in the Ahrens lab at HHMI Janelia.
- Segmentation annotations are by the CellMap Project Team.
- Alignment, segmentation and trace extraction are by Google Research.

Released under CC-BY 4.0. Cite Lueckmann, Immer et al., [ICLR 2025](https://openreview.net/pdf?id=oCHsDpyawq). The match to fish2, the EM connectome of the same fish, is the `zapbenchId` property published on neuPrint.
