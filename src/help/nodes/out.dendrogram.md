Draws the tree produced by [Linkage](#cluster.linkage) (hierarchical clustering). You can click a branch to select the leaves under it, and the selection is passed on through the `Selected` output. If the tree comes through [Cut Tree](#cluster.cut), branches are coloured by cluster.

```coda-graph
caption: A dendrogram with coloured clusters, with the selected branch shown in Neuroglancer. Not shown: `Neurons` and `Dataset`.
cluster.linkage as link
cluster.cut as cut
out.dendrogram as dend
cluster.selectedToNeurons as sel
out.neuroglancer as ng
link -> cut
cut:tree -> dend
dend:selected -> sel
sel -> ng
```

## Naming the leaves

Each leaf is labelled with whatever labelled the matrix that was clustered. On most routes that is a bare neuron id: [NBLAST](#neuron.nblast) has its own `Label by` setting, but [Similarity Matrix](#core.similarity), Adjacency and [Pivot](#core.pivot) label their rows and columns with the id column they were given.

To show something more readable, wire a table into the `Annotations` socket. Usually that is the same [Find Neurons](#neuron.findNeurons) table that fed the clustering. Then set `Match on` to the column holding the ids and `Label by` to the column holding the names. These default to `neuronId` and `type`, so with an ordinary neuron table there is nothing to configure.

```coda-graph
caption: The same neuron table feeds the clustering and names the leaves. `Match on` and `Label by` are at their defaults here.
neuron.findNeurons as find
cluster.linkage as link
cluster.cut as cut
out.dendrogram as dend { matchColumn: neuronId, labelColumn: type }
link -> cut
cut:tree -> dend:in
find:neurons -> dend:annotations
```

Any column of any table works: a hemilineage, a side, an instance name, a cluster number from a different clustering. The table does not even have to be a neuron table; an uploaded CSV with two columns, `id` and `name`, will do.

```coda-params
caption: Name the leaves from a wired table
out.dendrogram: matchColumn, labelColumn
```

> [!NOTE] Only the drawing changes
> `Label by` renames leaves in the picture and nowhere else. The `Tree` output, the `label` column
> of `Selected` and everything downstream keep the labels the matrix came with. This matters for
> [Selected to Neurons](#cluster.selectedToNeurons), which matches that column against a neuron
> table: if the labels were cell types, a clade of fourteen neurons would turn into every neuron of
> those types. Because nothing downstream changes, you can switch `Match on` and `Label by`
> freely without re-running anything.

Several leaves often end up with the same name, e.g. fourteen neurons with five cell types between them. Hover a leaf to see its original label. Clicking a branch still selects exactly the leaves under it, because the selection stores leaf positions, not names.

Leaves that the table has no entry for keep their original label, and the caption counts them (e.g. `12 unnamed`). If that number is large, the join is probably not matching at all. The usual cause is `Match on` pointing at a column whose ids were read as numbers; the node shows a warning on the card in that case.

## Large trees

With a few hundred leaves there isn't room for every name, so only every *n*th label is drawn and the caption says `labels thinned`. Beyond 3,000 leaves the caption says `structure only`: the shape of the tree is still accurate, but the branches are hairlines and too small to click. If you need to work with individual leaves of a tree that size, use [Cut Tree](#cluster.cut).

To look at part of a big tree, expand the card. There you can:

- scroll to zoom in around the pointer (the caption shows the zoom, e.g. `×8.7`)
- drag to pan
- double-click, or press ⤢, to fit the whole tree again

Zooming in spreads fewer leaves across the same space, so labels reappear at their normal size as room allows. Zoom and pan only work in the expanded view; on the canvas, scrolling moves the canvas.

> [!NOTE] Zoom only works along the leaves
> The full depth of the tree always stays on screen, so you can see where a clade branches off
> while you zoom in on it. Dragging along the depth axis does nothing.

Clicking a branch still selects it while you are zoomed in. Dragging always pans and never selects, so you can move to a clade first and then click it.

## Appearance

```coda-params
out.dendrogram: orientation, showLabels
```

"leaves on the right" fits more labels, since they read horizontally; "leaves at the bottom" is the conventional orientation. `Leaf labels` turns the names off; they are also dropped automatically when there is no room, and the caption says so.
