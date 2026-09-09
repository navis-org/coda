```coda-graph
caption: An override that lives in the graph, so the analysis can be re-run with it and without it
dataset.hemibrain as hb
neuron.findNeurons as find
core.editTable as edit
out.table as tab
hb -> find
find -> edit
edit -> tab
```

## A rule, not a cell

Every row on the card is one rule with three parts, and it reads left to right as a sentence:

| Where | Column | Value |
| --- | --- | --- |
| `type==LC4 status==Traced` | `type` | `LC4a` |

Which rows, which column, what to put in it. Blank *Where* means **every row**.

It is a rule rather than a coordinate because the table you are editing is *derived* — fetched,
filtered, joined, and fetched again tomorrow against a server whose proofreading has moved on.
"Row 412, column type" stops meaning anything the first time something upstream drops a row, and it
stops meaning it **silently**: row 412 still exists and still has a type.

## The filter language

The *Where* field is the same query language as the [Explore Dataset](#neuron.explore) search box
and the [Table](#out.table) viewer's header filters. Terms are separated by spaces and **all of them
must match** — there is no `OR` and no bracketing. `AND` is not a keyword either: writing it puts
the literal word `and` in your query, which this node rejects. Use two terms.

| Write | Means |
| --- | --- |
| `type==LC4` | the column equals the value |
| `type!=LC4` | does not equal it — **and this is the one that also matches rows with no value at all** |
| `pre>100`, `pre>=100`, `pre<5`, `pre<=5` | numeric comparison on a number column |
| `type~^LC[0-9]+$` | regular expression |
| `!type==LC4`, `-type==LC4` | exclude what follows |
| `type=="LC4 giant"` | quote a value with a space in it |
| `type==lc4` | matches `LC4` — **comparison is case-insensitive** |

**The regex is not anchored.** `type~LC` matches `LC4`, `LC4 giant` *and* `PLC5`. Anchor it
yourself when you mean the whole value: `type~^LC[0-9]+$`.

**A missing value satisfies `!=` and nothing else.** On a table with one untyped neuron in it,
`status!=Traced` returns the untraced *and* the unlabelled — which is not what SQL would do.

> [!WARNING] A bare term is refused here
> In the Explore box `LC4` on its own means "any column contains LC4", which is right for finding
> something and wrong for overwriting it: `LC4` also turns up in `instance`, in `notes` and in
> somebody's own `group` column. Write `type==LC4`.

## Examples

**Retype a set of neurons.**

| Where | Column | Value |
| --- | --- | --- |
| `type==LC4 status==Traced` | `type` | `LC4a` |

**Tag a group of your own.** `group` does not exist upstream, so this rule creates it — null on
every row it does not match:

| Where | Column | Value |
| --- | --- | --- |
| `type~^LPLC[0-9]+$` | `group` | `LPLC family` |

**Blank a value you disagree with.** `""` — two quote characters — writes an *empty* cell. An empty
*Value* field is a row you have not finished, and does nothing:

| Where | Column | Value |
| --- | --- | --- |
| `status==Traced pre<10` | `status` | `""` |

**Fix everything at once, then narrow.** Rules run top to bottom and each sees what the ones above
it wrote, so the second rule below filters on the column the first one created:

| Where | Column | Value |
| --- | --- | --- |
| *(blank)* | `checked` | `no` |
| `type==LC4` | `checked` | `yes` |

Reordering those two rows changes the answer.

## It adds columns, and it widens them

Naming a column the table does not have **creates** it, and the new column is published straight
away — a column picker two nodes downstream offers it without waiting for a Run.

Writing a value that does not fit the column's type **widens the column** rather than dropping the
edit. Writing `unknown` into a whole-number column turns the whole column into text, including the
numbers already in it; the card says so, and so does the warning on the node. Widening only ever
goes one way — whole number → number → text.

Clearing a cell with `""` does not widen anything: an empty value fits every column type.

## Nothing refuses, but a broken rule edits nothing

Every problem here is a warning and the table still passes through. But which way it errs matters,
and it is the opposite of the [Table](#out.table) viewer's: there, a filter that cannot be applied
is dropped and you see *more* rows than you meant. Dropping a term here would overwrite more rows
than you meant, so a rule whose filter cannot be resolved is **switched off entirely** and marked on
the card.

> [!WARNING] A negated term on a missing column matches everything
> A filter naming a column that does not exist matches nothing — but its negation matches every
> row. `!typ==LC4`, one letter away from `!type==LC4`, would overwrite the whole table. It is
> refused instead.

Edit time cannot catch a rule whose filter is valid and matches no rows, which looks exactly like a
rule that worked. That is what the **rows changed** count under the rules is for; the node also
raises a warning per rule after a Run.

## Where it sits

- **Filter Table** drops rows; this one rewrites them and keeps every row.
- **Rename Columns** changes a column's *name*; this changes its *values*.
- **Relabel** rewrites a column through a lookup table wired in from somewhere else — the right
  tool once the overrides number in the hundreds. Put them in a CSV, bring them in with
  [Upload Table](#core.uploadTable), and relabel. Edit Table is for the handful you decided
  yourself.

Both export routes translate it: `.loc[rows, column] = value` in the notebook, and
`mutate(column := replace(...))` in the R document.

```coda-params
core.editTable: edits
```
