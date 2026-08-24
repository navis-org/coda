## The shape of a brain region, on a wire

Every other `ROI` node answers a question about regions with a **table** — how many synapses, how completely traced, which pairs are connected. This one answers with their **shapes**, so a scene can put an arbour inside the volume it innervates instead of floating in the dark.

```coda-graph
caption: The volumes and the neurons meet at the viewer. Both are fetched from the same dataset, so they are already in the same space.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
neuron.roiMeshes as rois
out.viewer3d as view
ds -> find
ds -> skel:dataset
ds -> rois:dataset
find:neurons -> skel:neurons
skel -> view:skeletons
rois:meshes -> view:volumes
```

It needs nothing but a Dataset. Like `ROI Completeness`, it asks about the *volume* rather than about a list of cells, so it runs with one wire.

## Empty means the set that tiles the volume

```coda-params
caption: Leave it empty and the source decides — which is what you want, because it knows which of its regions nest.
neuron.roiMeshes: rois
```

The published region list **nests**. Hemibrain lists 229 regions of which 63 tile the brain; male-CNS lists 5,619 of which 144. So "every region" is not a bigger version of the right answer — it is thousands of requests producing a picture in which every shell is drawn inside another one.

An empty picker therefore means the **primary set**: the regions that do not sit inside each other. Name regions explicitly when you want a few, and the picker offers exactly what the connected dataset publishes.

> [!WARNING] One request per region, and they are not small
> A whole primary set runs to 29–62 MB — four to nine times a whole-dataset neuron index. That is why this node is `expensive`: nothing here is fetched until you press Run, and a picker you are still editing costs nothing.

## What arrives

A `Volumes` output carrying one mesh per region, with an attribute row each:

| Column | What it is |
| --- | --- |
| `roi` | the region's name, which is also the mesh's own id |
| `primary` | whether it belongs to the set that tiles the volume |

Both are ordinary columns, so `Volume colour` on the 3D View can colour by either — `by category` on `roi` gives every neuropil its own hue, and on `primary` it separates the tiling set from the ones nested inside it.

> [!NOTE] These are display surfaces, not measurements
> neuPrint publishes region meshes for visualization and says so: they are decimated, so a volume or a surface area computed off one is an approximation of a drawing rather than a figure to quote. Use `ROI Counts` and `ROI Completeness` for anything numeric.

## Where they go

The 3D View's `Volumes` socket, which is a **second** meshes input beside `Meshes` and not the same one. A neuropil shell and a neuron are the same type and never the same mark: one is an opaque object you are looking at, the other is faint context around it. Two sockets is what lets each keep its own colour and its own opacity — `Volume opacity` starts at 0.12, because a shell is drawn so that something else can be seen inside it.

Nothing stops you wiring these into the ordinary `Meshes` socket instead. It will draw, and it will draw opaque, in the same encoding as your neurons.
