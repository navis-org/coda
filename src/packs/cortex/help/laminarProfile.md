## What Laminar Profile does

Laminar Profile bins a depth column and draws it as bars running down the cortex, with the dataset's layers in the background and a count for each layer beside them.

There are two common ways to use it:

- Feed it the table from [Cortical Depth](#cortex:depth) run on a synapse cloud, and split by `partnerType`. This gives you a laminar input or output profile: which layers each partner type's synapses land in.
- Feed it the `Selected` output of the [Cortex Gallery](#cortex:gallery) and use `soma_depth` as the depth. This shows you where a set of cells sits.

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

## Reading the plot

Depth runs downwards from the pia, which is the line at 0. Each bar is `Bin (µm)` deep, and bars start at multiples of it.

The layers are only drawn if you wire the Dataset: a table on its own doesn't say which dataset its depths come from. The number beside each layer is how many rows fall into it, along with their share of all plotted rows.

`Split by` stacks each bar by the values of a column. Beyond eight values, the rest are folded into a single grey `Other`. Set `Scale` to "percent of rows" if you want to compare two profiles of different sizes.

## Facets

`Facet by` gives each value of a column its own panel, side by side. For example, `neuronId` gives you one panel per neuron and `type` one per cell type.

- All panels share the same depth axis, bin grid and count scale, and each series keeps its colour across panels.
- With `Scale` set to "percent of rows", each panel shows shares of its own rows. This is useful for comparing the shape of the profile between neurons of very different sizes.
- Panels are sorted largest first, up to the number set in `Panels`. The caption tells you how many were left out.
- Rows with no value in the facet column get a panel of their own, drawn last.
- Each panel lists its layers and their shares along its right edge.

```coda-params
cortex:laminarProfile: depth, series, facet, facetMax, binUm, normalize
```

## Selecting rows

Click a bar to select its rows, or click a layer's count to select all rows in that layer. Shift-click adds to the selection.

In a faceted profile, a selection is specific to its panel: clicking a bar in one neuron's panel selects that neuron's rows at those depths. Changing `Facet by` afterwards does not change what is selected.

The selection is stored as depth ranges, so it survives changing the bin width.

There are two outputs:

- `Selected` contains the rows in the selected depth ranges.
- `Table` passes the input through unchanged.
