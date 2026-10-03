## What Explore Dataset does

Explore Dataset lets you browse every neuron in a dataset. It downloads the dataset's full neuron table once and then searches it locally as you type, so after the initial download searching is fast. Tick neurons in the list to send them downstream.

```coda-graph
caption: Search for neurons and look at the ones you select.
dataset.hemibrain as hb
neuron.explore as exp
out.neuroglancer as ngl
hb -> exp
exp:selected -> ngl
```

## Outputs

| Output     | What it contains                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `Hits`     | every neuron matching the current search, up to `Max hits` if you set one                                     |
| `Selected` | only the neurons you ticked                                                                                   |
| `All`      | the dataset's complete neuron table, regardless of the search and with no cap                                 |

Ticked neurons stay selected when you change the search, even if they no longer appear in the hits.

`All` is handy for grouping, joining or plotting over the whole dataset. It costs nothing extra because the table has already been downloaded.

## Searching

[Find Neurons](#neuron.findNeurons) is a structured search. Here, by contrast, you type free text, and it is matched against every column of the neuron table.

Search terms are separated by spaces, and all of them have to match:

```
type==DNp02 status==Traced pre>1000
```

The following kinds of terms are understood:

| Term               | Matches                                                       |
| ------------------ | ------------------------------------------------------------- |
| `LC4`              | `LC4` anywhere in any column (a plain substring)              |
| `column==value`    | `value` in that one column                                    |
| `column!=value`    | neurons that do not have `value` in that column               |
| `pre>1000`         | a number comparison on one column                             |
| `type~^LC[0-9]+$`  | a regular expression on one column                            |
| `/^LC[0-9]+$`      | a regular expression on every column (closing `/` optional)   |
| `!term`            | neurons that do not match `term`                              |

Comparisons are case-insensitive, and a regular expression matches anywhere in the value unless you anchor it with `^` and `$`. So `/^LC[0-9]+$` finds `LC4` and `LC6` but not `LPLC1`.

Without the leading `/`, a term is always treated as plain text: `^LC4$` on its own finds nothing. That way a type name with special characters, like `LC4(R)`, still matches itself.

> [!WARNING] No `OR` and no brackets
> `AND` and `OR` are not keywords, so `type==DNp02 AND (hemilineage==A OR hemilineage==B)` searches
> for the words "and" and "or" and finds nothing. To allow several values in one column, use a
> regular expression like `hemilineage~^(A|B)$`, or wire the `All` output into a
> [Filter Table](#core.filterTable) and narrow it down there.

The same search syntax is used by the header filters in the [Table](#out.table) viewer and the row filters in [Edit Table](#core.editTable).

If you set an `Additional tags` column, `Search tags` decides whether free text is also matched against the tags. With it off, you can still search the tags by naming the column, e.g. `tags==foo`.

## Columns

In the expanded view, every column header is a button. Click one to:

- change how the column is drawn: as a number, as a bar relative to the largest value in the dataset (linear or log scale), or as the neuron's rank in the dataset
- move or remove it, or show it as a chip instead
- rename it (leave the name empty to go back to the automatic one; hovering a renamed header still shows which fields it reads)

Numbers in a column you added are shown as stored (`15417`), in the dataset's own unit. Tick `Human-readable formatting` in the column's menu to get `15.4K` instead. Columns the list picked by itself are human-readable from the start.

The **+** at the end of the header lists every field, each with a "column | chip" switch where the highlighted half shows how the field is currently shown. A column lines the field up down the list; a chip only appears on rows where that neuron has a value. Click the highlighted half again to hide the field. You can also right-click a chip on any row to turn it into a column or hide it.

Note that as soon as you have placed a field yourself, the list stops choosing fields automatically: from then on, only the fields you have placed are shown.

`Combine several fields into one column…`, at the bottom of the same menu, merges several numbers into one column. It can be drawn as a stacked bar, as bars side by side, as a donut, or as text (`100 / 50`). For example, ticking `axonIn`, `axonOut`, `dendriteIn` and `dendriteOut` shows how each neuron's synapses are split across its compartments.

> [!NOTE] Combined columns only add up what you ticked
> The bars are shares of the sum of the fields you chose, not of `pre` or `post`. The parts don't
> always add up to the published total: on fish2, `axonOut + dendriteOut` differs from `pre` for
> most neurons.

The node card shows the same fields as chips. Your choices are saved with the workflow. To go back to the automatic fields, use `Reset to automatic fields` in any header's menu or clear `Fields` in the inspector.

```coda-params
neuron.explore: pageSize, limit, layout
```
