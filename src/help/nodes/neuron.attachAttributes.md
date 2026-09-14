Joins a table's columns onto the attributes of skeletons, meshes or points, so a computed value can colour or split a scene: a Reduce Matrix statistic, a Cut Tree cluster, or an uploaded CSV.

```coda-graph
caption: Mean activity per neuron, as a skeleton attribute.
neuron.skeletons as skel
core.reduceMatrix as red
neuron.attachAttributes as attach { matchOn: label }
out.viewer3d as v3d
skel -> attach:in
red -> attach:table
attach -> v3d:skeletons
```

```coda-params
neuron.attachAttributes: matchOn, columns
```

- **Matching.** Rows are matched to the geometry's `neuronId`. Reduce Matrix, Cut Tree and Embedding key their tables on `label`.
- **Columns.** Empty `Columns` attaches every column except the key. A column replaces one of the same name, keeping its position.
- **Unmatched and repeated rows.** An item the table does not mention keeps its geometry, with nulls. A repeated id takes its first row.

To carry columns from the neuron table itself, use `Carry fields` on [Skeletons](#neuron.skeletons) or [Meshes](#neuron.meshes) instead.
