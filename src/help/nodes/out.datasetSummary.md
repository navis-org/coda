> [!WARNING] Built on neuPrint's summary statistics
> Other backends do not publish the same information, and the node shows only the subset that is
> there.

```coda-graph
caption: Dataset summary
dataset.malecns as ds
out.datasetSummary as s
ds -> s
```

```coda-params
out.datasetSummary: completenessMeasure, topTypes
```
