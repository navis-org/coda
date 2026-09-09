```coda-graph
caption: Show info for selected neurons
neuron.explore as exp
out.table as tab
exp:selected -> tab
```

## Outputs

Like every viewer, the plain `Table` port passes its input straight through, unaffected by sorting or filtering in the widget.

The `Filtered` port carries only the rows that survive the header filter row — the text fields under each column name.

Type `>10` under a number column to keep rows ≥10, `LC` under a text column for an exact match, or `~^LC[0-9]+$` for a regex.

```coda-params
out.table: pageSize, showFilters
```
