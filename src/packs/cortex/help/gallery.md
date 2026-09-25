Principally for the MICrONS minnie65 dataset, the gallery draws a wall of cells against depth below the pia. Each cell's axon and dendrite are in two colours, and the layers run behind them. The wall scrolls on the card, and can be resized or opened full size. Cells can be browsed by type, and selected to pass on as a table and as skeletons. For a dataset's cells as a searchable table, use [Explore Dataset](#neuron.explore).

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

## What it draws

Each cell is drawn at its soma's depth, from the dataset's cortical frame. For MICrONS minnie65 that is the rigid transform of `standard_transform` (see below): a 5° rotation, with the pia at depth 0. The layer boundaries are the column's published ones, and the ruler at the start of each row names them.

Axon and dendrite are the skeletons' own compartment labels. An unlabelled segment is grey; nothing is inferred/computed locally. Skeletons are fetched on demand via CAVE's SkeletonService, with L2 skeletons as fallback if a neuron has no cached skeleton.

The stripe over each cell is its type - see `Cell type source` below.
`Second stripe` adds a band from another column, such as `mtype`. Past eight values colours repeat - the legend will note that.

A dataset with no declared cortical frame is refused. Only minnie65 has one so far.

## Cell type source

minnie65 publishes its cell types in tables beside the neuron table, not on it. By default the gallery, merges them into a single columns - this allows the widget to work with a bare dataset as input. You have, however, full control over which annotations are used via `Cell type source` and `Group by`:

- `aibs_cell_info`, the default, combines the published typings by precedence: `type`, `mtype`, `broad_type` and `visual_area`.
- The others are single typings, among them two sets of m-types. Each arrives as `type`, so `Group by` regroups the wall without being changed.
- **None** reads whatever annotations are wired into Dataset.

Neuron status, i.e. which neurons are marked as proofread, is always read from `aibs_cell_info`.

## Browsing

- **Line-up** shows all groups in sequency.
- **Rows** gives each group its own row.
- **Compare** sets two groups side by side on one depth scale. Pick them with "Compare" and "with".

`Order` sets how the groups follow one another. By depth, a group's place is its median soma depth, so the wall reads down the cortex. Within a group, cells are always shallowest first.

`Column width` sets how wide each cell's column is. **Fit each neuron** makes a column as wide as the cell's own arbour, never clipped, so columns vary. **Even** gives every cell the same width, clipped at its edges, so columns line up. That width is `Width (µm)`, or, left empty, the median extent of the cells on the wall. Widths are in µm, so the card and the full-size view look the same.

`Per type` cells of each group are drawn, a random sample of those that pass `Proofread`. Shuffle draws another. Each group is sampled on its own, so filtering one out leaves the others' cells where they were.

`Proofread` reads minnie65's proofreading status. If that status cannot be read, the card says so and draws every cell.

The download button beside the cell count saves the whole wall, every row and not just those in view, as an SVG or a PNG with a legend of its colours. The selection is not drawn.


## Settings

```coda-params
cortex:gallery: cellTypes, groupBy, stripe, proofread, columnMode, columnUm, perType
```

## What it outputs

Click a cell to select it, and again to deselect it. Click "N selected" beside the cell count to clear the selection. The selection is saved in the workflow.

- `Selected` is the selected cells' rows of the neuron table, with the chosen cell-type columns and two more: `soma_depth` in µm below the pia, and `layer`. A cell with no single nucleus has neither.
- `Skeletons` are the selected cells' reconstructions, with their compartment labels. They are read at the Dataset's materialization, so each is the neuron as it is there, including any proofreading since earlier releases.

## Data and credit

Needs a CAVE token (Connections). MICrONS minnie65 is the [MICrONS Consortium](https://www.microns-explorer.org/cortical-mm3)'s, Nature 2025. The depth transform follows [`standard_transform`](https://github.com/CAVEconnectome/standard_transform). This widget is based on work by Casey Schneider-Mizell (Allen Institute for Brain Science).
