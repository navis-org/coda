## What Meshes does

Meshes fetches the surface meshes for the incoming neurons. Meshes are great for visualisation, but they are expensive to download and keep in memory. The node works just like [Skeletons](#neuron.skeletons), and the two can be shown in the same scene:

```coda-graph
caption: Find neurons, fetch their meshes and show them in 3D.
dataset.flywire as ds
neuron.findNeurons as find
neuron.meshes as mesh
out.viewer3d as v3d
ds -> find:dataset
ds -> mesh:dataset
find -> mesh:neurons
mesh -> v3d:meshes
```

## Level of detail

```coda-params
neuron.meshes: detail
```

Some sources publish meshes at several levels of detail. For those, `Detail` sets a triangle budget for the *whole* set of neurons, and the node picks the finest level that fits into it. That means the more neurons you ask for, the coarser each of them will be. If your meshes look blocky, either fetch fewer neurons or raise the budget.

Unlike neuroglancer, which loads the coarsest level first and refines as you zoom in, this node downloads each mesh once, at the requested detail.

> [!NOTE] Sources with only one level of detail
> If a source publishes just one level, `Detail` is greyed out and has no effect. Use `Downsample`
> (under the advanced settings) instead: 1 keeps full resolution (the default), 0 reduces each
> mesh only as far as needed for a 3D view to draw it, and a number above 1 is a ratio (4 keeps
> about a quarter of the triangles). Changing it re-fetches the meshes.

> [!NOTE] Missing meshes
> Not every dataset has meshes for every neuron that has a skeleton. If neurons come back without
> a mesh, try [Skeletons](#neuron.skeletons) before concluding the neuron is missing.

## Carry fields

The meshes come with their own attribute table, which is built by the fetch and is not the same as the neuron table you wired in. On neuPrint, for example, it has seven columns (`neuronId`, `type`, `instance`, `status`, `size`, `points`, `cableLength`) no matter how many properties the dataset publishes.

Use `Carry fields` to bring additional columns from the incoming neuron table along, matched by `neuronId`:

```coda-params
caption: Carried columns can be used by Split Neurons, the 3D View's colour picker and Download.
neuron.meshes: carry
```

You can carry any column of that table: the dataset's own properties, labels from an annotation chain, or a column rewritten by a Relabel. A few details:

- A neuron without a row in the incoming table keeps its mesh and gets an empty value.
- A neuron listed twice takes its values from the first row (it is not duplicated).
- A carried column replaces an existing column of the same name and keeps its position. You can use this to override an outdated `type`, for example.

> [!NOTE] Changing Carry fields re-runs the node
> Most meshes will come from the cache rather than the server, but the node does need to run
> again.
