```coda-graph
caption: Search for neurons and visualise what you select
dataset.hemibrain as hb
neuron.explore as exp
out.neuroglancer as ngl
hb -> exp
exp:selected -> ngl
```

### Search

Where `Find Neurons` is a structured search, this is free-form: it searches the entire neuron table for whatever text you type.

The field still takes a query syntax: `column==value` targets one column, `column!=value` excludes a value, `pre>1000` compares a number, `type~^LC[0-9]+$` is a regex against one column, and `!term` excludes. Comparisons are case-insensitive, and a regex is unanchored unless you anchor it yourself.

A term starting with `/` is a regular expression over *every* column — `/^LC[0-9]+$` finds `LC4` and `LC6` but not `LPLC1`, and the closing slash is optional. Without the slash a term is a plain substring, so `^LC4$` on its own finds nothing: that is what keeps a type like `LC4(R)` matching itself rather than being read as a pattern.

Terms are separated by spaces and **all of them must match**:

```
type==DNp02 status==Traced pre>1000
```

> [!WARNING] No `OR` and no bracketing, and `AND` is not a keyword
> `type==DNp02 AND (hemilineage==A OR hemilineage==B)` searches for the literal words `and` and
> `or` alongside a value of `B)`, and finds nothing. For a set of alternatives on one column use a
> regex — `hemilineage~^(A|B)$` — or wire the `All` output into a `Filter Table` and narrow it
> there.

The same grammar is used by the [Table](#out.table) viewer's header filters and by [Edit Table](#core.editTable)'s row filters.

### Three outputs

**Hits:** every neuron matching the current query, up to `Max hits` if set. This is Explore Dataset as a nicer Find Neurons.

**Selected:** only the neurons you ticked, regardless of the current query. Selection is resolved against the whole index, not just the current hits, so refining your search does not drop neurons you already chose.

**All:** the dataset's complete neuron index, unsearched and uncapped. Use it for group-bys, joins or charts over the whole table at no extra cost.

> [!NOTE] `Search tags` controls whether the box matches the `Additional tags` column
> With it off you can still target that column explicitly by name — `tags==foo`.

### Columns

In the expanded view every column header is a button. Click one to change how that column draws — a number can be a figure, a bar against the largest in the dataset (linear or log scale), or its rank in the dataset — or to move it, remove it, or show it as a chip instead. A column you add shows each number as stored (`15417`), in the dataset's own unit; tick **Human-readable formatting** in its menu for `15.4K` instead. The figures the list picks by itself start human-readable.

The **+** at the end of the header lists every field with a **column | chip** choice, the highlighted half being where that field is now. A column lines a field up down the list; a chip appears on a row only where that neuron has a value. Click the highlighted half again to hide that field. To turn a chip into a column, or hide it, right-click it on any row. Once you have made one of these choices, the list stops deciding for you: a field is shown only if you have placed it, as a column or as a chip.

**Combine several fields into one column…**, at the foot of the same menu, merges numbers into one column, drawn as a stacked bar, as bars side by side, as a donut, or as text (`100 / 50`). Ticking `axonIn`, `axonOut`, `dendriteIn` and `dendriteOut` shows, on every row, how that neuron's synapses split across its compartments.

Any column can be renamed in the same menu. Leave the name empty to keep the automatic one; hovering a renamed header still shows which fields it reads.

> [!NOTE] A merged column is a share of the fields you ticked, not of `pre` or `post`
> A dataset's parts do not always add up to its published total — on fish2, `axonOut +
> dendriteOut` differs from `pre` on most neurons — so the bar only ever divides by what you chose.

The node card shows the same fields, as chips. Your choices are saved with the workflow; **Reset to automatic fields** in any header's menu, or clearing **Fields** in the inspector, hands the choice back.

```coda-params
neuron.explore: pageSize, limit, layout
```
