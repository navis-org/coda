Good for visualization but also expensive to download and keep in memory.

```coda-graph
caption: Same shape as [Skeletons](#neuron.skeletons); the two can share a scene.
dataset.flywire as ds
neuron.findNeurons as find
neuron.meshes as mesh
out.viewer3d as v3d
ds -> find:dataset
ds -> mesh:dataset
find -> mesh:neurons
mesh -> v3d:meshes
```

## Detail is a budget for the whole batch, not per neuron

```coda-params
neuron.meshes: detail
```

Sources with levels of detail pick the finest level that fits, so **asking for more neurons gets you coarser ones**. Drop the neuron count, or raise the budget, if a mesh looks blocky.

Note this is different from neuroglancer which loads the coarsest level and then progressively refines it as you zoom in. This node does a single download at the requested detail.

> [!WARNING] A source with no levels of detail ignores this
> Not all datasets provide multi-resolution meshes. The node will still return a mesh, but it will be the same detail regardless of the budget.

> [!NOTE] Not every dataset has meshes where it has skeletons
> A precomputed volume can resolve to a directory with nothing in it, which reports as neurons that have no mesh. Try [Skeletons](#neuron.skeletons) before concluding the neuron is missing.
