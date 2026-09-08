> [!WARNING] neuPrint-only
> NeuPrint is the only backend that provides curated ROI meshes.

```coda-graph
caption: Show brain regions
dataset.malecns as ds
out.rois as r
ds -> r
```

### Caching

ROI meshes downloaded once and then cached in Coda for subsequent use. We only cache the frontal/dorsal/lateral outlines though to not blow the cache.

### Getting a closer look

Scroll to zoom and drag to pan, off the canvas — in the expanded view, a dashboard cell or the
pinned dock. `⤢`, or a double-click, goes back to the whole brain. Zooming re-thins the labels
rather than magnifying them, so a crowded corner gains names as you go in.

### Making things go "boom"

When two regions overlap in the current plane, the `Explode` slider un-stacks them by computing a 2D separation field, pushing them apart until they no longer overlap.

### Primary only

NeuPrint's published region lists nest. Hemibrain publishes 230 regions of which 63 tile the volume; male-CNS publishes 5,619 of which 144 do. Stacking every sub-region inside its parent creates a visual mess. The `Primary regions only` toggle keeps only the regions that tile the volume—the default. Disable it to compare sub-compartments of a single neuropil.

The toggle chooses which list gets *downloaded*, so the two are cached separately: switching back to the primary set is instant, and switching away asks for the meshes it has not seen. Because that is one request per region, a published list of more than a few hundred asks a second time before it starts—male-CNS's 5,619 is a much longer wait than its 144, and nothing is stored until it finishes.

### Color options

`Completeness (post)` shows fraction of post-synapses associated with a proofread neuron within the given brain region. `Completeness (pre)` is the pre-synaptic complement. `Region` assigns each region a distinct hue; left/right pairs share one because they are one structure seen twice. `Side` groups by hemisphere alone.

```coda-params
out.rois: view, explode, colorBy, primaryOnly
```
