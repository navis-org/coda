Attach Attributes joins the columns of a table onto skeletons, meshes or points, so that you can colour or split a scene by something you computed elsewhere in the graph: a [Reduce Matrix](#core.reduceMatrix) statistic, a [Cut Tree](#cluster.cut) cluster, or a CSV you uploaded.

```coda-graph
caption: Attach mean activity per neuron to the skeletons and colour the 3D View by it.
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

## Matching

Rows of the table are matched against the `neuronId` of each skeleton, mesh or point. Use `Match table on` to pick the table column that holds those ids. Note that Reduce Matrix, Cut Tree and [Embedding](#core.embed) call that column `label`, not `neuronId`.

For points (e.g. synapses), each point gets the values of the neuron it belongs to. That way you can, for example, colour a synapse cloud by the cell type of the presynaptic neuron.

## Columns

Leave `Columns` empty to attach every column of the table except the one you match on. If an attached column has the same name as an existing attribute, it replaces that attribute and takes its position.

## Unmatched and repeated rows

An item that the table doesn't mention keeps its geometry, with empty values in the new columns. If an id appears more than once in the table, the first row is used.

> [!TIP] Columns from the neuron table
> If you just want to carry columns from the neuron table you fetched the geometry for, use
> `Carry fields` on [Skeletons](#neuron.skeletons) or [Meshes](#neuron.meshes) instead.
