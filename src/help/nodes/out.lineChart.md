The Line Chart plots one or more numeric columns against a numeric X, one line each. Use it for any table where the order along X matters: voltage traces, a time course, a measure along a path, a profile. The input table passes through to the `Table` output unchanged.

## Choosing lines

`X` is the axis the lines run along, e.g. `t`. Which lines you get depends on the shape of your table:

- **Wide tables** have one column per line, e.g. voltage traces with `t`, `soma`, `site 1`, … Leave `Y` empty to draw every numeric column except X, or pick the ones you want.
- **Long tables** have one row per sample and a column saying which line it belongs to, e.g. `t`, `voltage` and `site`. Pick the value column as `Y` and the other as `Series`.

You can use both at once: with two `Y` columns and a `Series` column you get every Y for every series, labelled `series · Y`.

```coda-params
out.lineChart: x, ys, series
```

## Joining points

By default each line is joined in X order, so a table whose rows are not sorted still draws as a function of X. Set `Join` to "in row order" to keep the rows as they come, e.g. for a phase plot where the curve doubles back on itself.

Empty cells are skipped and the line runs straight across the gap. `Log X` and `Log Y` put an axis on a log scale; values at or below zero are dropped. The caption counts anything that was not drawn.

```coda-params
out.lineChart: order, xLog, yLog
```

## Reading and zooming

Hovering shows a dashed line at the pointer with every line's value at that X in the tooltip — e.g. the soma and three record sites at one time point.

Scroll to zoom along X, drag to pan once zoomed, and double-click to go back to the whole trace. The Y axis rescales to what is in view, so a short EPSP fills the height when you zoom in on it.

> [!TIP] Long traces keep their spikes
> A trace with more samples than the chart has pixels is drawn from each pixel column's first,
> lowest, highest and last sample. A spike one sample wide still shows, on screen and in the
> exported SVG.

## Colours

Lines take the colours of `Palette` in turn. With more lines than the palette has colours, colours repeat and the caption says so; pick a larger palette, or fewer lines. The legend lists the first twelve lines and how many more there are.
