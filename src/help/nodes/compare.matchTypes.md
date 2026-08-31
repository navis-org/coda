This node works out which cell types in one connectome are the same cells as which in another. Critically, it can deal with neurons having multiple types (e.g. `type`, `hemibrainType`, `flywireType` and `mancType`) - some of which will map between two given datasets while others will not. To cross the bridge it uses a graph-based approach: simply put, neurons are associated with all their type labels, and we look for connected components that include neurons from all datasets.

```coda-graph
caption: One node per comparison. Labels feed everything downstream.
dataset.hemibrain as ds1
dataset.flywire as ds2
compare.matchTypes as match
compare.connectivity as cmp
ds1 -> match:dataset1
ds2 -> match:dataset2
match:labels1 -> cmp:labels1
match:labels2 -> cmp:labels2
```

Each `Labels` output maps dataset's own neuron ids to a **shared label** (`neuronId`, `label`). They can be wired into [Compare Connectivity](#compare.connectivity), [Partner Vectors](#neuron.partnerVectors) or Relabel.

## Read the report

`Report` is `label`, `dataset`, `nNeurons`, `matched`, `suspicious`.

> [!WARNING]
> A label with 4 neurons in one brain and 40 in the other is almost always a bad match, and the report is the only place that shows. Worth double checking using e.g. a `Table` or a `Network` node to see the neurons that contributed to a label. Use `Ignore` matches to drop known bad labels.

## Settings

```coda-params
compare.matchTypes: datasetCount, types1, types2, labelMode, badLabels
```

`Type columns` should name **every** column holding a cell type, including the ones written in another dataset's namespace — those cross-references are what the match is made of.

> [!WARNING] Wire every dataset into one node; do not chain two
> The answer genuinely depends on how many are in it. Two subtypes stay distinct across two hemispheres that both name them, and collapse the moment a third dataset knows only the coarse name.

> [!WARNING] `Ignore labels` is not optional housekeeping
> Nothing in the data marks `unknown`, `na` or a placeholder as not-a-cell-type. Left in, they correspond like any other label and quietly assert that two neurons are the same cells even though they are just untyped.

## Types present in only one brain

Dropped by default — nothing in the data tells a genuinely sex-specific type apart from a naming artifact.

To keep some, wire a one-column table of those type names into `Pass Through`. It is a **separate pass** over what the matcher left empty, not a relaxed match, and the report's `matched` column is `false` for anything that came through that way.

> [!NOTE] `Allow indirect matches` is off for a reason
> A shares a group label with B, and B has the type that matches — so A is claimed to be that type on evidence the data offered about B.
