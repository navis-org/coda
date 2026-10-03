## What the Cortex Gallery does

The Cortex Gallery draws a wall of cells, each at its depth below the pia, with the cortical layers in the background and the axon and dendrite in two different colours. It is mainly meant for the MICrONS minnie65 dataset.

You can browse the wall by cell type, scroll through it on the card, resize the card or open it full size. Cells you select are passed on as a table and as skeletons. If you would rather search a dataset's cells as a table, use [Explore Dataset](#neuron.explore).

```coda-graph
caption: Select cells on the wall; Skeletons carries their reconstructions.
dataset.minnie65 as ds
cortex:gallery as gal
out.table as tbl
out.viewer3d as v3d
ds -> gal
gal:selected -> tbl
gal:skeletons -> v3d:skeletons
```

## What is drawn

Each cell is placed at the depth of its soma, using the dataset's cortical frame. For MICrONS minnie65 that is the rigid transform from `standard_transform` (credited below): a 5° rotation, with the pia at depth 0. The layer boundaries are the column's published ones, and the ruler at the start of each row names them.

Axon and dendrite come from the skeletons' own compartment labels. Unlabelled segments are drawn in grey: nothing is inferred or computed locally. Skeletons are fetched on demand from CAVE's SkeletonService. If a neuron has no cached skeleton there, its L2 skeleton is used instead.

The coloured stripe over each cell shows its type (see `Cell type source` below). `Second stripe` adds another band from a different column, such as `mtype`. Beyond eight values the colours repeat, and the legend says so.

Datasets without a declared cortical frame are refused. At the moment, only minnie65 has one.

## Cell type source

minnie65 publishes its cell types in separate tables next to the neuron table. By default, the gallery merges these into a single column, so it works with a bare dataset as input. You can choose which annotations to use with `Cell type source` and `Group by`:

- `aibs_cell_info` (the default) combines the published typings in order of precedence: `type`, `mtype`, `broad_type` and `visual_area`.
- The other options are single typings, among them two sets of m-types. Each of them arrives as `type`, so `Group by` regroups the wall without you having to change it.
- "None" uses only the annotations already on the Dataset, e.g. a table you wired into it.

Proofreading status is always read from `aibs_cell_info`, whichever source you pick.

## Browsing

`Mode` sets how the groups are laid out:

- "Line-up" shows all groups one after another.
- "Rows" gives each group its own row.
- "Compare" puts two groups side by side on the same depth scale. Pick them with `Compare` and `With`.

`Order` sets the order of the groups. "By depth" places each group by the median depth of its somata, so the wall reads down the cortex. Within a group, cells are always sorted shallowest first.

`Column width` sets how wide each cell's column is:

- "Fit each neuron" makes each column as wide as the cell's own arbour, without clipping. Columns therefore vary in width.
- "Even" gives every cell the same width and clips the arbours at the edges, so the columns line up. The width is `Width (µm)` or, if you leave that empty, the median extent of the cells on the wall.

Widths are in µm, so the card and the full-size view look the same.

`Per type` sets how many cells of each group are drawn: a random sample of the cells that pass `Proofread`. Hit shuffle to draw a different sample. Each group is sampled separately, so filtering one group out does not change the cells shown for the others.

`Proofread` uses minnie65's proofreading status. If the status can't be read, the card tells you and draws every cell.

The download button next to the cell count saves the whole wall (every row, not only those in view) as an SVG or PNG, with a legend of its colours. The selection is not drawn in the export.

```coda-params
cortex:gallery: cellTypes, groupBy, stripe, proofread, columnMode, columnUm, perType
```

## Selecting cells

Click a cell to select it, and click it again to deselect it. To clear the whole selection, click "N selected" next to the cell count. The selection is saved with the workflow.

There are two outputs:

- `Selected` contains the selected cells' rows from the neuron table, with the chosen cell-type columns plus `soma_depth` (µm below the pia) and `layer`. Cells without exactly one nucleus get neither.
- `Skeletons` contains the selected cells' reconstructions, with their compartment labels. They are read at the Dataset's materialization, so each one reflects the neuron as it is there, including any proofreading done since earlier releases. Each skeleton carries its cell's row from `Selected` (cell type, depth, layer), so you can colour a [3D View](#out.viewer3d) by any of those columns.

## Data and credit

You need a CAVE token (Connections). MICrONS minnie65 is from the [MICrONS Consortium](https://www.microns-explorer.org/cortical-mm3), Nature 2025. The depth transform follows [`standard_transform`](https://github.com/CAVEconnectome/standard_transform). This widget is based on work by Casey Schneider-Mizell (Allen Institute for Brain Science).
