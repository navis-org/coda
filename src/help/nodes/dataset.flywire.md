## About this dataset

FlyWire FAFB is the automated segmentation of the FAFB volume, a whole adult female *Drosophila* brain including both optic lobes, proofread by the FlyWire community. Coda reads the public release through CAVE.

Meshes, synapses, connectivity and skeletons are all available, the skeletons only for materialization 783, which is the one that publishes them. [Paths](#neuron.paths) and per-region synapse counts are not available; nodes that need them say so instead of failing.

## Materialization

```coda-params
dataset.flywire: version
```

There are two public materializations:

- `783` matches the data package of the Nature papers
- `630` matches the preprints

## Annotations

There are two sets of annotations for FlyWire:

1. Structured, hierarchical annotations (super class, class, type, side, etc.) from Schlegel et al., 2024; Matsliah et al., 2024; and Berg et al., 2024.
2. Free-form community annotations.

> [!WARNING] The built-in annotations are outdated
> On its own, this node uses the CAVE table `hierarchical_neuron_annotations`, which holds an
> outdated version of the hierarchical annotations and none of the community annotations. As long
> as nothing is wired into its `Annotations` input, the card warns you about this and offers a
> `Use current annotations` button that adds the setup described below.

You don't have to wire up the current annotations by hand. If you open this dataset via New ▸ FlyWire FAFB public or the Workflow Wizard, it comes with the full setup already in place:

- the latest hierarchical annotations from the [flywire_annotations](https://github.com/flyconnectome/flywire_annotations) repository
- root IDs updated to the selected materialization
- the community annotations joined in as tags

These six nodes arrive folded into a single frame called *FlyWire annotations*. You can open the frame to see them, but you don't have to. The AI assistant knows to build the same setup, and the zoo's *FlyWire FAFB Full Stack* workflow is the same graph with viewers already arranged.

## Connectivity

FlyWire publishes a server-side "view" that adds up synapses into connections between neurons, which makes small connectivity queries reasonably fast.

> [!TIP] Large connectivity queries
> For large queries, you can use a local copy of the edge table instead. Click the `Edge data`
> button on the card.

## Other CAVE datastacks

For CAVE datastacks other than FlyWire, use [Custom CAVE](#dataset.cave). There you name the datastack and the table holding its neurons yourself.
