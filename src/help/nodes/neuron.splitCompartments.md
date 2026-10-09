## How the split works

Split Axon/Dendrite labels every node of a skeleton as axon, dendrite or linker. It uses navis's `split_axon_dendrite` with synapse flow centrality, the method from Schneider-Mizell et al. (2016):

1. For every piece of cable, count how many paths from an input (postsynaptic site) to an output (presynaptic site) run through it. That count is the synapse flow.
2. Everything at or above `Linker threshold` × the neuron's peak flow is the linker. With the default 0.9, that is the cable carrying the top 10% of flow, usually the stretch between the dendrite and the axon.
3. Cutting out the linker leaves a few pieces. A piece whose share of the neuron's outputs is at least `Axon threshold` times its share of the inputs is axon; the rest is dendrite.

```coda-params
neuron.splitCompartments: flowThresh, splitVal, heal, flow
```

The split runs in the Python runtime, so the first one in a session waits for a ~10 MB download. After that it is fast, and moving a threshold re-splits straight away.

## Inputs

You need the skeletons and a synapse cloud for the same neurons, with both inputs and outputs. That is the `Synapses` node with `Polarity` left on "both".

A neuron can come back unsplit. The `splitStatus` column in Summary says why:

- "no synapses": it has only inputs or only outputs, which is common for sensory and motor neurons cut off at the edge of the volume.
- "multiple roots": the skeleton arrived in several pieces. Tick `Heal fragmented skeletons` to join them before splitting. The joins are only used for the split; the skeleton you get back is unchanged.

> [!WARNING] Not Synapses Between
> A `Synapses Between` cloud puts the presynaptic neuron in `neuronId` on every row, so a
> postsynaptic neuron's inputs would be filed under its partner. Use a plain `Synapses` node.

## A typical chain

```coda-graph
caption: Split a set of neurons and look at them in 3D.
neuron.findNeurons as find
neuron.skeletons as skel
neuron.synapses as syn
neuron.splitCompartments as split
out.viewer3d as view
find -> skel:neurons
find -> syn:neurons
skel -> split:skeletons
syn -> split:synapses
split:out -> view:skeletons
```

In the 3D View, set the skeleton `Colour` to "by compartment (axon/dendrite)".

## Inspecting a split

Run the node, then open the card full size with ⤢. You can also put it on a dashboard, next to a 3D View of the same skeletons.

The full-size view shows one neuron at a time as an unrooted dendrogram, coloured by compartment. Page through the neurons with ‹ ›. The dot marks the root, and the bar shows the neuron's segregation index (`SI`): 1 when inputs and outputs are completely apart, 0 when they are mixed evenly. If the index is low for a neuron you know is well polarised, the split probably needs fixing.

Turn on `Synapses` in the bar to draw the synapses on the dendrogram, outputs on one side of each branch and inputs on the other. A misplaced split usually shows up as a run of outputs on cable labelled dendrite, or the reverse.

The `Summary` output has the same numbers for every neuron at once: cable and synapse counts per compartment, `segregationIndex`, and `corrections`, the number of hand corrections applied to that neuron. Sorting by `segregationIndex` is a quick way to find the neurons worth a second look.

## Fixing a split

Try the thresholds first, since they apply to every neuron:

- Axon and dendrite swapped, or twigs near the linker landing on the wrong side: change `Axon threshold`. Lower it to call more of the neuron axon, raise it to call more of it dendrite.
- Linker too short or too long: change `Linker threshold`. Lowering it makes the linker longer.

For a single neuron, correct it by hand. Click a branch on the dendrogram and choose from the menu:

- "Away from the root → axon / dendrite / linker" relabels the branch and everything beyond it, as seen from the root.
- "Everything else → …" relabels the rest of the neuron instead.
- "Make this the root" moves the root to that end of the branch. Do this first when the part you want to relabel lies between the click and the current root.

Say the split put the axon's first branch point on the dendrite. Click the branch just past it and choose "Away from the root → axon". The colours, the `SI` and Summary update straight away; there is no need to re-run.

Each correction is listed beside the dendrogram for the neuron on screen. ✕ removes one, and "Reset this neuron" removes them all. Corrections are applied in order, so a later one wins where two overlap.

Corrections are applied on top of the automatic split, so they still hold when you change a threshold. They are saved with the node, in the workflow file and in share links. "Reset root" goes back to the root the neuron opened on.

> [!NOTE] Corrections that no longer land
> A correction remembers where you clicked and which root it was made from. If the skeleton
> changes, for example because you fetched it from another source, a click may no longer land
> on the neuron. The node then warns "N of M hand corrections no longer land", keeps them, and
> leaves the labels as they were. Remove them in the full-size view.

> [!NOTE] Healed skeletons
> With `Heal fragmented skeletons` on, a correction only reaches the fragment that holds its
> root. The full-size view draws that fragment only.

## Outputs

- `Skeletons`: the input skeletons with the split stored on them, for the 3D View's compartment colours. A neuron that could not be split has no labels.
- `Synapses`: the input cloud with a `compartment` column (`axon`, `dendrite`, `linker`, or empty).
- `Summary`: one row per neuron, with the skeletons' own columns first.

With `Write synapse flow` on, the skeletons also carry each node's flow as a fraction of that neuron's peak. Set the 3D View's skeleton `Colour` to "by node value" to see it; everything above `Linker threshold` is linker.

> [!TIP] Clean first, then split
> Clean Skeletons renumbers the nodes, so it drops a split and says so. Put it before this node,
> not after.
