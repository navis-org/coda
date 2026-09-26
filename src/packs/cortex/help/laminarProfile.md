Draws a depth column running down the cortex, with the dataset's layers behind the bars and each layer's count beside them. Fed by [Cortical Depth](#cortex:depth) on a synapse cloud and split by `partnerType`, it is a laminar input or output profile: which layers each partner type's synapses land in. Fed by the [Cortex Gallery](#cortex:gallery)'s `Selected`, with `soma_depth` as the depth, it shows where a set of cells sits.

```coda-graph
caption: Where a set of cells receives its inputs, by partner type.
dataset.minnie65 as ds
neuron.findNeurons as find
neuron.synapses as syn
cortex:depth as depth
cortex:laminarProfile as prof
ds -> find
ds -> syn
find -> syn:neurons
syn -> depth:points
ds -> depth:dataset
depth:table -> prof
ds -> prof:dataset
```

## Reading it

Depth runs down from the pia, which is the line at 0. Bars start at multiples of `Bin (µm)`. The layers are drawn only with the Dataset wired, since a table does not say which dataset its depths are in. The count beside each layer is how many rows fall in it, and its share of all rows plotted.

`Split by` stacks each bar by a column. Past eight values the rest are folded into one grey `Other`. `Scale` as percent of rows makes two profiles of different sizes comparable.

## Facets

`Facet by` gives each value of a column a panel of its own, side by side: `neuronId` for one panel per neuron, `type` for one per cell type. Every panel shares one depth axis, one bin grid and one count scale, and a series keeps its colour in every panel. With `Scale` as percent of rows, each panel is a share of its own rows, so neurons of very different sizes can be compared by shape.

Panels are drawn largest first, up to `Panels`; the caption says how many more there were. Rows with no value in the facet column get a panel of their own, drawn last. Each panel names its layers and their shares at its right edge.

## Settings

```coda-params
cortex:laminarProfile: depth, series, facet, facetMax, binUm, normalize
```

## What it outputs

Click a bar to select its rows, or a layer's count to select that layer's. In a faceted profile the selection is within that panel: a bar in one neuron's panel selects that neuron's rows at those depths, and changing `Facet by` later does not change what it selects. Shift-click adds to the selection. `Selected` carries the rows in the selected depth ranges, and `Table` passes the input on. A selection holds depth ranges, so it survives a change of bin width.
