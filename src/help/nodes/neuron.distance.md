## What it measures

Every pair of neurons, as a number of micrometres. Three measures, chosen with `Measure`:

- **`nearest-point distance`** works from every part of the Query to the closest part of the Target. `Statistic` reduces that to one number — the closest approach, the mean or median separation, or the furthest any part of the Query gets from the Target.
- **`centroid distance`** compares one point per neuron: the centre of mass of its cable, or of its surface.
- **`cable or area within a distance`** turns the question round and asks how *much* of a neuron is close to the other one.

These are distances to the **nearest** part of the other neuron, never between every pair of points. An all-pairs mean is dominated by how large each neuron is rather than by how near the two are: two arbours 50 µm apart and 200 µm across average about 150 µm, and would do so whether or not they touched.

Skeletons and meshes both, on either socket. A distance to a mesh is a distance to its **surface**, not to its nearest vertex.

## Where it sits beside NBLAST

The same two sockets and the same matrix out, and a different question. NBLAST scores how alike two arbours are in *shape*; two identically-shaped cells in opposite hemispheres score highly. This asks where they are.

It is also the one node whose matrix is a distance already, so `Linkage` clusters it with nothing in between.

```coda-graph
caption: Distances are a matrix, so clustering and the Heatmap take them unchanged.
dataset.hemibrain as ds
neuron.skeletons as skel
neuron.distance as dist
cluster.linkage as link
out.heatmap as hm
ds -> skel:dataset
skel -> dist:query
dist -> link
link:ordered -> hm
```

Leave `Target` empty for an all-by-all, or wire a second set to measure one group against another.

## Sampling does not move the answer

A skeleton's nodes sit wherever it was traced or resampled; a mesh is tessellated finely where it curves. So every sample carries the amount of neuron it stands for — half the length of each edge at a skeleton node, a third of the area of each triangle at a mesh vertex — and the statistics are weighted by it.

What that means in practice:

- `mean separation` and `median separation` are a mean and a median **over the neuron's cable or surface**. Resampling a skeleton upstream, or a coarser `Downsample` on the Meshes node, does not move them.
- `centroid distance` is a centre of mass, not the average of the sample points. A neuron traced densely at the soma and sparsely along a long projection has its centroid on the cable, not near the soma.
- `cable or area within a distance` is a real quantity — µm of cable, µm² of surface — so two neurons reconstructed differently are comparable.

`closest approach` and the furthest distance are not averages of anything and ignore the weights.

> [!NOTE]
> The pair of nodes this is most often confused with is **Clean Skeletons**, one card up. Resampling there is still worth doing to make two datasets' skeletons comparable in *shape* for NBLAST — it is just no longer needed to make a mean distance mean something.

## The two directions disagree

Measuring A against B is not measuring B against A: a small neuron can lie entirely alongside a large one, and only the Query side is sampled at all. `Symmetry` decides what to publish.

```coda-params
neuron.distance: symmetry
```

| Setting                     | Symmetric | Use when                                             |
| --------------------------- | --------- | ---------------------------------------------------- |
| `mean of both directions`   | yes       | the default; what makes an all-by-all matrix symmetric |
| `smaller of the two`        | yes       | "do these come near each other at all"                 |
| `larger of the two`         | yes       | "is either of them far from the other"                 |
| `query against target only` | no        | the Query is the population you are describing         |

`centroid distance` has one direction by construction, so the setting is hidden for it.

**It is also drawn dead for a closest approach between two skeletons**, where the two directions
are the same number — the nearest pair of points is the nearest pair whichever side you start
from. Wire a mesh to either socket and it comes back, because only the Query side is ever sampled:
a skeleton's nodes against a surface and that surface's vertices against the nodes really are two
measurements. Your setting is kept while the control is dead, not reset.

## Cable within a distance

```coda-params
neuron.distance: within, report
```

`Within` is how close counts as close — 2 µm is the usual choice, and roughly the distance across which a synapse could plausibly be made. `Report` chooses between an absolute quantity and a fraction of the neuron's own total.

The fraction is what makes two neurons of very different sizes comparable, and it is the only form a clustering can use directly: an absolute overlap is unbounded, so there is no distance to be had from it without a `Normalize` first.

> [!WARNING]
> With skeletons on one socket and meshes on the other, the two directions are µm of cable and µm² of surface. Averaging them is not a number of anything, so the node refuses — set `Symmetry` to `query against target only`, which measures the Query and nothing else, or wire the same kind of geometry to both.

## What it does not do

There is **no soma-to-soma distance**. Coda's skeletons carry positions, radii and a parent per node, and no soma — a root is usually the soma on a reconstruction that has one, and is not on a chunk-graph skeleton or on a fragment, so an anchor that meant two things depending on where the skeleton came from would be worse than none. `centroid distance` is the anchor that is always well defined.

Both sides have to be in the same coordinate system, and in nanometres. Geometry in dataset voxels is refused rather than reported in the wrong units; two template spaces are refused because every pair would come back hundreds of micrometres apart whatever their real shapes. `Transform Neurons` is the step in between.
