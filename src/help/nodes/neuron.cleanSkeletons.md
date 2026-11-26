## What Clean Skeletons does

Clean Skeletons repairs skeletons before you measure or compare them. It can do three things, each optional and always in this order:

1. **Heal**: join a skeleton that arrived in several disconnected pieces into one tree.
2. **Smooth**: take the jitter out of a tracing.
3. **Re-sample**: lay the nodes out at an even spacing along the cable.

All distances are in micrometres. Every step is off by default, so a freshly added node passes its skeletons through unchanged until you switch something on.

```coda-graph
caption: Clean skeletons before an all-by-all NBLAST.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
neuron.cleanSkeletons as clean { method: resample }
neuron.nblast as nb
ds -> find:dataset
ds -> skel:dataset
find -> skel:neurons
skel -> clean
clean -> nb:query
```

The number of nodes changes, but the number of neurons never does: each neuron keeps its row in the attribute table, so labels and colours downstream still line up.

The work runs in the in-browser Python runtime (navis-fastcore), so the first run of a session waits for a download of about 10 MB.

## Healing fragments

Skeletons from a segmentation, and many from CATMAID, come in several pieces. Most measurements walk the tree from its root, so a fragment that isn't connected is simply missed. `Heal fragments` joins the pieces with the shortest possible bridges.

```coda-params
neuron.cleanSkeletons: heal, healMethod, healMaxDist
```

With `Longest bridge` at 0 you always get one tree, which can mean joining a fragment that belongs to a different neuron. Set a limit (e.g. 5 µm) to leave distant fragments alone.

`Bridge from` says where a bridge is allowed to land. With `any node` you get the shortest join there is, which can attach a loose piece sideways onto the middle of another neurite. With `leaves and roots only` the loose ends are joined to each other — usually what you want for a neurite that broke in two, and the safer choice when the point of the exercise is to find open ends.

If the skeleton has a soma, the healed tree is rooted there.

## Smoothing

`Smooth` applies a Gaussian along the neurite, so the width is a distance along the cable rather than a number of nodes. Roots, branch points and leaves don't move. Smoothing helps [NBLAST](#neuron.nblast) in particular, because a raw tracing exaggerates every bend and NBLAST compares the directions of the neurites.

## Re-sampling

How densely a neuron was traced varies a lot, even within one neuron. Anything that averages a quantity per node is therefore weighted by tracing density. "re-sample to an even spacing" fixes that by placing nodes a fixed distance apart:

```coda-params
neuron.cleanSkeletons: method, spacing
```

1 µm is the usual spacing for NBLAST. Halving the spacing doubles the node count. A re-sample that would produce a very large number of nodes (millions) shows a warning first.

A new node's radius is interpolated between its two neighbours, which is exact only where the neurite tapers linearly.

To reduce the number of nodes instead, use [Simplify Skeletons](#neuron.simplifySkeletons).

## What happens to labels

- **Compartment labels** from the source (soma, axon, dendrite) are kept. A new node takes the label of the nearer of its two neighbours.
- **Node tags** (e.g. CATMAID's `soma` or `ends`) are kept, each moved to the nearest new node.
- **An axon/dendrite split** from [Split Axon/Dendrite](#neuron.splitCompartments), and any per-node values such as synapse flow, are dropped, because they belong to nodes that no longer exist. The node warns when this happens.

> [!TIP] Clean first, then split
> Put Clean Skeletons before Split Axon/Dendrite, not after it.

> [!NOTE] Distances need nanometre coordinates
> If the skeletons arrive in voxels, any setting that is a distance is refused, since a micrometre
> means nothing in voxels.

> [!NOTE] Older workflows
> Earlier versions could also "keep every Nth node". That has moved to Simplify Skeletons. A
> workflow saved with it still runs it and gets the same result, and the card says how to switch.

## Exporting

The notebook export calls the same navis-fastcore functions Coda runs, so it gives the same skeletons. There is no R equivalent for the smoothing, so the R Markdown export leaves a note pointing to the notebook.
