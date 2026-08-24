> [!WARNING] neuPrint-only
> NeuPrint is the only backend that provides ROI connectivity.

A coarse view of the connectome: which regions talk to which, and how strongly. The node returns two outputs: a matrix for heatmaps, and an edge list.

## Count versus weight

The `Links` table always carries both `count` and `weight`. The `Cells` parameter controls which one fills the `Matrix`.

**`count`** is the number of neurons with at least one input in Y and one output in X.

**`weight`** is the number of connections from brain region Y to brain region X defined as the number of synapses from neurons that have inputs in Y and outputs in X. The number represents the number of outputs from these neurons in X weighted by the proportion of inputs that are in Y.

```coda-params
neuron.roiConnectivity: measure
```
