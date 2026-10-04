## What BigClust Project does

This node reads one embedding from a [BigClust](https://github.com/schlegelp/BigClust2) project. It gives you four tables (the neurons, their 2D coordinates, the k-NN graph and the feature vectors) plus the project's neuroglancer scene.

```coda-graph
caption: Draw the embedding as a scatter plot, coloured by cell type.
annotation:bigclust as bc
core.join as j
out.scatter as sc
bc:embedding -> j:left
bc:neurons -> j:right
j -> sc
```

## Opening a project

Paste the address of the project folder (the folder containing the `info` file) under `URL`, or press **Choose folder…** to pick a folder on your disk. Addresses can be `https://…` or `gs://…`, as long as the server allows cross-origin requests; public `gs://` buckets do. If you paste an address ending in `/info`, the node uses the folder it is in.

> [!NOTE] Local folders after a reload
> Chrome and Edge remember a chosen folder across a reload, and at most ask you for one click to
> read it again. Other browsers ask you to choose the folder again.

## Choosing an embedding

A project usually holds several embeddings of the same neurons. For example, the fish2 project has one computed from NBLAST and two from connectivity. `Embedding` picks the one this node reads; by default that is the first. The inspector lists all of the project's embeddings, what each one comes with (k-NN graph, distances, features), and marks the one being read.

The four table outputs have the same columns whichever embedding you pick:

| Output       | Columns                                     | Contents                                                                 |
| ------------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| `Neurons`    | `neuronId` plus the project's own columns   | the project's `meta` table, with its `id` column renamed to `neuronId`; the same for every embedding |
| `Embedding`  | `neuronId`, `x`, `y`                        | the coordinates of the chosen embedding                                  |
| `Neighbours` | `queryId`, `targetId`, `rank`, `distance`   | the embedding's k-NN graph, one row per neighbour; `rank` 1 is the nearest |
| `Features`   | `neuronId`, `group`, `feature`, `value`     | the embedding's feature vectors, one row per non-zero value              |

In `Features`, two-level column names like `('upstream', 'LC4')` are split into `group` (`upstream`) and `feature` (`LC4`). `Neighbours` and `Features` are empty if the embedding has no k-NN graph or no feature vectors.

To compare two embeddings, use one node per embedding and [Join](#core.join) their `Embedding` tables on `neuronId`.

## Re-embedding a selection

To lay out just part of the project again, wire `Neighbours` (or `Features`) into an [Embedding](#core.embed) node and your selection, e.g. a [Scatter Plot](#out.scatter)'s `Selected`, into its `Only these` input. Because BigClust's k-NN graph holds distances, set the Embedding node's `Neighbour: score` to `distance` and `Scores are` to "distances (bigger is further apart)".

## Matching by row

Like BigClust itself, this node matches every embedding, k-NN graph and feature file to `meta` by row: the first row of each file is taken to be the first neuron in `meta`, whatever ids the file carries. If an embedding has its own id column and it disagrees with `meta`, the file is still read by row and the card tells you how many rows disagree.

Neighbours that are missing, out of range or the neuron itself are left out, again as in BigClust. Neurons left with no neighbours at all are counted in a warning.

## The neuroglancer scene

`Scene` is the project's own neuroglancer scene. Wire it into the `Dataset` input of a [Neuroglancer](#out.neuroglancer) node, then wire a selection (e.g. a Scatter Plot's `Selected`) into that node's `Neurons` to have those neurons drawn.

```coda-graph
caption: The project's scene next to its embedding. Wire the Scatter Plot's Selected into the Neuroglancer node's Neurons.
annotation:bigclust as bc
out.scatter as sc
out.neuroglancer as ng
bc:embedding -> sc
bc:scene -> ng:dataset
```

The scene is built from the project's `neuroglancer` settings, in the same way BigClust builds its 3D view: one segmentation layer per source the neurons come from (named after their dataset), plus the faint context mesh. Each neuron goes into its own source's layer, so a project spanning two connectomes puts every neuron in the right one. As long as the Neuroglancer node's colour setting is left on the scene's own colours, each neuron is drawn in the colour the project gives it.

> [!NOTE] Two settings are left out of the scene
> Landmark transforms between datasets are not included, so each dataset is drawn in its own
> space. A context mesh that is a file rather than a neuroglancer source is left out too. The card
> tells you which of these applied.

## What gets read

The node reads `meta` and the chosen embedding's files in one go, which is why it waits for **Run**. It does not read:

- a full square distance matrix: at the size of a whole connectome it does not fit in memory, and the card tells you when an embedding has one. Only a k-NN graph ends up in `Neighbours`.
- the `meta` sources BigClust refreshes its metadata from.

Some servers compress files while sending them, and then a file cannot be read in parts. Such files are downloaded whole, and the card lists them. If the project has changed, press **read again** to load it afresh.
