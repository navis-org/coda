> [!WARNING] neuPrint-only
> neuPrint is the only backend that provides ROI connectivity.

A coarse view of the connectome: which regions talk to which, and how strongly. Two outputs — a matrix for heatmaps, and an edge list.

## Count versus weight

The `Links` table always carries both. `Cells` controls which one fills the `Matrix`.

**`count`** is the number of neurons with at least one input in Y and one output in X.

**`weight`** is the number of connections from region Y to region X: the synapses from neurons that have inputs in Y and outputs in X, counting their outputs in X weighted by the proportion of their inputs that are in Y.

```coda-params
neuron.roiConnectivity: measure
```
