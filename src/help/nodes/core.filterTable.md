Keep the rows matching **one** condition on **one** column. Cheap, so the result re-computes as you type a threshold — nothing waits for Run.

```coda-params
core.filterTable: column, op, value
```

The operator list in `Condition` follows the column's type:

- a number gets `=`, `≠`, `>`, `≥`, `<`, `≤`
- text gets `is`, `contains`, `matches regex`, `starts with`, `ends with`, `is empty`
- a boolean gets `is true` / `is false`.

> [!WARNING] `matches regex` is unanchored
> `LC4` also matches **LPLC4** and **LC4b**. Write `^LC4$` if you want an exact match. This differs from [Find Neurons](#neuron.findNeurons) and [Explore Dataset](#neuron.explore), whose patterns are anchored for you.

> [!WARNING] Text comparisons are case-sensitive
> Including `is` and `contains`. This differs from [Table viewer](#out.table)'s own header filters which are case-insensitive.

> [!WARNING] On a number column, an empty cell counts as 0
> So `= 0` keeps the nulls and `≠ 0` drops them. `>`, `≥`, `<`, `≤` drop nulls instead. Filter on `is not empty` first if the distinction matters.

## One condition only

For `AND`, chain two of these. For `OR`, use one `matches regex` — `^(LC4|LC6)$`, combine two filter results using [Stack Tables](#out.stackTables), or [Find Neurons](#neuron.findNeurons), which builds several rows against the backend.

Filtering never changes the schema, and a table of neurons stays a table of neurons.
