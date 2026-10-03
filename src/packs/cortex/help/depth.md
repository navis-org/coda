## What Cortical Depth does

Cortical Depth takes a point cloud (typically synapses) and works out where each point sits in the cortex: its depth below the pia in µm, the layer it falls in, and its lateral position. It uses the dataset's cortical frame, the same one the [Cortex Gallery](#cortex:gallery) draws with. On a synapse cloud it also adds the cell type of each synapse's neuron and of its partner.

Once the layer is a column, you can answer laminar questions with ordinary nodes: [Laminar Profile](#cortex:laminarProfile) draws the profile, [Group By](#core.groupBy) counts synapses per layer, and [Filter Table](#core.filterTable) keeps the synapses in one layer.

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

## Added columns

| Column        | Contents                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| `depth`       | µm below the pia; negative above it                                      |
| `lateral`     | µm across the cortex, along the frame's flattened axis                   |
| `layer`       | the layer `depth` falls in, using the frame's published layer boundaries |
| `type`        | the cell type of `neuronId`, from `Cell type source`                     |
| `partnerType` | the cell type of `partnerId`, from `Cell type source`                    |

If the input already has a column with one of these names, it is overwritten in place.

A point more than 40 µm above the pia gets a depth but no layer, and the card tells you how many such points there were. If that number is large, the points probably come from a different dataset.

A partner that the chosen typing does not name gets an empty `partnerType`. Most of a neuron's synaptic partners are fragments, so expect a large share of untyped partners.

```coda-params
cortex:depth: cellTypes
```

## The cortical frame

For MICrONS minnie65, the frame is the rigid transform from `standard_transform`: a 5° rotation, with the pia at depth 0. It is exact near the column and becomes less accurate further away from it.

Only minnie65 declares a cortical frame at the moment. Other datasets are refused. The points also have to be in nanometres.

## Outputs

- `Points` is the point cloud with the new columns, e.g. for a [3D View](#out.viewer3d).
- `Table` contains the same rows as a table, for any node that takes one.
