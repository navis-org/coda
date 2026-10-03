## What ROI Meshes does

ROI Meshes fetches the 3D shapes of a dataset's brain regions (neuropils), so that you can show neurons inside the regions they innervate. The other ROI nodes give you tables with numbers; this one gives you meshes. All it needs is a Dataset:

```coda-graph
caption: Show neurons together with the regions they innervate.
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

Because the neurons and the regions come from the same dataset, they are already in the same space.

## Choosing regions

```coda-params
caption: Leave Regions empty to get the primary set.
neuron.roiMeshes: rois
```

If you leave `Regions` empty, you get the **primary** regions, i.e. the ones that together tile the brain without overlapping. That is usually what you want, because a dataset's full list of regions is nested: the hemibrain lists 229 regions of which 63 are primary, the male CNS lists 5,619 of which 144 are primary. Fetching all of them would mean thousands of requests, and a picture in which every region is drawn inside another one.

To fetch just a few regions, pick them by name; the list offers exactly the regions the dataset publishes.

Some sources publish region meshes without names, for example FlyWire's neuropil meshes read through a `Neuroglancer Source`. There, the picker lets you type or paste the segment ids of the regions instead, and each mesh is named by its id. On such a source, leaving the picker empty fetches nothing.

> [!WARNING] Region meshes are large
> Each region is a separate request, and the full primary set comes to 29–62 MB. The node
> therefore only runs when you press Run.

## Output

The `Volumes` output contains one mesh per region, with these attributes:

| Column    | What it is                                              |
| --------- | ------------------------------------------------------- |
| `roi`     | the name of the region (also the id of the mesh)        |
| `primary` | whether the region is one of the primary regions        |

You can use either column for `Volume colour` in the [3D View](#out.viewer3d): "by category" on `roi` gives every region its own colour, and on `primary` it distinguishes primary regions from the ones nested inside them.

> [!NOTE] For display only
> These meshes are simplified (decimated) for visualisation, so volumes or surface areas computed
> from them are only approximations. For numbers, use [ROI Counts](#neuron.roiCounts) or
> [ROI Completeness](#neuron.roiCompleteness).

## Showing regions in the 3D View

Wire the output into the 3D View's `Volumes` input. This is a separate input from `Meshes`, so that regions and neurons can have their own colour and opacity. `Volume opacity` starts at 0.12, so you can see the neurons inside the regions.

You can also wire the regions into the ordinary `Meshes` input. They will then be drawn opaque, with the same colour settings as your neurons.
