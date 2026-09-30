Keep the rows matching **one** condition on **one** column. Cheap, so the result re-computes as you type a threshold.

```coda-params
core.filterTable: column, op, value
```

The operator list in `Condition` follows the column's type:

- a number gets `=`, `≠`, `>`, `≥`, `<`, `≤`
- text gets `is`, `contains`, `matches regex`, `starts with`, `ends with`, `is empty`
- a boolean gets `is true` / `is false`

> [!WARNING] `matches regex` is unanchored
> `LC4` also matches **LPLC4** and **LC4b**. Write `^LC4$` for an exact match. This differs from
> [Find Neurons](#neuron.findNeurons) and [Explore Dataset](#neuron.explore), whose patterns are
> anchored for you.

> [!WARNING] Text comparisons are case-sensitive
> Including `is` and `contains`. This differs from the [Table viewer](#out.table)'s own header
> filters, which are case-insensitive.

> [!WARNING] On a number column, an empty cell counts as 0
> So `= 0` keeps the nulls and `≠ 0` drops them, where `>`, `≥`, `<`, `≤` drop nulls instead.
> Filter on `is not empty` first if the distinction matters.

## One condition only

For `AND`, chain two of these. For `OR`, use one `matches regex` — `^(LC4|LC6)$` — or combine two filter results with [Stack Tables](#core.stack), or use [Find Neurons](#neuron.findNeurons), which builds several rows against the backend.

Filtering never changes the schema, and a table of neurons stays a table of neurons.

## Below a Link Table

Wired after a [Link Table](#core.linkTable), this reads nothing. The condition travels with the
file, and whatever reads rows out of it below — [Read Rows](#core.readRows), or a
[Custom Dataset](#connectome:customDataset)'s synapse lookup and edge list — drops the rows that
fail it from the rows it fetched. A lookup of six neurons in a 200-million-row synapse table stays
a lookup of six neurons; the condition sees only their synapses.

A confidence threshold on a synapse table is the usual case: Link Table → Filter Table
(`score` `≥` `0.5`) → the Custom Dataset's Synapses socket. Its connectivity, when counted from
that table, counts only the synapses that pass.

Chained Filter Tables add their conditions together. The output is still the file, so a node that
needs a table in memory takes it through Read Rows.
