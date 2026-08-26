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

A node with no filters returns every neuron in the dataset. The limit defaults to 0, which is
everything — deliberately, since these queries run against a live server.

```coda-params
neuron.findNeurons: filters, limit
```
