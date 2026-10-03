## What the ROI Viewer does

The ROI Viewer draws a dataset's brain regions (neuropils) together in 2D, looking down one of three anatomical planes: frontal, dorsal or lateral. By default each region is coloured by how completely it has been reconstructed, which makes it a quick way to see where a dataset is well traced and where it isn't.

```coda-graph
caption: Show the brain regions of a dataset.
dataset.malecns as ds
out.rois as r
ds -> r
```

> [!WARNING] neuPrint only
> Only neuPrint datasets provide curated region meshes, and not all of them do. For a dataset
> without them the node shows a warning and draws nothing.

## Settings

```coda-params
out.rois: view, explode, colorBy, primaryOnly
```

`Colour` has the following options:

| Option                  | What it shows                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| "Completeness (post)"   | the fraction of postsynapses in a region that belong to a proofread neuron (the default)             |
| "Completeness (pre)"    | the same for presynapses                                                                              |
| "Region"                | a distinct colour per region; left/right pairs share a colour                                         |
| "Side"                  | one colour per hemisphere                                                                             |
| "Flat"                  | the same colour for every region                                                                      |

Where regions overlap in the chosen plane, the `Explode` slider pushes them apart until they no longer overlap. At 100% they are just separated.

## Primary regions only

The region lists that neuPrint publishes are nested: hemibrain has 230 regions, of which 63 tile the brain without overlap; male CNS has 5,619, of which 144 do. With `Primary regions only` ticked (the default) you only see the regions that tile the brain. Untick it if you want to compare the sub-compartments of a single neuropil.

> [!WARNING] Unticking downloads more meshes
> The two sets of regions are cached separately. Switching back to the primary regions is instant,
> but switching away has to download the meshes for every additional region, one request each. For
> lists longer than a few hundred regions the card asks you to confirm first. For male CNS's 5,619
> regions that is a much longer wait than for its 144, and nothing is cached until the download
> has finished.

## Zooming in

In the expanded view, a dashboard cell or the pinned dock you can scroll to zoom and drag to pan. `⤢` or a double-click takes you back to the whole brain. Labels stay the same size as you zoom; instead, more regions get a label as you zoom into a crowded area.

## Caching

Region meshes are downloaded once and then cached. To keep the cache small, only the frontal, dorsal and lateral outlines are stored.
