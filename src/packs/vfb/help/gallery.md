## What VFB Line Gallery does

VFB Line Gallery shows the images from [VFB Expression Images](#vfb:images): a large view of one image on top, and below it one tile per driver line, at the line's first whole-line image, with its other images behind `+N`. Opening a line's other images gathers them into one outlined band. Click a tile to show it in the large view.

The large view starts on VFB's maximum projection of the image, at full resolution, drawn over the template brain or VNC. Untick "template" to see the expression alone: VFB publishes no projection without the template, so Coda downloads the image stack and projects it itself, in grey. Nerve cord stacks are stored standing upright, so Coda turns them to lie on their side as VFB's own pictures do. Use the wheel to zoom, drag to pan, and double-click to fit again. Switch to "Slices" to step through the image stack with a z slider. The stack is downloaded only when you ask for it, one image at a time: between 0.15 and 26 MB, and 115 to 325 MB in memory while Slices shows it. The card remembers which view you chose, and whether the template shows, with the workflow.

Pin an image with ☆ and it comes out of `Pinned`. Wire `Pinned` into [VFB Load Expression](#vfb:expression) to download and draw only the lines you chose, rather than every image of every line.

```coda-graph
caption: Pick driver lines from their thumbnails, then draw only those.
vfb:lines as dl
vfb:images as img
vfb:gallery as gal
vfb:expression as ex
dl -> img:lines
img -> gal:images
gal:pinned -> ex:images
```

## Settings

```coda-params
vfb:gallery: view, withTemplate, tiles
```

`View` and `Show template` are the switch and the checkbox above the large view, kept with the workflow. `Lines per step` is how many lines the card shows at first, and how many more each "Show more" adds. Browsing never re-runs anything.

## The output

`Images` passes the input through unchanged. `Pinned` has the same columns as VFB Expression Images, with only the pinned images' rows, in the input's order.

> [!NOTE] Thumbnails load in the card
> Running the node fetches nothing. The card loads each thumbnail from Virtual Fly Brain's file server as it is shown, so a line you never scroll to costs nothing.
