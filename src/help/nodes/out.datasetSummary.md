## What Dataset Summary does

Dataset Summary gives you an overview of what is in a dataset: how many neurons there are, how they are classified (e.g. super class, transmitter, side), the most numerous cell types, and how completely each brain region has been reconstructed. Wire a dataset node straight into it:

```coda-graph
caption: Summarise a dataset.
dataset.malecns as ds
out.datasetSummary as s
ds -> s
```

> [!WARNING] Works best with neuPrint
> The summary is built on the statistics neuPrint publishes. Other backends don't provide the same
> information, so for them the node shows only what is available.

## Settings

```coda-params
out.datasetSummary: completenessMeasure, topTypes
```

- `Status` decides which neurons the counts include. Leave it empty to count every neuron the dataset publishes. Note that this is a different default from [Find Neurons](#neuron.findNeurons), which only includes traced neurons unless you say otherwise.
- `Charts` picks which fields get a chart. Leave it empty to choose automatically.
- `Top cell types` is how many of the most numerous cell types to list (10 by default, 0 hides the list).
- `Completeness` is the half of a synapse that the region chart reports. The default, "Postsynaptic", is usually the more useful one: a connection only shows up in a connectivity query if the receiving neuron is reconstructed. The two can differ a lot; on the hemibrain, 91% of presynaptic sites are traced but only 37% of postsynaptic ones.
- `Region order` sorts the region chart by completeness or lists the regions by name.

The node has no outputs: it is just for looking at.
