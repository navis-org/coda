The Scatter Plot plots two numeric columns against each other, with colour, size and shape available as additional channels. It is the usual way to look at an [Embedding](#core.embed) (UMAP), but works on any table. The input table passes through to the `Table` output unchanged, and points you lasso come out of `Selected`.

## Drawing and export

Every row is drawn, however large the table: a whole-dataset embedding of more than a hundred thousand neurons still pans smoothly. With more than 10,000 points in view the marks are drawn as pixels; zoom in and they become exact shapes again.

`Log X` and `Log Y` put an axis on a log scale. Values at or below zero can't be shown on a log axis and are dropped; the caption says how many. For an embedding, set `Aspect` to "equal scale" so both axes use the same units per pixel.

Export (SVG, PDF, PNG) redraws the current view. With more than 10,000 points in view, the exported points are a single high-resolution image inside an otherwise vector file, because a file with a hundred thousand vector shapes is too slow to open in most programs. Tick `Vector marks` if you want every point as a vector shape regardless.

```coda-params
out.scatter: xLog, yLog, vectorMarks
```

## Labels and tooltips

Tick `Labels on points` to write each point's `Label` next to it. Labels only appear once few enough points are in view (`Label up to`, 400 by default), so zoom in on a cluster to read them. Labels are placed so that they don't cover each other or other points; a label that doesn't fit is either left out or drawn faintly, depending on `Labels that do not fit`. Selected points get their labels first, and exports include the labels.

The tooltip shows the label, x, y and whichever columns colour and shape are read from. Use `Hover shows` to add more columns.

```coda-params
out.scatter: pointLabels, labelLimit, labelLines, unplacedLabels, hoverColumns
```

## Finding points

In the expanded view, **⌕** in the corner opens a search box. Type a name and every point whose label or id contains it is outlined, with the number of matches shown next to the box.

- **‹ ›** (or Enter and Shift+Enter) step through the matches, centring each one at the current zoom with its tooltip open.
- **◎** selects all matches; with Shift, it adds them to the current selection.
- **⋯** holds the options: search a single column instead of label and id, match the whole value only, match case, or treat the search term as a regular expression.

A term starting with `/` is always treated as a regular expression, as in the [Heatmap](#out.heatmap)'s filters.

## Selecting points

Lasso a group of points and the corresponding rows come out of the `Selected` output.

`ID column` decides how each selected point is identified, typically by `neuronId` (used by default if the table has one). If the table has no ID column, points are identified by their row number instead and the caption shows `by row index`.

> [!WARNING] Selections by row number are fragile
> A row number points at a different row as soon as anything upstream reorders or filters the
> table. Wherever possible, pick an `ID column`.

The selection is saved with the workflow, just as in the [Network Viewer](#out.network), so changing it re-runs whatever is wired to `Selected`.
