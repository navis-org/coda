## What Distance between does

Distance between measures how far apart neurons are in space and returns a matrix with one value per pair, in micrometres. It takes skeletons or meshes on either input. Leave `Target` empty to compare every neuron against every other (all-by-all), or wire a second set to compare one group against another.

`Measure` decides what exactly is calculated:

- "nearest-point distance": for every part of the Query neuron, find the closest part of the Target neuron. `Statistic` then reduces those distances to a single number: the closest approach, the mean or median separation, or how far the Query gets from the Target at most.
- "centroid distance": the distance between the two neurons' centres of mass (of their cable or their surface).
- "cable or area within a distance": how much of one neuron lies within a given distance of the other.

For meshes, distances are measured to the nearest point on the mesh's surface, not to its nearest vertex.

## Distance vs. NBLAST

This node has the same inputs and output as [NBLAST](#neuron.nblast) but answers a different question. NBLAST asks how similar two neurons are in *shape*: two neurons with identical shapes in opposite hemispheres get a high score. Distance between asks where they are relative to each other.

Because the output already contains distances, [Linkage](#cluster.linkage) can cluster it directly:

```coda-graph
caption: Cluster neurons by how far apart they are.
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

## Nearest points, not all pairs

All statistics are computed over distances to the *nearest* point on the other neuron, not over every pair of points. A mean over all pairs would mostly reflect how large the neurons are: two arbours that are 50 µm apart and 200 µm across would average about 150 µm, whether or not they touch.

## Sampling

Skeleton nodes sit wherever the neuron was traced or resampled, and meshes have more vertices where the surface curves. To make sure this doesn't bias the results, each sample point is weighted by how much of the neuron it represents: half the length of each edge at a skeleton node, and a third of the area of each triangle at a mesh vertex.

In practice this means:

- "mean separation" and "median separation" are averages over the neuron's cable or surface. Resampling a skeleton upstream, or changing `Downsample` on the [Meshes](#neuron.meshes) node, does not change them.
- "centroid distance" uses the centre of mass, not the average of the sample points. For a neuron that was traced densely around the soma and sparsely along a long projection, the centroid still lies on the cable rather than near the soma.
- "cable or area within a distance" gives real quantities (µm of cable, µm² of surface), so neurons reconstructed in different ways are comparable.

"closest approach" and "furthest from the other" are not averages and ignore the weights.

> [!TIP] You don't need to resample for this node
> Clean Skeletons is still worth using to make skeletons from two
> datasets comparable in shape for NBLAST, but you don't need it to get meaningful mean distances
> here.

## Symmetry

Measuring A against B does not give the same result as measuring B against A: a small neuron can lie entirely alongside a large one, and only the Query side is sampled. `Symmetry` decides how the two directions are combined:

```coda-params
neuron.distance: symmetry
```

| Setting                     | Symmetric | Use when                                                |
| --------------------------- | --------- | ------------------------------------------------------- |
| "mean of both directions"   | yes       | the default; makes an all-by-all matrix symmetric       |
| "smaller of the two"        | yes       | you want to know whether two neurons come close at all  |
| "larger of the two"         | yes       | you want to know whether either is far from the other   |
| "query against target only" | no        | the Query is the population you are describing          |

The setting is hidden for "centroid distance", which only has one direction anyway.

It is also greyed out for "closest approach" between two sets of skeletons: here both directions give the same number, since the nearest pair of points is the same whichever side you start from. If you wire a mesh to either input, the setting becomes available again, because measuring skeleton nodes against a surface and the surface's vertices against the nodes are two different measurements. Your choice is kept while the setting is greyed out.

## Cable within a distance

```coda-params
neuron.distance: within, report
```

`Within` sets how close counts as close. 2 µm is a common choice: it is navis's default for cable overlap and roughly the distance across which two neurons could plausibly form a synapse.

`Report` switches between an absolute quantity (µm of cable or µm² of surface) and a fraction of the neuron's own total. The fraction makes neurons of very different sizes comparable, and it is the only form you can cluster directly: an absolute overlap has no upper bound, so you would have to run it through a [Normalize](#core.normalize) first.

> [!WARNING] Skeletons vs. meshes
> With skeletons on one input and meshes on the other, the two directions are µm of cable and µm²
> of surface respectively, and averaging them makes no sense. The node refuses this combination:
> either set `Symmetry` to "query against target only" or wire the same kind of geometry to both
> inputs.

## Limitations

There is no soma-to-soma distance. Coda's skeletons don't carry a soma: the root is usually the soma for a full reconstruction, but not for a chunk-graph skeleton or a fragment. Use "centroid distance" if you need a single anchor point per neuron.

Both inputs have to be in the same coordinate system, and in nanometres. Geometry in voxels is refused, and so are neurons in two different template spaces (every pair would come out hundreds of micrometres apart). Use [Transform Neurons](#neuron.xform) to bring them into the same space first.
