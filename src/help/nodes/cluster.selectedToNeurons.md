Selected to Neurons and [Clusters to Neurons](#cluster.clustersToNeurons) run the identical
lookup: a table of names, matched back onto a neuron table.

**It is a local match, never a query.** The neurons returned by this come from whatever table is wired
into `Neurons` — e.g. the one that fed the Skeletons that fed NBLAST — so a clade of three cell types
resolves to the neurons that were actually clustered, not every neuron of those types in the
whole connectome. [IDs from Label](#neuron.idsFromLabel) is the node for that broader question.

### Matching by name

1. Wire the same neuron table that you ran NBLAST on into the **Neurons** input.
2. Set **Match on** to the column NBLAST used for its "Label by" setting — `type` for cell type,
   or any other column name. Compared as text, so both numbers and names work.

If NBLAST was left at its default (neuron id), leave **Neurons** unwired entirely — the ids are
read straight off the labels.

**Suffix** only matters when the neuron table already has a column of the same name as one the
labels carry — the carried column gets that suffix appended rather than overwriting the original.

```coda-params
cluster.selectedToNeurons: labelColumn, matchColumn, suffix
```
