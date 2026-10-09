Compare Connectivity puts the same type-to-type connection side by side across two or more connectomes. Each row of the output reads something like "LC4 to DNp01 is 30 synapses in one dataset and 6 in the other".

For each dataset, you wire in an edge list (e.g. from [Connectivity](#neuron.connectivity)) and that dataset's labels from [Match Cell Types](#compare.matchTypes). The node translates both ends of every edge into the shared labels and sums the weights per pair of labels:

```coda-graph
caption: Each dataset brings an edge list and its labels from Match Cell Types.
neuron.connectivity as conn1
neuron.connectivity as conn2
compare.matchTypes as match
compare.connectivity as cmp
conn1 -> cmp:edges1
conn2 -> cmp:edges2
match:labels1 -> cmp:labels1
match:labels2 -> cmp:labels2
```

```coda-params
compare.connectivity: datasetCount, minWeight
```

`Datasets` sets how many connectomes you compare; each one gets its own `Edges` and `Labels` input and its own tab of settings. `Min weight` drops pairs of labels that don't reach that weight in *any* dataset, so a pair with 1 synapse in one dataset and 40 in the other is kept.

## Output

The `Comparison` table has the columns `preLabel` and `postLabel`, followed by `weight_<name>` and `present_<name>` for each dataset. The `<name>` comes from each dataset's `Name` setting, so keep those short.

> [!WARNING] Check `present` before `weight`
> A zero and an empty cell mean different things:
>
> - **`weight` is 0 and `present` is true**: both cell types exist in that dataset, but they are
>   not connected.
> - **`weight` is empty**: the pre- or postsynaptic cell type doesn't exist in that dataset,
>   either because it is sex-specific or simply because it wasn't labelled. Take this kind of
>   absence with a grain of salt.
>
> Be careful with filters or charts that treat empty cells as 0: they turn "not measured" into
> "measured as none".

## Raw synapse counts

Raw synapse counts are often not directly comparable between datasets: differences in completeness, dataset-specific issues and the precision of synapse detection all bias them. The usual fix is to normalise weights, e.g. by the total input of the postsynaptic type. The `Counts` output gives you what you need for that, with one row per label and dataset: `label`, `dataset`, `nNeurons`, `outWeight` and `inWeight`.
