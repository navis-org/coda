## What Find Neurons does

Find Neurons searches a dataset for neurons matching one or more filters. The result is a table of neurons that you can pass on to almost any other node, e.g. to look at them in 3D:

```coda-graph
caption: Search for neurons and look at them in Neuroglancer.
dataset.hemibrain as hb
neuron.findNeurons as find
out.neuroglancer as ngl
hb -> find
find -> ngl
```

## Filters

Each filter is a row with a field, a condition and a value, e.g. `type` "matches regex" `LC.*`. You can add as many rows as you like; a neuron has to match all of them.

The fields come from the dataset you plug in, so the list changes from dataset to dataset:

- neuPrint datasets offer `type`, `status`, `size` and whatever else that release publishes, such as `cellBodyFiber` on hemibrain or `hemilineage` on MANC.
- FlyWire offers `super_class`, `cell_class` and `cell_sub_class`.
- CATMAID projects offer `annotations` and `cableLength`.

A few conditions are worth knowing about:

- "is one of" takes several comma-separated values. This is how you say "or" (e.g. `type` "is one of" `LC4, LPLC2`). On neuPrint it is also faster than the equivalent regex.
- "matches regex" has to match the *whole* value, so `LC.*` finds `LC4` but not `LPLC1`.
- "is" and "contains" are case-sensitive.

```coda-params
neuron.findNeurons: filters, limit
```

> [!WARNING] No filters, no neurons
> A Find Neurons node without any filters returns nothing rather than the whole dataset, because
> these queries go to shared servers. If you really want every neuron, add a row like `neuronId`
> "is not empty". To browse a dataset without querying it, use
> [Explore Dataset](#neuron.explore).

## Region and limit

Under the advanced settings you will find two more options:

- `In ROI` restricts the search to neurons with synapses in a given region. It only shows up for datasets that support it. A region on its own counts as a filter, so a node with only `In ROI` set will run a query.
- `Limit` caps the number of neurons returned. The default of 0 means no cap. A limit on its own does not count as a filter, so a node with only a limit still returns nothing.

## Large results

If more than 10,000 neurons match, the node shows a warning. It still returns all of them, but keep in mind that every one of those neurons is passed on to everything downstream. A morphology node such as [Skeletons](#neuron.skeletons) will likely be above its own `Warn above` threshold before it even starts.
