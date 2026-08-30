```coda-graph
caption: Search for neurons and visualize what you select
dataset.hemibrain as hb
neuron.explore as exp
out.neuroglancer as ngl
hb -> exp
exp:selected -> ngl
```


### Search

Where `Find Neurons` provides a structured search, `Explore Dataset` is more free-form: it searches the entire neuron table for whatever text you type, and returns a list of matching neurons.

That said, the search field does allow a simple query syntax: `column==value` to target a specific column, `column!=value` to exclude a value, `pre>1000` to compare a number, `type~^LC[0-9]+$` for a regular expression, and `!term` to exclude. Comparisons are case-insensitive, and a regex is unanchored unless you anchor it yourself.

Terms are separated by spaces and **all of them must match**:

```
type==DNp02 status==Traced pre>1000
```

> [!WARNING]
> There is **no `OR` and no bracketing**, and `AND` is not a keyword. Writing
> `type==DNp02 AND (hemilineage==A OR hemilineage==B)` searches for the literal words `and` and
> `or` alongside a value of `B)`, and finds nothing. For a set of alternatives on one column,
> use a regex — `hemilineage~^(A|B)$` — or wire the `All` output into a `Filter Table` node and
> narrow it there.

The same grammar is used by the [Table](#out.table) viewer's header filters and by
[Edit Table](#core.editTable)'s row filters, so what you learn here transfers to both.

### Three outputs

**Hits:** Every neuron matching the current query, up to the `Max hits` limit (if set). This is Explore Dataset as a nicer Find Neurons.

**Selected:** Only the neurons you ticked in the list, regardless of the current query. Selection is resolved against the whole index, not just the current hits — refining your search does not drop neurons you already chose.

**All:** The dataset's complete neuron index, unsearched and uncapped. Use it for group-bys, joins or charts over the whole table at no extra cost.

> [!NOTE]
> The `search tags` parameter controls whether the free-text search box matches values in the `Additional tags` column. If off, you can still target that column explicitly by name (e.g., `tags==foo`).

```coda-params
neuron.explore: pageSize, limit
```
