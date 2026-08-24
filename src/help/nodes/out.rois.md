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

### Making things go "boom"

When two regions overlap in the current plane, the `Explode` slider un-stacks them by computing a 2D separation field, pushing them apart until they no longer overlap.

### Primary only

NeuPrint's published region lists nest. Hemibrain publishes 230 regions of which 63 tile the volume; male-CNS publishes 5,619 of which 144 do. Stacking every sub-region inside its parent creates a visual mess. The `Primary regions only` toggle keeps only the regions that tile the volume—the default. Disable it to compare sub-compartments of a single neuropil.

### Color options

`Completeness (post)` shows fraction of post-synapses associated with a proofread neuron within the given brain region. `Completeness (pre)` is the pre-synaptic complement. `Region` assigns each region a distinct hue; left/right pairs share one because they are one structure seen twice. `Side` groups by hemisphere alone.

```coda-params
out.rois: view, explode, colorBy, primaryOnly
```
