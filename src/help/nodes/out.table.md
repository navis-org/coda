## What Table does

Table shows tabular data as rows and columns. You can sort by clicking a column header, page through the rows, filter each column and export what you see as CSV. It works with any table, e.g. the neurons you selected in [Explore Dataset](#neuron.explore):

```coda-graph
caption: Show the neurons selected in Explore Dataset.
neuron.explore as exp
out.table as tab
exp:selected -> tab
```

```coda-params
out.table: pageSize, showFilters
```

## Outputs

Table has two outputs:

- `Table` passes the input on unchanged, like every viewer. Sorting and filtering in the widget have no effect on it, so you can put a Table anywhere in a chain to look at intermediate results.
- `Filtered` only carries the rows that pass the filters under the column headers.

Sorting is only for looking at the data and doesn't change either output. Changing a filter, on the other hand, changes what `Filtered` returns, so nodes downstream of the Table need to re-run.

## Filtering

Tick `Show filter row` to get a text field under each column name. What you type there is matched against that column:

| You type      | Keeps rows where the value…                                  |
| ------------- | ------------------------------------------------------------ |
| `>10`         | is greater than 10 (also `>=`, `<`, `<=`)                    |
| `10`          | in a number column: equals 10                                |
| `LC`          | in a text column: contains "LC" (ignoring case)              |
| `==LC4`       | is exactly "LC4"                                             |
| `!=LC4`       | is anything but "LC4"                                        |
| `!frag`       | does not contain "frag" (`-frag` works too)                  |
| `~^LC[0-9]+$` | matches the regular expression (ignoring case)               |

If you filter on several columns, a row has to pass all of them. A filter that can't be applied, e.g. a regular expression with a typo or a column that no longer exists, is ignored and the card tells you about it.

> [!NOTE] Not quite the same as Filter Table
> The header filters use the same syntax as the search box in Explore Dataset, which differs slightly
> from the [Filter Table](#core.filterTable) node. For example, `==lc4` here also matches "LC4",
> whereas Filter Table compares text case-sensitively.
