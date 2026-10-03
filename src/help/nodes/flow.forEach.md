## What For Each does

For Each runs everything wired after it once per element of its input: once per row of a table, once per skeleton or once per mesh. Alternatively, it can run once per group of elements that share a value in some column. It is the automatic counterpart of [Select One](#core.selectOne), which lets you step through the same collection by hand.

There are two main reasons to use a loop: writing one file per neuron, and rendering one image per neuron. In both cases, loading the whole collection at once would take too much memory.

```coda-graph
 caption: Fetch one skeleton at a time and write each to its own SWC file.
 neuron.inputIds as ids
 flow.forEach as loop
 neuron.skeletons as sk
 out.download as dl
 ids -> loop
 loop:item -> sk
 sk:skeletons -> dl
```

## How it works

You don't need to build a separate sub-workflow: any node can sit inside a loop. For Each keeps track of which element it is on, and every time it moves on to the next element, all nodes downstream re-run, just as if you had changed a setting above them.

The nodes that are part of the loop are shown on the canvas inside a dashed frame. This includes everything downstream of the For Each, up to a [Collect](#flow.collect) if there is one. Use a Collect to combine the results of all passes into a single value.

Only one element is held in memory at a time. Fetching four hundred skeletons at once can easily take a few gigabytes; fetched one by one, the earlier ones are dropped from the cache as the loop moves on. That way you can save a collection that would be too large to load in one go.

## Settings

```coda-params
flow.forEach: mode, groupBy, batch, limit
```

`For each` has two options:

- "element" runs one pass per row, skeleton or mesh.
- "group of a column" runs one pass per distinct value in the `Group by` column, and each pass gets all elements that share that value. For example, use this to fetch the neurons of each cell type and save one edge list per type. Elements without a value form a single "(none)" group.

`First N` stops the loop after that many elements. It counts elements, not passes, so it gives you the same neurons whatever the `Batch size`. This is useful for trying a loop out on the first ten neurons before running it on the whole collection.

## Batch size

Backends normally fetch several neurons in parallel (e.g. six at a time from neuPrint and eight from CATMAID). A loop that asks for one neuron per pass loses that parallelism. Increasing `Batch size` hands several elements to each pass, which makes fetching much faster while still holding only one batch in memory at a time.

> [!WARNING] Keep it at 1 when rendering images
> A viewer that is handed twenty neurons draws one image with twenty neurons, not twenty images.
> When each pass writes files, on the other hand, a larger batch is safe because the files are
> named after the neurons either way. 20 is a good place to start.

`Batch size` is hidden in "group of a column" mode.

## Writing files

> [!WARNING] Use `Run loop`, not Run
> Browsers stop accepting downloads after about fifty from a single click. Use the `Run loop`
> button on the card to write files. Pressing Run in the toolbar still goes through the loop and
> fetches everything, but has nowhere to put the files.

`Run loop` asks where the files should go and then starts the loop. Depending on your browser, the card offers one of two options:

1. **A folder you pick.** Files are written straight to disk as they are produced, with no limit on how many. Only available in Chromium-based browsers.
2. **A single zip file.** Works in every browser, but all files are held in memory until the loop finishes, which eats into the memory the loop was meant to save.

Files are named after the element, with a zero-padded number in front, so a folder of four hundred files sorts in loop order.

## Rendering an image per element

Images are taken from a live viewer on screen, so the 3D View or chart card that feeds the [Download](#out.download) has to stay visible (and not collapsed) for the entire loop.

By default the camera does not move between elements. That is what you want for a set of images to compare at the same scale, but not if the neurons are far apart. In that case, turn on `Frame each` in the [3D View](#out.viewer3d).

## Running and re-running

For Each only runs when you press Run (or `Run loop`), never while you are editing. Once a loop has finished, it does not run again unless something upstream changes. Press `Run loop` to run it again anyway.

If a pass fails, the loop carries on with the remaining elements. The card tells you how many passes failed and which ones.
