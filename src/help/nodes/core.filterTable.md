## What Filter Table does

Filter Table keeps the rows of a table that match a single condition on a single column, e.g. `pre` `≥` `100`, or `type` `starts with` `LC`. The columns are left untouched, so a filtered neuron table is still a neuron table. The node is cheap, so the result updates as you type.

```coda-params
core.filterTable: column, op, value
```

The operators offered under `Condition` depend on the type of the column you picked:

| Column type | Operators |
| --- | --- |
| number | `=`, `≠`, `>`, `≥`, `<`, `≤` |
| text | `is`, `is not`, `contains`, `does not contain`, `matches regex`, `starts with`, `ends with`, `is empty`, `is not empty` |
| true/false | `is true`, `is false` |

## Things to watch out for

> [!WARNING] `matches regex` is not anchored
> `LC4` also matches `LPLC4` and `LC4b`. Write `^LC4$` if you want an exact match. This is
> different from [Find Neurons](#neuron.findNeurons) and [Explore Dataset](#neuron.explore), which
> anchor patterns for you.

Text comparisons are case-sensitive, including `is` and `contains`: `lc4` does not match `LC4`. The header filters in the [Table](#out.table) viewer, by contrast, ignore case.

On a number column, empty cells count as 0 for `=` and `≠`. So `= 0` keeps the empty cells and `≠ 0` drops them. `>`, `≥`, `<` and `≤` always drop empty cells; on a column of counts, `≥` `0` therefore removes the empty cells and keeps the zeros.

## Combining conditions

Each Filter Table applies one condition. To combine several:

- For AND, chain two or more Filter Tables.
- For OR on a text column, use a single `matches regex`, e.g. `^(LC4|LC6)$`.
- Otherwise, filter twice in parallel and combine the results with [Stack Tables](#core.stack).

If you are filtering neurons from a dataset, [Find Neurons](#neuron.findNeurons) lets you write several conditions at once and runs them on the server.

## Filtering a linked file

Filter Table also works below a [Link Table](#core.linkTable). In that case it doesn't read anything itself: the condition is passed along with the file, and whichever node reads rows from it further down ([Read Rows](#core.readRows), or a [Custom Dataset](#connectome:customDataset) looking up synapses or edges) applies the condition to the rows it fetches. Looking up six neurons in a 200-million-row synapse table is still a lookup of six neurons; the condition only ever sees their synapses.

The typical use is a confidence threshold on a synapse table: Link Table → Filter Table (`score` `≥` `0.5`) → the Custom Dataset's `Synapses` socket. Connectivity counted from that table then only includes synapses that pass.

Chained Filter Tables combine their conditions. The output is still the file, not a table, so a node that needs the rows in memory has to get them through Read Rows.
