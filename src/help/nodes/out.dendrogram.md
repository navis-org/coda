Draws a [Hierarchical Clustering](#cluster.linkage) tree, with branch selection that passes downstream. Often used with [Cut Tree](#cluster.cut) to colour branches by cluster.

```coda-graph
caption: Draw a dendrogram with coloured clusters and visualise selections in Neuroglancer. Not shown: `Neurons` and `Dataset`.
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

A leaf is labelled with whatever named the matrix that was clustered, and on most routes that is a bare neuron id. [NBLAST](#neuron.nblast) has a `Label by` setting, but [Similarity Matrix](#core.similarity), Adjacency and [Pivot](#core.pivot) all label their axes with the id column they were given.

The `Annotations` socket closes that gap. Wire it to a table with a column naming the neurons — usually the same **Find Neurons** table that fed the clustering — then set `Match on` to the column holding the ids and `Label by` to the one holding the names. Both default to `neuronId` and `type`, so on an ordinary neuron table there is nothing to configure.

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

Any column of any table works: a hemilineage, a side, an instance name, a cluster number from a *different* clustering, a note uploaded as a CSV. The table does not have to be a neuron table at all; a two-column upload of `id, name` will do.

> [!NOTE] The tree itself is unchanged
> `Label by` renames leaves *on the drawing* and nothing else — the `Tree` socket, the `label`
> column of `Selected`, and everything downstream keep the labels the matrix arrived with.
> [Selected to Neurons](#cluster.selectedToNeurons) matches that column against a neuron table, so
> a tree labelled by cell type would resolve one clade of fourteen neurons to *every* neuron of
> those types in the connectome. Both settings are therefore free to change: no re-run, no stale
> nodes, and no waiting for the clustering above.

**Cell types repeat, and that is the normal case.** Fourteen neurons can come back as five names, so several leaves read the same. Hovering one shows the label it had before, and clicking a branch still selects exactly the leaves under it, because the selection holds leaf *positions* rather than names.

**A leaf the table says nothing about keeps its own label** rather than going blank, and the caption counts them: `12 unnamed` beside the leaf count. A large count usually means the join is not matching at all — the usual cause is `Match on` pointing at a column of ids that were read as numbers, which the node warns about on the card.

## Reading a big tree

A few hundred leaves is more names than a card has pixels, so the labels are thinned — every *n*th, never a chosen few — and the caption says `labels thinned`. Past three thousand leaves it says `structure only`: the shape is still a real picture, but the brackets are hairlines and there is nothing left to click. [Cut Tree](#cluster.cut) is the node for the question that needs the individual leaves.

**Expand the card and you can zoom into it.** Scroll to zoom about the pointer, drag to pan, double-click or press ⤢ to fit the whole tree again; the caption shows `×8.7` while you are in. Zooming does not magnify the picture — it draws *fewer* leaves across the same axis, so their names come back one by one as there is room, at the same 10px they always were. The gestures are off on the canvas itself, where a scroll belongs to the canvas.

> [!NOTE] The zoom moves along the leaves only
> The tree's full depth is always on screen, so two views stay comparable and the branch a clade
> hangs off stays in the picture while you read it. Dragging along the depth axis does nothing.

Clicking still selects while you are zoomed in — a drag is a pan and never a selection, so you can navigate to a clade and then pick it.

```coda-params
caption: Control appearance
out.dendrogram: orientation, showLabels
```

```coda-params
caption: Name the leaves from a wired table
out.dendrogram: matchColumn, labelColumn
```
