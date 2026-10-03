## What Download does

Download writes whatever is wired into it to a file on your computer. By default the format is picked from what arrives: CSV for tables, SWC for skeletons, OBJ for meshes, and so on. You can also choose a format yourself under `Format`.

```coda-params
out.download: format, onRun
```

The input is passed on unchanged, so like the viewers you can put a Download node in the middle of a chain to save an intermediate result.

## When a file is written

This is controlled by `On run`:

- ticked (the default): a file is written every time the node runs
- unticked: a file is only written when you click the download button on the card

The node only runs when something upstream has changed. Pressing Run twice in a row therefore writes one file, not two. Likewise, changing the filename or format and pressing Run writes nothing; use the button on the card instead.

> [!WARNING] Auto-run
> With auto-run switched on, every edit that changes the data upstream triggers a run, and every
> run writes a file. Untick `On run` if you don't want a new file for every edit. Ticking
> `Timestamp` adds the date and time to the filename, so repeated runs don't overwrite each other.

## Saving a chart

"SVG" and "PNG" save the chart drawn by the node feeding into Download, e.g. a [Scatter Plot](#out.scatter) or a Bar Chart. This only works while that node's card is on screen and not collapsed; otherwise the card tells you why nothing was written.
