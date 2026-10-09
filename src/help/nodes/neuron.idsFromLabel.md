IDs from Label looks up the neurons that carry a given set of labels, e.g. all neurons of the cell types `LC4`, `LC6` and `LPLC2`. It is the inverse of [Find Neurons](#neuron.findNeurons): labels in, neurons out. This is useful because [Neuroglancer](#out.neuroglancer) and the other viewers want neuron ids, not cell type names.

You can type the labels into `Labels` (separated by commas or new lines), wire in a table and pick its `Label column`, or both, in which case the two lists are combined. Typical sources for a wired list are the `type` column of a [Connectivity](#neuron.connectivity) result, a [Group By](#core.groupBy) of one, or a list pasted from a paper. With no labels at all, the node returns an empty table. After a run, the card tells you which labels matched nothing.

```coda-params
neuron.idsFromLabel: match, status
```

## Exact vs. regex matching

`Match` defaults to "exact label", which takes each label literally. Labels copied from somewhere often contain characters that have a special meaning in a regular expression: `SMP001(a)` has parentheses, `LC4-g` has a hyphen. With exact matching, you can paste them as they are.

Switch to "regular expression" if you want patterns. As in Find Neurons, a pattern has to match the whole name, so `LC.*` matches `LC4` but not `LPLC1`. `Ignore case` (under the advanced settings) makes either mode case-insensitive.

## Which property to match

`Field` can be any text property of the dataset's neurons, e.g. `type`, `class`, `superclass` or `hemilineage`. The default is `type`, the same field Find Neurons searches.

## Status

`Status` (under the advanced settings) defaults to "Traced", the same as Find Neurons, so both nodes return the same neurons for the same label. Set it to "Any" to include untraced fragments. On datasets that don't record a status, this setting has no effect.
