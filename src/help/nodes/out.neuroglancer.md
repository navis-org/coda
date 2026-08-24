```coda-graph
caption: Explore and visualize neurons.
neuron.explore as exp
out.neuroglancer as ngl
exp:selected -> ngl
```

## What's in the scene?

NeuPrint typically publishes rich neuroglancer scenes for each dataset: image data, segmentation (includes neuron meshes), a brain outline and sometimes synapse locations.

CAVE datasets only provide image and segmentation sources from which we construct a very basic scene.

> [!WARNING]
> CAVE scenes occasionally fail to center on the neurons you select. If that happens, use the `Center` button in the inspector to recenter the view.

CATMAID datasets do not work in Neuroglancer at all. You have to use the `3D View` node instead.


```coda-params
caption: URL-affecting settings that tune the scene.
out.neuroglancer: layout, limit
```
