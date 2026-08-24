> [!WARNING]
> This widget is based on the summary statistics offered by neuPrint. Other backends will not provide the same information and the node will only show the subset of that's there.

```coda-graph
caption: Dataset summary
dataset.malecns as ds
out.datasetSummary as s
ds -> s
```

```coda-params
out.datasetSummary: completenessMeasure, topTypes
```

