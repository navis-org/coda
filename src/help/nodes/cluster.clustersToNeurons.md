The same lookup as [Selected to Neurons](#cluster.selectedToNeurons), registered under its own name for discoverability. Wire a Cut Tree's `Clusters` output here — not a Dendrogram's `Selected` — and every neuron gets its cluster number back, ready for:

- Neuroglancer to colour segments by cluster
- Filter to isolate one group
- Group By to count members per cluster

It is a **local match against whatever neuron table is wired in**, not a backend query. See [Selected to Neurons](#cluster.selectedToNeurons) for that distinction and for how `Match on` and `Suffix` work; both nodes share the same matching logic.

> [!WARNING] A labels table with no `cluster` column warns rather than refuses
> That is usually a Dendrogram's `Selected` wired in by mistake, in place of a Cut Tree's
> `Clusters`. The name-matching itself is still valid without a cluster column, so the run
> proceeds with nothing to colour by.

Where a label names several neurons — a cell type does — every one of them comes back carrying that cluster number.

```coda-params
cluster.clustersToNeurons: labelColumn, matchColumn
```
