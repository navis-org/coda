## What Skeletons does

Skeletons fetches the skeletons (centreline tracings) for the incoming neurons. Wire the `Dataset` to say where to fetch from, and a table of neurons into `Neurons`:

```coda-graph
caption: Find neurons, fetch their skeletons and show them in 3D.
dataset.hemibrain as ds
neuron.findNeurons as find
neuron.skeletons as skel
out.viewer3d as v3d
ds -> find:dataset
ds -> skel:dataset
find -> skel:neurons
skel -> v3d:skeletons
```

Coordinates are always in nanometres, whatever units the dataset itself uses, so the skeleton and the [mesh](#neuron.meshes) of a neuron line up.

Each skeleton comes with its attributes (e.g. its cell type), so downstream you can, for example, colour neurons by type in the [3D View](#out.viewer3d).

Each neuron is a separate request, so large sets take a while. `Warn above` (default 10,000) only shows a warning; it does not stop you from fetching more.

## Skeleton sources

Some datasets offer skeletons from more than one source, and they can differ quite a bit:

| Source                | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| published skeletons   | a `neuroglancer_skeletons` directory next to the segmentation              |
| neuPrint SWC          | neuPrint's own skeletons; the only neuPrint source with radii              |
| CAVE skeleton service | generated on demand and then cached; a neuron not yet cached takes 10–45 s |
| level-2 chunk graph   | one node per level-2 chunk; coarser, but faster to generate                |
| CATMAID tracing       | manually traced skeletons                                                  |

```coda-params
caption: The footer of the card shows which source was used.
neuron.skeletons: skeletonSource
```

"Automatic" picks the best source available for the dataset. If you pick a specific source and the dataset doesn't have it, you get an error rather than a fallback.

> [!NOTE] The list fills in after the first run
> Which sources are available is checked per dataset. In a fresh session, the list may only offer
> "Automatic" until the node has run once.

## Carry fields

The skeletons come with their own attribute table, which is built by the fetch and is not the same as the neuron table you wired in. On neuPrint, for example, it has seven columns (`neuronId`, `type`, `instance`, `status`, `size`, `points`, `cableLength`) no matter how many properties the dataset publishes.

Use `Carry fields` to bring additional columns from the incoming neuron table along, matched by `neuronId`:

```coda-params
caption: Carried columns can be used by Split Neurons, the 3D View's colour picker and Download.
neuron.skeletons: carry
```

You can carry any column of that table: the dataset's own properties, labels from an annotation chain, or a column rewritten by a Relabel. A few details:

- A neuron without a row in the incoming table keeps its skeleton and gets an empty value.
- A neuron listed twice takes its values from the first row (it is not duplicated).
- A carried column replaces an existing column of the same name and keeps its position. You can use this to override an outdated `type`, for example.

> [!NOTE] Changing Carry fields re-runs the node
> Most skeletons will come from the cache rather than the server, but the node does need to run
> again.
