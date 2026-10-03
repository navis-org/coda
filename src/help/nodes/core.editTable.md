## What Edit Table does

Edit Table overwrites values in a table. Use it when you disagree with the data: a cell type that has since been revised, a status that is wrong for the dozen neurons you have actually looked at, or a grouping of your own that the dataset doesn't have. Because the edits live in the workflow, you can always see what was changed, and you can re-run the analysis without them by simply taking the node out.

```coda-graph
caption: Correct a few annotations before looking at the table.
dataset.hemibrain as hb
neuron.findNeurons as find
core.editTable as edit
out.table as tab
hb -> find
find -> edit
edit -> tab
```

## Rules

Each line on the card is one rule with three parts: which rows to change, which column to write to, and what value to write. For example:

| Where | Column | Value |
| --- | --- | --- |
| `type==LC4 status==Traced` | `type` | `LC4a` |

sets `type` to `LC4a` in every row where `type` is `LC4` and `status` is `Traced`. Leave *Where* blank to change every row.

```coda-params
core.editTable: edits
```

Rules select rows by their contents rather than by position. The table you are editing is usually the result of a query, and the next time it is fetched, filtered or joined, "row 412" may well be a different neuron. A rule like the one above still means the same thing.

## Writing filters

The *Where* field uses the same query language as the search box in [Explore Dataset](#neuron.explore) and the header filters of the [Table](#out.table) viewer. Terms are separated by spaces, and a row has to match all of them. There is no `OR` and no brackets. `AND` isn't a keyword either: write two terms instead (the node rejects a literal `and`).

| Write | To match rows where |
| --- | --- |
| `type==LC4` | the column equals the value |
| `type!=LC4` | the column does not equal the value, **including rows where it is empty** |
| `pre>100`, `pre>=100`, `pre<5`, `pre<=5` | a number column is above or below a value |
| `type~^LC[0-9]+$` | the column matches a regular expression |
| `!type==LC4` or `-type==LC4` | the term does not match |
| `type=="LC4 giant"` | the value contains a space (use quotes) |

Comparisons ignore case, so `type==lc4` matches `LC4`.

Two things that may surprise you:

- Regular expressions are not anchored: `type~LC` matches `LC4`, `LC4 giant` and also `PLC5`. If you mean the whole value, anchor it yourself, as in `type~^LC[0-9]+$`.
- An empty value matches `!=` and nothing else. On a table with one untyped neuron, `status!=Traced` returns the untraced neurons *and* that one. This is not how SQL behaves.

> [!WARNING] Name the column in every term
> In the Explore search box, a bare `LC4` means "any column contains LC4". That is fine for
> finding neurons but dangerous for overwriting values: `LC4` might also turn up in `instance`, in
> `notes` or in a `group` column of your own. Edit Table therefore refuses bare terms. Write
> `type==LC4`.

## Examples

**Retype a set of neurons:**

| Where | Column | Value |
| --- | --- | --- |
| `type==LC4 status==Traced` | `type` | `LC4a` |

**Tag a group of your own.** There is no `group` column upstream, so this rule creates one. Rows the rule doesn't match get an empty value:

| Where | Column | Value |
| --- | --- | --- |
| `type~^LPLC[0-9]+$` | `group` | `LPLC family` |

**Clear a value.** Write `""` (two quote characters) to empty a cell. An empty *Value* field means the rule isn't finished yet and does nothing:

| Where | Column | Value |
| --- | --- | --- |
| `status==Traced pre<10` | `status` | `""` |

**Set everything, then narrow down.** Rules run from top to bottom and each one sees what the rules above it wrote, so the second rule here can filter on the column the first one created:

| Where | Column | Value |
| --- | --- | --- |
| *(blank)* | `checked` | `no` |
| `type==LC4` | `checked` | `yes` |

Swapping the two rules gives you a different result.

## New columns and column types

If you name a column the table doesn't have, it is created. The new column shows up in column pickers downstream straight away, without having to run anything.

If you write a value that doesn't fit the column's type, the whole column is converted rather than the edit being dropped. For example, writing `unknown` into a column of whole numbers turns the entire column into text, including the numbers that were already there. The card and the node's warning both tell you when this happens. Conversion only goes one way: whole number → number → text. Clearing a cell with `""` never converts anything, because an empty value fits every column type.

## When a rule doesn't work

Problems with a rule never stop the node: you get a warning and the table still passes through. A rule whose filter can't be worked out (e.g. because it names a column that doesn't exist) is switched off completely and marked on the card. This errs on the side of changing too few rows rather than too many. (The [Table](#out.table) viewer does the opposite with its header filters: a filter it can't apply is ignored, so you see more rows.)

> [!WARNING] Negating a misspelled column
> A filter on a column that doesn't exist matches no rows, so its negation would match every
> row: `!typ==LC4`, one letter off from `!type==LC4`, would overwrite the whole table. Edit Table
> refuses such a rule.

A rule with a valid filter that happens to match no rows looks exactly like one that worked. Check the **rows changed** count under the rules; after a run, the node also warns you about each rule that changed nothing.

## Related nodes

- [Filter Table](#core.filterTable) drops rows. Edit Table changes values and keeps every row.
- Rename Columns changes a column's *name*; Edit Table changes its *values*.
- Relabel rewrites a column using a lookup table from elsewhere in the workflow. Once you have hundreds of corrections, put them in a CSV, bring it in with [Upload Table](#core.uploadTable) and use Relabel. Edit Table is meant for a handful of changes you decided on yourself.

Both the Python notebook and the R Markdown export include your edits: as `.loc[rows, column] = value` in Python and as `mutate(column := replace(...))` in R.
