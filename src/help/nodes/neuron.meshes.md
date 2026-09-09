Good for visualisation, and expensive to download and keep in memory.

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

Unlike neuroglancer, which loads the coarsest level and refines it as you zoom, this node does a single download at the requested detail.

> [!WARNING] A source with no levels of detail ignores this
> The node still returns a mesh, at the same detail whatever the budget.

> [!NOTE] Not every dataset has meshes where it has skeletons
> A precomputed volume can resolve to a directory with nothing in it, which reports as neurons
> that have no mesh. Try [Skeletons](#neuron.skeletons) before concluding the neuron is missing.

## Carry fields

A collection's attribute table is not the neuron table you wired in — the fetch builds its own, and on neuPrint that is seven columns (`neuronId`, `type`, `instance`, `status`, `size`, `points`, `cableLength`) however many properties the dataset publishes. **Carry fields** names columns of the incoming table to bring along, matched by `neuronId`:

```coda-params
caption: Whatever you carry is what [Split Neurons](#neuron.splitNeurons), the 3D View's colour picker and Download can see.
neuron.meshes: carry
```

It carries what is on that table already — the dataset's own properties, an annotation chain's labels, a column a Relabel rewrote. A neuron the incoming table has no row for keeps its geometry and carries a blank; a neuron listed twice annotates from the first row rather than doubling. A carried column **replaces** one of the same name, keeping its position, which is how you override a stale `type`.

> [!WARNING] It is part of the provenance key, so changing it re-runs the fetch
> The per-neuron geometry cache answers most of that without going back to the server, but the
> node does go stale.
