```coda-graph
caption: Search in Explore and get a per-neuron summary.
neuron.explore as exp
out.profile as prof
out.neuroglancer as ngl
exp:selected -> ngl
exp:selected -> prof
```

What this node can show depends on the dataset. Richest for neuPrint datasets because of the precomputed information it provides.

For CAVE and CATMAID datasets, some of the panels will remain empty.

```coda-params
caption: Threshold controls—instant filtering.
out.profile: minWeight, topN
```
