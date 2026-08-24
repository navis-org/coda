The same lookup as [Selected to Neurons](#cluster.selectedToNeurons), registered under its own
name for discoverability. Wire a Cut Tree's `Clusters` output here — not a Dendrogram's
`Selected` — and every neuron gets its cluster number back, ready for:
- Neuroglancer to colour segments by cluster
- Filter to isolate one group
- Group By to count members per cluster

It's a **local match against whatever neuron table is wired in**, not a backend query — see
[Selected to Neurons](#cluster.selectedToNeurons) for that distinction and for how `Match on`
and `Suffix` work; both nodes share the same matching logic.

> [!WARNING] A labels table with no `cluster` column warns, rather than refuses
> Carrying the cluster number is the whole reason this node exists, so a labels table without
> one is usually a Dendrogram's `Selected` wired in by mistake, in place of a Cut Tree's
> `Clusters`. That is caught as a warning at edit time, not a hard refusal — the name-matching
> itself is still valid without a cluster column, so the run proceeds with nothing to colour by.

> [!NOTE]
> Where a label names several neurons — a cell type does — every one of them comes back carrying
> that cluster number.

```coda-params
cluster.clustersToNeurons: labelColumn, matchColumn
```
