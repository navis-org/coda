```coda-graph
caption: Search for neurons and visualize what you select
dataset.hemibrain as hb
neuron.findNeurons as find { typePattern: DA1_lPN }
out.neuroglancer as ngl
hb -> find
find -> ngl
```

The fields in this widget are modelled after what neuPrint offers. Consequently, some of the fields are ignored or refused when the underlying dataset is CAVE or CATMAID.

```coda-params
neuron.findNeurons: typePattern, limit
```
