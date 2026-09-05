Draws a [Hierarchical Clustering](#cluster.linkage) tree. It lets you interactively select branches and pass the selection to downstream widget. Often used in conjunction with [Cut Tree](#cluster.cut) to colour branches by cluster.

```coda-graph
caption: Draw a dendrogram with colored clusters and visualize selections in Neuroglancer. Not shown: `Neurons` and `Dataset`.
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

A leaf is labelled with whatever named the matrix that was clustered, and on most routes that is a bare neuron id. [NBLAST](#neuron.nblast) has a `Label by` setting, so a tree built from shapes can arrive already labelled by cell type — but [Similarity Matrix](#core.similarity), Adjacency and [Pivot](#core.pivot) all label their axes with the id column they were given, and a matrix carries nothing else. By the time the tree gets here, the cell type that would make it readable is several nodes upstream.

The `Annotations` socket closes that gap. Wire it to a table that has a column naming the neurons — the same **Find Neurons** table that fed the clustering is the usual answer — then set `Match on` to the column holding the ids and `Label by` to the one holding the names. Both default to `neuronId` and `type`, so on an ordinary neuron table there is nothing to configure.

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

Nothing about `type` is special — it is just the default. Any column of any table works: a hemilineage, a side, an instance name, a cluster number that came out of a *different* clustering, a note somebody uploaded as a CSV. The table does not have to be a neuron table at all; a two-column upload of `id, name` will do.

> [!NOTE]
> **The tree is unchanged.** `Label by` renames leaves *on the drawing* and nothing else — the tree that leaves the `Tree` socket, the `label` column of `Selected`, and everything downstream all keep the labels the matrix arrived with. That is deliberate: [Selected to Neurons](#cluster.selectedToNeurons) matches that column against a neuron table, and if the tree itself were labelled by cell type then one clade of fourteen neurons would resolve to *every* neuron of those types in the connectome. If you want the cell types further downstream, they are already there — `Selected to Neurons` carries the whole neuron table's columns onto its output.
>
> The upshot is that both settings are free to change: no re-run, no stale nodes, and no waiting for the clustering above.

**Cell types repeat, and that is the normal case.** Fourteen neurons can come back as five names, so several leaves will read the same. Hovering one shows the label it had before — usually its neuron id — and clicking a branch still selects exactly the leaves under it, because the selection holds leaf *positions* rather than names.

**A leaf the table says nothing about keeps its own label** rather than going blank, and the caption counts them: `12 unnamed` beside the leaf count. A large count usually means the join is not matching at all rather than that the annotations have holes — the usual cause is `Match on` pointing at a column of ids that were read as numbers, which the node warns about on the card.

## Reading a big tree

A few hundred leaves is more names than a card has pixels, so the labels are thinned — every
*n*th, never a chosen few — and the caption says `labels thinned` when it happens. Past three
thousand leaves it says `structure only`: the shape is still a real picture, but the brackets are
hairlines and there is nothing left to click. [Cut Tree](#cluster.cut) is the node for the
question that needs the individual leaves.

**Expand the card and you can zoom into it.** Scroll to zoom about the pointer, drag to pan,
double-click or press ⤢ to fit the whole tree again; the caption shows `×8.7` while you are in.
Zooming does not magnify the picture — it draws *fewer* leaves across the same axis, so their
names come back one by one as there is room for them, at the same 10px they always were. The
gestures are off on the canvas itself, where a scroll belongs to the canvas.

> [!NOTE]
> The zoom moves along the **leaves** only; the tree's full depth is always on screen. That is
> deliberate: a merge's height is the distance it was joined at, so holding that axis still keeps
> two views comparable and keeps the branch a clade hangs off in the picture while you read it.
> Dragging along the depth axis therefore does nothing.

Clicking still selects while you are zoomed in — a drag is a pan and never a selection, so you
can navigate to a clade and then pick it.

```coda-params
caption: Control appearance
out.dendrogram: orientation, showLabels
```

```coda-params
caption: Name the leaves from a wired table
out.dendrogram: matchColumn, labelColumn
```
