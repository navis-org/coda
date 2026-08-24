```coda-graph
caption: Search for neurons and visualize what you select
dataset.hemibrain as hb
neuron.explore as exp
out.neuroglancer as ngl
hb -> exp
exp:selected -> ngl
```


### Search

Where `Find Neurons` provides a structured search, `Explore` is more free-form: it searches the entire neuron table for whatever text you type, and returns a list of matching neurons.

That said, the search field does allow a simple query syntax: `column==value` to target a specific column, or `column!=value` to exclude a value. You can also combine multiple clauses with `AND` and `OR`, and use parentheses to group them:

```
type==DNp02 AND (hemilineage==A OR hemilineage==B)
```

### Three outputs

**Hits:** Every neuron matching the current query, up to the `Max hits` limit (if set). This is Explore as a nicer Find Neurons.

**Selected:** Only the neurons you ticked in the list, regardless of the current query. Selection is resolved against the whole index, not just the current hits — refining your search does not drop neurons you already chose.

**All:** The dataset's complete neuron index, unsearched and uncapped. Use it for group-bys, joins or charts over the whole table at no extra cost.

> [!NOTE]
> The `search tags` parameter controls whether the free-text search box matches values in the `Additional tags` column. If off, you can still target that column explicitly by name (e.g., `tags==foo`).

```coda-params
neuron.explore: pageSize, limit
```
