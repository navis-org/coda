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

```coda-params
neuron.explore: pageSize, limit
```
