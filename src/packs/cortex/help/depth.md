Places a point cloud in the cortex. Each point gets its depth below the pia in µm, the layer it falls in, and its lateral position across the cortex, all through the dataset's cortical frame — the same one the [Cortex Gallery](#cortex:gallery) draws with. On a synapse cloud it also adds the cell type of each synapse's neuron and of its partner.

Once "which layer" is a column, the rest of the canvas can answer laminar questions: [Laminar Profile](#cortex:laminarProfile) draws the profile, [Group By](#core.groupBy) counts per layer, [Filter Table](#core.filterTable) keeps one layer's synapses.

```coda-graph
caption: The input profile of a set of cells, split by partner type.
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

## What it adds

- `depth`: µm below the pia; negative above it.
- `lateral`: µm across the cortex, along the frame's flattened axis.
- `layer`: the layer that depth falls in, by the frame's published boundaries. A point more than 40 µm above the pia has a depth and no layer, and the card says how many — usually a sign the points are from another dataset.
- `type` and `partnerType`: the cell type of `neuronId` and of `partnerId`, from `Cell type source`. A partner the typing does not name is empty. Most of a neuron's partners are fragments, so expect a large untyped share.

A column already carrying one of these names is written over in place.

For MICrONS minnie65 the frame is `standard_transform`'s rigid transform: a 5° rotation, with the pia at depth 0. It is exact near the column and drifts away from it. A dataset with no declared cortical frame is refused; only minnie65 has one so far. The points must be in nanometres.

## Settings

```coda-params
cortex:depth: cellTypes
```

## What it outputs

`Points` is the cloud with the new columns, for a [3D View](#out.viewer3d). `Table` is the same rows as a table, for anything that takes one.
