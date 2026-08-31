Wire-frame morphologies for the incoming neurons. Coordinates are always **nanometres**, converted from whatever the dataset stores, so a skeleton and a mesh of the same neuron sit in the same space.

```coda-graph
caption: Neurons in, geometry out. The Dataset wire is what says where to fetch from.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
out.viewer3d as v3d
ds -> find:dataset
ds -> skel:dataset
find -> skel:neurons
skel -> v3d:skeletons
```

Each skeleton carries its own attributes, so colouring by e.g. cell type downstream is just a matter of selecting the corresponding column.

## Skeleton flavors

Some datasets offer multiple sources for skeletons, and they aren't necessarily the same:

| Route                 | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| published skeletons   | a `neuroglancer_skeletons` directory beside the segmentation               |
| neuPrint SWC          | neuPrint's own traced skeleton — the only neuPrint route with radii        |
| CAVE skeleton service | generated on demand and cached; a cold neuron is 10–45 s                   |
| level-2 chunk graph   | one node per L2 chunk — coarser but faster to generate                     |
| CATMAID tracing       | always manually traced                                                            |


```coda-params
caption: `Source` is per dataset, and the card footer repeats whichever it used.
neuron.skeletons: skeletonSource
```

> [!NOTE] The list is dynamic
> Skeletons sources are probed per dataset. A fresh session offers `Automatic` initially, and will populate the list after the first run.

## Cost

Expensive, one request per neuron. `Warn above` (10,000) is a threshold, not a cap.
