## Your own regions, as Volumes

A dataset's neuropils are the ones its curators named. Anything else — a glomerulus you
segmented, a shell from another lab's template, one hemisphere of a structure the connectome
lists whole — has no route onto a wire at all, because `ROI Meshes` can only ask a server for
what the server publishes.

This reads them off disk instead, and the output is the same `Volumes` value: the 3D View's
`Volumes` socket, `Points in Volumes`, `Download` and the rest take it without knowing where it
came from.

```coda-graph
caption: The shells are local and the neurons are not. They meet at the viewer, so both have to be in nanometres.
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

## OBJ, STL or PLY, one mesh per file

Pick several at once. Each file becomes one region named after itself — `LO_R.obj` arrives as
`LO_R` — so a directory of shells imports in one gesture. A file holding several objects merges
into one mesh; if you want them apart, they are apart on disk already.

Picking again **replaces** the set rather than adding to it.

> [!NOTE] An STL says nothing about which corners are shared
> The format writes every triangle's three corners separately, so the same shape is six times the
> vertices of an OBJ. Coda merges corners at identical coordinates on read, exactly — without
> that, `computeVertexNormals` shades each face flat and an uploaded shell looks faceted beside a
> fetched one. Exact, not within a tolerance: a tolerance is a decimation, and this is your data.

## Units are the one thing to get right

```coda-params
caption: Everything in Coda is nanometres. A micron file drawn as nanometres is a thousand times too small — internally consistent, so nothing fails and nothing looks broken except the picture.
core.uploadMesh: units
```

A connectome exports nanometres, a template-space or light-level surface is usually microns, and
a surface out of an MRI pipeline is millimetres. The scaling happens when the node runs, not when
the file is read, so a wrong setting costs a re-run rather than another trip to the file picker.

## What arrives

One mesh per file, with an attribute row each:

| Column | What it is |
| --- | --- |
| `roi` | the region's name — the file's own, without its extension |
| `primary` | always true here |
| `file` | the file it came from |

The first two are `ROI Meshes`' columns under `ROI Meshes`' names, which is what makes the two
interchangeable downstream. `primary` is the licence to sum, and nothing in a pile of files says
which shells sit inside which — so it is true throughout rather than guessed at.

`file` is the column a fetched set has no counterpart for. Two directories can each hold an
`LO.obj`, and then two regions are both called `LO`.

> [!WARNING] Sharing a workflow does not share the meshes
> The `.coda.json` carries a content-addressed reference and nothing else. A colleague opening it
> sees the card naming your files and everything downstream blocked until they pick their own
> copies. Send the files alongside the link.
