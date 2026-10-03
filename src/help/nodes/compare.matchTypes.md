Match Cell Types works out which cell types in one connectome correspond to which cell types in another. This is the starting point for any comparison across datasets.

## How it works

Neurons often carry several type columns, e.g. `type`, `hemibrainType`, `flywireType` or `mancType`. Some of these link two given datasets and some don't. The node associates each neuron with all of its type labels and then looks for connected groups of labels that include neurons from every dataset. Each such group becomes one shared label.

```coda-graph
caption: Match cell types between two datasets, then compare their connectivity.
dataset.hemibrain as ds1
dataset.flywire as ds2
compare.matchTypes as match
compare.connectivity as cmp
ds1 -> match:dataset1
ds2 -> match:dataset2
match:labels1 -> cmp:labels1
match:labels2 -> cmp:labels2
```

Each `Labels` output maps one dataset's neuron ids to the shared labels (columns `neuronId` and `label`). Wire these into [Compare Connectivity](#compare.connectivity), [Partner Vectors](#neuron.partnerVectors) or a Relabel node.

## Settings

```coda-params
compare.matchTypes: datasetCount, types1, types2, labelMode, badLabels
```

Under `Type columns`, pick **every** column that holds a cell type, including the ones that use another dataset's names (e.g. `flywireType` on a hemibrain neuron). Those cross-references are what the matching is based on.

`Name matches by` decides what a matched group is called. "Every name, joined" makes it easy to see when two types were merged.

> [!WARNING] Wire all datasets into one node
> If you want to compare three datasets, wire all three into a single Match Cell Types rather than
> chaining two nodes. The result depends on how many datasets take part: two subtypes may stay
> distinct across two datasets that both name them, but collapse into one as soon as a third
> dataset only knows the coarser name.

> [!WARNING] Fill in `Ignore labels`
> Nothing in the data marks labels like `unknown`, `na` or other placeholders as "not a cell
> type". If you leave them in, they are matched like any other label, and neurons that are simply
> untyped get claimed to be the same cells. List such labels in `Ignore labels`, separated by
> commas or new lines.

## Checking the result

The `Report` output has one row per label and dataset, with the columns `label`, `dataset`, `nNeurons`, `matched` and `suspicious`. It's worth looking at.

> [!TIP] Look out for lopsided labels
> A label with 4 neurons in one dataset and 40 in the other is almost always a bad match, and the
> report is the only place where you will see that. Use a [Table](#out.table) to read the report,
> or a [Network Viewer](#out.network) on the `Network` output to see which neurons contributed to a
> label. Then add known bad labels to `Ignore labels`.

## Types found in only one dataset

By default, cell types that exist in only one dataset are dropped: nothing in the data distinguishes a genuinely sex-specific type from a naming artefact.

To keep some of them, wire a one-column table with those type names into `Pass Through`. These are handled in a separate pass over whatever the matcher left unmatched, and the report's `matched` column is `false` for anything that came through this way.

> [!NOTE] Indirect matches
> `Allow indirect matches` (under the advanced settings) is off by default. With it on, neuron A
> can be assigned a type because it shares a group label with neuron B, and B has the type that
> matches. In other words, A gets claimed to be that type based on evidence about B.
