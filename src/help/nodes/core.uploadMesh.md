## What Upload Mesh does

Upload Mesh loads meshes from files on your computer and outputs them as `Volumes`, the same kind of value [ROI Meshes](#neuron.roiMeshes) produces. Use it for regions that the dataset doesn't publish: a glomerulus you segmented yourself, a neuropil from another lab's template brain, or one half of a structure the connectome only lists as a whole.

The output can go anywhere ROI Meshes can, e.g. the `Volumes` socket of the [3D View](#out.viewer3d) or Points in Volumes:

```coda-graph
caption: Draw your own meshes next to neurons from a dataset. Both have to be in nanometres.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
core.uploadMesh as up
out.viewer3d as view
ds -> find
ds -> skel:dataset
find:neurons -> skel:neurons
skel -> view:skeletons
up:meshes -> view:volumes
```

## Files

Press "Choose meshes…" and pick one or more OBJ, STL or PLY files. Each file becomes one mesh, named after the file: `LO_R.obj` becomes a region called `LO_R`. That way you can import a whole folder of meshes in one go. If a file contains several objects, they are merged into one mesh; to keep them apart, save them as separate files.

Picking files again replaces the current set; it does not add to it.

STL files store every triangle's corners separately. Coda merges corners with identical coordinates when reading the file, so STL meshes are shaded as smoothly as OBJ or PLY ones. Corners are only merged if their coordinates match exactly, so the mesh itself is not changed.

## Units

Everything in Coda is in nanometres, so you have to tell the node what units your files are in:

```coda-params
core.uploadMesh: units
```

Meshes exported from a connectome are usually in nanometres, template-brain or light-level meshes usually in microns, and meshes from MRI pipelines often in millimetres.

> [!WARNING] Getting the units wrong fails silently
> A mesh in microns that is read as nanometres comes out a thousand times too small. Nothing
> breaks and there is no error; the mesh just won't show up where your neurons are. If an
> uploaded mesh seems to be missing in the 3D View, check `Units` first.

The units are applied when the node runs, not when the file is read, so fixing them doesn't require picking the files again.

## Output columns

Each mesh comes with one row of attributes:

| Column | Contains |
| --- | --- |
| `roi` | the region's name: the file name without its extension |
| `primary` | always true |
| `file` | the file the mesh came from |

`roi` and `primary` match the columns of [ROI Meshes](#neuron.roiMeshes), so downstream nodes treat both the same way. `primary` is set to true for every mesh because Coda has no way of knowing whether one of your meshes sits inside another. Keep that in mind if you add up counts across regions that overlap.

Two folders can each contain an `LO.obj`, which would give you two regions called `LO`. The `file` column tells them apart.

> [!WARNING] Sharing a workflow does not share the meshes
> A `.coda.json` file or share link only contains a reference to the meshes. A colleague opening
> it sees the card naming your files, and everything downstream stays blocked until they pick
> their own copies. Send the files along with the workflow.
