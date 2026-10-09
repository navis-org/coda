## What ROI Connectivity does

ROI Connectivity gives you a coarse overview of a whole connectome: which brain regions are connected to which, and how strongly. neuPrint precomputes this, so it is a single small request. All it needs is a Dataset.

> [!WARNING] neuPrint only
> neuPrint is the only backend that provides ROI connectivity.

There are two outputs:

- `Matrix` is a region-by-region matrix, e.g. for a [Heatmap](#out.heatmap). Region pairs without a connection are 0.
- `Links` is the same data as a table with one row per pair of regions (`source`, `target`, `count`, `weight`), which you can filter, sort, join or export like any other table.

## Weight vs. connections

The `Links` table always contains both of neuPrint's numbers. `Cells` decides which of them goes into the `Matrix`:

```coda-params
neuron.roiConnectivity: measure
```

- "Weight (as published)" (`weight`, the default) is the number of connections from region Y to region X: the synapses of neurons that have inputs in Y and outputs in X, counting their outputs in X weighted by the fraction of their inputs that are in Y.
- "Connections" (`count`) is the number of neurons that have at least one input in Y and one output in X.

The two are not the same measure in different units: on the hemibrain, `AB(L)→BU(L)` has a `count` of 13 and a `weight` of 3.11. The matrix's legend says which of the two it shows.
