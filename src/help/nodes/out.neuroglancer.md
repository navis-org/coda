```coda-graph
caption: Explore and visualise neurons.
neuron.explore as exp
out.neuroglancer as ngl
exp:selected -> ngl
```

## What is in the scene

neuPrint publishes rich neuroglancer scenes for each dataset: image data, segmentation including neuron meshes, a brain outline and sometimes synapse locations.

CAVE datasets provide only image and segmentation sources, from which Coda constructs a basic scene.

> [!WARNING] A CAVE scene occasionally fails to centre on the neurons you select
> Use the `Center` button in the inspector to recentre the view.

CATMAID datasets do not work in neuroglancer at all — use the `3D View` node instead.

```coda-params
caption: URL-affecting settings that tune the scene.
out.neuroglancer: layout, limit
```
