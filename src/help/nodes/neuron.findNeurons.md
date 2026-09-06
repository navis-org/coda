```coda-graph
caption: Search for neurons and visualize what you select
dataset.hemibrain as hb
neuron.findNeurons as find
out.neuroglancer as ngl
hb -> find
find -> ngl
```

Filters are rows: a **field**, a **condition** and a **value**. Add as many as you need — they all
have to match.

The field list is the dataset's own, so this node looks different depending on what you plug into
it. A neuPrint dataset offers `type`, `status`, `size` and whatever else that release publishes —
`cellBodyFiber` on hemibrain, `hemilineage` on manc. A FlyWire datastack offers `super_class`,
`cell_class` and `cell_sub_class`. A CATMAID project offers `annotations` and `cableLength`. You
cannot pick a field the dataset does not have, which is the point: it used to be possible, and the
result was a query that returned nothing, or everything, without saying so.

A few conditions are worth knowing:

- **is one of** takes several values, comma-separated. That is how you say "or" here — and against
  neuPrint it is faster than the equivalent pattern, because it becomes an indexed lookup.
- **matches regex** matches the *whole* name, so `LC.*` finds `LC4` but not `LPLC1`.
- **is** and **contains** are case-sensitive unless you say otherwise.

**In ROI** is not a filter row, because a region is not a property of a neuron in the way a type
is. It appears only where the dataset can actually answer it.

**A node with no filters returns no neurons.** Not the whole dataset: these queries run against
shared production servers, and a card nobody has configured yet is not a request for a whole
connectome. Add a row and it queries; delete the last one and it goes quiet again. To say
"everything" on purpose, say it — a row like `neuronId` `is not empty` matches every neuron there
is. To look around a dataset without asking it anything, use `Explore Dataset`.

**In ROI** counts as a filter here even though it is not a row, so a node whose only setting is a
region still queries. **Limit** does not: a cap is not a question about *which* neurons, so a node
whose only setting is a limit still returns nothing. The limit itself defaults to 0, which caps
nothing.

Past ten thousand matches the card says so. Nothing is refused — every one of those ids simply
travels into everything downstream, and a morphology node below this is over its own **Warn
above** before it starts.

```coda-params
neuron.findNeurons: filters, limit
```
