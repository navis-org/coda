## What Affinity Clusters does

Affinity Clusters asks a model whether the points of a neuron all belong to the same neuron. It samples 1024 points from each skeleton, runs them through a point affinity transformer, and gets back an affinity for every ordered pair — how confident the model is that those two points are on one cell. Clustering those affinities gives each point a cluster number.

The model is [Troidl et al.'s point affinity transformer](https://doi.org/10.1101/2024.11.24.625067), the FlyWire checkpoint, converted and quantised to run in your browser on WebGPU. Nothing is sent to a server, and nothing is written back to the segmentation.

> [!WARNING]
> **This checkpoint does not find real merges**
> It was trained on synthetic merges: two neurons each centred on the origin and then offset by about 20 µm. A real merge is two neurons in their true positions, touching at one place. Whether the model carried over was an open question when this node was written, and it has since been answered — scored against real FlyWire merges it performs **at chance**. A second node, Find Merges, is being built around a model trained on real FlyWire merges; until it lands there is nothing here that finds merges reliably.
>
> This node is kept because a retrained affinity model would slot straight into it, and because its clustering is a useful way to look at what a shape model thinks about a neuron. It is not a merge detector.

```coda-graph
caption: Clusters drawn over the EM, beside the segment they are about.
dataset.flywire as ds
neuron.findNeurons as find
neuron.skeletons as skel
seam:affinityClusters as clusters
out.neuroglancer as ng
ds -> find
find -> skel:neurons
ds -> skel:dataset
skel -> clusters:in
ds -> ng:dataset
clusters:layers -> ng:layers
```

## Downloading the model

The weights are a few hundred megabytes. Nothing is fetched until you tick `Download the model`, and the card refuses to run until you do. They are then kept in this browser, so the second run — and every run after it, in any workflow — starts in about a second. Once they are cached the tick box no longer matters.

You need WebGPU. Chrome and Edge have it; Safari and Firefox are adding it. A page served over plain `http` has it switched off, and the node says so rather than running on the CPU, where it would take minutes per neuron.

## Outputs

| Output      | Contents                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `Skeletons` | the input, with a `cluster` value on every skeleton node and the summary columns on its attributes  |
| `Points`    | the sampled points themselves, one row each, with `cluster` and `confidence`                        |
| `Table`     | one row per neuron: `clusters`, `backgroundShare`, `confidence` and `lowestConfidence`              |
| `Layers`    | a neuroglancer annotation layer of the sampled points, coloured by cluster                          |

`Layers` goes into the Neuroglancer node's `Extra layers` socket, which puts the clusters over the EM beside the segment they are about. Chain another layer-emitting node into this one's `Layers` input to send more than one.

To draw the clusters in the 3D View instead, colour the `Skeletons` output by node value and pick "predicted cluster". Cluster 0 is background.

The summary columns are on the skeletons' attribute table as well as in `Table`, so [Split Neurons](#neuron.splitNeurons) and [Filter Table](#core.filterTable) can work on them directly — `clusters > 1` keeps the neurons the model split.

## Reading the numbers

`confidence` on a point is the mean affinity from it to the rest of its own cluster. A low value on a point the clustering nonetheless placed is the useful signal: it is where the boundary is soft, which is where to look. `lowestConfidence` on a neuron is the weakest such point.

`backgroundShare` is the fraction of points that fell into no cluster at all. Clusters smaller than `Minimum cluster size` become background, because the training data deliberately held fragments belonging to no complete neuron. A large background share means the model found little it was confident about, which is itself worth knowing.

Background does not spread when the answer is folded back onto the skeleton: a node whose nearest sampled point is background is background too, rather than being given the nearest real cluster.

## Settings

`Points` is how many points are sampled from each skeleton, with replacement, as the model's own training sampler did. The work grows with the square of it — 1024 points is about ten seconds per neuron, 2048 about forty. The model was trained at 1024 and the node warns if you move away from what the checkpoint was evaluated at.

`Threshold` is a distance threshold on `1 − affinity`, which is how the paper states it: 0.8 links points whose average affinity is above 0.2. Lower it to split more readily. Clusterings near the threshold are sensitive, so a point changing cluster between two nearby settings is expected.

`Minimum cluster size` folds anything smaller into background.

> [!TIP]
> **Send a few neurons at a time**
> Every neuron costs the full square, and a long run only shows its answer at the end. A set of ten is about two minutes; the card warns past five. Cancel is seen within about a third of a second.

A skeleton with fewer than 50 nodes is left out — there is not enough shape for the model to reason about — as is one whose coordinates are in voxels, which cannot be converted to the micrometres the model expects. A left-out neuron keeps its row in `Table` and its place in `Skeletons`, with empty cluster columns, but contributes no points — so it is absent from `Points` and from the annotation layer. The card says how many there were and why.

```coda-params
seam:affinityClusters: points, threshold, minClusterSize
```
