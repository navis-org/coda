> [!WARNING] neuPrint-only
> neuPrint is the only backend that provides curated ROI meshes.

```coda-graph
caption: Show brain regions
dataset.malecns as ds
out.rois as r
ds -> r
```

### Caching

ROI meshes are downloaded once and cached. Only the frontal, dorsal and lateral outlines are kept, to bound the cache.

### Getting a closer look

Scroll to zoom and drag to pan, off the canvas — in the expanded view, a dashboard cell or the pinned dock. `⤢`, or a double-click, goes back to the whole brain. Zooming re-thins the labels rather than magnifying them, so a crowded corner gains names as you go in.

### Explode

Where two regions overlap in the current plane, the `Explode` slider un-stacks them by computing a 2D separation field and pushing them apart until they no longer overlap.

### Primary only

neuPrint's published region lists nest. Hemibrain publishes 230 regions of which 63 tile the volume; male-CNS publishes 5,619 of which 144 do. `Primary regions only` keeps the tiling set, and is the default. Disable it to compare sub-compartments of a single neuropil.

> [!WARNING] The toggle chooses which list gets downloaded
> The two are cached separately, so switching back to the primary set is instant and switching away
> asks for the meshes it has not seen. That is one request per region, so a published list of more
> than a few hundred asks a second time before it starts — male-CNS's 5,619 is a much longer wait
> than its 144, and nothing is stored until it finishes.

### Colour options

`Completeness (post)` is the fraction of post-synapses in a region that belong to a proofread neuron; `Completeness (pre)` is its presynaptic complement. `Region` gives each region a distinct hue, with left/right pairs sharing one because they are one structure seen twice. `Side` groups by hemisphere alone.

```coda-params
out.rois: view, explode, colorBy, primaryOnly
```
