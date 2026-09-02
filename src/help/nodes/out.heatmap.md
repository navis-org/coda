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

Sequential for counts and fractions; diverging when zero is a meaningful middle, as it is after a log ratio. Each scale has its own palette list: `Coda blue` and `Coda blue–red` are the validated defaults and reverse with the theme, so an empty cell always recedes into the surface. The rest — viridis, magma, inferno, plasma, cividis, rocket, mako for a sequential scale; RdBu, PuOr, BrBG for a diverging one — are matplotlib's and seaborn's, drawn as published on both themes and named the same way in the exported notebook.

```coda-params
out.heatmap: colorMin, colorMax, logColor
```

**Min and Max** pin the two ends of the ramp; empty lets the data decide. Pin both on two heatmaps and they can be read against each other. A cell outside the range is drawn in the end colour it passed rather than dropped, and the caption says `values clipped` when that happens. On a diverging scale only Max is offered — it is the magnitude of *both* arms, since they have to match for the middle colour to keep meaning zero.

**Log colour** spreads the ramp over a logarithm — the colour only. The printed cells, the tooltip and the two ends of the colour bar stay the values themselves. This is the setting for connectivity, where a handful of strong pairs otherwise paint the whole long tail as empty: against a maximum of 100, a weight of 1 is 1% of a linear ramp and 15% of a log one.

> [!NOTE] Put a [Normalize](#core.normalize) in front if one row dominates
> A heatmap of raw synapse counts is usually a picture of which cell type is numerous.

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

One expression per axis, and the two axes are independent: on a square matrix over one population, filtering both to the same expression is what keeps it square. Like the order below, **the filter changes the matrix this node outputs**, so a Table wired beside the heatmap shows the same rows.

## Order

```coda-params
out.heatmap: sortBy, sortAxis, sortFollow, sortReverse
```

**The order changes the matrix this node outputs**, not only the picture — so a Table wired beside the heatmap, the CSV export and the notebook all show what the card shows, and the tab says that downstream nodes go stale.

- **Total** — the sum of each row or column, largest first. Puts the strongest partners in the corner.
- **Label** — natural order, so `LC4` comes before `LC10`.
- **One row or column** — type a label. Ordering rows, it names the column whose values decide; ordering columns, the row. A label the matrix does not have leaves that axis alone and says so on the card.
- **Clustering** — seaborn's `clustermap`: each row is a vector across the columns, rows are clustered by the distance between those vectors, and the leaf order is the order. The first use boots Python in the tab; after any NBLAST or Linkage it is milliseconds.

> [!TIP] Other axis follows
> A matrix from Adjacency is square over one population and usually not symmetric. With this on, the other axis takes the same order, matched by label, so the diagonal stays the diagonal. Labels the sorted axis does not have keep their place after them — on a matrix whose axes share no labels it changes nothing.

> [!NOTE] Clustering here is not Linkage's
> [Linkage](#cluster.linkage) reads the matrix *as* the distances, which is right for a score matrix; this reads each row as a profile and compares profiles, which is right for a connectivity matrix. For a score matrix, wire `Linkage → Ordered` instead.

## More cells than pixels

The matrix is folded onto a grid of at most one cell per pixel, so drawing costs the card rather than the data — millions of cells are fine.

> [!WARNING] A folded block keeps its **strongest** cell, never the mean
> Averaging one strong connection across the hundred empty cells beside it would put it near the bottom of the ramp, and a connectivity matrix is mostly empty. The tooltip names the real row, column and value, and says `strongest of ~N cells` beside it.

Axis labels are thinned to a legible pitch when there are more of them than fit, and the caption counts what it dropped.

## Zoom and pan

In the expanded view, scroll to zoom about the pointer, drag to pan, and double-click or press ⤢ to see the whole matrix again. Zooming in re-folds only what is on screen, so a matrix that was blocks at full size becomes real cells with their own names and values — the labels are re-thinned for the room the zoom gives them and never shrink. The colour scale stays the whole matrix's, so a cell's colour means the same thing at every zoom.
