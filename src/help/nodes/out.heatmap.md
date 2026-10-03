Draws a matrix as a grid of coloured cells. Typical inputs are the output of [Pivot](#core.pivot), [Similarity Matrix](#core.similarity), [NBLAST](#neuron.nblast) or Adjacency.

The order of rows and columns matters a lot: an unsorted similarity matrix looks like noise, while the same numbers sorted by a clustering show clusters as blocks along the diagonal. For NBLAST scores, the easiest way to get there is to feed the heatmap from the `Ordered` output of [Linkage](#cluster.linkage) instead of the raw matrix. For any other matrix, use the `Order` tab (see below).

```coda-graph
caption: Feed Linkage's `Ordered` output into the heatmap, not the raw matrix.
neuron.nblast as nb
cluster.linkage as link
out.heatmap as hm
nb -> link
link:ordered -> hm
```

The heatmap's settings are spread over five tabs: `Colour`, `Labels`, `Filter`, `Order` and `Selection`. Everything except `Colour` changes the matrix that the node outputs, not just the picture. A Table wired next to the heatmap, the CSV export and the exported notebook all show what the card shows, and downstream nodes go stale when you change these tabs.

## Colour

```coda-params
out.heatmap: scale, palette, cellShape, showValues
```

Use "sequential" for counts and fractions, and "diverging (0 centred)" when zero is a meaningful midpoint, e.g. for a log ratio. "Coda blue" and "Coda blue–red" flip with the light/dark theme so that empty cells always fade into the background. The other palettes (viridis, magma, inferno, plasma, cividis, rocket and mako for sequential; RdBu, PuOr and BrBG for diverging) are the ones from matplotlib and seaborn. They look the same on both themes and have the same names in the exported notebook.

> [!TIP] Normalise first if one row dominates
> A heatmap of raw synapse counts mostly tells you which cell types are numerous. Put a
> [Normalize](#core.normalize) in front to compare connectivity profiles instead.

### Colour range

```coda-params
out.heatmap: colorMin, colorMax, logColor
```

`Min` and `Max` fix the two ends of the colour scale; leave them empty to use the range of the data. Set both to the same values on two heatmaps if you want to compare them by eye. Cells outside the range are drawn in the colour of the end they exceed (they are not dropped), and the caption says `values clipped`. On a diverging scale only `Max` is offered: it sets the magnitude of both arms, which have to be equal for the middle colour to still mean zero.

`Log colour` maps values to colours on a log scale. Only the colours change: the numbers printed in the cells, the tooltip and the ends of the colour bar still show the actual values. For example, against a maximum of 100, a weight of 1 sits at 1% of a linear scale but 15% of a log scale. `Log colour` is not available on a diverging scale.

### Circles

With `Cell shape` set to "circles sized by value", each cell is drawn as a disc whose area is proportional to the value, so the value is shown twice: as colour and as size. This works well for connectivity matrices, which are mostly empty: unconnected pairs show up as blank cells instead of cells in the lowest colour.

Some things to be aware of:

- A cell at the bottom of the scale draws nothing at all. That means you can't tell a recorded zero from a pair that was never measured, whereas squares would show the difference.
- On a diverging scale, the size shows the distance from the centre and the colour shows the direction.
- If the cells get too small for circles, they are drawn as squares and the card says `too dense for circles`. Zoom in, make the card bigger, or aggregate upstream.

> [!NOTE] Exports always draw squares
> The exported notebook and R document draw a normal tile heatmap. Both include a note saying that
> the card used circles. The numbers are the same either way.

`Show values` prints each cell's value. The numbers are hidden automatically once the cells get too small to read them.

## Labels

```coda-params
out.heatmap: matchColumn, labelColumn, labelAxis
```

On most routes into a heatmap, the rows and columns are labelled with neuron ids: Adjacency, [Pivot](#core.pivot) and [Similarity Matrix](#core.similarity) all use whatever column identified the neurons. To use cell types (or any other column) instead, wire a neuron table into `Annotations`. `Match on` is the column compared with the existing labels and `Label by` is the column the new names come from. Rows or columns without a match keep their original label, and the card says how many there were.

> [!WARNING] The new labels replace the old ones
> Unlike the same two settings on the [Dendrogram](#out.dendrogram), which only change the
> drawing, here the names are written into the matrix. The `Filter` tab matches on them, the `Order`
> tab sorts by them, and the CSV and notebook contain them. The original ids are gone from the
> output, so if you also want to cluster with [Linkage](#cluster.linkage), put Linkage above this node.

`Apply to` defaults to "both axes", which is what you want for a square matrix over a single population. If rows and columns are different kinds of things (e.g. neurons vs. brain regions), narrow it to "rows" or "columns"; otherwise the card will tell you that nothing matched the other axis.

When you label by cell type, several rows will often share the same name. That is what makes a filter like `/^LC4$` useful. The one catch: when the `Order` tab sorts by "one row or column", it uses the first row (or column) with that name.

## Filter

```coda-params
out.heatmap: rowFilter, colFilter
```

Keeps only the rows or columns whose label matches. This works the same way as the search box in [Explore Dataset](#neuron.explore): a plain term matches anywhere in the label regardless of case, and a term starting with `/` is a regular expression (the closing `/` is optional).

| you type               | you get                                    |
| ---------------------- | ------------------------------------------ |
| `LC`                   | every label containing `LC`, in any case   |
| `/^LC[0-9]+$`          | `LC4` and `LC10`, but not `LPLC2`          |
| `/^(LC4\|LC6\|LPLC2)$` | exactly those three                        |
| `!DN` or `-DN`         | everything except labels containing `DN`   |

> [!NOTE] Plain terms are not regular expressions
> Cell type names often contain characters that mean something in a regular expression, e.g.
> `LC4(R)` or `SMP001(a)`. That's why a plain term is matched literally, and you have to start with
> `/` to get a pattern.

You get one expression per axis, and the two are independent. On a square matrix over one population, giving both axes the same expression keeps it square. If an expression can't be compiled, that axis is left unfiltered. If it compiles but matches nothing, the axis ends up empty. Filtering happens before sorting.

## Order

```coda-params
out.heatmap: sortBy, sortAxis, sortFollow, sortReverse
```

`Order by` offers these options:

- "as they arrive": keep the input order.
- "total, largest first": the sum of each row or column.
- "label, A → Z": natural sort order, so `LC4` comes before `LC10`.
- "one row or column": type a label into `Row or column`. When ordering rows, this names the column whose values decide the order, and vice versa. If the matrix has no such label, that axis is left as it is and the card says so.
- "clustering": the same approach as seaborn's `clustermap`. Each row is treated as a vector across the columns, rows are clustered by the distance between those vectors, and the tree's leaf order becomes the row order. `Linkage` and `Distance` set the clustering method and the metric ("euclidean" is seaborn's default; "correlation" and "cosine" compare the shape of a profile instead of its magnitude). The first time you use this, Python has to start up in your browser tab, which takes a moment.

> [!TIP] Other axis follows
> A matrix from Adjacency is square over one population but usually not symmetric. With
> `Other axis follows` on, the other axis gets the same order, so the diagonal stays the diagonal.
> Lines that only exist on the other axis are placed after the rest. Matching uses each line's
> original label, so it still works after the `Labels` tab has given several lines the same name.

> [!NOTE] This clustering is not the same as Linkage
> [Linkage](#cluster.linkage) treats the matrix values themselves as distances, which is right
> for a score matrix such as NBLAST. The clustering here compares rows as profiles, which is
> right for a connectivity matrix. To cluster a score matrix, use Linkage's `Ordered` output.

## Selecting rows and columns

Shift-drag a rectangle (⌘-drag or Ctrl-drag does the same), either on the card or in the expanded view. The rows and columns it covers are sent out through two outputs, `Selected Rows` and `Selected Columns`, e.g. into [Selected to Neurons](#cluster.selectedToNeurons) or a filter.

| gesture        | what it does                                       |
| -------------- | -------------------------------------------------- |
| shift-drag     | select the rows and columns covered by the box     |
| shift+⌘-drag   | add another block to the selection                 |
| shift+⌘-click  | add the single cell under the pointer              |
| alt-shift-drag | also adds a block (same gesture as in the Scatter) |
| shift-click    | clear the selection                                |
| drag           | pan                                                |

The caption shows how many rows and columns are selected, and the `Selection` tab holds the same list as a field you can edit or clear.

Both output tables have three columns:

| column    | what it is                                                                                |
| --------- | ----------------------------------------------------------------------------------------- |
| `label`   | the line's label as it came into this node, usually the neuron id                          |
| `index`   | its position in the matrix this node outputs, so you can restore the order with a Sort     |
| `relabel` | the label shown on the card; the same as `label` unless the `Labels` tab renamed the axis |

> [!WARNING] Select last
> The selection stores positions in the matrix, so that selecting one row of a repeated cell type
> gives you that row only. The downside is that if you change the `Order` or `Filter` tab
> afterwards, the selection now refers to whatever ended up at those positions. The card shows
> this straight away, but it's best to arrange the matrix first and select afterwards.

The selection is drawn as bands across the plot, not as the box you dragged. Rows and columns are two separate lists, not the block where they cross, so a wide drag shows up as a cross. To select whole rows, drag across the full width of the plot.

> [!NOTE] One cell means one row and one column
> Shift+⌘-clicking a cell adds its row to `Selected Rows` and its column to `Selected Columns`; it
> does not record the pair. Clicking a second cell elsewhere gives you two rows and two columns,
> i.e. four cells' worth of cross, not the two cells you clicked.

## Large matrices

The heatmap never draws more than about one cell per pixel. Bigger matrices are folded into blocks, so even matrices with millions of cells are fine.

> [!WARNING] Blocks show their strongest cell
> When several cells are folded into one block, the block shows the strongest value, not the
> mean. In a mostly empty connectivity matrix, averaging would hide a single strong connection
> among its empty neighbours. The tooltip shows the actual row, column and value, followed by
> `strongest of ~N cells`.

When there are more axis labels than fit, only some are drawn and the caption says how many were dropped.

## Zoom and pan

In the expanded view, scroll to zoom in around the pointer, drag to pan, and double-click or press ⤢ to see the whole matrix again. When you zoom in, only the visible part is folded, so blocks turn back into individual cells with their own labels and values. Labels stay the same size and reappear as there is room. The colour scale always covers the whole matrix, so a colour means the same value at every zoom level.
