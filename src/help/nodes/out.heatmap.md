A matrix drawn as a grid of coloured cells — the natural end of [Pivot](#core.pivot), [Similarity Matrix](#core.similarity), [NBLAST](#neuron.nblast) or Adjacency.

```coda-graph
caption: Feed Linkage's `Ordered`, not the raw matrix.
neuron.nblast as nb
cluster.linkage as link
out.heatmap as hm
nb -> link
link:ordered -> hm
```

**An unordered similarity matrix is visual noise.** The same numbers in leaf order show their clusters as blocks down the diagonal, which is what `Ordered` is for — and what the `Order` tab below does for any other matrix.

## Colour

```coda-params
out.heatmap: scale, palette, showValues
```

Sequential for counts and fractions; diverging when zero is a meaningful middle, as after a log ratio. `Coda blue` and `Coda blue–red` reverse with the theme, so an empty cell always recedes into the surface. The rest — viridis, magma, inferno, plasma, cividis, rocket, mako for sequential; RdBu, PuOr, BrBG for diverging — are matplotlib's and seaborn's, drawn as published on both themes and named the same way in the exported notebook.

```coda-params
out.heatmap: colorMin, colorMax, logColor
```

**Min and Max** pin the two ends of the ramp; empty lets the data decide. Pin both on two heatmaps and they can be read against each other. A cell outside the range is drawn in the end colour it passed rather than dropped, and the caption says `values clipped`. On a diverging scale only Max is offered — it is the magnitude of *both* arms, since they have to match for the middle colour to keep meaning zero.

**Log colour** spreads the ramp over a logarithm — the colour only. The printed cells, the tooltip and the two ends of the colour bar stay the values themselves. Against a maximum of 100, a weight of 1 is 1% of a linear ramp and 15% of a log one.

> [!NOTE] Put a [Normalize](#core.normalize) in front if one row dominates
> A heatmap of raw synapse counts is usually a picture of which cell type is numerous.

## Labels

```coda-params
out.heatmap: matchColumn, labelColumn, labelAxis
```

On most routes into a heatmap an axis is a column of root ids — `Adjacency`, `Pivot` and `Similarity Matrix` all label their rows with whatever identified the observation. Wire a neuron table to **Annotations** and the axes take a column of it instead: `Match on` is compared with the axis label, `Label by` supplies the name. Unmatched lines keep their own, and the card counts them.

> [!WARNING] This changes the matrix, where the Dendrogram's port does not
> [Dendrogram](#out.dendrogram) has the same two pickers and they only decorate. Here the names
> are real: the Filter tab matches on them, the Order tab sorts by them, and the CSV and the
> notebook carry them. The other side of that is what the axis gives up — the id it arrived with
> — so a [Linkage](#cluster.linkage) whose leaves need ids goes *above* this node.

`Apply to` is `both` by default, which is right for a square matrix over one population. Narrow it when the two axes are different kinds of thing — neurons down, regions across — or the card will tell you that nothing named the columns.

Naming by type routinely gives several lines the same name, which is what makes a filter of `/^LC4$` useful. The one thing it costs: `Order by: one row or column` takes the first line of a repeated name.

## Filter

```coda-params
out.heatmap: rowFilter, colFilter
```

Keep only the rows or columns whose label matches. **Same spelling as the search box on [Explore Dataset](#neuron.explore)**: a plain term matches anywhere in the label ignoring case, and a term starting with `/` is a regular expression, whose closing `/` is optional.

| you type | you get |
| --- | --- |
| `LC` | every label containing `LC`, in any case |
| `/^LC[0-9]+$` | `LC4` and `LC10`, but not `LPLC2` |
| `/^(LC4\|LC6\|LPLC2)$` | exactly those three |
| `!DN` or `-DN` | everything *except* labels containing `DN` |

> [!NOTE] A plain term is a literal, on purpose
> Cell-type labels are full of regex characters — `LC4(R)`, `SMP001(a)` — so a box that compiled everything would quietly match `LC4R` too. The `/` is how you ask for a pattern.

One expression per axis, and the two are independent: on a square matrix over one population, filtering both to the same expression keeps it square. Like the order below, **the filter changes the matrix this node outputs**.

## Order

```coda-params
out.heatmap: sortBy, sortAxis, sortFollow, sortReverse
```

**The order changes the matrix this node outputs**, not only the picture — so a Table wired beside the heatmap, the CSV export and the notebook all show what the card shows, and the tab says that downstream nodes go stale.

- **Total** — the sum of each row or column, largest first.
- **Label** — natural order, so `LC4` comes before `LC10`.
- **One row or column** — type a label. Ordering rows, it names the column whose values decide; ordering columns, the row. A label the matrix does not have leaves that axis alone and says so on the card.
- **Clustering** — seaborn's `clustermap`: each row is a vector across the columns, rows are clustered by the distance between those vectors, and the leaf order is the order. The first use boots Python in the tab.

> [!TIP] Other axis follows
> A matrix from Adjacency is square over one population and usually not symmetric. With this on, the other axis takes the same order, matched by label, so the diagonal stays the diagonal. Labels the sorted axis does not have keep their place after them.

> [!NOTE] Clustering here is not Linkage's
> [Linkage](#cluster.linkage) reads the matrix *as* the distances, which is right for a score matrix; this reads each row as a profile and compares profiles, which is right for a connectivity matrix. For a score matrix, wire `Linkage → Ordered` instead.

## Selecting rows and columns

Expand the card and **shift-drag a rectangle** (⌘- or Ctrl-drag does the same). The rows and columns it covers leave the node on their own two ports, `Selected Rows` and `Selected Columns`, ready for [Selected to Neurons](#cluster.selectedToNeurons) or a filter.

| gesture | what it does |
| --- | --- |
| shift-drag | select the rows and columns the box covers |
| alt-shift-drag | add another block to the selection |
| shift-click, or ⌫ | clear it |
| drag | pan, as before — selection needs the modifier |

Each table carries three columns:

| column | what it is |
| --- | --- |
| `label` | what the line was called **on the way in** — the neuron id, unless something upstream named it |
| `index` | its position in the matrix this node outputs, so a Sort downstream can restore this order |
| `relabel` | what the card showed — the same as `label` unless the Labels tab renamed the axis |

> [!WARNING] Sorting or filtering after selecting moves the selection
> It holds the *positions* the box covered, so a box round one row of a repeated cell type takes
> that row and not its namesakes. The price is at the other end: change the Order or Filter tab
> under a standing selection and it names whatever now sits at those positions. The card shows it
> the moment it happens — select after you have arranged the matrix, not before.

The picture is **bands rather than the box you drew**, because an added block is a second run and a matrix folded to fit puts many lines on one block. The two ports are independent lists rather than the block where they cross, which is why a wide drag reads as a cross. To take whole rows, drag the full width of the plot.

## More cells than pixels

The matrix is folded onto a grid of at most one cell per pixel, so drawing costs the card rather than the data — millions of cells are fine.

> [!WARNING] A folded block keeps its **strongest** cell, never the mean
> Averaging one strong connection across the hundred empty cells beside it would put it near the
> bottom of the ramp, and a connectivity matrix is mostly empty. The tooltip names the real row,
> column and value, and says `strongest of ~N cells` beside it.

Axis labels are thinned to a legible pitch when there are more of them than fit, and the caption counts what it dropped.

## Zoom and pan

In the expanded view, scroll to zoom about the pointer, drag to pan, and double-click or press ⤢ to see the whole matrix again. Zooming in re-folds only what is on screen, so a matrix that was blocks at full size becomes real cells with their own names and values; the labels are re-thinned for the room the zoom gives them and never shrink. The colour scale stays the whole matrix's, so a cell's colour means the same thing at every zoom.
