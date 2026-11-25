## What Bounding Box does

Bounding Box makes an axis-aligned box from two opposite corners that you type in. It has two outputs:

- `Volumes` is the box as a mesh, the same kind of value [ROI Meshes](#neuron.roiMeshes) and [Upload Mesh](#core.uploadMesh) produce. Wire it into Points in Volumes to find the synapses inside the box, or into the [3D View](#out.viewer3d) to draw it.
- `Layers` is the box as a neuroglancer annotation. Wire it into the `Extra layers` socket of the [Neuroglancer](#out.neuroglancer) card to see it there.

```coda-graph
caption: Keep the synapses inside a box, and show the box in neuroglancer.
neuron.findNeurons as find
neuron.synapses as syn
core.boundingBox as box
neuron.pointsInVolumes as inside
out.neuroglancer as ngl
find:neurons -> syn:neurons
syn:points -> inside:points
box:meshes -> inside:volumes
find:neurons -> ngl
box:layers -> ngl:layers
```

## Corners

```coda-params
core.boundingBox: cornerA, cornerB
```

Type each corner as three numbers, e.g. `118000, 52000, 4100`. Commas, spaces or tabs between them all work, and so does `[118000, 52000, 4100]`, so you can paste a position straight from neuroglancer. It doesn't matter which corner you type first: the node takes the smaller and the larger value on each axis.

If both corners have the same value on an axis, the box is flat. The card warns you, because no point can be inside a flat box and Points in Volumes would put everything in `Outside`. A flat box still draws in neuroglancer, as a rectangle.

## Units

```coda-params
core.boundingBox: units, voxelSize
```

Everything in Coda is in nanometres. Neuroglancer, however, usually shows positions in voxels. If you copied your corners from neuroglancer's position readout, set `Units` to "voxels" and enter the dataset's voxel size in nanometres: `4, 4, 40` for FlyWire, `8, 8, 8` for the hemibrain and MANC. The node multiplies the corners out, so both outputs are in nanometres either way.

> [!WARNING] Getting the units wrong fails silently
> A box typed in voxels but read as nanometres sits in the wrong place and is the wrong size,
> and nothing reports an error. Points in Volumes just finds nothing inside it. If the box is
> empty when it shouldn't be, check `Units` and `Voxel size` first, or draw the box in the 3D View
> next to your neurons.

`Voxel size` has no default because it differs between datasets, and a wrong guess would put the box in the wrong place.

## Name

```coda-params
core.boundingBox: name
```

The name is what Points in Volumes writes in its `roi` column for the points inside the box, and what the layer is called in neuroglancer. It defaults to `box`. If you combine several boxes, give each its own name, or you won't be able to tell which box a point fell in.

## Several boxes in neuroglancer

The `Layers` input passes on whatever arrives there, with this box added. To show several boxes in one Neuroglancer card, chain them: wire the first box's `Layers` into the second's `Layers` input, and the second into `Extra layers`. Layers from Neuroglancer Source nodes can join the same chain.
