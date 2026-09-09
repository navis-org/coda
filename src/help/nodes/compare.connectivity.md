Puts the same type-to-type connection side by side across two or more connectomes. One row reads "LC4 to DNp01 is 30 synapses here and 6 there".

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

Output: `preLabel`, `postLabel`, then `weight_<name>` and `present_<name>` per dataset. `Name 1`/`Name 2` are what those columns are called — keep them short.

## Read `present` before `weight`

> [!WARNING] Zero and empty mean opposite things
> - **`weight` 0 with `present` true** — that dataset holds both types, and the connection is
>   genuinely absent in it.
> - **`weight` empty** — the pre- or postsynaptic type does not exist in that dataset, whether
>   because it is sex-specific or simply not labelled. Take the absence with a grain of salt.
>
> A filter or a chart that treats an empty cell as 0 turns "not measured" into "measured as none".

## Be careful with raw synapse counts

> [!WARNING] Completeness, dataset-specific issues and synapse-detection precision all bias a raw count
> The usual fix is (input-)normalised weights. The `Counts` output carries what that needs:
> `label`, `dataset`, `nNeurons`, `outWeight`, `inWeight`.

```coda-params
compare.connectivity: datasetCount, minWeight
```
